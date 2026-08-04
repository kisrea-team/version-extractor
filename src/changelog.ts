// 更新日志提取（规则化，不依赖 LLM）
//
// 三种来源：
//   github-releases：GitHub API release body（结构化，最高可靠）
//   rss：RSS/Atom feed 条目（按版本号匹配）
//   changelog-page：官网 changelog 页（先判结构类型 → 定位版本区块 → 净化 HTML → Markdown）
import TurndownService from 'turndown';
import Parser from 'rss-parser';
import type { ChangelogEntry, UpdateSource, Confidence } from './types';
import { fetchJson, fetchPage } from './crawler';
import { compareVersions } from './version-extract';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const rssParser = new Parser();

// changelog 页面结构类型
export type ChangelogType = 'plain-text' | 'heading' | 'list' | 'blog' | 'js-render' | 'none';

export function normalizeVersion(v: string): string {
  const t = String(v || '').trim();
  const noV = t.replace(/^v+/i, '');
  return `v${noV}`;
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

// ── Changelog 页面结构分类 ──
// changelog 结构差异本质是"版本区块组织方式不同"，先分类再按类提取，替代单一字符串切割。
export function detectChangelogType(html: string, url?: string): ChangelogType {
  if (!html) return 'none';
  // SPA 壳：根节点为空/只有 JS 入口，版本在 JS 渲染后出现
  const rootEmpty = /<div\s+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(html)
    && !/<h[1-6][^>]*>[^<]*v?\d+\.\d+/.test(html)
    && !/\b(?:Changes|Release|Version|Changelog)\s+(?:with\s+)?v?\d+\.\d+/i.test(html);
  if (rootEmpty) return 'js-render';
  // JS 入口 + 无任何版本痕迹
  if (/<script[^>]*src=["'][^"']*(_next|app\.|main\.|bundle)[^"']*["']/i.test(html)
    && !/<h[1-6][^>]*>[^<]*v?\d+\.\d+/.test(html)
    && !/\bv?\d+\.\d+\.\d+\b/.test(html)) {
    return 'js-render';
  }
  // 纯文本：nginx CHANGES 风格（"Changes with nginx 1.31.3" / 版本行开头）
  if (/\b(?:Changes|Changelog)\s+(?:with\s+[\w.-]+\s+)?v?\d+\.\d+/i.test(html)
    || /^[ \t]*(?:Changes|Changelog)[\s\S]{0,30}?v?\d+\.\d+\.\d+/mi.test(html)
    || /^[ \t]*v?\d+\.\d+\.\d+[ \t]*$/m.test(html)) {
    return 'plain-text';
  }
  // 标题式：有版本标题 heading（blender/obsidian）
  const hasHeading = /<h[1-4][^>]*>[^<]*v?\d+\.\d+[^<]*<\/h[1-4]>/i.test(html);
  // 博客式：版本是文章标题链接（python news "Python 3.15.0 beta 4 is here!" / gimp news）
  const hasVersionLink = /<a[^>]+href=["'][^"']*[\w-]*(?:release|news|blog)[^"']*["'][^>]*>[\s\S]{0,80}?\bv?\d+\.\d+/i.test(html)
    || /<h[1-6][^>]*>[\s\S]{0,120}?\bv?\d+\.\d+\.\d+\b[\s\S]{0,40}?<\/h[1-6]>/i.test(html);
  // 列表式：版本是 <li> 链接（postgresql /docs/release/18.3/）
  const hasListVersion = /<li>[\s\S]{0,120}?<a[^>]+href=["'][^"']*\d+\.\d+["'][^>]*>/i.test(html);
  if (hasHeading) return 'heading';
  if (hasVersionLink) return 'blog';
  if (hasListVersion) return 'list';
  return 'none';
}

// 内容区块净化：移除 HTML 闭合残片 / CSS / 导航 / 图片 / 脚本，只留干净正文
function cleanSectionHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<(?:header|footer)\b[\s\S]*?<\/(?:header|footer)>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<\/(?:li|ul|ol|div|table|tr|td|section|article)>/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, (m) => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' } as Record<string, string>)[m] || ' ')
    .trim();
}

// ── Changelog 页面（版本锚点 + 文本密度）──
export function extractFromChangelogPage(html: string, opts: { version?: string } = {}): ChangelogEntry | null {
  if (!html) return null;
  const target = opts.version ? opts.version.replace(/^v/i, '') : null;
  const type = detectChangelogType(html);

  // 纯文本：nginx CHANGES 风格 → 按版本行切块（正文天然干净）
  if (type === 'plain-text') {
    const pt = extractFromPlainText(html, target);
    if (pt) return pt;
  }
  // JS 渲染：交给外层 L2 浏览器
  if (type === 'js-render') return null;

  // 博客详情页（python/gimp 跟随链接后）：整页是 <article> 正文 → 直接提取密度最高区
  const article = html.match(/<article[\s\S]*?<\/article>/i)?.[0];
  if (article) {
    const blogContent = extractDensestBlock(article);
    if (blogContent && blogContent.length > 20) {
      const v = (target ? target : html.match(/<h[1-6][^>]*>([\s\S]{0,120}?\bv?(\d+\.\d+(?:\.\d+)?)[\s\S]{0,40}?<\/h[1-6]>)/i)?.[2]) || null;
      const version = normalizeVersion(v || '0.0.0');
      return {
        version,
        date: null,
        title: null,
        content: blogContent,
        source: 'changelog-page',
        language: detectLanguage(blogContent),
        confidence: 'medium',
      };
    }
  }

  // 收集标题节点（带 id 的 heading 最容易匹配版本）
  const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    level: Number(m[1]),
    html: m[2],
    index: m.index as number,
    end: (m.index as number) + m[0].length,
    text: m[2].replace(/<[^>]+>/g, '').trim(),
  }));

  // 定位版本标题：含目标版本优先；否则取含版本号的标题里【数值最大】的（最新版）
  let hIdx = target ? headings.findIndex((h) => h.text.includes(target)) : -1;
  if (hIdx === -1) {
    const versioned = headings
      .map((h, i) => ({ h, i, v: h.text.match(/\bv?(\d+\.\d+(?:\.\d+)?)/)?.[1] }))
      .filter((x) => x.v);
    if (versioned.length > 0) {
      versioned.sort((a, b) => compareVersions(`v${b.v}`, `v${a.v}`));
      hIdx = versioned[0].i;
    }
  }

  // 有版本标题 → 锚定标题，取其后【文本密集】区块
  if (hIdx !== -1) {
    const h = headings[hIdx];
    const versionMatch = h.text.match(/\bv?(\d+\.\d+(?:\.\d+)?)/);
    const version = normalizeVersion(versionMatch ? versionMatch[1] : opts.version || '0.0.0');
    // 从标题后开始，向后扫描文本密集的正文区块（跳过导航/空块/残片）
    const start = h.end;
    const next = headings.slice(hIdx + 1).find((x) => x.level <= h.level);
    const bound = next ? next.index : html.length;
    const content = extractDenseText(html.slice(start, bound), version);
    if (content) {
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
  }

  // 无版本标题（或标题提取为空）→ 版本锚点：在纯文本里定位版本号，取其后文本密集段
  if (target) {
    const pt = extractFromPlainText(html, target);
    if (pt && pt.content.length > 20) return pt;
  }
  // 最后兜底：整页取文本密度最高的主区块（博客正文/无版本标题的详情页）
  const fallback = extractDensestBlock(cleanSectionHtml(html));
  if (fallback && fallback.length > 40) {
    return {
      version: normalizeVersion(target || '0.0.0'),
      date: null,
      title: null,
      content: fallback,
      source: 'changelog-page',
      language: detectLanguage(fallback),
      confidence: 'medium',
    };
  }
  return null;
}

// 文本密度提取：从版本区块 HTML 中取第一段有实质内容的正文
// 依据：真实日志是连续句子（多词+标点），导航/标签/图片/CSS 是碎片
function extractDenseText(sectionHtml: string, version: string): string | null {
  // 博客详情页：优先提取 <article> 主体（python/gimp 博客文章）
  const article = sectionHtml.match(/<article[\s\S]*?<\/article>/i)?.[0];
  if (article) {
    // article 内取文本密度最高的连续区域
    const dense = extractDensestBlock(article);
    if (dense && dense.length > 20) return dense;
  }
  // 无 article → 按块级标签切段，取第一个文本密度高的块
  const blocks = sectionHtml
    .split(/<(?:p|div|li|ul|ol|table|h[1-6]|blockquote|pre|section|article)\b[^>]*>/i)
    .map((b) => cleanSectionHtml(b));
  const sentencesRe = /\b[\w一-鿿]+\b/g;
  for (const b of blocks) {
    const words = (b.match(sentencesRe) || []).length;
    const isLinkNav = /<a[^>]+href=/.test(b) && words < 5;
    if (words >= 5 && !isLinkNav) {
      const content = cleanMarkdown(turndown.turndown(b));
      if (content.length > 20) return content;
    }
  }
  // 没有密度块 → 整体净化后取正文
  const all = cleanMarkdown(turndown.turndown(cleanSectionHtml(sectionHtml)));
  return all.length > 20 ? all : null;
}

// 取一段 HTML 里文本密度最高的连续区域（博客正文 vs 导航/日期/标签）
function extractDensestBlock(html: string): string | null {
  const blocks = html
    .split(/<(?:p|div|li|ul|ol|h[1-6]|blockquote|pre|section)\b[^>]*>/i)
    .map((b) => cleanSectionHtml(b));
  const sentencesRe = /\b[\w一-鿿]+\b/g;
  let best = null, bestScore = 0;
  for (const b of blocks) {
    const words = (b.match(sentencesRe) || []).length;
    if (words > bestScore) { bestScore = words; best = b; }
  }
  if (!best || bestScore < 10) return null;
  const content = cleanMarkdown(turndown.turndown(best));
  return content.length > 20 ? content : null;
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

// 返回最新版本链接 + 版本号（供详情页提取时作为锚点）
// 排除版权/法律/导航链接（creativecommons/license/privacy 等含版本号但非产品版本）
function findLatestVersionLinkWithVersion(html: string, baseUrl: string): { url: string; version: string } | null {
  const EXCLUDE_RE = /creativecommons|license|licen[sc]e|privacy|terms|imprint|about|legal|github\.com\/(?!.*\/releases)|\.css|\.js|\.map/i;
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, ' ').trim() }))
    .filter((l) => !EXCLUDE_RE.test(l.href + ' ' + l.text))
    .map((l) => {
      const m = (l.href + ' ' + l.text).match(/\bv?(\d+(?:\.\d+){1,3})\b/);
      return m ? { href: l.href, version: m[1] } : null;
    })
    .filter((x): x is { href: string; version: string } => x !== null);
  if (links.length === 0) return null;
  let best = links[0];
  for (const l of links) {
    if (compareVersions(`v${l.version}`, `v${best.version}`) > 0) best = l;
  }
  try {
    return { url: new URL(best.href, baseUrl).href, version: best.version };
  } catch {
    return { url: best.href, version: best.version };
  }
}

// ── 统一入口 ──
export async function extractChangelog(
  source: UpdateSource,
  opts: { token?: string; version?: string; pageHtml?: string; skipBrowser?: boolean } = {}
): Promise<ChangelogEntry | null> {
  try {
    switch (source.type) {
      case 'github-releases':
        return await extractFromGithubReleases(source, { token: opts.token || process.env.GITHUB_TOKEN });
      case 'rss':
        return source.feedUrl ? await extractFromRss(source.feedUrl, { version: opts.version }) : null;
      case 'changelog-page': {
        if (!source.url) return null;
        const r = opts.pageHtml ? { status: 200, text: opts.pageHtml, error: undefined } : await fetchPage(source.url, { timeout: 15000 });
        // 静态抓取失败/空 → 交给浏览器渲染（docs.docker.com 等需 JS 或反爬）
        if (r.error || !r.text) {
          if (!opts.skipBrowser) {
            const { extractChangelogWithBrowser } = await import('./changelog-ai');
            return await extractChangelogWithBrowser(source.url, { version: opts.version });
          }
          return null;
        }
        const type = detectChangelogType(r.text);

        // 规则层内容质量门控：太短或含 HTML 残片/版权 → 降级浏览器
        const goodEnough = (e: ChangelogEntry | null): e is ChangelogEntry =>
          !!e && e.content.length > 300
          && !/<\/?(li|ul|ol|div|table|td|a|img|svg|h[1-6])[\s>]/.test(e.content)
          && !/Canonical URL|Creative Commons|Copyright|You are free to|\[Prev\]|\[Up\]|\[Next\]|Privacy Policy|Terms of Use/i.test(e.content);

        // 列表/博客：版本是链接 → 跟随最新版本链接进详情页
        let detailUrl: string | null = null;
        if (type === 'list' || type === 'blog') {
          const latestLink = findLatestVersionLinkWithVersion(r.text, source.url);
          if (latestLink) {
            const page2 = await fetchPage(latestLink.url, { timeout: 15000 });
            if (page2.text && !page2.error) {
              // 规则层先试详情页（纯文本/标题式）
              const followed = extractFromChangelogPage(page2.text, { version: latestLink.version });
              if (goodEnough(followed)) {
                return { ...followed, source: 'changelog-page', confidence: 'medium' };
              }
              detailUrl = latestLink.url;
            }
          }
        }

        // 纯文本/标题式：内联提取（正文在当前页）
        if (type === 'plain-text' || type === 'heading') {
          const inline = extractFromChangelogPage(r.text, { version: opts.version });
          if (goodEnough(inline)) return inline;
        }

        // 规则层不足 → 浏览器渲染 + Trafilatura 清洗
        // 列表/博客跟随到详情页后再渲染（详情页正文是 Trafilatura 强项）
        if (!opts.skipBrowser) {
          const { extractChangelogWithBrowser } = await import('./changelog-ai');
          const browserUrl = detailUrl || source.url;
          const browserVersion = detailUrl ? null : opts.version; // 详情页版本号由锚点提取
          const browserEntry = await extractChangelogWithBrowser(browserUrl, { version: browserVersion || undefined });
          if (browserEntry && browserEntry.content.length > 20) return browserEntry;
        }

        // 跟随失败回退：列表页可能也有版本标题区块
        const inline2 = extractFromChangelogPage(r.text, { version: opts.version });
        if (inline2 && inline2.content.length > 150) return inline2;
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export { compareVersions };
