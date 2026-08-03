// 版本号提取模型 v2（规则化，不依赖 LLM）
//
// 核心原则：真实版本号会【反复出现】—— 标题、meta、下载链接、正文多处。
// 垃圾版本（JS 资产、构建号）只出现一次、不在下载链接里。
//
// 评分 = 范围权重 + 精度权重 + 出现次数 + 是否在页面URL中 + 是否在下载链接中
// 只有高置信才可免 AI 直接写入；中/低置信必须升级到 AI 复核。
import type { Confidence, VersionResult } from './types';

const SEMVER_RE =
  /\bv?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc|pre|patch)[0-9.]*)?(?:[+][0-9A-Za-z.-]+)?\b/g;
const MINOR_RE = /\bv?(0|[1-9]\d*)\.(0|[1-9]\d*)\b/g;
const MAJOR_RE = /\bv(0|[1-9]\d*)\b/g;

function normalizeVersion(raw: string): string {
  const t = raw.trim();
  return t.startsWith('v') || t.startsWith('V') ? t : `v${t}`;
}

export function suggestRegex(version: string): string | null {
  const cleaned = version.replace(/^v/i, '');
  const parts = cleaned.split('.').length;
  if (parts >= 3) return `v?(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)`;
  if (parts === 2) return `v?(\\d+\\.\\d+)`;
  return `v?(\\d+)`;
}

// 可疑版本：次要段/补丁段超长（如 3.884.99 的 884）、无 v 的大数字、全零 —— 大概率是 JS/资产版本
function isSuspicious(raw: string): boolean {
  const nums = raw.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  if (nums.every((n) => n === 0)) return true; // 0.0.0 之类占位值
  if (nums.length >= 2 && nums[1] >= 1000) return true;
  if (nums.length >= 3 && nums[2] >= 10000) return true;
  if (nums.length === 1 && !raw.startsWith('v') && nums[0] >= 100) return true;
  return false;
}

function isDownloadUrl(u: string): boolean {
  return (
    /\.(zip|dmg|exe|msi|tar\.gz|tar\.bz2|tgz|deb|rpm|apk|pkg|7z)(\?|#|$)/i.test(u) ||
    /\/download(s)?\//i.test(u) ||
    /\/releases?\//i.test(u) ||
    /\/ftp\//i.test(u) ||
    /\/dl\//i.test(u)
  );
}

function extractStructuredText(html: string): string {
  const parts: string[] = [];
  const jsonLd = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  jsonLd.forEach((m) => parts.push(m.replace(/<[^>]+>/g, '')));
  // 关键：__NEXT_DATA__ / __INITIAL_STATE__ 是巨型 JSON，包含大量非版本数字（图片尺寸、坐标、ID）。
  // 只保留"版本语义字段"附近的值，避免把 JSON 噪音当版本。
  const nextData = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) {
    const VERSION_FIELD_RE =
      /["'](?:version|versionNumber|latestVersion|releaseVersion|appVersion|pkgVersion|softwareVersion|productVersion|currentVersion|buildVersion|apiVersion|sdkVersion|stableVersion|newVersion|tag_name|tagName|name)["']\s*:\s*["']([^"']{1,40})["']/gi;
    const matches = [...nextData[1].matchAll(VERSION_FIELD_RE)];
    matches.forEach((m) => parts.push(`version:${m[1]}`));
  }
  const initState = html.match(/<script[^>]*id=["']__INITIAL_STATE__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (initState) {
    const VERSION_FIELD_RE =
      /["'](?:version|versionNumber|latestVersion|releaseVersion|appVersion|pkgVersion|softwareVersion|productVersion|currentVersion|buildVersion|apiVersion|sdkVersion|stableVersion|newVersion|tag_name|tagName|name)["']\s*:\s*["']([^"']{1,40})["']/gi;
    const matches = [...initState[1].matchAll(VERSION_FIELD_RE)];
    matches.forEach((m) => parts.push(`version:${m[1]}`));
  }
  return parts.join('\n');
}

// JSON 响应（iTunes lookup / 版本接口等）：提取精确 version 键的值；排除 OS/SDK/API/构建版本键
function extractVersionFromJsonLike(json: string): string | null {
  const BAD_KEY_RE = /minimumOsVersion|minimum_os_version|requiredOsVersion|sdkVersion|sdk_version|apiVersion|api_version|buildNumber|build_number|schemaVersion|schema_version|protocolVersion|protocol_version|releaseCandidateVersion|minRequiredVersion|compatibleVersion/i;
  // 优先精确 version 键（产品版本）
  const exact = json.match(/["']version["']\s*:\s*["']([^"']{1,30})["']/i);
  if (exact && !BAD_KEY_RE.test(exact[0])) {
    const v = exact[1].trim();
    if (/\d/.test(v) && !/^\d{4}[-.]\d{2}[-.]\d{2}/.test(v)) return normalizeVersion(v);
  }
  // 其他命名字段（排除 BAD）
  const m = json.match(/["'](?:appVersion|latestVersion|releaseVersion|currentVersion|stableVersion|newVersion)["']\s*:\s*["']([^"']{1,30})["']/i);
  if (m && !BAD_KEY_RE.test(m[0])) return normalizeVersion(m[1]);
  return null;
}

export function extractVersionFromHtml(html: string, opts: { versionRegex?: string | null } = {}): VersionResult {
  const none = (): VersionResult => ({ version: null, source: 'none', confidence: 'low', needsAiCheck: true, needsBrowser: true, suggestedRegex: null });
  if (!html) return none();

  if (opts.versionRegex) {
    try {
      const re = new RegExp(opts.versionRegex);
      const match = re.exec(html);
      const raw = match ? (match[1] !== undefined ? match[1] : match[0]) : null;
      if (raw) {
        return { version: normalizeVersion(raw), source: 'version_regex', confidence: 'high', needsAiCheck: false, needsBrowser: false, suggestedRegex: opts.versionRegex };
      }
    } catch {
      // 正则无效，继续启发式
    }
  }

  // JSON 响应（如 iTunes lookup / 版本接口）：按命名字段提取，避免把 minimumOsVersion 当产品版本
  const trimmedHtml = html.trim();
  if (trimmedHtml.startsWith('{') || trimmedHtml.startsWith('[')) {
    const jv = extractVersionFromJsonLike(html);
    if (jv) {
      return { version: jv, source: 'json', confidence: 'high', needsAiCheck: false, needsBrowser: false, suggestedRegex: suggestRegex(jv) };
    }
  }

  const urls = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)].map((m) => m[1]).filter((u) => u.startsWith('http') || u.startsWith('/'));
  const downloadUrls = urls.filter(isDownloadUrl);

  const candidates: Array<{ version: string; pattern: 'semver' | 'minor' | 'major'; scope: string }> = [];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const metas = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:title|og:description)["'][^>]*content=["']([^"']*)["']/gi)].map((m) => m[1]).join(' ');
  const structured = extractStructuredText(html);
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const visibleText = `${title}\n${metas}\n${body}`; // 可见文字：真实产品版本必然出现在这里
  // 版本语义关键词：避免把 HTML 属性里的 `v class` 误当版本标记
  const keywordRe = /(?:version|ver\.?\s|release|changelog|download|下载|更新|版本)[^\n]{0,80}/gi;
  const keywordText = [...body.matchAll(keywordRe)].map((m) => m[0]).join('\n');

  const scopes: Array<{ text: string; scope: string }> = [
    { text: `${title}\n${metas}`, scope: 'title' },
    { text: structured, scope: 'json-ld' },
    { text: keywordText, scope: 'body' },
    // 标题区域（h1/h2/h3）：版本常出现在页面主标题/版本号徽章，不依赖关键词前缀
    { text: [...body.matchAll(/<(h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2].replace(/<[^>]+>/g, ' ')).join('\n'), scope: 'heading' },
  ];
  // 噪音上下文：版本号若紧邻这些词（许可证、CSS 类、JS 资源、日期、坐标），不是产品版本
  const NOISE_CTX_RE =
    /(apache|mit|gpl|bsd|mpl|lgpl|cc[\s-]?by|creative\s*commons|license|licen[sc]e|版权|许可|class=|className|py-|px-|mt-|mb-|ml-|mr-|text-|gap-|grid-|flex-|w-|h-|translate|rotate|scale|opacity|stroke|fill|width=|height=|viewBox|d=|points=|javascript|\.js|\.css|\.map|\.json|chunk|webpack|node_modules|\.min\.|src=|href=)([\s"'=:.]{0,4})(v?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3})/gi;
  // 过滤噪音：从各 scope 文本中剔除噪音上下文的版本号
  const noiseFilter = (text: string): string => text.replace(NOISE_CTX_RE, ' ');
  const patterns: Array<{ re: RegExp; name: 'semver' | 'minor' | 'major' }> = [
    { re: SEMVER_RE, name: 'semver' },
    { re: MINOR_RE, name: 'minor' },
    { re: MAJOR_RE, name: 'major' },
  ];
  for (const s of scopes) {
    const filteredText = noiseFilter(s.text);
    for (const p of patterns) {
      for (const m of filteredText.matchAll(p.re)) {
        const raw = m[0];
        if (p.name === 'major' && /^\d{4}$/.test(raw)) continue;
        if (isSuspicious(raw)) continue;
        candidates.push({ version: normalizeVersion(raw), pattern: p.name, scope: s.scope });
      }
    }
  }
  for (const u of urls) {
    // JS/CSS 资源路径中的版本号不是产品版本
    if (/\.(js|css|mjs|cjs|map)(\?|#|$)/i.test(u)) continue;
    const m = u.match(/\bv?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\b/);
    if (m && !isSuspicious(m[0])) candidates.push({ version: normalizeVersion(m[0]), pattern: 'semver', scope: 'url' });
  }

  if (candidates.length === 0) return none();

  const scopeWeight: Record<string, number> = { title: 3, 'json-ld': 3, body: 2, url: 2, heading: 2 };
  const patternWeight: Record<string, number> = { semver: 2, minor: 1, major: 0 };
  // json-ld/结构化数据中的版本是权威命名字段（如 vscode 的 version 字段），额外加权
  const structuredAuthority = new Map<string, number>(); // version -> 加成
  for (const c of candidates) {
    if (c.scope === 'json-ld') structuredAuthority.set(c.version, (structuredAuthority.get(c.version) || 0) + 3);
  }
  const scoreMap = new Map<string, { score: number; inDownloadUrl: boolean; inVisibleText: boolean; scope: string; pattern: string }>();

  for (const c of candidates) {
    const bare = c.version.replace(/^v/i, '');
    let e = scoreMap.get(c.version);
    if (!e) {
      e = { score: 0, inDownloadUrl: false, inVisibleText: false, scope: c.scope, pattern: c.pattern };
      scoreMap.set(c.version, e);
    }
    // 出现在可见正文（真实产品版本必然展示给用户；只出现在 <script>/CDN 链接的是垃圾）
    if (visibleText.includes(bare)) e.inVisibleText = true;
    if (urls.some((u) => u.includes(bare))) e.score += 2;
    if (downloadUrls.some((u) => u.includes(bare))) {
      e.inDownloadUrl = true;
      e.score += 4;
    }
  }
  for (const [key, e] of scoreMap) {
    e.score += scopeWeight[e.scope] || 0;
    e.score += patternWeight[e.pattern] || 0;
    e.score += structuredAuthority.get(key) || 0; // json-ld 权威加成
    const bare = key.replace(/^v/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (html.match(new RegExp(bare, 'g')) || []).length;
    e.score += Math.min(count, 5);
  }

  let bestKey: string | null = null;
  let bestScore = -1;
  for (const [key, e] of scoreMap) {
    if (e.score > bestScore) {
      bestKey = key;
      bestScore = e.score;
    }
  }
  if (!bestKey) return none();
  const bestEntry = scoreMap.get(bestKey)!;

  // L3 版本体系守卫（文档 three-tier-extractor.md P3）：
  // 下载列表页/正文多版本场景（python.org 3.7~3.14、redis.io 7.4/8.2/8.4 等），
  // score 与"出现次数"强相关——旧版本出现多、score 高，但真实最新版是版本号最大的。
  // 判定版本列表场景：≥3 个候选且最高分与次高分接近 → 取"高分中的最大版本"。
  const allCandidates = [...scoreMap.entries()].map(([v, e]) => ({ version: v, score: e.score, inDownloadUrl: e.inDownloadUrl }));
  const sortedByScore = [...allCandidates].sort((a, b) => b.score - a.score);
  const topScore = sortedByScore[0]?.score || 0;
  const secondScore = sortedByScore[1]?.score || 0;
  const isVersionList = allCandidates.length >= 3 && topScore > 0 && secondScore >= topScore * 0.5;
  if (isVersionList) {
    // 从候选池中取"score 达标的最高版本"：从最大版本往下找第一个 score ≥ 最高分 10% 的
    const maxScore = topScore;
    const sortedByVersion = [...allCandidates].sort((a, b) => compareVersions(b.version, a.version));
    let picked = sortedByVersion[0];
    for (const cand of sortedByVersion) {
      if (cand.score >= maxScore * 0.1) { picked = cand; break; }
    }
    if (compareVersions(picked.version, bestKey) > 0) {
      bestKey = picked.version;
      bestScore = picked.score;
    }
  }
  if (!bestKey) return none();
  const bestEntry2 = scoreMap.get(bestKey)!;

  // 置信度：出现在可见正文是"真实版本"的必要条件（标题/json-ld 除外，它们是结构化权威源）
  let confidence: Confidence;
  // 增强：json-ld 来源的版本若未出现在任何下载链接/标题中，很可能是 SDK/依赖版本而非产品版本
  const jsonLdOnly = bestEntry2.scope === 'json-ld' && !bestEntry2.inDownloadUrl && !bestEntry2.inVisibleText;
  const bodyOnly = bestEntry2.scope === 'body' && !bestEntry2.inDownloadUrl && !bestEntry2.inVisibleText;
  // 可见正文门控（文档 L1）：body 来源 + 无下载链接 + 版本号不以 v 开头（如 CSS 类 py-2.5、SVG 坐标 2.5）
  // 真实产品版本几乎总出现在下载链接中或带 v 前缀；裸数字多来自 CSS/JS/图片元数据
  const bodyNoAnchorBare = bestEntry2.scope === 'body' && !bestEntry2.inDownloadUrl && !/^v/i.test(bestKey);
  if (jsonLdOnly) {
    confidence = 'low';
  } else if (bodyOnly || bodyNoAnchorBare) {
    confidence = 'low';
  } else if (bestEntry2.inDownloadUrl && bestEntry2.score >= 7 && bestEntry2.inVisibleText) confidence = 'high';
  else if (bestEntry2.scope === 'title' && bestEntry2.score >= 7) confidence = 'high';
  else if (bestEntry2.scope === 'json-ld' && bestEntry2.score >= 6 && bestEntry2.inDownloadUrl) confidence = 'high';
  else if (bestEntry2.score >= 5 && bestEntry2.inVisibleText) confidence = 'medium';
  else confidence = 'low';

  const matchedIndex = html.indexOf(bestKey.replace(/^v/i, ''));
  return {
    version: bestKey,
    source: bestEntry2.scope,
    confidence,
    needsAiCheck: confidence !== 'high',
    needsBrowser: confidence === 'low', // 低置信/未提取 → 建议 Playwright 渲染后再试
    suggestedRegex: suggestRegex(bestKey),
    matchedContext: matchedIndex >= 0 ? extractContext(html, matchedIndex) : undefined,
    candidates: [...scoreMap.entries()]
      .map(([v, e]) => ({ version: v, score: e.score, inDownloadUrl: e.inDownloadUrl, scope: e.scope }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5),
  };
}

function extractContext(html: string, index: number): string {
  if (index < 0) return '';
  const start = Math.max(0, index - 60);
  const end = Math.min(html.length, index + 60);
  return html.slice(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── 版本比较与交叉校验（无需 AI 的低成本防错）──

export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const cleaned = String(v || '').replace(/^v/i, '').replace(/-.*$/, '').replace(/\+.*$/, '');
    const nums = cleaned.split('.').map((x) => parseInt(x, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return nums;
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function crossCheckVersion(extracted: string | null, currentDbVersion: string | null | undefined) {
  if (!extracted) return { verdict: 'incomparable', reason: '未提取到版本', trustable: false };
  if (!currentDbVersion) return { verdict: 'incomparable', reason: '数据库无当前版本', trustable: true };
  const cmp = compareVersions(extracted, currentDbVersion);
  if (cmp > 0) return { verdict: 'update', reason: `${extracted} > ${currentDbVersion}`, trustable: true };
  if (cmp === 0) return { verdict: 'equal', reason: `${extracted} == ${currentDbVersion}`, trustable: false };
  return { verdict: 'downgrade', reason: `${extracted} < ${currentDbVersion}，疑似提取错误`, trustable: false };
}

export function shouldTrustExtraction(extract: VersionResult, currentDbVersion: string | null | undefined) {
  const cross = crossCheckVersion(extract.version, currentDbVersion);
  if (extract.confidence === 'high' && cross.trustable) return { trust: true, reason: `高置信(${extract.source}) + ${cross.reason}`, needsAiCheck: false };
  if (extract.confidence === 'high' && cross.verdict === 'incomparable') return { trust: true, reason: `高置信(${extract.source})，无当前版本可比`, needsAiCheck: false };
  if (extract.confidence === 'high' && !cross.trustable) return { trust: false, reason: `高置信但交叉校验异常(${cross.reason})`, needsAiCheck: true };
  return { trust: false, reason: `${extract.confidence}置信(${extract.source}) + ${cross.reason}，需 AI 复核`, needsAiCheck: true };
}
