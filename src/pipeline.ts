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
import { queryRegistry } from './registries';
import type { ChangelogEntry, UpdateSource, VersionResult } from './types';

export interface ExtractOutcome {
  url: string;
  source: UpdateSource;
  version: VersionResult;
  changelog: ChangelogEntry | null;
  neededBrowser: boolean; // 是否升级到了浏览器渲染
  registryVersion?: string | null; // 注册表确定性版本（最高优先级）
  registryKey?: string | null;
  renderedText?: string;
}

export async function extractFromUrl(
  url: string,
  opts: { token?: string; registryKey?: string } = {}
): Promise<ExtractOutcome> {
  const source = await enrichSource(classifySource(url));

  // 0. 注册表优先：确定性命名字段，优于任何 HTML 猜测；命中直接短路（快且权威）
  let registryVersion: string | null = null;
  let registryResolvedKey: string | null = null;
  if (opts.registryKey) {
    try {
      const reg = await queryRegistry(opts.registryKey, { token: opts.token });
      registryVersion = reg.version;
      registryResolvedKey = opts.registryKey;
    } catch {
      // 注册表查询失败则回退 HTML
    }
  }
  if (registryVersion) {
    const finalVersion: VersionResult = {
      version: registryVersion,
      source: 'registry',
      confidence: 'high',
      needsAiCheck: false,
      needsBrowser: false,
      suggestedRegex: null,
    };
    return { url, source, version: finalVersion, changelog: null, neededBrowser: false, registryVersion, registryKey: registryResolvedKey };
  }

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
      if (!version || !version.version || (re.version && re.confidence === 'high')) {
        version = re;
        page = rendered;
        neededBrowser = true;
      }
    }
  }

  // 注册表未命中时，用页面提取结果
  const finalVersion: VersionResult =
    version || { version: null, source: 'none', confidence: 'low' as const, needsAiCheck: true, needsBrowser: true, suggestedRegex: null };

  // 日志
  let changelog: ChangelogEntry | null = null;
  if (source.type === 'github-releases') {
    changelog = await extractChangelog(source, { token: opts.token });
  } else if (page.text) {
    changelog = await extractChangelog(source, { pageHtml: page.text, version: finalVersion.version || undefined, token: opts.token });
  }

  return { url, source, version: finalVersion, changelog, neededBrowser, registryVersion, registryKey: registryResolvedKey, renderedText: neededBrowser ? page.text : undefined };
}

export { closeBrowser };
