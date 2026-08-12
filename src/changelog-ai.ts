// 浏览器 DOM 定位 + Trafilatura 清洗的 changelog 提取
//
// 解决 changelog 结构差异（纯文本/标题/列表/博客/JS渲染）：
//  1. Playwright 渲染（若需要）+ DOM 定位版本节点
//  2. 取该版本区块的 innerHTML（精确边界，无导航残片）
//  3. 调 Python Trafilatura 清洗正文 → Markdown
//
// 降级：Playwright/Trafilatura 不可用时回退现有正则提取（extractFromChangelogPage）。
import { normalizeVersion } from './changelog';
import { getBrowser, fetchPage } from './crawler';
import { cleanWithTrafilatura } from './trafilatura';
import type { ChangelogEntry } from './types';

export async function extractChangelogWithBrowser(url: string, opts: { version?: string } = {}): Promise<ChangelogEntry | null> {
  try {
    // 优先按调用方已确认的版本定位 DOM 区块；找不到时才回退整页清洗。
    const pageData = await renderPage(url, opts.version);
    if (!pageData) return null;
    // 版本号：优先已知 version；否则从锚点标题提取（最新版数字最大）
    const versionFromTitle = (pageData.anchorTitle || '').match(/v?(\d+(?:\.\d+){1,3})/)?.[1] || '';
    const version = normalizeVersion(opts.version || versionFromTitle || '');
    if (!/\d/.test(version)) return null; // 无版本号 → 不是日志页
    // Trafilatura 清洗已定位区块，未定位时使用整页 HTML
    const content = await cleanWithTrafilatura(pageData.html);
    if (!content || content.length < 20) return null;
    return {
      version,
      date: null,
      title: pageData.anchorTitle,
      content,
      source: 'changelog-page',
      language: /[一-鿿]/.test(content) && (content.match(/[一-鿿]/g) || []).length / Math.max(content.length, 1) > 0.05 ? 'zh' : 'en',
      confidence: 'high',
    };
  } catch {
    return null;
  }
}

// 渲染页面：优先返回目标版本所在的 DOM 区块，找不到时返回整页 HTML。
async function renderPage(url: string, targetVersion?: string): Promise<{ html: string; anchorTitle: string | null } | null> {
  // fastCRW 模式: LightPanda 已做 JS 渲染 + stealth 反爬, 复用 fetchPage 即可,
  // 不启动本地 Chromium(3.8G VPS 上批量跑必 OOM)。DOM 定位降级为整页返回。
  if (process.env.FETCHER === 'fastcrw') {
    const r = await fetchPage(url, { timeout: 30000 });
    if (r.error || !r.text) return null;
    return { html: r.text, anchorTitle: null };
  }
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    locale: 'zh-CN',
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    const html = await page.content();
    const target = (targetVersion || '').replace(/^v/i, '').replace(/\+.*$/, '');
    // 使用字符串函数体，避免 tsx/esbuild 将 __name helper 注入 page.evaluate。
    const located = await page.evaluate(`(target) => {
      const normalize = (value) => String(value || '').replace(/^v/i, '').replace(/\\+.*$/, '');
      const targetValue = normalize(target);
      const versionRe = /\\bv?(\\d+\\.\\d+(?:\\.\\d+)?)/;
      const matchesTarget = (value) => {
        const text = String(value || '');
        if (!targetValue) return false;
        return text.includes(targetValue) || text.includes('v' + targetValue);
      };
      const titleOf = (node) => String(node?.textContent || '').trim().slice(0, 120) || null;

      // 听点点等时间线页面：版本号直接作为容器 id，区块边界最可靠。
      if (targetValue) {
        const idNode = document.getElementById('v' + targetValue) || document.getElementById(targetValue);
        if (idNode) return { html: idNode.outerHTML, title: titleOf(idNode), located: true };
      }

      if (targetValue) {
        const idNodes = Array.from(document.querySelectorAll('[id]')).filter((node) => String(node.id || '').includes(targetValue));
        const article = idNodes.find((node) => node.closest('article'))?.closest('article');
        if (article) return { html: article.outerHTML, title: titleOf(article), located: true };
      }

      // 1Password 等页面同一版本按平台重复出现；选择目标版本下正文最长的详情块。
      if (targetValue) {
        const markers = Array.from(document.querySelectorAll('div')).filter((node) => /Updated\\s+to\\s+/.test(node.textContent || '') && matchesTarget(node.textContent || ''));
        let best = null;
        for (const marker of markers) {
          let current = marker;
          for (let i = 0; i < 5 && current.parentElement; i += 1) {
            const parent = current.parentElement;
            const text = String(parent.textContent || '');
            if (matchesTarget(text) && text.length >= 180 && text.length <= 20000) {
              if (!best || text.length > best.text.length) best = { node: parent, text };
            }
            current = parent;
          }
        }
        if (best) return { html: best.node.outerHTML, title: best.text.slice(0, 120), located: true };
      }

      const elements = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,header,time,div,p,article,section'));
      const anchor = elements.find((node) => matchesTarget(node.textContent || '') && (targetValue ? true : versionRe.test(node.textContent || '')));
      if (anchor) {
        // 1Password 等页面用“Updated to <version>”详情条紧邻正文卡片；向上取包含正文的组容器。
        let current = anchor;
        for (let i = 0; i < 5 && current.parentElement; i += 1) {
          const parent = current.parentElement;
          const text = String(parent.textContent || '');
          if (targetValue && matchesTarget(text) && text.length >= 180 && text.length <= 20000) {
            return { html: parent.outerHTML, title: titleOf(anchor), located: true };
          }
          current = parent;
        }
        return { html: anchor.outerHTML, title: titleOf(anchor), located: true };
      }

      // 无已知版本时，仍按版本标题/文本找锚点，但不误把整页第一个版本当成目标版本。
      const fallback = elements.find((node) => versionRe.test(node.textContent || ''));
      if (fallback) return { html: fallback.parentElement?.outerHTML || fallback.outerHTML, title: titleOf(fallback), located: true };
      return { html, title: null, located: false };
    }`, target);
    return { html: located.html || html, anchorTitle: located.title };
  } catch {
    return null;
  } finally {
    await context.close();
  }
}
