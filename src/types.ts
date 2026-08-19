// 软件更新数据提取模型 —— 共享类型
//
// 三个子模块：
//   SourceResolver    更新源识别
//   VersionExtractor  版本号提取（规则化，不依赖 LLM）
//   ChangelogExtractor 更新日志提取（规则化，不依赖 LLM）

export type Confidence = 'high' | 'medium' | 'low';

// ── 版本号提取结果 ──
export interface VersionResult {
  version: string | null;
  source: string; // version_regex | title | structured | body | url | none
  confidence: Confidence;
  needsAiCheck: boolean; // 只有 high 才免 AI
  needsBrowser: boolean; // 页面疑似 JS 渲染，启发式拿不到 → 建议 chrome-devtools/AI
  suggestedRegex: string | null;
  matchedContext?: string;
  candidates?: Array<{ version: string; score: number; inDownloadUrl: boolean; scope: string }>;
  // 完整候选池（无 top-8 截断）：用于失败层归因，区分采集层漏召回 vs 选择层选错
  allCandidates?: string[];
}

// ── 更新源识别 ──
export type UpdateSourceType = 'github-releases' | 'github-tags' | 'rss' | 'changelog-page' | 'json' | 'none';

export interface UpdateSource {
  type: UpdateSourceType;
  url: string;
  confidence: Confidence;
  note?: string;
  // 解析后的定位信息
  owner?: string;
  repo?: string;
  feedUrl?: string;
}

// ── 更新日志提取结果 ──
export interface ChangelogEntry {
  version: string;
  date?: string | null;
  title?: string | null;
  content: string; // Markdown
  source: 'github-release' | 'github-tag' | 'rss' | 'changelog-page' | 'json' | 'official-endpoint' | 'none';
  language?: 'zh' | 'en' | 'other' | 'unknown';
  confidence: Confidence;
}

// ── 交叉校验 ──
export interface CrossCheckResult {
  verdict: 'update' | 'equal' | 'downgrade' | 'incomparable';
  reason: string;
  trustable: boolean;
}
