// LightGBM 版本候选评分（TS 侧）
//
// 模型：data/lgb-filter.joblib（15 特征，43/51 验证）
// 推理：调 scripts/lgb_predict.py 子进程（同 Trafilatura 模式）
// 特征：14 个可从版本字符串重建，bert_prob 传 0
import { spawn } from 'child_process';
import { join } from 'path';
import { collectCandidates as collectExportCandidates } from '../scripts/export-candidates';
import { extractVersionFromHtml, compareVersions, detectVersionSequence } from './version-extract';
import { extractVersionWithLlm } from './llm';
import { rerankProductVersions } from './reranker';
import type { AuditDecision } from './audit';
import type { VersionResult } from './types';

// 特征列顺序（与 data/lgb-nodl-cols.joblib 一致，14 列无 bert_prob）
// 用无 embedding 的模型 lgb-filter-nodl.joblib：含 bert 的模型在推理时
// bert_prob 传 0 会喂给模型训练时未见过的分布，导致判别失效（noise 反而高分）。
export type LgbRow = [
  number, // has_v
  number, // is_clean
  number, // is_short_major
  number, // is_yearish
  number, // major
  number, // minor
  number, // n_digits_total
  number, // n_seg
  number, // patch
  number, // scope_dl
  number, // scope_heading
  number, // scope_noise
  number, // scope_structured
  number, // scope_visible
  number, // latest_annotated
];

// 运行时候选 scope → 训练词汇表映射
// 训练: {download-link, structured, heading, visible, noise}
// 运行时: {title, structured, body, heading, changelog-header, url, changelog-url}
export function mapScopeToTrain(scope: string): string {
  switch (scope) {
    case 'url':
    case 'changelog-url':
      return 'download-link';
    case 'structured':
    case 'json-ld': // 旧数据兼容
    case 'changelog-header':
      return 'structured';
    case 'heading':
      return 'heading';
    case 'title':
    case 'body':
      return 'visible';
    default:
      return 'noise';
  }
}

// 从版本字符串重建结构化特征（对应 train_lgb_filter.py 的 version_features，无 bert 列）
export function buildFeatureRow(version: string, scopes: string[], contexts?: Array<{ text: string; scope: string }>): LgbRow {
  const base = version.replace(/^[vV]/, '').split('-')[0].split('+')[0];
  const nums = (base.match(/\d+/g) || []).map(Number);
  const seg = base.split('.');
  const scopeSet = new Set(scopes);
  // latest_annotated 特征(与 15 列 filter 模型匹配): 候选上下文含 "Latest/Current version: X" 标注
  const latestAnnotated = (contexts || []).some((x) => /(?:latest|current|stable|newest)\s+version\s*[:=]\s*["']?v?\d/i.test(x.text)) ? 1 : 0;
  return [
    version.startsWith('v') || version.startsWith('V') ? 1 : 0, // has_v
    /^\d+(\.\d+){0,3}$/.test(base) ? 1 : 0, // is_clean
    seg.length === 1 ? 1 : 0, // is_short_major
    /^\d{4}([.-]\d{1,2}){1,2}$/.test(base) ? 1 : 0, // is_yearish
    nums[0] || 0, // major
    nums[1] || 0, // minor
    (base.match(/\d/g) || []).length, // n_digits_total
    seg.length, // n_seg
    nums[2] || 0, // patch
    scopeSet.has('download-link') ? 1 : 0,
    scopeSet.has('heading') ? 1 : 0,
    scopeSet.has('noise') ? 1 : 0,
    scopeSet.has('structured') ? 1 : 0,
    scopeSet.has('visible') ? 1 : 0,
    latestAnnotated,
  ];
}

export interface LgbCandidate {
  version: string;
  scopes: string[]; // 运行时候选 scope（如 ['url','body']）
  contexts?: Array<{ text: string; scope: string }>; // 上下文文本（前缀归族用）
  tag?: string; // 候选在 HTML 中的前一个标签名（"结构相似"桥接用）
  paths?: string[]; // 语义标签祖先路径（h2 等），"结构相似"桥接用
}

export interface LgbResult {
  version: string;
  prob: number; // 产品版本概率 [0,1]
}

// 统一 Python 推理协议。模型缺失、超时或输出异常时返回 null，让调用方完整回退。
async function runPredict(mode: 'filter' | 'rank', rows: number[][]): Promise<any | null> {
  if (rows.length === 0) return mode === 'filter' ? { probs: [] } : { scores: [] };
  const script = join(process.cwd(), 'scripts', 'lgb_predict.py');
  return new Promise((resolve) => {
    const child = spawn('python', [script], { windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 15000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
    child.stdin.write(JSON.stringify({ mode, rows }));
    child.stdin.end();
  });
}

// 批量推理：构造候选级过滤特征 → 返回产品版本概率。
export async function predictCandidateVersions(candidates: LgbCandidate[]): Promise<LgbResult[]> {
  if (candidates.length === 0) return [];
  const rows: LgbRow[] = candidates.map((c) => buildFeatureRow(c.version, c.scopes, c.contexts));
  const parsed = await runPredict('filter', rows);
  const probs: number[][] = parsed?.probs || [];
  return candidates.map((c, i) => ({ version: c.version, prob: probs[i] && Number.isFinite(probs[i][1]) ? probs[i][1] : -1 }));
}

export async function predictRankScores(rows: number[][]): Promise<number[] | null> {
  return predictRankScoresInternal(rows);
}

async function predictRankScoresInternal(rows: number[][]): Promise<number[] | null> {
  const parsed = await runPredict('rank', rows);
  const scores = parsed?.scores;
  return Array.isArray(scores) && scores.length === rows.length && scores.every((x) => Number.isFinite(x)) ? scores : null;
}

function rankVersionParts(version: string): number[] {
  const base = version.replace(/^v/i, '').split(/[+-]/)[0];
  return (base.match(/\d+/g) || []).slice(0, 4).map(Number);
}

function rankVersionCompare(a: string, b: string): number {
  const x = rankVersionParts(a), y = rankVersionParts(b);
  for (let i = 0; i < 4; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

function rankMatches(a: string, b: string): boolean {
  const x = a.replace(/^v/i, ''), y = b.replace(/^v/i, '');
  return x === y || x.startsWith(y + '.') || y.startsWith(x + '.');
}

// Runtime columns must stay in exactly the same order as scripts/train3_lgb.py.
export function buildRankFeatureRows(
  html: string,
  scored: LgbResult[],
  candidates: LgbCandidate[],
  productName?: string | null,
): number[][] {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ');
  // 与训练 build-train3 一致：全部有限概率候选都参与排序，不过滤 0.3。
  const valid = scored.filter((s) => Number.isFinite(s.prob));
  const globalMax = [...valid].sort((a, b) => rankVersionCompare(a.version, b.version)).pop()?.version || '';
  const product = productName?.trim() || '';
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const productRe = product ? new RegExp(escapeRe(product) + '[\\s-]*v?(\\d+(?:\\.\\d+){1,3})', 'gi') : null;
  const sequence = detectVersionSequence(html);
  const majorGroups = new Map<number, LgbResult[]>();
  for (const s of valid) {
    const major = rankVersionParts(s.version)[0] || 0;
    if (!majorGroups.has(major)) majorGroups.set(major, []);
    majorGroups.get(major)!.push(s);
  }
  return valid.map((s) => {
    const c = candidates.find((x) => x.version === s.version);
    const base = s.version.replace(/^v/i, '').split(/[+-]/)[0];
    const nums = rankVersionParts(s.version);
    const major = nums[0] || 0;
    const group = majorGroups.get(major) || [];
    const sameMajorLatest = [...group].sort((a, b) => rankVersionCompare(a.version, b.version)).pop()?.version || '';
    const higher = valid.filter((x) => rankVersionCompare(x.version, s.version) > 0).length;
    const scopes = new Set(c?.scopes || []);
    const contexts = c?.contexts || [];
    const bare = s.version.replace(/^v/i, '');
    const occurrence = (html.match(new RegExp('(?<![0-9.])' + escapeRe(bare) + '(?![0-9.])', 'gi')) || []).length;
    const first = html.toLowerCase().indexOf(bare.toLowerCase());
    const anchor = productRe ? [...html.matchAll(productRe)].some((m) => rankMatches(s.version, 'v' + m[1])) : false;
    const titleAnchor = product ? new RegExp(escapeRe(product) + '[\\s-]*v?' + escapeRe(bare), 'i').test(title) : false;
    const productPresent = product ? contexts.some((x) => new RegExp('\\b' + escapeRe(product) + '\\b', 'i').test(x.text)) : false;
    const paths = c?.paths || [];
    const pathCounts = new Map<string, number>();
    for (const member of group) {
      const memberPaths = candidates.find((x) => x.version === member.version)?.paths || [];
      for (const path of memberPaths) pathCounts.set(path, (pathCounts.get(path) || 0) + 1);
    }
    const dominantPath = [...pathCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const pageType = /error|403 forbidden|404 not found/i.test(html) ? 'error' : /download/i.test(locationHrefForRank(html)) ? 'download' : /changelog|release|history|version/i.test(locationHrefForRank(html)) ? 'history' : /news|blog/i.test(locationHrefForRank(html)) ? 'article' : 'page';
    return [
      s.prob, s.version.startsWith('v') ? 1 : 0, base.split('.').length, (base.match(/\d/g) || []).length,
      nums[0] || 0, nums[1] || 0, nums[2] || 0, /^\d+(\.\d+){0,3}$/.test(base) ? 1 : 0,
      /^\d{4}([.-]\d{1,2}){1,2}$/.test(base) ? 1 : 0, base.split('.').length === 1 ? 1 : 0,
      scopes.has('download-link') ? 1 : 0, scopes.has('structured') ? 1 : 0, scopes.has('heading') ? 1 : 0,
      scopes.has('visible') ? 1 : 0, scopes.has('noise') ? 1 : 0,
      valid.length, group.length, higher, valid.length ? higher / valid.length : 0,
      rankMatches(s.version, globalMax) ? 1 : 0, rankMatches(s.version, sameMajorLatest) ? 1 : 0,
      occurrence, first >= 0 ? first / Math.max(html.length, 1) : 1, contexts.length, scopes.size,
      anchor ? 1 : 0, titleAnchor ? 1 : 0, productPresent ? 1 : 0,
      dominantPath && paths.includes(dominantPath) ? 1 : 0,
      dominantPath && paths.includes(dominantPath) ? (pathCounts.get(dominantPath) || 0) / Math.max(group.length, 1) : 0,
      // latest_annotated(与 38 列 rank 模型匹配): 候选上下文含 "Latest/Current version: X" 标注
      contexts.some((x) => /(?:latest|current|stable|newest)\s+version\s*[:=]\s*["']?v?\d/i.test(x.text)) ? 1 : 0,
      new Set(group.map((x) => rankVersionParts(x.version).slice(0, 2).join('.'))).size,
      sequence?.series.some((v) => rankMatches(s.version, v)) ? 1 : 0,
      sequence && rankMatches(s.version, sequence.latest) ? 1 : 0,
      pageType === 'download' ? 1 : 0, pageType === 'history' ? 1 : 0,
      pageType === 'article' ? 1 : 0, pageType === 'error' ? 1 : 0,
    ];
  });
}

// The current caller does not expose a URL, so page-type inference uses HTML markers.
function locationHrefForRank(html: string): string { return html.slice(0, 200000); }

// ── 前缀归族：过滤垃圾后按"产品前缀"归族，族内取最大版本 ──
//
// 为什么用前缀而非数值距离：
//   DBSCAN/数值聚类（major*1e6+minor*1e3+patch）必然失败——版本空间非线性，
//   go 的 1.25.12→1.26.0 数值距离 988000 却是相邻版本；eagle 的 v4.0→v22 数值更大却是不同东西
//   （产品版本 vs 构建号）。"同族"只由上下文产品名定义：go1.26.5/go1.4.2 同族（前缀 go），
//   nginx-1.31.3/nginx-0.8.55 同族（前缀 nginx，0.x/1.x 自动合一族），Eagle 4.0(标题) 与
//   构建号序列 v20-v22 不同族。这就是"最大权重连通子图"的形态：边=共享产品前缀，
//   连通分量=族，取总分最高的族，族内取最大版本。
const PREFIX_STOP = new Set([
  'os', 'osx', 'x', 'linux', 'mac', 'macos', 'windows', 'win', 'apple', 'intel', 'amd64', 'x86', 'x86_64', 'arm64', 'arm',
  'version', 'ver', 'v', 'build', 'release', 'releases', 'download', 'downloads', 'stable', 'unstable', 'mainline', 'legacy',
  'archived', 'archive', 'latest', 'current', 'new', 'old', 'all', 'featured', 'changes', 'change', 'changelog', 'blog',
  'pgp', 'installer', 'install', 'file', 'files', 'source', 'sources', 'default', 'none', 'get', 'see', 'read',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'this', 'for', 'the', 'with', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'from', 'update', 'updated', 'updates',
  '版本', '下载', '更新',
]);

// productPrefix（最高频前缀提取）已删除：验证无效，前缀不足以区分主角与依赖库。

// 主角优先级（从启发式泛化，不需要语义）：下载链接/标题里的版本几乎总是当前版本。
// 族评分用它区分"页面主角族"（Eagle 4.0 在标题）vs"构建号/孤立版本族"（v20-22 序列）。
function familyPriority(scopes: Set<string>): number {
  let p = 0;
  if (scopes.has('download-link')) p += 3;
  if (scopes.has('title')) p += 3;
  if (scopes.has('structured')) p += 1;
  if (scopes.has('heading')) p += 1;
  p += Math.max(0, scopes.size - 1);
  return p;
}

function isYearishV(v: string): boolean {
  return /^v?\d{4}([.-]\d{1,2}){1,2}$/.test(v.replace(/^v/i, ''));
}

// ── 数值演变图 ──
// 前缀和页面结构只作弱证据；族的主体由候选版本自身形成的轨迹决定。
interface NumericNode {
  result: LgbResult;
  nums: number[];
  major: number;
  minor: number;
  patch: number;
  segments: number;
  preRank: number;
  preNum: number;
  yearish: boolean;
  prefix: string | null;
  tag: string | null; // 候选在 HTML 中的前一个标签名（li/h3/p 等），"结构相似"桥接用
  paths: string[]; // 语义标签祖先路径（h2 等），"结构相似"桥接用
}

function majorOf(v: string): number {
  return parseInt(v.replace(/^v/i, '').split('.')[0], 10) || 0;
}

function numericNode(result: LgbResult, prefix: string | null, tag?: string | null, paths?: string[]): NumericNode {
  const raw = result.version.replace(/^v/i, '');
  const base = raw.split('+')[0];
  const pre = base.match(/(?:^|[.-])(alpha|beta|rc|pre|dev|patch)(\d*)/i);
  const numeric = base.replace(/(?:^|[.-])(alpha|beta|rc|pre|dev|patch)\d*/i, '');
  const nums = (numeric.match(/\d+/g) || []).slice(0, 4).map(Number);
  while (nums.length < 3) nums.push(0);
  const preName = pre?.[1].toLowerCase();
  const preRank = preName ? ({ dev: 1, pre: 2, alpha: 3, beta: 4, rc: 5, patch: 2 } as Record<string, number>)[preName] || 2 : 6;
  return {
    result,
    nums,
    major: nums[0],
    minor: nums[1],
    patch: nums[2],
    segments: (numeric.match(/\d+/g) || []).length,
    preRank,
    preNum: pre ? Number(pre[2] || 0) : 0,
    yearish: isYearishV(result.version),
    prefix,
    tag: tag || null,
    paths: paths || [],
  };
}

function compareEvolution(a: NumericNode, b: NumericNode): number {
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i += 1) {
    const av = a.nums[i] || 0, bv = b.nums[i] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  if (a.preRank !== b.preRank) return a.preRank > b.preRank ? 1 : -1;
  if (a.preNum !== b.preNum) return a.preNum > b.preNum ? 1 : -1;
  return 0;
}

function sameShape(a: NumericNode, b: NumericNode): boolean {
  return Math.abs(a.segments - b.segments) <= 1;
}

// 只比较版本结构中的局部变化，不使用 major*1e6 之类的虚拟欧氏距离。
// 版本演变邻接：同主版本 = 同一产品线（最强证据，不看 minor/patch 邻接，
// 因为 go 1.20/1.26.5、windsurf 1.12/1.9600 都是同 major 的产品版本）。
// 跨主版本桥接：
//   段数相同（0.8.55 -> 1.0.15、5.821 -> 6.0）→ 0.85，同一条线。
//   段数不同（3段 -> 2段：postgresql 9.6.24 -> 10.0）→ 只允许 2 段一侧 minor==0
//   （10.0 表示 10.0.x 起始，是真实版本切换；4.1 的 minor=1 跳过了 4.0，是不同线，
//   如 windsurf 3.6.27 -> 4.1 不连）。
function numericNeighbor(a: NumericNode, b: NumericNode): number {
  if (a.major === b.major) return 1;
  if (Math.abs(a.major - b.major) === 1) {
    if (a.segments === b.segments) return 0.85;
    if (Math.abs(a.segments - b.segments) > 1) return 0;
    // 段数不同：2 段一侧 minor 必须为 0 才连
    const two = a.segments === 2 ? a : b;
    if (two.minor !== 0) return 0;
    return 0.72;
  }
  return 0;
}

function edgeWeight(a: NumericNode, b: NumericNode, scopesOf: Map<string, Set<string>>): number {
  // 年份版本（Sketch/Bitwarden）与普通 semver 是两种数值体系，不能直接连边。
  if (a.yearish !== b.yearish) return 0;
  const continuity = numericNeighbor(a, b);
  if (continuity === 0) return 0;
  let weight = continuity * 0.72;
  if (a.prefix && b.prefix && a.prefix === b.prefix) weight += 0.06;
  if (!a.prefix || !b.prefix) weight += 0.03;
  const sa = scopesOf.get(a.result.version) || new Set();
  const sb = scopesOf.get(b.result.version) || new Set();
  const aa = sa.has('download-link') || sa.has('title') || sa.has('structured') || sa.has('heading');
  const ab = sb.has('download-link') || sb.has('title') || sb.has('structured') || sb.has('heading');
  if (aa && ab) weight += 0.08;
  return Math.min(weight, 1);
}

interface NumericFamily {
  nodes: NumericNode[];
  density: number;
  trajectory: number;
  latest: NumericNode;
  score: number;
}

function buildNumericFamilies(nodes: NumericNode[], scopesOf: Map<string, Set<string>>): NumericFamily[] {
  if (nodes.length === 0) return [];
  const ordered = [...nodes].sort(compareEvolution);
  const neighbors = new Map<string, Set<string>>();
  for (const node of ordered) neighbors.set(node.result.version, new Set());
  for (let i = 0; i < ordered.length; i += 1) {
    for (const j of [i - 2, i - 1, i + 1, i + 2]) {
      if (j < 0 || j >= ordered.length) continue;
      const a = ordered[i], b = ordered[j];
      if (edgeWeight(a, b, scopesOf) >= 0.58) neighbors.get(a.result.version)!.add(b.result.version);
    }
  }
  const parent = ordered.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const index = new Map(ordered.map((n, i) => [n.result.version, i]));
  // 各 major 的成员数（跨 major 且段数不同时，要求两侧 ≥2 才算真实版本线延续）
  const majorCount = new Map<number, number>();
  for (const n of ordered) majorCount.set(n.major, (majorCount.get(n.major) || 0) + 1);
  // 每个 major 组的主体语义路径：该 major 下出现最多的路径。直接取路径原始值，
  // 不做 meaningful 过滤——过滤会丢掉 Sparkle 的 li（它正是依赖库的结构证据），
  // 而"取出现最多"本身就能抵抗少数噪声（itsycal 0.x 里 6 个 li 不影响 h4×69 主导）。
  // 版本列表边界行（新 major 首个版本）常有不同标记（bettertouchtool v6.0 是 tr>td、
  // 主体是 td>tr>text），单点比较会误伤；按 major 组的主体路径比较才稳。
  const majorPathCount = new Map<number, Map<string, number>>();
  for (const n of ordered) {
    if (n.paths.length === 0) continue;
    const p = n.paths[0];
    const m = majorPathCount.get(n.major) || new Map();
    m.set(p, (m.get(p) || 0) + 1);
    majorPathCount.set(n.major, m);
  }
  const dominantPath = (major: number): string | null => {
    const m = majorPathCount.get(major);
    if (!m) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  for (const a of ordered) {
    for (const bVersion of neighbors.get(a.result.version) || []) {
      const b = ordered[index.get(bVersion)!];
      if (!neighbors.get(b.result.version)?.has(a.result.version)) continue;
      // 跨 major 桥接前缀兼容：都有前缀需相同；一个有前缀一个无 → 不桥接。
      // Itsycal v0.15.11(itsycal) 和 Sparkle v1.13.1(null) 不桥接，避免依赖库并入产品族。
      if (a.major !== b.major) {
        const pa = a.prefix, pb = b.prefix;
        if (pa && pb) { if (pa !== pb) continue; }
        else if (pa !== pb) continue; // 一个有前缀一个无
      }
      // 跨 major 结构门槛：两侧 major 组的主体语义路径不同 → 不是同一条版本线。
      // itsycal 产品 0.x 主体 <h4>、依赖 Sparkle 1.x 主体 <li> → 不桥接；
      // bettertouchtool 5.x/6.x 主体都是 <td><tr> 表格行 → 桥接。
      if (a.major !== b.major) {
        const pa = dominantPath(a.major), pb = dominantPath(b.major);
        if (pa && pb && pa !== pb) continue;
      }
      // 跨 major 桥接已由 numericNeighbor 把关（段数差 ≤1 + major 差 1）。
      // 段数相同（nodejs-lts 的 3 段版本 v4.9.1~v26.6.0）→ 允许单点桥接。
      // 段数不同（3段→2段：postgresql 9.6.24→10.0、raycast v1.x→v2.0）→
      // 要求两侧各 ≥2 个成员：postgresql 10.x 有多个版本是真实线，raycast
      // 的 v2.0 只是导航宣传孤立点，不应并入 v1.x 主线。
      if (a.major !== b.major && a.segments !== b.segments) {
        if ((majorCount.get(a.major) || 0) < 2 || (majorCount.get(b.major) || 0) < 2) continue;
      }
      const ra = find(index.get(a.result.version)!);
      const rb = find(index.get(b.result.version)!);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  // 语义路径不再做"强制并族"：共享路径只是放宽了本不该放宽的缺口
  // （依赖库与产品版本出现在同一个 <li> 里就会被误并进产品族）。
  // 结构只保留"排除"用法：跨 major 桥接前检查 structurallyAlike（edgeWeight 内）。
  const groups = new Map<number, NumericNode[]>();
  ordered.forEach((n, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(n);
  });
  return [...groups.values()].map(group => {
    const latest = [...group].sort(compareEvolution).pop()!;
    const uniqueBases = new Set(group.map(n => `${n.major}.${n.minor}`)).size;
    const density = group.length / Math.max(uniqueBases, 1);
    const trajectory = Math.min(1, (group.length + uniqueBases) / 12);
    const meanProb = group.reduce((s, n) => s + n.result.prob, 0) / group.length;
    const anchors = group.filter(n => {
      const scopes = scopesOf.get(n.result.version) || new Set();
      return scopes.has('download-link') || scopes.has('title') || scopes.has('structured') || scopes.has('heading');
    }).length / group.length;
    // 单点族没有"数值演变"证据：只有当整页别无选择时才可胜出。
    // 不能因 structured 锚点豁免——结构化字段可能是资产版本（gitkraken 的 2024.11.0）。
    const singletonPenalty = group.length === 1 ? 1.5 : 0;
    const score = Math.log1p(group.length) * 1.5 + Math.min(density, 3) * 0.5 + trajectory * 1.8 + meanProb * 0.45 + anchors * 0.25 + latest.result.prob * 0.35 - singletonPenalty;
    return { nodes: group, density, trajectory, latest, score };
  }).sort((a, b) => b.score - a.score);
}

// 归族选版：LightGBM 负责排噪，数值演变图负责找族，族内按预发布感知的版本顺序取最大。
// productName：调用方已知产品名 → 给"产品前缀匹配"的候选大幅加分，
// 使 GIMP 页的 gimp 前缀候选赢过依赖库 GEGL/Mathjax（它们的版本不是产品版本）。
// anchorHits：产品名锚点命中的版本集（"PopClip 2026.7.1" 等），命中候选所属族额外加分，
// 但不短路——仍由归族综合密度/最新端/单点惩罚决定，避免锚点命中历史版就错选。
export function selectVersionByFamily(scored: LgbResult[], candidates: LgbCandidate[], productName?: string | null, anchorHits?: Set<string> | null): LgbResult | null {
  const valid = scored.filter(s => s.prob > 0.3 && !/^v?\d{4}[-.]\d{2}[-.]\d{2}$/.test(s.version));
  if (valid.length === 0) return null;
  const ctxOf = new Map<string, Array<{ text: string; scope: string }>>();
  for (const c of candidates) if (c.contexts) ctxOf.set(c.version, [...(ctxOf.get(c.version) || []), ...c.contexts]);
  const scopesOf = new Map<string, Set<string>>();
  for (const c of candidates) scopesOf.set(c.version, new Set(c.scopes || []));
  const tagOf = new Map<string, string | null>();
  for (const c of candidates) tagOf.set(c.version, c.tag || null);
  const pathsOf = new Map<string, string[]>();
  for (const c of candidates) pathsOf.set(c.version, c.paths || []);
  const nodes = valid.map(s => numericNode(s, null, tagOf.get(s.version) || null, pathsOf.get(s.version) || []));
  const families = buildNumericFamilies(nodes, scopesOf);
  // 产品前缀匹配：候选前缀 == 已知产品名，或候选上下文里紧邻出现产品名
  const pn = productName?.trim().toLowerCase();
  // anchorHits 归一化：匹配候选版本（去掉 v 前缀）
  const anchorNorm = new Set<string>();
  for (const v of anchorHits || []) anchorNorm.add(v.replace(/^v/i, ''));
  const isProductNode = (n: NumericNode): boolean => {
    // 只精确匹配前缀：GIMP 3.2 前缀=gimp；GEGL 0.4.68 前缀=gegl。
    // 不能用"上下文含产品名"——GEGL 的上下文"GIMP 3.2...also released GEGL"也含 gimp，会误判。
    if (pn && n.prefix && n.prefix === pn) return true;
    if (anchorNorm.size > 0 && anchorNorm.has(n.result.version.replace(/^v/i, ''))) return true;
    return false;
  };
  const winner = [...families].sort((a, b) => {
    const productBoost = (f: typeof a) => {
      if (!pn && (!anchorHits || anchorHits.size === 0)) return 0;
      const match = f.nodes.some(n => isProductNode(n));
      return match ? 3 : 0;
    };
    const sa = a.score + productBoost(a) + (a.nodes.length === 1 ? -1.2 : 0);
    const sb = b.score + productBoost(b) + (b.nodes.length === 1 ? -1.2 : 0);
    if (Math.abs(sb - sa) > 0.15) return sb - sa;
    // 分数接近时，优先轨迹覆盖更广、节点更多的族，而不是孤立高概率候选。
    return b.nodes.length - a.nodes.length || b.trajectory - a.trajectory;
  })[0];
  if (!winner) return null;

  const pool = new Map<string, number>();
  for (const node of winner.nodes) pool.set(node.result.version, node.result.prob);
  for (const s of scored) {
    if (pool.has(s.version) || s.prob <= 0.1 || isYearishV(s.version)) continue;
    const node = numericNode(s, null, tagOf.get(s.version) || null, pathsOf.get(s.version) || []);
    // rescue 只允许同 major 的低分候选（nginx v1.31.3 是 major 1 被模型低估）；
    // 跨 major 不允许——否则 GPL 3.0 许可证（major 3）会通过 major 2 拉进 pool。
    if (winner.nodes.some(w => w.major === node.major && numericNeighbor(node, w) >= 0.72)) pool.set(s.version, s.prob);
  }
  const picked = [...pool.entries()]
    .map(([version, prob]) => numericNode({ version, prob }, null))
    .sort(compareEvolution)
    .pop();
  return picked?.result || null;
}

// 页面排序模型选择 seed；数值归族仅约束 seed 可到达的版本线，不能以族规模改选其他族。
// 返回 null 表示排序工件不可用/特征不匹配，由调用方回退旧选择器。
export interface RankSeedDetail { result: LgbResult; margin: number; strong: boolean; globalMax?: string; }
export async function selectVersionByRankSeedDetailed(
  html: string,
  scored: LgbResult[],
  candidates: LgbCandidate[],
  productName?: string | null,
): Promise<RankSeedDetail | null> {
  // 过滤门槛 prob>0.3, 但保留"前缀匹配高prob候选"的低prob完整版:
  // v0.dev 案例: v16.2(导航, prob=0.94) 与 v16.2.0(详情文本, prob=0.02) 同前缀,
  // filter 给显眼位置高分、详情低分——若把 v16.2.0 滤掉, rank 永远看不到完整版。
  // 规则: prob>0.3 的候选先取; 对每个高prob候选 X.Y, 若存在 X.Y.Z 且 prob<0.3, 也保留(交 rank 裁决)。
  const base = scored.filter((s) => Number.isFinite(s.prob) && s.prob > 0.3 && !/^v?\d{4}[-.]\d{2}[-.]\d{2}$/.test(s.version));
  const baseVers = new Set(base.map((s) => s.version.replace(/^v/i, '')));
  const prefixKeep = scored.filter((s) => {
    if (s.prob > 0.3 || !Number.isFinite(s.prob)) return false;
    if (/^v?\d{4}[-.]\d{2}[-.]\d{2}$/.test(s.version)) return false;
    const bare = s.version.replace(/^v/i, '');
    // 自己是某高prob候选的扩展(X.Y.Z 是 X.Y 的扩展)
    return baseVers.has(bare.split('.').slice(0, 2).join('.'));
  });
  const valid = [...base, ...prefixKeep];
  // ⚠️ valid 空兜底(2026-08-12): filter 重训后部分页面候选 prob 全 <0.3(SD v2.5=0.208/v3.0=0.002),
  // valid 空 → seed undefined 崩溃。取 prob 最高的 1-2 个兜底, 至少让 rank 有候选可判。
  if (valid.length === 0) {
    const fallback = scored
      .filter((s) => Number.isFinite(s.prob) && !/^v?\d{4}[-.]\d{2}[-.]\d{2}$/.test(s.version))
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 2);
    valid.push(...fallback);
    if (process.env.DEBUG_LLM) console.error('[rd] valid 空, 兜底取 prob 最高: ' + fallback.map((s) => s.version).join(','));
  }
  const globalMax = [...valid].sort((a, b) => rankVersionCompare(a.version, b.version)).pop()?.version || '';
  const rows = buildRankFeatureRows(html, valid, candidates, productName);
  const scores = await predictRankScores(rows);
  if (!scores) return null;
  const seedIndex = scores.reduce((best, score, index) => {
    if (score !== scores[best]) return score > scores[best] ? index : best;
    if (valid[index].prob !== valid[best].prob) return valid[index].prob > valid[best].prob ? index : best;
    return rankVersionCompare(valid[index].version, valid[best].version) > 0 ? index : best;
  }, 0);
  let seed = valid[seedIndex];
  if (process.env.DEBUG_LLM && !seed) console.error('[rd] seed undefined! seedIndex=' + seedIndex, 'valid.length=' + valid.length, 'scores.length=' + scores.length);
  const sorted = [...scores].sort((a, b) => b - a);
  const margin = sorted.length > 1 ? sorted[0] - sorted[1] : 1;
  const scopesOf = new Map(candidates.map((c) => [c.version, new Set(c.scopes || [])]));
  // (回滚 2026-08-11 v40): prob 优先替换 seed 是负收益——Insomnia v2023.5.8(年份版干扰)prob 高但
  // 模型打分低, 强行替换 seed 破坏 rank 综合判断, 4 例退化(76% < 92%)。恢复纯模型打分选 seed
  const tagOf = new Map(candidates.map((c) => [c.version, c.tag || null]));
  const pathsOf = new Map(candidates.map((c) => [c.version, c.paths || []]));
  const nodes = valid.map((s) => numericNode(s, null, tagOf.get(s.version) || null, pathsOf.get(s.version) || []));
  const family = buildNumericFamilies(nodes, scopesOf).find((f) => f.nodes.some((n) => n.result.version === seed.version));
  const seedScopes = scopesOf.get(seed.version) || new Set();
  const strongScope = seedScopes.has('download-link') || seedScopes.has('title') || seedScopes.has('structured') || seedScopes.has('heading');
  // 强 seed：有强 scope 证据（下载/标题/heading/结构化）或在多成员版本线内。
  // 强 seed 即使 margin 低（排名平票）也应信任 rank，不让 LLM 覆盖（Things v3.22）。
  const strong = strongScope || (family ? family.nodes.length > 1 : false);
  // 单点族且 seed 无强 scope 证据 → 极可能是孤立噪声（blender v330、redis v18.0），回退旧选择器
  if (family && family.nodes.length === 1 && !strongScope) return null;
  // ⚠️ family 归族同 major 选最大(2026-08-12): v42 是"族内选最大"——BTT seed=v6.701 提为 v6.712(同 6.x 族)。
  // 但 Bandizip v7.45 vs v8.1 被 prefix 归族误并入同族, "选最大"会错选 v8.1(OS 版本, 跨 major)。
  // 折中: 族内选最大, 但只限同 major 的候选(v7.45 与 v8.1 major 不同 → 不选 v8.1)。
  const seedMajor = rankVersionParts(seed.version)[0];
  const sameMajorMembers = family
    ? [...family.nodes].map((n) => n.result).filter((m) => rankVersionParts(m.version)[0] === seedMajor)
    : [seed];
  const result = sameMajorMembers.length > 1
    ? [...sameMajorMembers].sort((a, b) => rankVersionCompare(b.version, a.version))[0]
    : seed;
  if (process.env.DEBUG_LLM) console.error('[rd] seed=' + seed.version, 'family=' + (family ? family.nodes.length : 'none'), 'result=' + result?.version);
  return { result, margin, strong, globalMax };
}

export async function selectVersionByRankSeed(
  html: string,
  scored: LgbResult[],
  candidates: LgbCandidate[],
  productName?: string | null,
): Promise<LgbResult | null> {
  const d = await selectVersionByRankSeedDetailed(html, scored, candidates, productName);
  return d?.result || null;
}

// ── 版本号提取：LightGBM 评分替代启发式 ──
// 候选收集复用（多 scope）→ LightGBM 评分 → 选当前版本。
// LightGBM 不可用（python 缺失/超时）→ 回退现有启发式 extractVersionFromHtml。
// opts.productName：调用方已知的产品名（如 "gimp"），用于"产品名 + 版本号"权威锚定，
// 避免把页面里依赖库版本（GEGL/Mathjax）当主角。可靠且不依赖词表。
export async function extractVersionWithLgb(html: string, opts: { versionRegex?: string | null; productName?: string | null; rank?: boolean; llm?: boolean; onLlm?: (info: { margin: number; answer: string | null }) => void; onAudit?: (d: AuditDecision) => void } = {}): Promise<VersionResult> {
  // 显式正则最高优先（与启发式一致）
  if (opts.versionRegex) {
    const re = new RegExp(opts.versionRegex);
    const match = re.exec(html);
    const raw = match ? (match[1] !== undefined ? match[1] : match[0]) : null;
    if (raw) {
      return { version: 'v' + raw.replace(/^v/i, ''), source: 'version_regex', confidence: 'high', needsAiCheck: false, needsBrowser: false, suggestedRegex: opts.versionRegex };
    }
  }

  // 已知产品名 → 收集"产品名 + 版本号"锚点命中的版本集（GIMP 3.2 → v3.2）。
  // 页面里依赖库版本（GEGL 0.4.68 / Mathjax 3.2.2）紧邻的是库名，不会命中产品名锚点。
  // 锚点命中的候选在归族里获得族加分，但不短路——仍由归族综合密度/最新端判断，
  // 避免锚点命中历史版本（Things 页 "Things 3.11" 是旧版）就错误选中。
  const anchorHits = new Set<string>();
  if (opts.productName) {
    const esc = opts.productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const proto = new RegExp(`(?:${esc})[\\s-]*v?(\\d+(?:\\.\\d+){1,3})`, 'gi');
    for (const m of html.matchAll(proto)) {
      const v = m[1];
      if (/^\d{4}([.-]\d{1,2}){1,2}$/.test(v)) continue;
      anchorHits.add('v' + v.replace(/^v/i, ''));
    }
  }

  // JSON 响应（iTunes lookup 等）：命名字段确定性提取，启发式已处理，直接复用其结果
  const trimmed = html.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const hv = extractVersionFromHtml(html);
    if (hv.source === 'json') return hv;
  }

  // 用 export-candidates 的完整候选收集（与训练数据同源）：
  // 每个候选收集它出现的所有 scope 上下文（title/meta/heading/visible/download-link/structured/noise）
  const rawCandidates = collectExportCandidates(html);
  if (rawCandidates.length === 0) return { version: null, source: 'none', confidence: 'low', needsAiCheck: true, needsBrowser: true, suggestedRegex: null };
  const candidates: LgbCandidate[] = rawCandidates.map((c) => ({
    version: c.version,
    scopes: c.contexts.map((ctx) => ctx.scope),
    contexts: c.contexts,
    tag: c.tag,
    paths: c.paths,
  }));

  // 版本序列候选：页面标题/导航出现"8.5.0/8.4.5/..."这类版本序列时，序列版本加入候选池。
  // 不短路——序列可能是构建号/型号（Eagle v20-22 是 build，真实版本 v4.0），
  // 交回加权评分决定，由 LightGBM 概率 + 优先级综合。
  const seq = detectVersionSequence(html);
  const seqVersion = seq ? seq.latest : null;
  if (seqVersion) {
    candidates.push({ version: seqVersion, scopes: ['heading'] });
  }

  const scored = await predictCandidateVersions(candidates);
  // 选择：rank seed → 受限归族。rank 工件不可用/特征不匹配 → 回退旧归族。
  // 置信度用 rank margin：≥0.1 高置信；<0.1 触发 LLM（有产品名时）拿页面语境定夺。
  const rankDetail = opts.rank === false ? null : await selectVersionByRankSeedDetailed(html, scored, candidates, opts.productName || null);
  if (process.env.DEBUG_LLM) console.error('[evl] rankDetail.result=' + rankDetail?.result?.version, 'seqVersion=' + seqVersion, 'candidates=' + candidates.length);
  let selected: LgbResult | null = null;
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let llmTrace: AuditDecision['llm'] = null; // 审计用：LLM 是否触发/给了什么答案
  if (rankDetail) {
    selected = rankDetail.result;
    // 触发 LLM 兜底的条件:
    //   margin < 0.5 —— rank 有明显分歧就交给 LLM 语义裁决。
    //   注意不能加"seed 非 globalMax"限制: Termius 案例 seed=v26.10 恰好是候选池最大(但它是
    //   Ubuntu 版本, 错误的), 如果要求"非 globalMax 才触发"就把这种场景排除了。
    //   ⚠️ 不加 "strong 不触发": Blender(seed=v227 噪声, 多成员族 strong=true)需要 LLM 纠正;
    //   foobar2000(seed=v2.26 preview)也需要 LLM 纠正。strong 只表示 rank 有倾向, 不代表倾向正确。
    const llmNeeded = rankDetail.margin < 0.5;
    if (!llmNeeded) {
      confidence = rankDetail.margin >= 0.1 ? 'high' : 'low';
    } else if (opts.llm !== false && opts.productName) {
      // 交给纯文字 LLM 用候选清单判定(含全局最大版本, 让 LLM 能发现 rank 漏选的最新版)
      // ⚠️ 候选清单同样要"前缀保留": v0.dev 案例 v16.2.0 prob=0.02 会被 >0.3 过滤,
      //    LLM 永远看不到完整版 → 必须把低 prob 的完整版也喂给 LLM
      // ═══════ 争议集候选(2026-08-11 架构重构, 用户指出"补丁越加越多=任务定义错了") ═══════
      // 旧方案: 家族锚定+自适应数量+前缀保留+产品名强制 → 8-15 个候选, LLM 注意力分散,
      // 需要 6 条仲裁规则判"谁对"(seedHasDl0/seedIsPrerelease/llmIsTruncation/llmMoreComplete...)
      // 每条救一个案例又误伤一个(CPU-Z 救回/ImageMagick 误伤/audacity 误伤)。
      // 新方案: LLM 只看到"rank 有争议的候选"——seed + 归属 score 最高的 4 个。
      // LLM 的任务从"15 选 1"变成"5 选 1 的争议裁决", 答案在争议集内就采用, 无需复杂仲裁。
      const llmScored = scored.filter((s) => Number.isFinite(s.prob));
      const pn = (opts.productName || '').toLowerCase();
      // reranker(硅基流动 bge-reranker-v2-m3)对候选做产品归属打分——比规则"产品名共现"更准:
      // Termius 案例 v9.43.0(rerank 0.96, 产品版)vs v14.16.1(Ubuntu 版)rerank 能区分;
      // Terraform 案例 v1.15.8(稳定版)vs v1.16.0-beta(预发布)rerank 能识别。
      // 失败(无 key/超时)时返回 [] → 回退纯规则排序
      // ⚠️ 只对"有归属线索"的候选 rerank: Unity/Node.js 等 JSON 页面候选上下文是版本号+日期,
      // reranker 对纯数字列表无判别力, 反而把 v6000.0.81(含 version 字段)排前误导。跳过 JSON 页
      // ⚠️ 只 rerank 预筛后的少量候选(各族顶端 + prob top): BTT 2899 候选全喂 reranker
      // 会超时+限流(每例卡几分钟), 预筛 ≤15 个再 rerank 快且够
      let rerankScores: Map<string, number> = new Map();
      try {
        const preFilter = (() => {
          const fam = new Map<string, LgbResult>();
          for (const s of llmScored) {
            const bare = s.version.replace(/^v/i, '');
            const seg = bare.split('.');
            const f = seg.length >= 2 ? seg.slice(0, 2).join('.') : seg[0];
            const cur = fam.get(f);
            if (!cur || rankVersionCompare(s.version, cur.version) > 0) fam.set(f, s);
          }
          return [...fam.values()].sort((a, b) => b.prob - a.prob).slice(0, 15);
        })();
        const ctxSamples = preFilter.slice(0, 5).map((s) => {
          const cc = candidates.find((x) => x.version === s.version);
          return cc?.contexts?.[0]?.text || '';
        }).join(' ');
        const looksNatural = /[a-zA-Z]{3,}/.test(ctxSamples) && !/^\s*[\[\]{}\"0-9,\s]*$/.test(ctxSamples);
        if (looksNatural) {
          const rr = await rerankProductVersions(opts.productName || '', preFilter.map((s) => {
            const cc = candidates.find((x) => x.version === s.version);
            return { version: s.version, context: cc?.contexts?.[0]?.text || '' };
          }));
          // 归一化到 0-1, 存 version → score
          const max = Math.max(...rr.map((r) => r.score), 1e-9);
          rr.forEach((r) => {
            const s = preFilter[r.index];
            if (s) rerankScores.set(s.version, r.score / max);
          });
        }
      } catch { /* reranker 失败 → 空 map */ }
      const llmScoreOf = (s: LgbResult): number => {
        const cc = candidates.find((x) => x.version === s.version);
        if (!cc) return 0;
        const p = cc.contexts?.some((x) => x.text.toLowerCase().includes(pn)) ? 2 : 0;
        const h = cc.contexts?.some((x) => x.scope === 'heading') ? 3 : 0;
        const r = (rerankScores.get(s.version) || 0) * 2; // rerank 分 ×2(与产品名共现同权)
        return p + h + r;
      };
      // 争议集 = seed + 竞争候选(共 5):
      // ⚠️ 不能纯按 score 取 top4——Prometheus 案例 v3.5.4/v3.5.5(旧版)score=5 占满名额,
      // 正确 v3.13.2 排 #6 被截。竞争候选 = ①seed 同族最高版本(famMax, 各族顶端) ②score 高者
      // 这样 v3.13.2(3.x 族最高, 正确当前版)必进, v3.5.5(旧版)被各族顶端挤掉
      const famMax2 = new Map<string, LgbResult>();
      for (const s of llmScored) {
        const bare = s.version.replace(/^v/i, '');
        const seg = bare.split('.');
        const fam = seg.length >= 2 ? seg.slice(0, 2).join('.') : seg[0];
        const cur = famMax2.get(fam);
        if (!cur || rankVersionCompare(s.version, cur.version) > 0) famMax2.set(fam, s);
      }
      // 各族顶端 + score 高者混合, 按 score 降序取 4 个(各族顶端保证版本号最新候选可见)
      // ⚠️ 排序 tiebreak 用 prob(模型可信度)而非版本号: Termius 案例各族顶端 v14.16.1(Ubuntu 版)
      // 与 v9.43.0(产品版)score 相同, 按版本号降序 v14.16.1 排前误导 LLM; prob 是模型对
      // "是版本"的判断, v9.43.0 prob=0.9352 > v14.16.1, 更可信
      // ⚠️ 数量: 各族顶端必须全进(它们是"各族最新", 截断会丢正确版——Prometheus 案例 v3.13.2
      // 是 3.13 族顶端但 prob=0.707 低, 取 4 个会被 v3.5.5 挤掉)。族本身不多(≤10), 放宽到 10
      const famMaxVers2 = [...famMax2.values()];
      const llmContested = [...new Set([...famMaxVers2, ...llmScored])]
        .sort((a, b) => llmScoreOf(b) - llmScoreOf(a) || b.prob - a.prob)
        .slice(0, 10);
      const contestedVers = new Set([selected.version, ...llmContested.map((s) => s.version)]);
      const llmCandidates = candidates
        .filter((c) => contestedVers.has(c.version))
        .map((c) => ({ version: c.version, scopes: c.scopes, contexts: c.contexts, prob: scored.find((s) => s.version === c.version)?.prob }));
      const llmVer = await extractVersionWithLlm(html, opts.productName, { candidates: llmCandidates });
      opts.onLlm?.({ margin: rankDetail.margin, answer: llmVer }); // 暴露 LLM 判定结果（bench 测 LLM 准确性用）
      llmTrace = { triggered: true, margin: rankDetail.margin, answer: llmVer };
      if (process.env.DEBUG_LLM) console.error('[llm-check]', 'llmVer=' + llmVer, 'typeof=' + typeof llmVer, 'seed=' + selected.version);
      if (llmVer) {
        // ═══════ 简化仲裁(2026-08-11 架构重构) ═══════
        // LLM 候选 = 争议集(seed + score top4, 最多 5 个), LLM 看到的就是 rank 拿不准的候选。
        // 任务清晰后不再需要语义补丁(seedHasDl0/seedIsPrerelease/llmStrong 全删——它们每条
        // 救一个案例又误伤一个, 是"任务定义错"的症状)。只剩两条版本字符串硬规则:
        // ① LLM 答的是 seed 的截断(丢段/丢后缀) → 保留 seed(完整版更精确, Unity f1/mpv 反向)
        // ② LLM 答的更完整 → 采用 LLM(mpv v0.41.0 vs seed v0.41)
        const seedCand0 = candidates.find((cc) => cc.version === selected.version);
        const llmIsTruncation = llmVer !== selected.version && (
          selected.version.startsWith(llmVer + '.') ||
          selected.version.startsWith(llmVer + '-') ||
          // 紧贴字母数字后缀(6000.5.7f1 vs 6000.5.7)——必须先验证前缀一致!
          // ⚠️ bug: v5.64.396 vs v5.23.1, slice(7)='96' 纯数字误判截断, 但 v5.64.396 前缀不是 v5.23.1
          (llmVer.startsWith('v') === selected.version.startsWith('v') &&
           selected.version.startsWith(llmVer) &&
           selected.version.slice(llmVer.length).match(/^[a-z]?\d+$/i) !== null)
        );
        const llmMoreComplete = llmVer.startsWith(selected.version + '.') ||
          (llmVer.startsWith('v') === selected.version.startsWith('v') && llmVer.slice(selected.version.length).match(/^\.\d+/));
        if (llmVer === selected.version) {
          confidence = 'high';
        } else if (llmIsTruncation) {
          confidence = 'medium'; // 保留完整 seed
        } else if (llmMoreComplete) {
          selected = { version: llmVer, prob: 0.9 }; confidence = 'high';
        } else {
          // 争议集内 LLM 裁决: rank 与 LLM 冲突时, LLM 看到的是同样的候选 + 上下文,
          // 它的语义判断优先(它能识别 预发布/依赖版本/Ubuntu 版等 rank 不懂的信号)
          // ⚠️ 但 seed 是 JSON latest/structured 字段指向的版本时(Unity "latest":"6000.5.7f1"),
          // 结构化数据明确标注了最新版, LLM 的语义判断(可能选 alpha v6000.0.81)不应覆盖。
          // 注意: 只认 structured JSON 字段, 不认 "Latest version: X" 文本文案
          // (文案可能过时/指向 preview, 用户 2026-08-12 纠正——文本文案不是可靠信号)
          const seedIsLatestField = seedCand0?.contexts?.some((x) =>
            x.scope === 'structured' && /\blatest\b|"latest"|latest\s*[:=]/.test(x.text)
          );
          if (seedIsLatestField) {
            confidence = 'medium'; // 保留 JSON latest 标注的 seed
          } else {
            selected = { version: llmVer, prob: 0.9 }; confidence = 'high';
          }
        }
      } else {
        confidence = 'low';
      }
    } else {
      confidence = 'low';
    }
  } else {
    selected = selectVersionByFamily(scored, candidates, opts.productName || null, anchorHits.size > 0 ? anchorHits : null);
    confidence = selected ? (selected.prob >= 0.7 ? 'high' : selected.prob >= 0.3 ? 'medium' : 'low') : 'low';
    // rank 返回 null(单点族无强证据, v0.dev 案例 seed=v4.2.0 单点族)时也触发 LLM 兜底:
    // 候选里有 v16.2.0(期望)但 prob 0.02 太低, family 回退选 v2.5——LLM 从候选清单里可能选对
    if (selected && opts.llm !== false && opts.productName && scored.length > 0) {
      const pn = (opts.productName || '').toLowerCase();
      const llmScored2 = scored.filter((s) => Number.isFinite(s.prob));
      // rank=null 场景候选本来就少(≤15), 全部给 LLM 不过滤——
      // v0.dev 的 v16.2.0 prob=0.02 前缀不在 base(v16.2), 任何过滤都会丢它
      const llmPool2 = llmScored2.length <= 15 ? llmScored2 : llmScored2.slice(0, 15);
      if (llmPool2.length > 0) {
        try {
          const llmVer2 = await extractVersionWithLlm(html, opts.productName, {
            candidates: llmPool2.map((s) => {
              const cc = candidates.find((x) => x.version === s.version);
              return { version: s.version, scopes: cc?.scopes || [], contexts: cc?.contexts || [], prob: s.prob };
            }),
          });
          if (llmVer2 && llmVer2 !== selected.version) {
            const llmCand2 = candidates.find((cc) => cc.version === llmVer2);
            const llmStrong2 = llmCand2?.contexts?.some((x) => x.text.toLowerCase().includes(pn));
            if (llmStrong2) {
              selected = { version: llmVer2, prob: 0.9 };
              confidence = 'medium';
            }
          }
        } catch { /* LLM 失败不阻塞 */ }
      }
    }
  }
  if (!selected) {
    // 过滤后无候选 / python 不可用 → 回退启发式
    const hv = extractVersionFromHtml(html, opts);
    opts.onAudit?.({
      productName: opts.productName || null,
      filterThreshold: 0.3,
      candidates: [],
      rank: null,
      llm: null,
      final: { version: hv.version, confidence: hv.confidence, source: hv.source, suggestedRegex: hv.suggestedRegex, matchedContext: hv.matchedContext },
    });
    return hv;
  }
  const best = selected;
  const sourceScope = candidates.find((c) => c.version === best.version)?.scopes?.[0] || 'body';
  const suggestedRegex = best.version.replace(/^v/i, '').split('.').length >= 3 ? `v?(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)` : `v?(\\d+\\.\\d+)`;
  // matchedContext：选中候选的上下文片段（比 raw indexOf 干净——indexOf 会命中 CSS/JS 里的同名数字）
  const matchedContext = (() => {
    const candCtx = candidates.find((c) => c.version === best.version)?.contexts?.[0]?.text;
    const text = (candCtx || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 200) || undefined;
    const bare = best.version.replace(/^v/i, '');
    const idx = html.indexOf(bare);
    if (idx < 0) return undefined;
    return html.slice(Math.max(0, idx - 60), Math.min(html.length, idx + 60)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || undefined;
  })();
  // 审计：记录候选+概率+rank+LLM+最终，由调用方(pipeline)补 url/html 后落库
  opts.onAudit?.({
    productName: opts.productName || null,
    filterThreshold: 0.3,
    candidates: candidates.map((c) => ({
      version: c.version,
      scopes: c.scopes,
      contexts: (c.contexts || []).map((x) => ({ scope: x.scope, text: x.text.length > 300 ? x.text.slice(0, 300) + '…' : x.text })),
      tag: c.tag,
      paths: c.paths,
      prob: scored.find((s) => s.version === c.version)?.prob ?? null,
      isSeed: rankDetail ? c.version === rankDetail.result?.version : undefined,
    })),
    rank: rankDetail ? { seed: rankDetail.result?.version || null, margin: rankDetail.margin, strong: rankDetail.strong } : null,
    llm: llmTrace,
    final: { version: best.version, confidence, source: sourceScope, suggestedRegex, matchedContext },
  });
  return {
    version: best.version,
    source: sourceScope,
    confidence,
    needsAiCheck: confidence !== 'high',
    needsBrowser: false,
    suggestedRegex,
    matchedContext,
    candidates: [...scored].sort((a, b) => b.prob - a.prob).slice(0, 8).map((s) => ({
      version: s.version,
      score: Math.round(s.prob * 100),
      inDownloadUrl: candidates.find((c) => c.version === s.version)?.scopes?.includes('download-link') || false,
      scope: candidates.find((c) => c.version === s.version)?.scopes?.[0] || 'body',
    })),
  };
}
