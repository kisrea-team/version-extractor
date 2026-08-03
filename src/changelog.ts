// 更新日志提取（规则化，不依赖 LLM）
//
// 三种来源：
//   github-releases：GitHub API release body（结构化，最高可靠）
//   rss：RSS/Atom feed 条目（按版本号匹配）
//   changelog-page：官网 changelog 页（定位版本标题 → 截取区块 → HTML→Markdown）
import TurndownService from 'turndown';
import Parser from 'rss-parser';
import type { ChangelogEntry, UpdateSource, Confidence } from './types';
import { fetchJson, fetchPage } from './crawler';
import { compareVersions } from './version-extract';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const rssParser = new Parser();

function normalizeVersion(v: string): string {
  const t = String(v || '').trim();
  return /^v/i.test(t) ? t : `v${t}`;
}

function cleanMarkdown(content: string): string {
  return content.replace(/\n{3,}/g, '\n\n').trim();
}

function detectLanguage(text: string): ChangelogEntry['language'] {
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  if (cjk > 0 && cjk / Math.max(text.length, 1) > 0.05) return 'zh';
  return 'en';
}

// ── GitHub Releases ──
export async function extractFromGithubReleases(source: UpdateSource, opts: { token?: string } = {}): Promise<ChangelogEntry | null> {
  const { owner, repo } = source;
  if (!owner || !repo) return null;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  // 先取 latest（快），失败再翻列表取最新非 prerelease
  const latest = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { timeout: 12000 });
  let release: any = latest.status === 200 ? (latest.body as any) : null;
  if (!release || release.draft || release.prerelease) {
    const list = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`, { timeout: 12000 });
    const arr = (list.body as any[]) || [];
    release = arr.find((r) => r && !r.draft && !r.prerelease && r.tag_name) || null;
  }
  if (!release) return null;

  const content = cleanMarkdown(String(release.body || '').trim());
  if (!content) return null;
  return {
    version: normalizeVersion(release.tag_name),
    date: release.published_at || null,
    title: release.name || null,
    content,
    source: 'github-release',
    language: detectLanguage(content),
    confidence: 'high',
  };
}

// ── RSS/Atom ──
export async function extractFromRss(feedUrl: string, opts: { version?: string } = {}): Promise<ChangelogEntry | null> {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const items = feed.items || [];
    if (items.length === 0) return null;

    // 优先按目标版本匹配；否则取最新条目
    let item: any = null;
    if (opts.version) {
      const target = normalizeVersion(opts.version).replace(/^v/i, '');
      item = items.find((it: any) => {
        const hay = `${it.title || ''} ${it.contentSnippet || ''} ${it.content || ''}`;
        return hay.includes(target);
      }) || null;
    }
    if (!item) item = items[0];
    if (!item) return null;

    let content = item.content || item.contentSnippet || '';
    if (!content) return null;
    // RSS 内容可能是 HTML，转 Markdown
    if (/<[a-z][\s\S]*>/i.test(content)) content = turndown.turndown(content);
    content = cleanMarkdown(content);

    return {
      version: opts.version ? normalizeVersion(opts.version) : normalizeVersion(item.title?.match(/\d+\.\d+(?:\.\d+)?/)?.[0] || '0.0.0'),
      date: item.isoDate || item.pubDate || null,
      title: item.title || null,
      content,
      source: 'rss',
      language: detectLanguage(content),
      confidence: 'high',
    };
  } catch {
    return null;
  }
}

// ── Changelog 页面（定位版本标题 → 截取区块）──
export function extractFromChangelogPage(html: string, opts: { version?: string } = {}): ChangelogEntry | null {
  if (!html) return null;
  const target = opts.version ? opts.version.replace(/^v/i, '') : null;

  // ① 无 h1-h4 版本标题的页面（nginx CHANGES 等纯文本/近纯文本）→ 纯文本按版本行切块
  if (!/<h[1-4][^>]*>[^<]*v?\d+\.\d+[^<]*<\/h[1-4]>/i.test(html)) {
    const pt = extractFromPlainText(html, target);
    if (pt) return pt;
  }

  // ② 收集标题节点（带 id 的 heading 最容易匹配版本）
  const headings = [...html.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    level: Number(m[1]),
    html: m[2],
    index: m.index as number,
    text: m[2].replace(/<[^>]+>/g, '').trim(),
  }));

  // 找到包含目标版本的标题（优先），否则取第一个含版本号的标题
  let idx = headings.findIndex((h) => target && h.text.includes(target));
  if (idx === -1) idx = headings.findIndex((h) => /\bv?\d+\.\d+(?:\.\d+)?\b/.test(h.text));
  if (idx === -1) return null;

  const h = headings[idx];
  const versionMatch = h.text.match(/\bv?(\d+\.\d+(?:\.\d+)?)/);
  const version = normalizeVersion(versionMatch ? versionMatch[1] : opts.version || '0.0.0');

  // 截取该标题到下一个同级/更高层级标题之间的内容
  const next = headings.slice(idx + 1).find((x) => x.level <= h.level);
  const start = h.index;
  const end = next ? next.index : html.length;
  const sectionHtml = html.slice(start, end);

  // 去掉标题本身，保留正文
  const bodyHtml = sectionHtml.replace(/<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>/i, '').replace(/<[^>]+>\s*$/i, '');
  let content = turndown.turndown(bodyHtml || sectionHtml);
  content = cleanMarkdown(content);
  if (!content) return null;

  const dateMatch = html.slice(Math.max(0, h.index - 200), h.index + 500).match(/datetime=["']([^"']+)["']/i) || html.slice(Math.max(0, h.index - 200), h.index + 500).match(/\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/);

  return {
    version,
    date: dateMatch ? dateMatch[1] : null,
    title: h.text,
    content,
    source: 'changelog-page',
    language: detectLanguage(content),
    confidence: 'medium',
  };
}

// 纯文本 changelog（nginx CHANGES / postgresql 等）：按"版本行 + 后续行"切块
function extractFromPlainText(text: string, target: string | null): ChangelogEntry | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  // 版本行：以版本号开头的行，如 "Changes with nginx 1.31.3" / "2026-07-15  PostgreSQL 18.2"
  const versionLineRe = /(?:^|\s)(?:v|version\s+)?(\d+(?:\.\d+){1,3})(?:\s|$)/i;
  let idx = -1;
  if (target) idx = lines.findIndex((l) => l.includes(target));
  if (idx === -1) idx = lines.findIndex((l) => versionLineRe.test(l) && !/^[A-Z]{2,}/.test(l));
  if (idx === -1) return null;

  const v = lines[idx].match(versionLineRe)?.[1];
  if (!v) return null;
  // 取到下一个版本行之间的内容
  const next = lines.slice(idx + 1).findIndex((l) => versionLineRe.test(l) && l !== lines[idx]);
  const contentLines = next === -1 ? lines.slice(idx + 1) : lines.slice(idx + 1, idx + 1 + next);
  const content = contentLines.filter(Boolean).join('\n').trim();
  if (!content) return null;

  return {
    version: normalizeVersion(v),
    date: lines[idx].match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})/)?.[1] || null,
    title: lines[idx],
    content,
    source: 'changelog-page',
    language: detectLanguage(content),
    confidence: 'medium',
  };
}

// 列表页（python news / blender releases 等）：找含版本号的链接，返回最新的那个
// 版本链接特征：href 或链接文本里带版本号，且 href 不含 js/css
function findLatestVersionLink(html: string, baseUrl: string): string | null {
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, ' ').trim() }))
    .filter((l) => !/\.(js|css|map)(\?|#|$)/i.test(l.href))
    .map((l) => {
      const m = (l.href + ' ' + l.text).match(/\bv?(\d+(?:\.\d+){1,3})\b/);
      return m ? { href: l.href, version: m[1] } : null;
    })
    .filter((x): x is { href: string; version: string } => x !== null);

  if (links.length === 0) return null;
  // 取版本最高的链接（列表页通常按最新在前，但取 max 更稳）
  let best = links[0];
  for (const l of links) {
    if (compareVersions(`v${l.version}`, `v${best.version}`) > 0) best = l;
  }
  // 解析相对链接
  try {
    return new URL(best.href, baseUrl).href;
  } catch {
    return best.href;
  }
}

// ── 统一入口 ──
export async function extractChangelog(
  source: UpdateSource,
  opts: { token?: string; version?: string; pageHtml?: string } = {}
): Promise<ChangelogEntry | null> {
  try {
    switch (source.type) {
      case 'github-releases':
        return await extractFromGithubReleases(source, { token: opts.token || process.env.GITHUB_TOKEN });
      case 'rss':
        return source.feedUrl ? await extractFromRss(source.feedUrl, { version: opts.version }) : null;
      case 'changelog-page':
        if (opts.pageHtml) return extractFromChangelogPage(opts.pageHtml, { version: opts.version });
        if (source.url) {
          const r = await fetchPage(source.url, { timeout: 15000 });
          if (r.error || !r.text) return null;
          // 先内联提取；失败则列表页跟随最新版本链接
          const inline = extractFromChangelogPage(r.text, { version: opts.version });
          if (inline) return inline;
          const latestLink = findLatestVersionLink(r.text, source.url);
          if (latestLink) {
            const page2 = await fetchPage(latestLink, { timeout: 15000 });
            if (page2.text && !page2.error) {
              const followed = extractFromChangelogPage(page2.text, { version: opts.version });
              if (followed) return { ...followed, source: 'changelog-page', confidence: 'medium' };
            }
          }
          return null;
        }
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export { compareVersions };
