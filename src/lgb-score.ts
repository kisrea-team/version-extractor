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
export function buildFeatureRow(version: string, scopes: string[]): LgbRow {
  const base = version.replace(/^[vV]/, '').split('-')[0].split('+')[0];
  const nums = (base.match(/\d+/g) || []).map(Number);
  const seg = base.split('.');
  const scopeSet = new Set(scopes);
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
  const rows: LgbRow[] = candidates.map((c) => buildFeatureRow(c.version, c.scopes));
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
export interface RankSeedDetail { result: LgbResult; margin: number; strong: boolean; }
export async function selectVersionByRankSeedDetailed(
  html: string,
  scored: LgbResult[],
  candidates: LgbCandidate[],
  productName?: string | null,
): Promise<RankSeedDetail | null> {
  const valid = scored.filter((s) => Number.isFinite(s.prob) && s.prob > 0.3 && !/^v?\d{4}[-.]\d{2}[-.]\d{2}$/.test(s.version));
  if (valid.length === 0) return null;
  const rows = buildRankFeatureRows(html, valid, candidates, productName);
  const scores = await predictRankScores(rows);
  if (!scores) return null;
  const seedIndex = scores.reduce((best, score, index) => {
    if (score !== scores[best]) return score > scores[best] ? index : best;
    if (valid[index].prob !== valid[best].prob) return valid[index].prob > valid[best].prob ? index : best;
    return rankVersionCompare(valid[index].version, valid[best].version) > 0 ? index : best;
  }, 0);
  const seed = valid[seedIndex];
  const sorted = [...scores].sort((a, b) => b - a);
  const margin = sorted.length > 1 ? sorted[0] - sorted[1] : 1;
  const scopesOf = new Map(candidates.map((c) => [c.version, new Set(c.scopes || [])]));
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
  const result = family ? ([...family.nodes].sort(compareEvolution).pop()?.result || seed) : seed;
  return { result, margin, strong };
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
  let selected: LgbResult | null = null;
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let llmTrace: AuditDecision['llm'] = null; // 审计用：LLM 是否触发/给了什么答案
  if (rankDetail) {
    selected = rankDetail.result;
    if (rankDetail.margin >= 0.1) {
      confidence = 'high';
    } else if (opts.llm !== false && opts.productName) {
      // 低 margin = rank 模型在两个候选间摇摆，交给纯文字 LLM 用候选清单判定
      const llmCandidates = candidates
        .filter((c) => scored.some((s) => s.version === c.version && Number.isFinite(s.prob) && s.prob > 0.3))
        .map((c) => ({ version: c.version, scopes: c.scopes, contexts: c.contexts, prob: scored.find((s) => s.version === c.version)?.prob }));
      const llmVer = await extractVersionWithLlm(html, opts.productName, { candidates: llmCandidates });
      opts.onLlm?.({ margin: rankDetail.margin, answer: llmVer }); // 暴露 LLM 判定结果（bench 测 LLM 准确性用）
      llmTrace = { triggered: true, margin: rankDetail.margin, answer: llmVer };
      if (llmVer) { selected = { version: llmVer, prob: 0.9 }; confidence = 'high'; }
      else confidence = 'low';
    } else {
      confidence = 'low';
    }
  } else {
    selected = selectVersionByFamily(scored, candidates, opts.productName || null, anchorHits.size > 0 ? anchorHits : null);
    confidence = selected ? (selected.prob >= 0.7 ? 'high' : selected.prob >= 0.3 ? 'medium' : 'low') : 'low';
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
