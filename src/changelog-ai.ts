// 浏览器 DOM 定位 + Trafilatura 清洗的 changelog 提取
//
// 解决 changelog 结构差异（纯文本/标题/列表/博客/JS渲染）：
//  1. Playwright 渲染（若需要）+ DOM 定位版本节点
//  2. 取该版本区块的 innerHTML（精确边界，无导航残片）
//  3. 调 Python Trafilatura 清洗正文 → Markdown
//
// 降级：Playwright/Trafilatura 不可用时回退现有正则提取（extractFromChangelogPage）。
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { normalizeVersion } from './changelog';
import { getBrowser } from './crawler';
import type { ChangelogEntry } from './types';

const execFileAsync = promisify(execFile);

// 调用 Python Trafilatura 清洗 HTML 区块 → Markdown
async function cleanWithTrafilatura(html: string): Promise<string | null> {
  const f = join(tmpdir(), `chg-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(f, html, 'utf-8');
  // tsx ESM 下 __dirname 不可用，用 process.cwd()（脚本需从项目根目录运行）
  const script = join(process.cwd(), 'scripts', 'trafilatura_clean.py');
  try {
    const { stdout } = await execFileAsync('python', [script, f, '--format', 'markdown', '--precision'], {
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  } finally {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}

export async function extractChangelogWithBrowser(url: string, opts: { version?: string } = {}): Promise<ChangelogEntry | null> {
  try {
    // 1. 渲染页面，取整页 HTML + 版本锚点标题（Trafilatura 是整页正文提取器，不需要精确容器）
    const pageData = await renderPage(url);
    if (!pageData) return null;
    // 2. 版本号：优先已知 version；否则从锚点标题提取（最新版数字最大）
    const versionFromTitle = (pageData.anchorTitle || '').match(/v?(\d+(?:\.\d+){1,3})/)?.[1] || '';
    const version = normalizeVersion(opts.version || versionFromTitle || '');
    if (!/\d/.test(version)) return null; // 无版本号 → 不是日志页
    // 3. Trafilatura 整页提取正文
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

// 渲染页面：返回整页 HTML + 版本锚点（锚点只用于确认版本，正文交给 Trafilatura 整页提取）
async function renderPage(url: string): Promise<{ html: string; anchorTitle: string | null } | null> {
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
    // 版本锚点：优先含版本号的标题；否则从链接/文本找（obsidian 版本在 <a> 里不在 heading）
    const anchor = await page.evaluate(() => {
      const verRe = /\bv?(\d+\.\d+(?:\.\d+)?)/;
      const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      const h = heads.find((x) => verRe.test(x.textContent || ''));
      if (h) return { title: (h.textContent || '').trim(), ver: (h.textContent || '').match(verRe)?.[1] || null };
      const all = Array.from(document.querySelectorAll('a,li,strong,span,p,td'));
      const a = all.find((x) => verRe.test(x.textContent || ''));
      if (a) return { title: (a.textContent || '').trim().slice(0, 80), ver: (a.textContent || '').match(verRe)?.[1] || null };
      return { title: null, ver: null };
    }).catch(() => ({ title: null, ver: null }));
    return { html, anchorTitle: anchor.title };
  } catch {
    return null;
  } finally {
    await context.close();
  }
}
