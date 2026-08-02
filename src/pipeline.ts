// 高层管道：URL → 版本 + 日志
//
// 流程：
//   1. 识别更新源（GitHub / RSS / changelog 页）
//   2. 普通抓取 → 版本提取
//   3. 若版本为 null 或低置信（needsBrowser）→ Playwright 渲染后再提取（解决 JS 站）
//   4. 按来源提取更新日志
import { classifySource, enrichSource } from './sources';
import { extractVersionFromHtml } from './version-extract';
import { extractChangelog } from './changelog';
import { fetchPage, fetchPageRendered, closeBrowser } from './crawler';
import type { ChangelogEntry, UpdateSource, VersionResult } from './types';

export interface ExtractOutcome {
  url: string;
  source: UpdateSource;
  version: VersionResult;
  changelog: ChangelogEntry | null;
  neededBrowser: boolean; // 是否升级到了浏览器渲染
  renderedText?: string;
}

export async function extractFromUrl(url: string, opts: { token?: string } = {}): Promise<ExtractOutcome> {
  const source = await enrichSource(classifySource(url));

  // changelog-page / rss 走页面；github 走 API（无需渲染）
  let page = source.type === 'changelog-page' || source.type === 'rss'
    ? await fetchPage(url)
    : { status: 0, text: '', error: undefined };
  let version = page.text ? extractVersionFromHtml(page.text) : null;
  let neededBrowser = false;

  // JS 兜底：普通抓取拿不到/低置信 → 浏览器渲染
  if (page.text && (!version || version.needsBrowser || !version.version)) {
    const rendered = await fetchPageRendered(url);
    if (!rendered.error && rendered.text) {
      const re = extractVersionFromHtml(rendered.text);
      // 渲染结果更好才替换（渲染可能引入更多噪音）
      if (!version || !version.version || (re.version && re.confidence === 'high')) {
        version = re;
        page = rendered;
        neededBrowser = true;
      }
    }
  }

  const finalVersion = version || { version: null, source: 'none', confidence: 'low' as const, needsAiCheck: true, needsBrowser: true, suggestedRegex: null };

  // 日志
  let changelog: ChangelogEntry | null = null;
  if (source.type === 'github-releases') {
    changelog = await extractChangelog(source, { token: opts.token });
  } else if (page.text) {
    changelog = await extractChangelog(source, { pageHtml: page.text, version: finalVersion.version || undefined, token: opts.token });
  }

  return { url, source, version: finalVersion, changelog, neededBrowser, renderedText: neededBrowser ? page.text : undefined };
}

export { closeBrowser };
