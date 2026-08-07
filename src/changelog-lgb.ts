// 更新日志主路径：Trafilatura 清洗正文 + LightGBM 选版本
//
// 用户策略：
//   ① Trafilatura 清洗页面 → 干净正文（结构无关，postgresql/obsidian 等）
//   ② 从原始 HTML 收集版本候选 + 各 scope 上下文（title/url/heading/json-ld/body）
//   ③ 其他位置补充上下文
//   ④ LightGBM 评分候选 → 选当前版本
//   纯文本（nginx <pre>）和 JS 壳（python fallback）交给兜底规则/浏览器。
import { fetchPage } from './crawler';
import { cleanWithTrafilatura } from './trafilatura';
import { predictCandidateVersions, selectVersionByFamily, selectVersionByRankSeed } from './lgb-score';
import { extractVersionFromHtml } from './version-extract';
import { collectCandidates as collectExportCandidates } from '../scripts/export-candidates';
import { normalizeVersion, findLatestVersionLinkWithVersion, findLatestChangelogDetailLink } from './changelog';
import type { ChangelogEntry, UpdateSource } from './types';

// 页面含版本标题（"Changes with nginx 1.31.3" / "Fixed in 8.21.0"）时，标题版本是权威锚点
function headerVersion(html: string): string | null {
  const m = html.match(/(?:Changes?\s+with\s+[^\s<]+\s+|Fixed\s+in\s+|Release\s+|Version\s+)[\s]*v?(\d+(?:\.\d+){1,3})/i);
  return m ? normalizeVersion(m[1]) : null;
}

export async function extractChangelogWithTrafilatura(
  source: UpdateSource,
  opts: { version?: string; pageHtml?: string; productName?: string | null } = {}
): Promise<ChangelogEntry | null> {
  if (!source.url) return null;
  const r = opts.pageHtml ? { text: opts.pageHtml, error: undefined } : await fetchPage(source.url, { timeout: 15000 });
  if (r.error || !r.text) return null;
  let html = r.text;

  // 列表/博客页：页面只有版本列表/文章索引，真实日志在详情页里。
  // 先跟随最新版本详情链接（postgresql /docs/release/18.4/、python 新闻文章、obsidian /changelog/...-v1.13.4/），
  // 再对详情页 Trafilatura 清洗——否则洗到的是列表首页简介（postgresql "archive of release notes"）。
  const latestLink = findLatestVersionLinkWithVersion(html, source.url) || findLatestChangelogDetailLink(html, source.url, opts.version);
  if (latestLink && latestLink.url !== source.url) {
    const detail = await fetchPage(latestLink.url, { timeout: 15000 });
    if (detail.text && !detail.error) {
      html = detail.text;
      if (!opts.version) opts = { ...opts, version: latestLink.version };
    }
  }

  // 1. Trafilatura 清洗整页正文（结构无关；纯文本 <pre>/JS 壳会失败，返回 null 走兜底）
  const content = await cleanWithTrafilatura(html);
  if (!content || content.length < 40) return null;

  // 2. 版本候选：优先调用方给定（版本提取器结果）；否则 LightGBM 选
  let version: string;
  if (opts.version) {
    version = normalizeVersion(opts.version);
  } else {
    // 标题锚点权威优先（curl/nginx 的 "Fixed in 8.21.0"）
    const hdr = headerVersion(html);
    if (hdr) {
      version = hdr;
    } else {
      // 收集候选（与训练数据同源）→ LightGBM 评分 → 【归族选版】（与版本提取器同一策略）
      const candidates = collectExportCandidates(html).map((c) => ({
        version: c.version,
        scopes: c.contexts.map((x) => x.scope),
        contexts: c.contexts,
        tag: c.tag,
        paths: c.paths,
      }));
      if (candidates.length === 0) return null;
      const scored = await predictCandidateVersions(candidates);
      const ranked = await selectVersionByRankSeed(html, scored, candidates, opts.productName || null);
      const selected = ranked || selectVersionByFamily(scored, candidates, opts.productName || null);
      if (selected) {
        version = selected.version;
      } else {
        // python 不可用 / 无有效候选 → 现有启发式兜底
        const heuristic = extractVersionFromHtml(html);
        version = heuristic.version || 'v0.0.0';
      }
    }
  }

  // 3. 组装 changelog：Trafilatura 正文 + 选定版本
  return {
    version,
    date: null,
    title: null,
    content,
    source: 'changelog-page',
    language: /[一-鿿]/.test(content) && (content.match(/[一-鿿]/g) || []).length / Math.max(content.length, 1) > 0.05 ? 'zh' : 'en',
    confidence: 'high',
  };
}
