// 高层管道：URL → 版本 + 日志
//
// 流程：
//   1. 识别更新源（GitHub / RSS / changelog 页）
//   2. 普通抓取 → 版本提取
//   3. 若版本为 null 或低置信（needsBrowser）→ Playwright 渲染后再提取（解决 JS 站）
//   4. 按来源提取更新日志
import { classifySource, enrichSource } from './sources';
import { extractVersionFromHtml } from './version-extract';
import { extractChangelog } from './changelog';
import { fetchPage, fetchPageRendered, fetchPageRenderedDeep, closeBrowser } from './crawler';
import { queryRegistry, queryOfficialEndpoint } from './registries';
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
  opts: { token?: string; registryKey?: string; skipBrowser?: boolean } = {}
): Promise<ExtractOutcome> {
  const source = await enrichSource(classifySource(url));

  // L3 结构化源优先（文档 three-tier-extractor.md P3）：官方 JSON 端点比注册表更权威。
  // 对已知域名尝试，命中即确定性返回。
  const l3 = await queryOfficialEndpoint(url);
  if (l3) {
    const finalVersion: VersionResult = {
      version: l3.version,
      source: 'official-endpoint',
      confidence: 'high',
      needsAiCheck: false,
      needsBrowser: false,
      suggestedRegex: null,
    };
    return { url, source, version: finalVersion, changelog: null, neededBrowser: false, registryVersion: null, registryKey: null };
  }

  // 0. 注册表优先：确定性命名字段，优于任何 HTML 猜测；命中直接短路（快且权威）
  let registryVersion: string | null = null;
  let registryResolvedKey: string | null = null;
  if (opts.registryKey) {
    try {
      const reg = await queryRegistry(opts.registryKey, { token: opts.token });
      registryVersion = reg.version;
      registryResolvedKey = opts.registryKey;
    } catch {
      // 注册表查询失败则回退 HTML
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
    return { url, source, version: finalVersion, changelog: null, neededBrowser: false, registryVersion, registryKey: registryResolvedKey };
  }

  // changelog-page / rss 走页面；github 走 API（无需渲染）
  let page = source.type === 'changelog-page' || source.type === 'rss'
    ? await fetchPage(url)
    : { status: 0, text: '', error: undefined };
  let version = page.text ? extractVersionFromHtml(page.text) : null;
  let neededBrowser = false;

  // L2 深度兜底（文档 three-tier-extractor.md P1/P2）：
  // 普通抓取拿不到/低置信 → 浏览器渲染 + 网络拦截 + 运行时全局态 + 主 CTA 定位
  // opts.skipBrowser 时跳过渲染（低内存机器/CI 用：只测 L1+注册表+L3 确定性路径）
  if (!opts.skipBrowser && page.text && (!version || version.needsBrowser || !version.version)) {
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
      // 渲染后 HTML 启发式（L1 在 JS 跑完后的 DOM 上重跑）
      const rendered = await fetchPageRendered(url);
      if (!rendered.error && rendered.text) {
        const re = extractVersionFromHtml(rendered.text);
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

  // 注册表未命中时，用页面提取结果（含 L1/L2 各档结果）
  const finalVersion: VersionResult =
    version || { version: null, source: 'none', confidence: 'low' as const, needsAiCheck: true, needsBrowser: true, suggestedRegex: null };

  // 日志
  let changelog: ChangelogEntry | null = null;
  if (source.type === 'github-releases') {
    changelog = await extractChangelog(source, { token: opts.token });
  } else if (page.text) {
    changelog = await extractChangelog(source, { pageHtml: page.text, version: finalVersion.version || undefined, token: opts.token });
  }

  return { url, source, version: finalVersion, changelog, neededBrowser, registryVersion, registryKey: registryResolvedKey, renderedText: neededBrowser ? page.text : undefined };
}

export { closeBrowser };
