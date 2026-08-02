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
  const nextData = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) parts.push(nextData[1]);
  const initState = html.match(/<script[^>]*id=["']__INITIAL_STATE__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (initState) parts.push(initState[1]);
  return parts.join('\n');
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
        return { version: normalizeVersion(raw), source: 'version_regex', confidence: 'high', needsAiCheck: false, suggestedRegex: opts.versionRegex };
      }
    } catch {
      // 正则无效，继续启发式
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
  const keywordRe = /(?:version|v\.?\s|release|changelog|download|下载|更新|版本)[^\n]{0,80}/gi;
  const keywordText = [...body.matchAll(keywordRe)].map((m) => m[0]).join('\n');

  const scopes: Array<{ text: string; scope: string }> = [
    { text: `${title}\n${metas}`, scope: 'title' },
    { text: structured, scope: 'json-ld' },
    { text: keywordText, scope: 'body' },
  ];
  const patterns: Array<{ re: RegExp; name: 'semver' | 'minor' | 'major' }> = [
    { re: SEMVER_RE, name: 'semver' },
    { re: MINOR_RE, name: 'minor' },
    { re: MAJOR_RE, name: 'major' },
  ];
  for (const s of scopes) {
    for (const p of patterns) {
      for (const m of s.text.matchAll(p.re)) {
        const raw = m[0];
        if (p.name === 'major' && /^\d{4}$/.test(raw)) continue;
        if (isSuspicious(raw)) continue;
        candidates.push({ version: normalizeVersion(raw), pattern: p.name, scope: s.scope });
      }
    }
  }
  for (const u of urls) {
    const m = u.match(/\bv?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\b/);
    if (m && !isSuspicious(m[0])) candidates.push({ version: normalizeVersion(m[0]), pattern: 'semver', scope: 'url' });
  }

  if (candidates.length === 0) return none();

  const scopeWeight: Record<string, number> = { title: 3, 'json-ld': 3, body: 2, url: 2 };
  const patternWeight: Record<string, number> = { semver: 2, minor: 1, major: 0 };
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

  // 置信度：出现在可见正文是"真实版本"的必要条件（标题/json-ld 除外，它们是结构化权威源）
  let confidence: Confidence;
  if (bestEntry.inDownloadUrl && bestEntry.score >= 7 && bestEntry.inVisibleText) confidence = 'high';
  else if (bestEntry.scope === 'title' && bestEntry.score >= 7) confidence = 'high';
  else if (bestEntry.scope === 'json-ld' && bestEntry.score >= 6) confidence = 'high';
  else if (bestEntry.score >= 5 && bestEntry.inVisibleText) confidence = 'medium';
  else confidence = 'low';

  const matchedIndex = html.indexOf(bestKey.replace(/^v/i, ''));
  return {
    version: bestKey,
    source: bestEntry.scope,
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
