// 选择层新特征（2026-08-16）：候选邻近日期新近度 + 声明词距离
//
// 背景：58 例基准的 16 个 FAIL 里 9 例是"真版本在候选池内但 rank 选错"（用完整候选池
// allCandidates 归因，非 top-8 截断）。实测这 9 例的判别信号都存在于候选上下文中，
// 但 37 个排序特征无一读取：
//   Fork(池183):  v2.69 邻近 "10 Jul 2026" vs v2.22 邻近 "16 Sep 2022" —— 4 年差
//   Termius:      v9.43.1 邻近 "latest/stable" vs v24.04 属于 "Ubuntu 24.04"(非本产品)
// changelog/release-notes 页把历史版本全部采集进池后，同族候选的 scope、出现次数、
// 路径分布几乎完全相同 → 现有特征无区分度 → 长列表排序必然失效。
//
// ⚠️ 训练(build-train3.ts)与推理(lgb-score.ts)必须调用同一实现，否则特征语义漂移会
// 造成"列数一致但分布不一致"的静默偏差——比列数不一致更难发现（后者至少会报错）。

export interface CtxLike { scope?: string; text: string }

// 日期形态：2026-08-16 / 2026/8/16 / 16 Jul 2026 / Jul 16, 2026 / 2026年8月16日
const DATE_PATTERNS: RegExp[] = [
  /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/,
  /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(20\d{2})\b/i,
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i,
  /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
];
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// 从文本抽第一个日期 → 时间戳（毫秒）；无日期返回 null
export function parseFirstDate(text: string): number | null {
  if (!text) return null;
  for (let i = 0; i < DATE_PATTERNS.length; i++) {
    const m = text.match(DATE_PATTERNS[i]);
    if (!m) continue;
    let y: number, mo: number, d: number;
    if (i === 1) {
      d = Number(m[1]); mo = MONTHS[m[2].slice(0, 3).toLowerCase()] || 0; y = Number(m[3]);
    } else if (i === 2) {
      mo = MONTHS[m[1].slice(0, 3).toLowerCase()] || 0; d = Number(m[2]); y = Number(m[3]);
    } else {
      y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
    }
    if (!y || !mo || !d || mo > 12 || d > 31) continue;
    const ts = Date.UTC(y, mo - 1, d);
    // 合理区间：1990 ~ 今天+1年（防把 viewBox 坐标/版本号误解析成日期）
    if (ts < Date.UTC(1990, 0, 1) || ts > Date.now() + 365 * 864e5) continue;
    return ts;
  }
  return null;
}

// 页面内所有候选上下文的日期范围（用于把绝对时间归一化成页内相对新近度）
export function pageDateSpan(allContexts: (CtxLike[] | undefined)[]): { min: number; max: number } | null {
  const stamps: number[] = [];
  for (const ctxs of allContexts) {
    for (const c of ctxs || []) {
      const ts = parseFirstDate(c.text);
      if (ts !== null) stamps.push(ts);
    }
  }
  if (stamps.length < 2) return null; // 少于 2 个日期无法构成相对排序
  return { min: Math.min(...stamps), max: Math.max(...stamps) };
}

// 候选邻近日期的新近度：页内最旧=0，最新=1；无日期或页面无日期跨度=0.5（中性）
// 用相对而非绝对（距今天数），因为页面新旧差异很大：一个 2020 年停更的软件，
// 其"最新版"的绝对新近度很低，但页内相对新近度仍应为 1。
export function dateRecency(ctxs: CtxLike[] | undefined, span: { min: number; max: number } | null): number {
  if (!span || span.max === span.min) return 0.5;
  let best: number | null = null;
  for (const c of ctxs || []) {
    const ts = parseFirstDate(c.text);
    if (ts !== null && (best === null || ts > best)) best = ts;
  }
  if (best === null) return 0.5;
  const r = (best - span.min) / (span.max - span.min);
  return Math.max(0, Math.min(1, r));
}

// 声明词：宽于 latest_annotated 的严格 "latest version:" 正则
const DECL_WORDS = /(latest|current|newest|stable|recommended|最新|当前|正式版|稳定版)/i;

// 到声明词的 token 距离，归一化 1/(1+dist)：紧邻=1，距离 3=0.25，无声明词=0
// 连续值而非布尔判定——让模型学权重，不做词表硬过滤（词表只决定"看哪些词"，
// 不决定"候选真假"）。
export function declDistance(ctxs: CtxLike[] | undefined): number {
  let best = 0;
  for (const c of ctxs || []) {
    const text = c.text || '';
    const m = text.match(DECL_WORDS);
    if (!m || m.index === undefined) continue;
    // 版本号在上下文中的位置（候选上下文以候选为中心，取首个版本号样 token）
    const vm = text.match(/\bv?\d+(?:\.\d+){1,3}\b/);
    if (!vm || vm.index === undefined) continue;
    const between = text.slice(Math.min(m.index, vm.index), Math.max(m.index, vm.index));
    const dist = between.split(/\s+/).filter(Boolean).length;
    const score = 1 / (1 + dist);
    if (score > best) best = score;
  }
  return best;
}
