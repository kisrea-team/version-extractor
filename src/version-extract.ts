// 版本号提取模型 v2（规则化，不依赖 LLM）
//
// 核心原则：真实版本号会【反复出现】—— 标题、meta、下载链接、正文多处。
// 垃圾版本（JS 资产、构建号）只出现一次、不在下载链接里。
//
// 评分 = 范围权重 + 精度权重 + 出现次数 + 是否在页面URL中 + 是否在下载链接中
// 只有高置信才可免 AI 直接写入；中/低置信必须升级到 AI 复核。
import { coerce, compare } from 'semver';
import type { Confidence, VersionResult } from './types';

const SEMVER_RE =
  /(?<![0-9.])v?(0|[1-9]\d*|\d*[0-9])\.(0|[1-9]\d*|\d*[0-9])\.(0|[1-9]\d*|\d*[0-9])(?:-(?:alpha|beta|rc|pre|patch)[0-9.]*)?(?:[+][0-9A-Za-z.-]+)?(?![0-9])/g;
const MINOR_RE = /(?<![0-9.])v?(0|[1-9]\d*|\d*[0-9])\.(0|[1-9]\d*|\d*[0-9])(?![0-9.])/g;
const MAJOR_RE = /\bv(0|[1-9]\d*|\d*[0-9])\b/g;

/** 剥离版本号前缀污染: npm 包名(@scope/pkg@1.2.3 / pkg@1.2.3) + 分支前缀(desktop-v0.0.11 / app-v2.6.5)
 * 保留纯 semver。不误伤: release.2026-08-10(日期)、3.19.0-0.1.pre(预发布)、b10355(构建号) */
export function stripVersionPrefix(raw: string): string {
  let t = raw.trim();
  // @scope/pkg@1.2.3 → 1.2.3
  t = t.replace(/^@?[\w.-]+(?:\/[\w.-]+)?@(?=\d)/, '');
  // pkg@1.2.3 → 1.2.3(无 scope 形式, 如 n8n@2.33.7)
  t = t.replace(/^[\w.-]+@(?=\d)/, '');
  // desktop-v0.0.11 → v0.0.11(必须紧跟 v, 不带 v 的是日期不剥)
  t = t.replace(/^[a-z][\w.-]*?-(?=v\d)/i, '');
  return t;
}

function normalizeVersion(raw: string): string {
  const t = stripVersionPrefix(raw);
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

// 版本序列检测：识别"Android 8/9/10/.../17"这类【相同前缀词 + 连续数字】的版本序列。
// 只在语义列举区（<nav> 导航 + h1-h6 标题）提取。按前缀词分组，同前缀 ≥3 个不同数字才成序列。
// 这比裸数字扫描严谨：php/bitwarden/sketch 的无前缀或年份数字不会误判。
export function detectVersionSequence(html: string): { latest: string; series: string[] } | null {
  // 语义区：导航 + 标题区
  const navText = [...html.matchAll(/<nav[\s\S]*?<\/nav>/gi)].map((m) => m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).join(' ');
  const headText = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) => m[1].replace(/<[^>]+>/g, ' ').trim()).join(' ');
  const semantic = `${navText} ${headText}`;
  // 前缀不能是月份词：标题里 "Fixed in 8.21.0 - June 24 2026" 会把日期天数当版本序列
  const MONTH_RE = /^(?:january|february|march|april|may|june|july|august|september|october|november|december|一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月)$/;
  // 分组：key = 前缀（有产品前缀时按前缀分；无前缀的裸版本号归到空组）
  // 支持两种 changelog 结构：
  //   ① 有前缀：Android 8/9/.../17、go1.26、Version 1.1/1.2/1.8
  //   ② 无前缀：标题就是裸版本号（insomnia 8.5.0/8.4.5/...、2023.5.8 等）
  const groups = new Map<string, Set<string>>();
  // 有前缀的版本号。前缀词必须是纯字母产品名（go/Android/Version/v），
  // 版本号可带 rc/beta/alpha 后缀（go1.7rc6 → 前缀 go，版本 1.7rc6）。
  // 前缀不能含数字——否则 go1.7rc 会被当成前缀、6 当版本，rc1..rc6 凑成假序列。
  const prefixedRe = /\b([A-Za-z]+[\s-]*?)(?:v|version|版本|ver\.?)?[\s:]*(\d+(?:\.\d+){0,3}(?:[-.]?(?:rc|beta|alpha|pre|patch)\d*)?)\b/gi;
  for (const m of semantic.matchAll(prefixedRe)) {
    const prefix = m[1].trim().toLowerCase();
    const ver = m[2];
    if (prefix.length > 20) continue;
    if (MONTH_RE.test(prefix)) continue;
    if (!isSequenceVersion(ver)) continue;
    if (!groups.has(prefix)) groups.set(prefix, new Set());
    groups.get(prefix)!.add(ver);
  }
  // 裸版本号：标题/导航里独立出现的版本号（无前缀）。要求含小数点（版本号特征，排除年份/章节/页码）。
  const bareRe = /(?<![A-Za-z0-9.])(v?)(\d+\.\d+(?:\.\d+)?)(?![A-Za-z0-9.])/g;
  for (const m of semantic.matchAll(bareRe)) {
    const ver = m[2];
    if (!isSequenceVersion(ver)) continue;
    // 归入空前缀组（所有裸版本号共同构成一个潜在序列）
    if (!groups.has('')) groups.set('', new Set());
    groups.get('')!.add(ver);
  }
  // 找序列：≥3 个版本号 + 单调（递增或递减）+ 密度达标，取版本号最大者。
  // 版本号用 semver.coerce 归一化（1.20 → 1.20.0），解决 go 页面 1.26.5/1.20 段数不一致问题。
  let best: { latest: string; series: string[] } | null = null;
  for (const [prefix, versions] of groups) {
    if (versions.size < 3) continue;
    // 段数接近（coerce 前检查）：同一系列版本段数差 ≤1。
    // go 的 1.20(2段)/1.26.5(3段) 是同系列（缺 patch 补零），允许混；
    // v1.1(2段)/v2(1段) 段数差 1 但主版本不同（1 vs 2），不是同系列。
    // 用"主版本相同 或 段数完全一致"约束：1.20/1.26.5 主版本都是 1，混；
    // v1.1/v2 主版本 1 vs 2 不同且段数也不同 → 分开。
    const majors = new Set([...versions].map((v) => parseInt(v.split('.')[0], 10)));
    const segs = new Set([...versions].map((v) => v.split('.').length));
    const sameMajor = majors.size === 1;
    const sameSeg = segs.size === 1;
    if (!sameMajor && !sameSeg) continue; // 主版本不同且段数不同 → 非同一系列
    // coerce 归一化（rc/beta → 正式版，段数补齐），去重后版本数仍 ≥3 才成序列
    const normed = new Map<string, string>(); // coerce版本 → 原始版本（保留原形输出）
    for (const v of versions) {
      const c = coerce(v)?.version;
      if (c && !normed.has(c)) normed.set(c, v);
    }
    if (normed.size < 3) continue;
    // 排序用 coerce 版本（补零后 1.20.0 < 1.26.5 正确），输出保留原始版本号
    const sorted = [...normed.entries()].sort((a, b) => compare(a[0], b[0]));
    const latest = sorted[sorted.length - 1][1];
    const first = sorted[0][1];
    // 连续性：版本序列覆盖大部分主版本区间（密度判定）。
    // 不检查原始顺序单调性——真实版本列表排序不可预测（正序/倒序/最新优先+归档倒序，
    // go 页面是 1.26.5,1.25.12,1.27rc2,1.26.4... 混合），同前缀+主版本集中+密度达标已足够。
    const majorOf = (v: string) => parseInt(v.split('.')[0], 10) || 0;
    const span = majorOf(latest) - majorOf(first);
    const density = span === 0 ? 1 : sorted.length / (span + 1);
    if (density < 0.3) continue;
    const latestCoerced = coerce(latest)?.version || latest;
    if (!best || compare(latestCoerced, coerce(best.latest)?.version || best.latest) > 0) {
      best = { latest, series: sorted.map((s) => s[1]) };
    }
  }
  if (!best) return null;
  return { latest: `v${best.latest}`, series: best.series.map((n) => `v${n}`) };
}

// 版本序列的版本号合法性：首段 1~99（排除年份/大数），非年份式
function isSequenceVersion(v: string): boolean {
  const major = parseInt(v.split('.')[0], 10) || 0;
  if (major < 1 || major > 99) return false;
  if (major >= 1900 && major <= 2100) return false; // 年份
  return true;
}

function extractStructuredText(html: string): string {
  const parts: string[] = [];
  // JSON-LD 不再作为版本候选来源：SoftwareApplication 的 ld+json 里通常只有
  // ratingValue（评分）、price（价格）、reviewCount 等非版本数字（CleanShot 的 4.9 是评分不是版本），
  // 全文本扫描噪音远大于信号；且 JSON-LD 是写给搜索引擎的元数据，维护度低、可信度不如正文。
  // 仅保留 __NEXT_DATA__ / __INITIAL_STATE__ 中显式 version 命名字段（语义明确，非全文本扫描）。
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
  // JSON Feed 格式(obsidian.md/changelog.json 等): 顶层 version 是规范 URL("https://jsonfeed.org/version/1.1"),
  // items 数组才是版本条目(最新在前)。识别后取 items[0] 的 id/title 里的版本号。
  if (/"items"\s*:\s*\[/.test(json) && /"feed_url"|"home_page_url"/.test(json)) {
    const item = json.match(/"items"\s*:\s*\[\s*\{([\s\S]*?)\}\s*,/);
    if (item) {
      const m = item[1].match(/(?:id|title|url)["']\s*:\s*["']([^"']*?v?\d+\.\d+[^"']*)["']/i);
      if (m) {
        const vm = m[1].match(/(?:v)?(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)/);
        if (vm && !/^\d{4}[-.]\d{2}[-.]\d{2}/.test(vm[1])) return normalizeVersion(vm[1]);
      }
    }
  }
  // 优先精确 version 键（产品版本）——排除值为 URL 的（JSON Feed 规范版本等）
  // ⚠️ 取所有 version 字段里数值最大的: PyCharm JSON {"PCC":[...version:2025.3], "PCP":[...version:2026.2.0.1]}
  // 多产品分支时第一个 version 是 Community(旧), 期望是 Professional(新)——最新版本通常是最大数值
  const exactAll = [...json.matchAll(/["']version["']\s*:\s*["']([^"']{1,30})["']/gi)]
    .map((m) => ({ raw: m[1].trim(), full: m[0] }))
    .filter((m) => !BAD_KEY_RE.test(m.full) && !/^https?:/.test(m.raw) && /\d/.test(m.raw) && !/^\d{4}[-.]\d{2}[-.]\d{2}/.test(m.raw));
  if (exactAll.length > 0) {
    const best = exactAll.sort((a, b) => {
      const av = a.raw.replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
      const bv = b.raw.replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
      for (let i = 0; i < 4; i += 1) {
        const ai = av[i] || 0, bi = bv[i] || 0;
        if (ai !== bi) return bi - ai;
      }
      return 0;
    })[0];
    return normalizeVersion(best.raw);
  }
  // 其他命名字段（排除 BAD）
  const m = json.match(/["'](?:appVersion|latestVersion|releaseVersion|currentVersion|stableVersion|newVersion)["']\s*:\s*["']([^"']{1,30})["']/i);
  if (m && !BAD_KEY_RE.test(m[0])) return normalizeVersion(m[1]);
  // GitLab/GitHub release tag 格式: "name":"INKSCAPE_1_4_4" / "v1.2.3-rc1" / "release-1.4.4"
  // ⚠️ 只收"下划线/连字符分隔的数字段"或 v 前缀版本形态, 不收普通产品名("Inkscape")
  const tag = json.match(/["'](?:name|tag_name|tagName)["']\s*:\s*["']([A-Za-z]*_?\d+_\d+(?:_\d+)*|v\d+\.\d+(?:\.\d+)*[^"']*|release[-_]\d+\.\d+(?:\.\d+)*)["']/i);
  if (tag) {
    const cleaned = tag[1].replace(/^[A-Za-z]+_/i, '').replace(/_/g, '.').replace(/^release[-_]/i, '');
    const vm = cleaned.match(/(?:v)?(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)/);
    if (vm && !/^\d{4}[-.]\d{2}[-.]\d{2}/.test(vm[1])) return normalizeVersion(vm[1]);
  }
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

  // 版本序列检测：页面出现 "Android 8/9/.../17"（相同前缀词 + 连续数字）→ 候选主版本 = 数值最大
  // 不短路：作为候选加入正常评分，避免覆盖下载链接/标题里的正确版本
  const seq = detectVersionSequence(html);
  const seqLatest: string | null = seq ? seq.latest : null;

  const urls = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)].map((m) => m[1]).filter((u) => u.startsWith('http') || u.startsWith('/'));
  const downloadUrls = urls.filter(isDownloadUrl);

  const candidates: Array<{ version: string; pattern: 'semver' | 'minor' | 'major'; scope: string }> = [];
  // 纯文本 CHANGES 页的版本标题是最强语义锚点（"Changes with nginx 1.31.3" / "Fixed in 8.21.0"）。
  // 只匹配强标题结构；"Changelog 9.3.3" 这种普通词会误匹配 commit 文案（update changelog 9.3.3）。
  for (const m of html.matchAll(
    /(?:Changes?\s+with\s+[^\s<]+\s+|Fixed\s+in\s+)[\s]*v?(\d+(?:\.\d+){1,3})(?=\s|<|$)/gi
  )) {
    const raw = m[1];
    if (!isSuspicious(raw)) candidates.push({ version: normalizeVersion(raw), pattern: 'semver', scope: 'changelog-header' });
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const metas = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:title|og:description)["'][^>]*content=["']([^"']*)["']/gi)].map((m) => m[1]).join(' ');
  const structured = extractStructuredText(html);
  // 正文候选只看标签之间的文本；HTML 属性中的尺寸、资源路径、file-types 等不是页面可见版本信息。
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const visibleText = `${title}\n${metas}\n${body}`; // 可见文字：真实产品版本必然出现在这里
  // 版本语义关键词：避免把 HTML 属性里的 `v class` 误当版本标记
  const keywordRe = /(?:version|ver\.?\s|release|changelog|download|下载|更新|版本)[^\n]{0,80}/gi;
  const keywordText = [...body.matchAll(keywordRe)].map((m) => m[0]).join('\n');

  const scopes: Array<{ text: string; scope: string }> = [
    { text: `${title}\n${metas}`, scope: 'title' },
    { text: structured, scope: 'structured' },
    { text: keywordText, scope: 'body' },
    // 标题区域（h1/h2/h3）：版本常出现在页面主标题/版本号徽章，不依赖关键词前缀
    { text: [...body.matchAll(/<(h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2].replace(/<[^>]+>/g, ' ')).join('\n'), scope: 'heading' },
  ];
  // 噪音上下文：版本号若紧邻这些词（许可证、CSS 类、JS 资源、日期、坐标、系统要求），不是产品版本。
  // 系统要求（macOS 10.15 / iOS 15 / Windows 11）是平台版本不是软件版本。
  // macOS 代号(Tahoe/Sequoia/Sonoma/Ventura/Monterey/Big Sur 等)后跟版本号也是系统版本
  const NOISE_CTX_RE =
    /(apache|mit|gpl|bsd|mpl|lgpl|cc[\s-]?by|creative\s*commons|license|licen[sc]e|版权|许可|class=|className|py-|px-|mt-|mb-|ml-|mr-|text-|gap-|grid-|flex-|w-|h-|translate|rotate|scale|opacity|stroke|fill|width=|height=|viewBox|d=|points=|javascript|\.js|\.css|\.map|\.json|chunk|webpack|node_modules|\.min\.|src=|href=|macOS|mac\s?os|ios|iphone|ipad|watchos|tvOS|windows|android|linux|ubuntu|debian|centos|minimum|最低|或更高|or later|and higher|compatible|Tahoe|Sequoia|Sonoma|Ventura|Monterey|Big\s*Sur|Catalina|Mojave|High\s*Sierra|Sierra|El\s*Capitan|Yosemite|Mavericks|Mountain\s*Lion|Lion|Snow\s*Leopard|Leopard|Tiger|Panther|Jaguar|Puma|Cheetah)([\s"'=:.]{0,6})(v?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3})/gi;
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
    // changelog 详情 URL 单独作为高权重语义候选处理，避免先被普通 URL 候选占位。
    if (/\/changelog\//i.test(u)) continue;
    // JS/CSS 资源路径中的版本号不是产品版本
    if (/\.(js|css|mjs|cjs|map)(\?|#|$)/i.test(u)) continue;
    const m = u.match(/\bv?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\b/);
    if (m && !isSuspicious(m[0])) candidates.push({ version: normalizeVersion(m[0]), pattern: 'semver', scope: 'url' });
  }
  // 版本序列候选：作为 heading 来源参与评分（序列版本出现在导航/标题区）
  if (seqLatest) {
    candidates.push({ version: seqLatest, pattern: 'major', scope: 'heading' });
  }

  // changelog 详情 URL 中的版本是产品版本强信号（如 Obsidian /changelog/...-v1.13.4/）。
  for (const u of urls) {
    const m = u.match(/\/changelog\/[^"'\s>]*[-_/]v(\d+(?:\.\d+){1,3})/i);
    if (m && !isSuspicious(m[1])) candidates.push({ version: normalizeVersion(m[1]), pattern: 'semver', scope: 'changelog-url' });
  }

  if (candidates.length === 0) return none();

  const scopeWeight: Record<string, number> = { title: 3, structured: 3, body: 2, url: 2, heading: 2, 'changelog-header': 8, 'changelog-url': 14 };
  const patternWeight: Record<string, number> = { semver: 2, minor: 1, major: 0 };
  // structured/命名字段中的版本是权威信号（如 vscode 的 version 字段），额外加权
  const structuredAuthority = new Map<string, number>(); // version -> 加成
  for (const c of candidates) {
    if (c.scope === 'structured') structuredAuthority.set(c.version, (structuredAuthority.get(c.version) || 0) + 3);
  }
  const scoreMap = new Map<string, { score: number; inDownloadUrl: boolean; inVisibleText: boolean; scope: string; pattern: string; contexts: Set<string> }>();

  for (const c of candidates) {
    const bare = c.version.replace(/^v/i, '');
    let e = scoreMap.get(c.version);
    if (!e) {
      e = { score: 0, inDownloadUrl: false, inVisibleText: false, scope: c.scope, pattern: c.pattern, contexts: new Set() };
      scoreMap.set(c.version, e);
    }
    // 上下文多样性：同一个版本出现在多少个不同上下文（标题/meta/json-ld/正文/标题区块/URL）
    // 产品版本跨多个上下文反复出现；构建号/库版本只在一处 → 多样性是"语义版本 vs 构建号"的强判别
    e.contexts.add(c.scope);
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
    // 上下文多样性加成：每个额外出现的上下文 +2（语义版本多上下文胜出，构建号单上下文落败）
    e.score += Math.max(0, e.contexts.size - 1) * 2;
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

  // changelog-header 权威覆盖：页面存在版本标题（"Changes with nginx 1.31.3" / "Fixed in 8.21.0"）时，
  // 标题里的版本号是权威语义锚点，选数值最大者（版本标题从新到旧排列，最大 = 最新）。
  // 只在标题版本 ≥ 当前最佳时才覆盖——避免 commit 文案里的 "changelog 9.3.3" 误匹配压过真实最新版 11.3.0。
  const headerCandidates = [...scoreMap.entries()]
    .filter(([, e]) => e.scope === 'changelog-header')
    .map(([v, e]) => ({ version: v, score: e.score }));
  if (headerCandidates.length > 0) {
    const latestHeader = [...headerCandidates].sort((a, b) => compareVersions(b.version, a.version))[0];
    if (bestKey && compareVersions(latestHeader.version, bestKey) > 0) {
      bestKey = latestHeader.version;
      bestScore = latestHeader.score;
    } else if (!bestKey) {
      bestKey = latestHeader.version;
      bestScore = latestHeader.score;
    }
  } else {
  // L3 版本体系守卫（文档 three-tier-extractor.md P3）：
  // 下载列表页/正文多版本场景（python.org 3.7~3.14、redis.io 7.4/8.2/8.4 等），
  // score 与"出现次数"强相关——旧版本出现多、score 高，但真实最新版是版本号最大的。
  // 判定版本列表场景：≥3 个候选且最高分与次高分接近 → 取"高分中的最大版本"。
  const allCandidates = [...scoreMap.entries()].map(([v, e]) => ({ version: v, score: e.score, inDownloadUrl: e.inDownloadUrl, scope: e.scope }));
  const sortedByScore = [...allCandidates].sort((a, b) => b.score - a.score);
  const topScore = sortedByScore[0]?.score || 0;
  const secondScore = sortedByScore[1]?.score || 0;
  const isVersionList = allCandidates.length >= 3 && topScore > 0 && secondScore >= topScore * 0.5;
  if (isVersionList) {
    // 从候选池中取"score 达标的最高版本"：从最大版本往下找第一个分数达标者。
    // 关键：候选必须在下载链接中，或分数接近最高分——否则 IP 地址（127.0.0）、构建号等
    // "数值大、分数低"的假版本会被误选（nodejs 页面正文里的 127.0.0.1 是本地回环地址）。
    const maxScore = topScore;
    const sortedByVersion = [...allCandidates].sort((a, b) => compareVersions(b.version, a.version));
    let picked: (typeof sortedByVersion)[0] | null = null;
    for (const cand of sortedByVersion) {
      const qualifies = cand.inDownloadUrl || cand.score >= maxScore * 0.7;
      if (qualifies) { picked = cand; break; }
    }
    if (picked && compareVersions(picked.version, bestKey) > 0) {
      bestKey = picked.version;
      bestScore = picked.score;
    }
  }
  const changelogCandidates = allCandidates.filter((c) => c.scope === 'changelog-url');
  if (changelogCandidates.length > 0) {
    const latestChangelog = [...changelogCandidates].sort((a, b) => compareVersions(b.version, a.version))[0];
    bestKey = latestChangelog.version;
    bestScore = latestChangelog.score;
  }
  }
  if (!bestKey) return none();
  const bestEntry2 = scoreMap.get(bestKey)!;

  // 置信度：出现在可见正文是"真实版本"的必要条件（标题/structured 除外，它们是结构化权威源）
  let confidence: Confidence;
  // 增强：structured（命名字段）来源的版本若未出现在任何下载链接/标题中，很可能是 SDK/依赖版本而非产品版本
  const structuredOnly = bestEntry2.scope === 'structured' && !bestEntry2.inDownloadUrl && !bestEntry2.inVisibleText;
  const bodyOnly = bestEntry2.scope === 'body' && !bestEntry2.inDownloadUrl && !bestEntry2.inVisibleText;
  // 可见正文门控（文档 L1）：body 来源 + 无下载链接 + 版本号不以 v 开头（如 CSS 类 py-2.5、SVG 坐标 2.5）
  // 真实产品版本几乎总出现在下载链接中或带 v 前缀；裸数字多来自 CSS/JS/图片元数据
  const bodyNoAnchorBare = bestEntry2.scope === 'body' && !bestEntry2.inDownloadUrl && !/^v/i.test(bestKey);
  if (structuredOnly) {
    confidence = 'low';
  } else if (bodyOnly || bodyNoAnchorBare) {
    confidence = 'low';
  } else if (bestEntry2.inDownloadUrl && bestEntry2.score >= 7 && bestEntry2.inVisibleText) confidence = 'high';
  else if (bestEntry2.scope === 'title' && bestEntry2.score >= 7) confidence = 'high';
  else if (bestEntry2.scope === 'structured' && bestEntry2.score >= 6 && bestEntry2.inDownloadUrl) confidence = 'high';
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
