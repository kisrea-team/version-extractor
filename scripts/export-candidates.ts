/**
 * 候选标注导出 —— 为 BERT 分类器生成干净的候选 + 上下文样本。
 *
 * 正样本来自活标注；明确的 build/SDK/OS/CSS/SVG 噪声是负样本；
 * changelog/RSS 中无法确定是否为当前产品版本的候选不参与训练。
 */
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

// 候选正则：放宽版本号前边界（允许 go1.26.5 / blender-5.2 这类产品前缀），
// 但禁止前一个字符是数字/点（避免从 11.26.5 / 0.1.26.5 截出子串）。
// 尾部 lookahead 排除数量单位（k/K/m/M/b/B）：GitHub star 数 "89.3k"、下载量 "1.2M"
// 会假扮版本号（hugo 页面的 "Star 89315 89.3k" 曾把 v89.3 当版本）。
const SEMVER_RE = /(?<![0-9.])v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?(?![0-9kKmMbB])/g;
const MINOR_RE = /(?<![0-9.])v?(0|[1-9]\d*)\.(0|[1-9]\d*)(?![0-9.\s][kKmMbB])/g;
// MAJOR 仅匹配带 v 前缀的（避免把年份/数字当版本）；用于对比时让 BERT 候选池覆盖 v153 这类主版本号
const MAJOR_RE = /\bv(0|[1-9]\d*)\b/g;
// 带产品前缀的单段版本：Chrome 151 / Firefox 153 / Opera 134。
// 浏览器类产品 release-notes 用 "Chrome 151" 而非 "v151"，前缀给了单段数字语义。
// 只匹配 3 位数字（\d{3} 后跟非数字 → 天然排除 "Chrome 2025" 这种 4 位年份，
// 也排除 "Step 31"/"Part 13" 这类 2 位噪声——浏览器单段版本都是 3 位）。
const PREFIXED_MAJOR_RE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9-]{1,15})\s+v?(\d{3})(?![\d.])/g;
// 前缀 STOP 词：非产品名的通用词（Download/Release/Star 等），避免 "Star 89" 被当版本
const PREFIXED_MAJOR_STOP = new Set([
  'version', 'ver', 'release', 'releases', 'download', 'downloads', 'build', 'changelog', 'update', 'updates',
  'news', 'page', 'chapter', 'step', 'issue', 'issues', 'star', 'stars', 'section', 'date', 'new', 'old',
  'latest', 'current', 'stable', 'beta', 'alpha', 'preview', 'archive', 'category', 'article', 'item', 'entry',
  'part', 'row', 'col', 'line', 'number', 'no', 'testing', 'test', 'channel', 'stable', 'canary', 'dev', 'beta',
]);
// 标准/规范/协议/OS 名 + 版本号（WCGA 2.0 / APCA 3.0 / HTML 5 / macOS 15）不是产品版本。
// 也放许可证名（ShareAlike 4.0 / Attribution 4.0 / CC 4.0）：GIMP 页的 "Creative Commons
// Attribution-ShareAlike 4.0" 会提取出 v4.0 干扰 v3.2，且许可证名是有限集合，可靠。
// 用于 SEMVER/MINOR 匹配前的"最近前一词"检查：shottr 的 "WCGA 2.0" 会提取出 v2.0 干扰 v1.9.1。
// 只放确凿的标准/OS/许可证名；产品名（PHP/nginx/mysql 等）不在此列，它们的版本要保留。
// 也放 AI 模型名：windsurf 页面 "GPT-4.1"/"GPT-5.6"/"o4-mini" 的模型版本不是 Windsurf 应用版本。
const STANDARD_PREFIX_STOP = new Set([
  'wcag', 'wcga', 'apca', 'aac', 'html', 'css', 'xml', 'xhtml', 'json', 'http', 'https', 'tls', 'ssl', 'usb', 'bluetooth',
  'mpeg', 'mp3', 'mp4', 'pdf', 'dpi', 'fps', 'lts', 'sdk', 'api', 'oauth', 'openid', 'jwt', 'svg', 'png', 'jpeg',
  'gif', 'tiff', 'avif', 'webp', 'macos', 'mac', 'osx', 'windows', 'win', 'linux', 'ios', 'android', 'iphone',
  'ipad', 'watchos', 'tvos', 'directx', 'opengl', 'vulkan', 'sql',
  // 许可证名（有限集合，可靠）：ShareAlike 4.0 / Attribution 4.0 / CC BY 4.0 / CC by-sa 4.0
  'sharealike', 'attribution', 'creative', 'cc', 'by', 'sa',
  // 许可证 URL（gpl-2.0.en.html / License version 2.0）不是产品版本
  'gpl', 'lgpl', 'agpl', 'mpl', 'bsd', 'mit', 'license', 'licence', 'licenses', 'licences',
  // AI 模型名 + 版本（GPT-4.1 / GPT-5.6 / Claude 4 / Gemini 2.5 / Llama 3）不是软件产品版本
  'gpt', 'claude', 'gemini', 'llama', 'mistral', 'o3', 'o4', 'devin', 'copilot', 'sonnet', 'opus', 'haiku',
  'deepseek', 'qwen', 'grok', 'command', 'falcon', 'phi',
  // 库/框架/平台名 + 版本号（Sparkle 1.13.1 / FontAwesome 7.2.0）不是产品版本
  'sparkle', 'fontawesome',
]);

// 版本号匹配位置前最近的字母词是否为标准名/模型名（WCGA 2.0 → wcag；GPT-4.1 → gpt）
// 用 split 按分隔符拆分，检查所有词：CC by-sa 4.0 → ["CC","by","sa"] → "cc" 在 STOP。
function hasStandardPrefix(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 30), index);
  const words = before.toLowerCase().split(/[\s_\/-]+/);
  return words.some((w) => STANDARD_PREFIX_STOP.has(w));
}
const VERSION_FIELD_RE = /["'](version|versionNumber|latestVersion|releaseVersion|appVersion|pkgVersion|softwareVersion|productVersion|currentVersion|stableVersion|newVersion|semanticVersion|tag_name|tagName)["']\s*:\s*["']([^"']{1,40})["']/gi;
const SEMANTIC_SCRIPT_RE = /["'](?:modelUpgradeNotice|releaseNote|releaseNotes|releaseTitle|latestRelease|productTitle|title)["']\s*:\s*["']([^"']{1,240})["']/gi;
const NOISE_RE = /(?:build(?:Number|_number|\s*number)?|minimumOsVersion|minimum_os_version|sdkVersion|sdk_version|apiVersion|api_version|schemaVersion|protocolVersion|viewBox|line-height|font-size|semanticVersion|node_modules|webpack|chunk|\.css|\.js|\.map|svg|asset|bundle|internal version|revision|commit)/i;
const PAGE_VERSION_RE = /(?:changelog|change-log|release|releases|history|updates?|version|rss|feed|download|changes|product_history)/i;
const STRUCTURED_ENDPOINT_RE = /(?:registry\.npmjs\.org|open-vsx\.org\/api|itunes\.apple\.com\/lookup|api\.)/i;

type Scope = 'title' | 'meta' | 'heading' | 'visible' | 'download-link' | 'structured' | 'noise';
type Context = { text: string; scope: Scope };
type Candidate = { version: string; contexts: Context[]; tag?: string; paths?: string[] };
type Sample = {
  text: string;
  label: 0 | 1 | 'unknown';
  version: string;
  url: string;
  scopes: Scope[];
  labelReason: string;
};

export function norm(v: string): string {
  const t = v.trim();
  return /^v/i.test(t) ? t : `v${t}`;
}

// 版本号净化：SEMVER_RE 允许 [-+][0-9A-Za-z.-]+ 后缀，会把下载文件名当版本
// （php 的 8.5.9-src.zip → 应归一为 8.5.9）。只保留数字+点前缀，去掉后缀/字母段。
export function purifyVersion(raw: string): string {
  const text = String(raw || '');
  // 保留常见预发布标记，避免 1.27rc2 被折叠为 1.27；源码包/文件扩展名仍被截掉。
  const m = text.match(/v?\d+(?:\.\d+){0,3}(?:(?:-|\.)?(?:alpha|beta|rc|pre|dev|patch)\d*)?/i);
  return m ? m[0] : text;
}

function cleanText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function snippet(text: string, index: number, width = 180): string {
  const start = Math.max(0, index - Math.floor(width / 2));
  return cleanText(text.slice(start, Math.min(text.length, start + width)));
}

function addMatch(out: Map<string, Candidate>, raw: string, context: string, scope: Scope): void {
  const version = norm(purifyVersion(raw)); // 净化：8.5.9-src.zip → v8.5.9
  if (!context || /^(?:v?\d{4}[-.]\d{2}[-.]\d{2})$/.test(version)) return;
  const candidate = out.get(version) || { version, contexts: [] };
  if (!candidate.contexts.some((c) => c.scope === scope && c.text === context)) candidate.contexts.push({ text: context, scope });
  out.set(version, candidate);
}

function addMatches(out: Map<string, Candidate>, text: string, scope: Scope, includeMajor = false): void {
  const res: RegExp[] = includeMajor && scope !== 'visible' ? [SEMVER_RE, MINOR_RE, MAJOR_RE] : [SEMVER_RE, MINOR_RE];
  for (const re of res) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      // 标准/协议名前缀（WCGA 2.0 / macOS 15 / HTML 5）不是产品版本，剔除
      if (hasStandardPrefix(text, match.index || 0)) continue;
      addMatch(out, match[0], snippet(text, match.index || 0), scope);
    }
  }
  // 带产品前缀的单段版本（Chrome 151 / Firefox 153）：前缀给了单段数字"这是产品版本"的语义，
  // 所以 visible 正文也接受；前缀在 STOP 集合（Download/Star/Release 等）里时拒绝。
  if (scope !== 'noise') {
    PREFIXED_MAJOR_RE.lastIndex = 0;
    for (const match of text.matchAll(PREFIXED_MAJOR_RE)) {
      if (PREFIXED_MAJOR_STOP.has(match[1].toLowerCase())) continue;
      addMatch(out, match[2], snippet(text, match.index || 0), scope);
    }
  }
}

// SVG 块清理：只保留块内可见文本（<text>/<title>/<desc>/<tspan> 内容），
// 删掉所有坐标/路径/渐变/stop 等数值元素——它们才是版本候选的噪音来源
// （nodejs 页面的内联 SVG 会产生上千个 v0.64/v44.7 这类坐标候选）。
// 保留文本是因为真实产品版本可能写在 SVG 文字里（如 logo 里的版本号）。
function stripSvgToText(html: string): string {
  return html.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svg) => {
    const texts = [...svg.matchAll(/<(?:text|title|desc|tspan)\b[^>]*>([\s\S]*?)<\/(?:text|title|desc|tspan)>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return texts.length ? ` ${texts.join(' ')} ` : ' ';
  });
}

// 许可证版本噪声：GPL 3.0 / Apache 2.0 / MIT 2.0 等许可证号会假扮产品版本
// （arduino 的 "GPL 3.0 License" 提取出 v3.0、prometheus 的 "Apache 2.0 License" 提取出 v2.0）。
// 只删带 License 词的，避免误删 "Apache 2.4.68" 这类真产品版本。
const LICENSE_VERSION_RE = /(?:gpl|lgpl|agpl|mpl|bsd|mit|apache|cc)\s*v?\d+(?:\.\d+){0,2}\s+licen[sc]e|v?\d+(?:\.\d+){0,2}\s+licen[sc]e\b/gi;

export function collectCandidates(html: string, includeMajor = false): Candidate[] {
  html = stripSvgToText(html);
  // 全量剔除许可证版本：必须在 <a> 标签循环/visible 提取之前，否则 anchor 里也会提出版本
  html = html.replace(LICENSE_VERSION_RE, ' ');
  const out = new Map<string, Candidate>();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  addMatches(out, cleanText(title), 'title', includeMajor);

  for (const match of html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:title|og:description|twitter:title)["'][^>]*content=["']([^"']*)["'][^>]*>/gi)) {
    addMatches(out, cleanText(match[1]), 'meta', includeMajor);
  }

  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => cleanText(m[1])).join(' ');
  addMatches(out, headings, 'heading', includeMajor);

  const withoutNoise = html
    .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // 许可证版本已在 collectCandidates 开头对全量 html 剔除，这里无需重复
  const visible = cleanText(withoutNoise);
  addMatches(out, visible, 'visible', includeMajor);

  // HTML 属性中的版本 JSON：许多下载站把版本藏在 data-* 属性的转义 JSON 里
  // （如 &quot;versionNumber&quot;:&quot;15.80.4&quot;）。visible 去标签后属性被丢弃。
  // 只提取【命名字段附近】的版本（version/latestVersion/versionNumber 等），
  // 避免把 data 属性里的 SVG 路径/坐标/JS 依赖当版本。
  const ATTR_VERSION_FIELD_RE = /["'](?:version|latestVersion|versionNumber|releaseVersion|appVersion|currentVersion|stableVersion|newVersion|softwareVersion|productVersion)["']\s*:\s*["']([^"']{1,40})["']/gi;
  for (const tag of html.matchAll(/<[^>]+>/g)) {
    const decoded = tag[0].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'");
    for (const field of decoded.matchAll(ATTR_VERSION_FIELD_RE)) {
      addMatches(out, field[1], 'structured', includeMajor);
    }
  }
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1];
    const href = attrs.match(/href=["']([^"']*)["']/i)?.[1] || '';
    const anchor = cleanText(`${match[2]} ${href}`);
    if (!anchor) continue;
    const scope: Scope = /download|release|\.((?:zip|dmg|exe|msi|pkg|tar\.gz))(?:[?#]|$)/i.test(href) ? 'download-link' : 'visible';
    addMatches(out, anchor, scope, includeMajor);
  }

  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const script = match[1];
    for (const field of script.matchAll(VERSION_FIELD_RE)) {
      addMatches(out, field[2], 'structured', includeMajor);
      const version = norm(field[2]);
      const candidate = out.get(version);
      if (candidate) candidate.contexts.unshift({ text: `${field[1]}: ${field[2]}`, scope: 'structured' });
    }
    for (const field of script.matchAll(SEMANTIC_SCRIPT_RE)) {
      addMatches(out, field[1], 'structured', includeMajor);
    }
  }

  for (const block of html.matchAll(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi)) {
    const content = block[0];
    if (!NOISE_RE.test(content)) continue;
    // 只在噪音关键词附近提取版本（噪声负样本，帮模型学"什么是垃圾"），
    // 不能整块 MINOR_RE 扫——__NEXT_DATA__ 里序列化的 SVG 坐标会产生上千个候选。
    const noiseRe = new RegExp(NOISE_RE.source, 'gi');
    for (const m of content.matchAll(noiseRe)) {
      const idx = m.index as number;
      const near = content.slice(idx, Math.min(content.length, idx + 80));
      for (const vm of near.matchAll(/(?<![0-9.])v?\d+(?:\.\d+){1,3}/g)) {
        addMatch(out, vm[0], snippet(content, idx + (vm.index || 0)), 'noise');
      }
    }
  }

  // 从原始 HTML 提取每个候选前最近的 HTML 标签名（如 li、h3、p 等），用于"标签结构相似"
  // 判断，使同一版本列表的不同 major 版本能桥接。
  // 用 html 中第一次出现该版本号的位置。
  for (const [version, candidate] of out) {
    const bare = version.replace(/^v/i, '');
    const idx = html.indexOf(bare);
    if (idx >= 0) {
      const before = html.slice(Math.max(0, idx - 80), idx);
      const tag = before.match(/<(\/?[a-z0-9]+)\b[^>]*>[^<]*$/i)?.[1] || '';
      if (tag) candidate.tag = tag.toLowerCase();
    }
  }

  // 语义标签路径：用 cheerio 解析 DOM，对每个候选版本号计算它所在叶子节点的
  // 语义标签祖先路径（h1-h6/li/p/dt/dd 等，跳过 div/span 骨架）。
  // 同一版本列表的版本（Things 2.1 / 3.22 都在 h2）路径相同 → 结构相似可桥接；
  // 依赖库版本（Itsycal 页 Sparkle 在 li，产品版本在 h4）路径不同 → 不桥接。
  try {
    const $ = cheerio.load(html);
    // 语义标签：h/li/p/dt/dd/strong 等是"版本列表结构"特征。
    // 排除 <a>——链接在页面里无处不在（导航/下载/changelog 链接都含版本号），
    // raycast 的 v1.104.0(changelog链接) 和 v2.0(导航链接) 都在 <a>，不该桥接。
    const SEMANTIC = new Set(['h1','h2','h3','h4','h5','h6','li','p','dt','dd','strong','b','em','td','th','tr','caption','figcaption','title']);
    const verToPaths = new Map<string, Set<string>>();
    $('body *').each((i, el) => {
      if ($(el).children().length > 0) return;
      const text = $(el).text();
      if (!/\d\.\d/.test(text) || text.length > 200) return;
      const tags: string[] = [];
      $(el).parents().each((j, p) => {
        const t = String(p.tagName || '').toLowerCase();
        if (SEMANTIC.has(t)) tags.push(t);
      });
      const leaf = String(el.tagName || '').toLowerCase();
      if (tags.length === 0 && !SEMANTIC.has(leaf)) return;
      tags.push(SEMANTIC.has(leaf) ? leaf : 'text');
      const path = tags.join('>');
      for (const m of text.matchAll(/v?\d+(?:\.\d+){1,3}/g)) {
        const v = 'v' + m[0].replace(/^v/i, '');
        if (!verToPaths.has(v)) verToPaths.set(v, new Set());
        verToPaths.get(v)!.add(path);
      }
    });
    for (const [version, candidate] of out) {
      const paths = verToPaths.get(version);
      if (paths) candidate.paths = [...paths];
    }
  } catch { /* cheerio 解析失败则无 paths，退化为 tag 桥接 */ }

  return [...out.values()].map((candidate) => ({
    ...candidate,
    contexts: candidate.contexts.filter((context, index, all) => all.findIndex((x) => x.scope === context.scope && x.text === context.text) === index).slice(0, 8),
  }));
}

export function matches(actual: string, label: string): boolean {
  const a = actual.replace(/^v/i, ''), l = label.replace(/^v/i, '');
  return a === l || a.startsWith(l + '.') || l.startsWith(a + '.');
}

export function isExplicitNoise(candidate: Candidate): boolean {
  const useful = candidate.contexts.filter((c) => c.scope !== 'noise');
  if (useful.length > 0) return false;
  return candidate.contexts.some((c) => NOISE_RE.test(c.text));
}

function isUnknown(candidate: Candidate, url: string): boolean {
  if (isExplicitNoise(candidate)) return false;
  if (STRUCTURED_ENDPOINT_RE.test(url)) return true;
  if (PAGE_VERSION_RE.test(url)) return true;
  const semantic = candidate.contexts.some((c) => c.scope !== 'noise');
  return semantic && candidate.contexts.some((c) => /version|release|changelog|download|changes|更新|版本/i.test(c.text));
}

export function chooseContexts(candidate: Candidate): Context[] {
  const priority: Scope[] = ['structured', 'download-link', 'title', 'heading', 'meta', 'visible', 'noise'];
  return [...candidate.contexts].sort((a, b) => priority.indexOf(a.scope) - priority.indexOf(b.scope)).slice(0, 3);
}

async function main() {
  const ds = JSON.parse(readFileSync('data/dataset.json', 'utf-8'));
  const samples: Sample[] = [];
  const stats = { cases: 0, positive: 0, negative: 0, unknown: 0, skipped: 0 };

  for (const c of ds) {
    if (!c.label || !c.htmlFile) continue;
    let html: string;
    try { html = readFileSync(c.htmlFile, 'utf-8'); } catch { stats.skipped += 1; continue; }
    const candidates = collectCandidates(html);
    const labeled = candidates.filter((candidate) => matches(candidate.version, c.label) && !isExplicitNoise(candidate));
    if (labeled.length === 0) { stats.skipped += 1; continue; }
    stats.cases += 1;

    for (const candidate of candidates) {
      const contexts = chooseContexts(candidate);
      if (contexts.length === 0) continue;
      const label: 0 | 1 | 'unknown' = matches(candidate.version, c.label)
        ? 1
        : isExplicitNoise(candidate) ? 0
        : isUnknown(candidate, c.url) ? 'unknown' : 0;
      const labelReason = label === 1 ? 'matches-live-label' : label === 0 ? 'explicit-noise' : 'ambiguous-semantic-candidate';
      samples.push({
        text: `候选: ${candidate.version} [SEP] 上下文: ${contexts.map((x) => `[${x.scope}] ${x.text}`).join(' | ').slice(0, 480)}`,
        label,
        version: candidate.version,
        url: c.url,
        scopes: contexts.map((x) => x.scope),
        labelReason,
      });
      stats[label === 1 ? 'positive' : label === 0 ? 'negative' : 'unknown'] += 1;
    }
  }

  writeFileSync('data/candidates-clean.jsonl', samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
  console.log(`候选样本: ${samples.length} 条（正 ${stats.positive} / 负 ${stats.negative} / unknown ${stats.unknown}）`);
  console.log(`覆盖: ${stats.cases} 个用例，跳过 ${stats.skipped} 个无可靠正样本/快照的用例`);
  console.log('→ data/candidates-clean.jsonl');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('导出失败:', e.message); process.exit(1); });
}
