// 高层管道：URL → 版本 + 日志
//
// 流程：
//   1. 识别更新源（GitHub / RSS / changelog 页）
//   2. 普通抓取 → 版本提取
//   3. 若版本为 null 或低置信（needsBrowser）→ Playwright 渲染后再提取（解决 JS 站）
//   4. 按来源提取更新日志
import { classifySource, enrichSource } from './sources';
import { extractVersionFromHtml } from './version-extract';
import { extractVersionWithLgb } from './lgb-score';
import { extractChangelog } from './changelog';
import { fetchPage, fetchPageRendered, fetchPageRenderedDeep, closeBrowser } from './crawler';
import { queryRegistry, queryOfficialEndpoint } from './registries';
import { discoverRegistry, fetchGithubRelease, pickBestCandidate } from './registry-discover';
import { recordAudit, type AuditDecision } from './audit';
import type { ChangelogEntry, UpdateSource, VersionResult } from './types';

export interface ExtractOutcome {
  url: string;
  source: UpdateSource;
  version: VersionResult;
  changelog: ChangelogEntry | null;
  neededBrowser: boolean; // 是否升级到了浏览器渲染
  registryVersion?: string | null; // 注册表确定性版本（最高优先级）
  registryKey?: string | null;
  renderedText?: string;
}

export async function extractFromUrl(
  url: string,
  opts: { token?: string; registryKey?: string; skipBrowser?: boolean; productName?: string | null; noRegistry?: boolean; onLlm?: (info: { margin: number; answer: string | null }) => void } = {}
): Promise<ExtractOutcome> {
  const source = await enrichSource(classifySource(url));

  // L3 结构化源优先（文档 three-tier-extractor.md P3）：官方 JSON 端点比注册表更权威。
  // 对已知域名尝试，命中即确定性返回。
  const l3 = await queryOfficialEndpoint(url);
  const l3Version: VersionResult | null = l3 ? {
    version: l3.version,
    source: 'official-endpoint',
    confidence: 'high',
    needsAiCheck: false,
    needsBrowser: false,
    suggestedRegex: null,
  } : null;
  // L3 附带 changelog（如 iTunes releaseNotes）→ 直接返回，避免 JSON 被当页面清洗成垃圾。
  if (l3Version && l3?.changelog) {
    return {
      url, source, version: l3Version,
      changelog: { version: l3.version, content: l3.changelog.content, date: l3.changelog.date || null, source: 'official-endpoint', confidence: 'high' as const },
      neededBrowser: false, registryVersion: null, registryKey: null,
    };
  }
  // 日志页/RSS 仍需继续抓页面；L3 只提供确定性版本锚点。
  if (l3Version && source.type !== 'changelog-page' && source.type !== 'rss') {
    return { url, source, version: l3Version, changelog: null, neededBrowser: false, registryVersion: null, registryKey: null };
  }

  // 0. 注册表优先：确定性命名字段，优于任何 HTML 猜测；命中直接短路（快且权威）
  let registryVersion: string | null = null;
  let registryResolvedKey: string | null = null;
  let discoveredChangelog: ChangelogEntry | null = null;
  if (opts.registryKey) {
    try {
      const reg = await queryRegistry(opts.registryKey, { token: opts.token });
      registryVersion = reg.version;
      registryResolvedKey = opts.registryKey;
    } catch {
      // 注册表查询失败则回退 HTML
    }
  } else if (opts.productName && !opts.noRegistry) {
    // 自动发现：给 URL + 产品名 → 多渠道搜索 → homepage 域名匹配 → pickBestCandidate（预发布过滤 + brew>github>npm）
    // noRegistry=true 时禁用注册表, 强制纯 HTML/浏览器提取(测 VE 页面能力而非注册表查询)
    try {
      const cands = await discoverRegistry(url, { productName: opts.productName, token: opts.token });
      const best = pickBestCandidate(cands);
      if (best) {
        if (best.version) {
          registryVersion = best.version;
        } else if (best.source === 'github') {
          // GitHub 候选查 releases 拿最新 tag；顺带拿 release body 当 changelog
          const rel = await fetchGithubRelease(best.name, opts.token);
          if (rel?.version) registryVersion = rel.version;
          if (rel?.changelog) {
            discoveredChangelog = { version: rel.version, title: best.name, content: rel.changelog, date: rel.date, source: 'github-release', confidence: 'high' };
          }
        }
        registryResolvedKey = best.registryKey;
      }
    } catch {
      // 发现失败静默回退 HTML
    }
  }
  if (registryVersion) {
    const finalVersion: VersionResult = {
      version: registryVersion,
      source: 'registry',
      confidence: 'high',
      needsAiCheck: false,
      needsBrowser: false,
      suggestedRegex: null,
    };
    // 注册表命中：非日志页直接返回（版本确定性高，页面无日志可提）；
    // 日志页/RSS 继续走页面流程拿 changelog，注册表版本作为锚点（同 L3 策略，避免版本对但日志 null）
    if (source.type !== 'changelog-page' && source.type !== 'rss') {
      return { url, source, version: finalVersion, changelog: discoveredChangelog, neededBrowser: false, registryVersion, registryKey: registryResolvedKey };
    }
  }

  // changelog-page / rss 走页面；github 走 API（无需渲染）——但 API 失败/限流时 HTML 兜底
  // ⚠️ github-releases 也抓 HTML: 新50基准 mpv/jq/Pandoc/Restic/Zola 的 GitHub API 调用失败返回
  // null, 纯 API 路径导致 version=null。HTML 提取(v0.41.0 等)作为兜底, 避免 None
  let page = source.type === 'changelog-page' || source.type === 'rss' || source.type === 'github-releases' || source.type === 'github-tags'
    ? await fetchPage(url)
    : { status: 0, text: '', error: undefined };
  // 审计：收集提取决策（L1/L2 都触发，取最后一次），返回前统一落库
  // 用 box 对象而非 let + 闭包赋值——后者在部分 TS 版本下会被窄化到 never
  const auditBox: { last: AuditDecision | null } = { last: null };
  const onAudit = (d: AuditDecision) => { auditBox.last = d; };
  let version = l3Version || (page.text ? await extractVersionWithLgb(page.text, { productName: opts.productName, onLlm: opts.onLlm, onAudit }) : null);
  let neededBrowser = false;

  // L2 深度兜底（文档 three-tier-extractor.md P1/P2）：
  // 普通抓取拿不到/低置信 → 浏览器渲染 + 网络拦截 + 运行时全局态 + 主 CTA 定位
  // opts.skipBrowser 时跳过渲染（低内存机器/CI 用：只测 L1+注册表+L3 确定性路径）
  // L1 静态抓取失败（page.text 空）也要试 L2——JS 站/反爬站常只有浏览器能拿到 DOM。
  // GitHub releases/tags 源：版本走 GitHub API（下方 changelog 回填），无需浏览器渲染
  const needL2 = source.type === 'github-releases' || source.type === 'github-tags'
    ? false
    : !page.text || !version || !version.version || version.needsBrowser;
  if (!opts.skipBrowser && needL2) {
    const deep = await fetchPageRenderedDeep(url);
    let l2Version: VersionResult | null = null;

    // ── L2 采纳规则（修正误报：不取"第一个 version 字段"）──
    // 产品版本会跨多个网络响应重复出现 + 出现在主下载按钮/渲染DOM 中；
    // SDK/接口版本只出现一次，不满足交叉验证 → 不采纳
    const nv = deep.networkVersions || []; // [{version, count}] 按 count 降序
    const ctaSet = new Set(deep.ctaVersions || []);
    const domHas = (v: string) => deep.text && deep.text.includes(v.replace(/^v/i, ''));
    const semverish = (v: string) => /^v?\d+\.\d+/.test(v);

    let pick: string | null = null;
    let pickSource = '';
    // 1. 网络中出现 >=2 个响应，且与 CTA 或渲染DOM 交叉验证一致 → 最强
    const confirmed = nv.find((x) => x.count >= 2 && (ctaSet.has(x.version) || domHas(x.version)));
    if (confirmed && semverish(confirmed.version)) {
      pick = confirmed.version;
      pickSource = 'network';
    }
    // 2. 网络中出现 >=2 个响应的（无交叉也采纳，频次本身就是共识）
    if (!pick) {
      const freq = nv.find((x) => x.count >= 2);
      if (freq && semverish(freq.version)) {
        pick = freq.version;
        pickSource = 'network';
      }
    }
    // 3. CTA 定位（主下载按钮 href/text）
    if (!pick) {
      const c = [...ctaSet].find(semverish);
      if (c) {
        pick = c;
        pickSource = 'cta';
      }
    }
    // 4. 全局态
    if (!pick) {
      const g = (deep.globalVersions || []).find(semverish);
      if (g) {
        pick = g;
        pickSource = 'global';
      }
    }

    if (pick) {
      l2Version = {
        version: pick.startsWith('v') ? pick : `v${pick}`,
        source: pickSource,
        confidence: 'high',
        needsAiCheck: false,
        needsBrowser: false,
        suggestedRegex: null,
      };
    }
    if (l2Version && l2Version.version) {
      // L2 命名字段确定性命中 → 直接采用
      version = l2Version;
      neededBrowser = true;
    } else {
      // 渲染后 DOM 用 LGB 归族重选（与 L1 同一选择器）——release-notes 页（chrome）
      // 的版本在正文版本列表里，启发式只扫 heading/nav 会选到旧版本 v95，而
      // LGB 归族能识别完整版本序列（v100~v151）选最大。启发式作 LGB 失败时的兜底。
      const rendered = await fetchPageRendered(url);
      if (!rendered.error && rendered.text) {
        const lgbRendered = await extractVersionWithLgb(rendered.text, { productName: opts.productName, onLlm: opts.onLlm, onAudit });
        const re = (lgbRendered.version && lgbRendered.confidence !== 'low')
          ? lgbRendered
          : extractVersionFromHtml(rendered.text);
        // 只采用高置信的渲染后结果；低置信（营销页/SPA 噪音）宁缺毋滥
        if (re.version && re.confidence === 'high') {
          version = re;
          page = rendered;
          neededBrowser = true;
        } else if (!version || !version.version) {
          // L1 也无结果时，用渲染后的结果兜底（置信不变，仍可能低）
          version = re;
          page = rendered;
          neededBrowser = true;
        }
      }
    }
  }

  // 最终版本：注册表命中（日志页场景）→ 注册表版本优先（确定性最高）；否则用页面提取结果
  let finalVersion: VersionResult =
    registryVersion
      ? { version: registryVersion, source: 'registry', confidence: 'high' as const, needsAiCheck: false, needsBrowser: false, suggestedRegex: null }
      : version || { version: null, source: 'none', confidence: 'low' as const, needsAiCheck: true, needsBrowser: true, suggestedRegex: null };

  // 日志：统一走 extractChangelog（内部含静态抓取 + 规则层 + 浏览器+Trafilatura 兜底）
  let changelog: ChangelogEntry | null = null;
  if (source.type === 'github-releases') {
    changelog = await extractChangelog(source, { token: opts.token, productName: opts.productName });
    // GitHub API 返回的 release/tag 版本回填：无注册表/无 HTML 版本时直接用 release tag，
    // 避免 version=null 触发慢速浏览器渲染（github.com/xxx/releases 纯链接场景）
    if (changelog?.version && !finalVersion.version) {
      finalVersion = {
        version: changelog.version,
        source: changelog.source === 'github-tag' ? 'github-tag' : 'github-release',
        confidence: 'high' as const,
        needsAiCheck: false,
        needsBrowser: false,
        suggestedRegex: null,
      };
    }
  } else if (page.text || !opts.skipBrowser) {
    // 优先用已抓取的页面 HTML（省一次请求）；静态为空时交给 extractChangelog 内部浏览器兜底
    changelog = await extractChangelog(
      source,
      page.text ? { pageHtml: page.text, version: finalVersion.version || undefined, token: opts.token, productName: opts.productName } : { version: finalVersion.version || undefined, token: opts.token, productName: opts.productName }
    );
    // 页面 changelog 锚定版本回填：注册表版本可能来自组件/子包（如 brew thingsmacsandboxhelper
    // 的 3.48 是沙盒辅助组件版本，Things 主程序页面真实版本是 3.22.13）。changelog 锚定的版本
    // 是页面正文真实标题（用户可见），与注册表不一致时以页面为准。
    // ⚠️ 只覆盖"注册表来源"的版本——LGBM rank/LLM 提取的版本(version-extract/lgb-score)是页面
    //   候选语义选择的结果，changelog anchor 可能从 changelog 标题误提取组件版本
    //   (Junie 案例: changelog 标题 "2xx.105.40" 是 IDE 兼容区间, 覆盖了 LGBM 的 262.2144.90)
    const fromRegistry = finalVersion.source === 'registry' || finalVersion.source === 'official-endpoint';
    if (fromRegistry && changelog?.version && finalVersion.version && changelog.version !== finalVersion.version) {
      finalVersion = {
        version: changelog.version,
        source: changelog.source === 'changelog-page' ? 'changelog-anchor' : finalVersion.source,
        confidence: 'high' as const,
        needsAiCheck: false,
        needsBrowser: false,
        suggestedRegex: null,
      };
    }
  }

  // 审计落库：记录页面 HTML + 候选/rank/LLM/最终（供 API 调取排查）
  if (auditBox.last) {
    recordAudit({
      ...auditBox.last,
      ts: new Date().toISOString(),
      url,
      htmlLength: (page.text || '').length,
      html: page.text || '',
    });
  }

  return { url, source, version: finalVersion, changelog, neededBrowser, registryVersion, registryKey: registryResolvedKey, renderedText: neededBrowser ? page.text : undefined };
}

export { closeBrowser };
