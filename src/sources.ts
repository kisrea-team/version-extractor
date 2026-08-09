// 更新源识别：给定 URL，判断它属于哪种更新来源，并解析定位信息
import type { UpdateSource } from './types';
import { fetchPage } from './crawler';

export function classifySource(input: string): UpdateSource {
  const url = String(input || '').trim();
  if (!url) return { type: 'none', url, confidence: 'low' };

  // GitHub releases 页 / 仓库
  const ghMatch = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(.*)$/i);
  if (ghMatch) {
    const [, owner, repo, rest] = ghMatch;
    const lower = rest.toLowerCase();
    if (lower.includes('/releases')) {
      return { type: 'github-releases', url, confidence: 'high', owner, repo, note: 'GitHub Releases 页' };
    }
    if (lower.includes('/tags')) {
      return { type: 'github-tags', url, confidence: 'high', owner, repo, note: 'GitHub Tags 页' };
    }
    return { type: 'github-releases', url, confidence: 'high', owner, repo, note: 'GitHub 仓库（默认走 releases）' };
  }

  // raw.githubusercontent.com 的 CHANGELOG 文件：仓库 owner/repo 从路径解析，
  // 走 GitHub releases API（真实 tag + release body），避免把 md 当 HTML 页清洗
  // （newton-physics/newton 案例：v1.16.0 是正文 warp-lang 依赖版本，真实 release 是 v1.4.0）
  const rawGh = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//i);
  if (rawGh) {
    return { type: 'github-releases', url, confidence: 'high', owner: rawGh[1], repo: rawGh[2], note: 'raw.githubusercontent.com 仓库文件（走 releases）' };
  }

  // API 形式的 GitHub releases
  const ghApi = url.match(/^https?:\/\/api\.github\.com\/repos\/([^/]+)\/([^/#?]+)(.*)$/i);
  if (ghApi) {
    return { type: 'github-releases', url, confidence: 'high', owner: ghApi[1], repo: ghApi[2], note: 'GitHub API' };
  }

  // RSS/Atom
  if (/\.(xml|rss|atom)(\?|#|$)/i.test(url) || /\/feed(\/|$)/i.test(url) || /\/rss(\/|$)/i.test(url)) {
    return { type: 'rss', url, confidence: 'high', feedUrl: url, note: 'RSS/Atom feed' };
  }

  // 默认：changelog 页面（运行时可进一步检测 feed 链接）
  return { type: 'changelog-page', url, confidence: 'medium', note: 'Changelog 页面（待页面级检测）' };
}

// 对 changelog-page 做页面级增强：检测 <head> 里的 RSS/Atom（仅记录提示，不切换类型——
// 切换成 rss 后若 feed 解析失败会丢失页面提取兜底）
export async function enrichSource(source: UpdateSource): Promise<UpdateSource> {
  if (source.type !== 'changelog-page' || !source.url) return source;
  const r = await fetchPage(source.url, { timeout: 12000 });
  if (r.error || !r.text) return source;
  const head = r.text.match(/<head[\s>]([\s\S]*?)<\/head>/i)?.[1] || '';
  const feedLink = head.match(/<link[^>]+type=["'](?:application\/rss\+xml|application\/atom\+xml)["'][^>]*href=["']([^"']+)["']/i);
  if (feedLink) {
    let feedUrl = feedLink[1];
    if (feedUrl.startsWith('/')) feedUrl = new URL(feedUrl, source.url).href;
    return { ...source, note: `检测到 feed: ${feedUrl}` };
  }
  return { ...source, note: '未检测到 feed，按 changelog 页面处理' };
}
