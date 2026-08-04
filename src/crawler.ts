// 抓取层（工业级：UA 轮换 + TLS 指纹 + 重试）
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const generator = new HeaderGenerator({
  browsers: [{ name: 'chrome', minVersion: 100 }],
  operatingSystems: ['windows', 'linux', 'macos'],
  locales: ['zh-CN', 'en-US'],
});

function headers(): Record<string, string> {
  const h = generator.getHeaders();
  return {
    'user-agent': h['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'accept-language': h['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
  };
}

export interface FetchResult {
  status: number;
  text: string;
  error?: string;
  cached?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 可选磁盘缓存：设置 BENCH_CACHE_DIR 后，成功响应按 URL 缓存（改模型重跑不用重新抓）
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

function cacheKey(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 24);
}

function cacheGet(url: string): FetchResult | null {
  const dir = process.env.BENCH_CACHE_DIR;
  if (!dir) return null;
  try {
    const f = join(dir, cacheKey(url) + '.json');
    if (!existsSync(f)) return null;
    const obj = JSON.parse(readFileSync(f, 'utf-8'));
    // 24h TTL
    if (Date.now() - (obj.ts || 0) > 24 * 3600 * 1000) return null;
    return { status: obj.status, text: obj.text, cached: true };
  } catch {
    return null;
  }
}

function cacheSet(url: string, result: FetchResult) {
  const dir = process.env.BENCH_CACHE_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, cacheKey(url) + '.json'), JSON.stringify({ status: result.status, text: result.text, ts: Date.now() }));
  } catch {
    // 忽略缓存写失败
  }
}

export async function fetchPage(url: string, opts: { timeout?: number; retries?: number } = {}): Promise<FetchResult> {
  const cached = cacheGet(url);
  if (cached) return cached;
  const { timeout = 15000, retries = 2 } = opts;
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const resp = await gotScraping.get(url, {
        headers: headers(),
        useHeaderGenerator: false,
        timeout: { request: timeout, response: timeout },
        retry: { limit: 0 },
        responseType: 'text',
      });
      const result = { status: resp.statusCode, text: typeof resp.body === 'string' ? resp.body : String(resp.body) };
      cacheSet(url, result);
      return result;
    } catch (e: any) {
      lastError = e?.code || e?.message || 'fetch failed';
      if (attempt < retries) await sleep(1000 * Math.pow(2, attempt));
    }
  }
  return { status: 0, text: '', error: lastError };
}

export async function fetchJson(url: string, opts: { timeout?: number } = {}): Promise<{ status: number; body: unknown; error?: string }> {
  const r = await fetchPage(url, opts);
  if (r.error || !r.text) return { status: r.status, body: null, error: r.error };
  try {
    return { status: r.status, body: JSON.parse(r.text) };
  } catch {
    return { status: r.status, body: null, error: 'invalid json' };
  }
}

// ── Playwright 渲染抓取（JS 站兜底：版本号只有 JS 跑完才出现在 DOM）──
let browserPromise: Promise<any> | null = null;

export async function getBrowser(): Promise<any> {
  if (!browserPromise) {
    const { chromium } = await import('playwright');
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
        '--js-flags=--max-old-space-size=256'],
    });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    // ignore
  } finally {
    browserPromise = null;
  }
}

export async function fetchPageRendered(url: string, opts: { timeout?: number } = {}): Promise<FetchResult> {
  const cacheKey2 = url + '#rendered';
  const cached = cacheGet(cacheKey2);
  if (cached) return cached;
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      locale: 'zh-CN',
    });
    try {
      const page = await context.newPage();
      // domcontentloaded + 固定等待比 networkidle 快得多且不会在某些站永远挂起
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout || 15000 });
      await page.waitForTimeout(2000); // 让异步渲染落地
      const text = await page.content();
      const result = { status: 200, text };
      cacheSet(cacheKey2, result);
      return result;
    } finally {
      await context.close();
    }
  } catch (e: any) {
    return { status: 0, text: '', error: e?.message || 'render failed' };
  }
}

// ── L2 深度渲染：网络拦截 + 运行时全局态（文档 three-tier-extractor.md P1/P2）──
// 返回渲染后的 HTML + 从 XHR/fetch 响应中捕获的 version 字段值 + 全局态版本
export interface RenderedWithNetwork {
  text: string;
  networkVersions: Array<{ version: string; count: number }>; // 每个版本出现的响应数（产品版本跨多个响应重复出现）
  globalVersions: string[];  // 从 __NEXT_DATA__ / __INITIAL_STATE__ / window 全局提取
  ctaVersions: string[];     // 从主下载按钮 href/text 提取
}

// 常见 version 命名字段（JSON 响应中确定性识别）
const VERSION_KEY_RE =
  /["'](?:version|version_number|versionNumber|latestVersion|releaseVersion|appVersion|pkgVersion|packageVersion|softwareVersion|productVersion|currentVersion|stableVersion|newVersion|tag_name|tagName|name|display_version)["']\s*:\s*["']([^"']{1,40})["']/gi;

export function extractVersionsFromJson(json: string): string[] {
  const out = new Set<string>();
  const matches = [...json.matchAll(VERSION_KEY_RE)];
  // 排除 OS/SDK/API/构建/最低系统版本 等非产品版本键
  const BAD_KEY_RE = /minimumOsVersion|minimum_os_version|requiredOsVersion|sdkVersion|sdk_version|apiVersion|api_version|buildNumber|build_number|schemaVersion|schema_version|protocolVersion|protocol_version|releaseCandidateVersion|minRequiredVersion|compatibleVersion/i;
  for (const m of matches) {
    const key = m[0];
    if (BAD_KEY_RE.test(key)) continue;
    const v = m[1].trim();
    // 过滤明显非版本的值（日期、URL、哈希、纯单词）
    if (!/\d/.test(v)) continue;
    if (/^[\w.-]+@|^https?:\/\//i.test(v)) continue;
    if (v.length > 30) continue;
    // 日期格式（202604.2.0、2026-04-02、20260402）不是版本
    if (/^\d{4}[-.]?\d{2}[-.]?\d{2}/.test(v)) continue;
    if (/^\d{4}[.-]\d{1,2}/.test(v)) continue;
    if (/^\d{6,}/.test(v) && !v.includes('.')) continue;
    // 纯哈希/长数字串
    if (/^[0-9a-f]{16,}$/i.test(v)) continue;
    out.add(v);
  }
  return [...out];
}

// 从下载文件名提取版本号：Notion-7.29.0.msix → 7.29.0；文件名中的版本是产品版本强信号
export function extractVersionsFromFilename(filename: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[_-])(v?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3})(?=[._-]|$)/gi;
  for (const m of filename.matchAll(re)) {
    const v = m[1];
    if (!/\d/.test(v)) continue;
    if (/^\d{4}[-.]?\d{2}[-.]?\d{2}/.test(v)) continue; // 日期
    if (v.length > 20) continue;
    out.add(v);
  }
  return [...out];
}

export async function fetchPageRenderedDeep(url: string, opts: { timeout?: number } = {}): Promise<RenderedWithNetwork> {
  const cacheKey3 = url + '#deep';
  const cached = cacheGet(cacheKey3);
  if (cached) {
    return { text: cached.text, networkVersions: (cached as any).networkVersions || [], globalVersions: (cached as any).globalVersions || [], ctaVersions: (cached as any).ctaVersions || [] };
  }
  const networkCount = new Map<string, number>(); // version -> 出现该版本的响应数
  const globalVersions = new Set<string>();
  const ctaVersions = new Set<string>();
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      locale: 'zh-CN',
    });
    try {
      const page = await context.newPage();
      // 1. 网络拦截：捕获 XHR/fetch JSON 响应中的 version 字段
      // 排除第三方组件域（Intercom/Zendesk/Analytics 等在线客服/统计组件的 version 不是产品版本）
      // 也排除 Segment 类遥测配置端点（sourceConfig/writeKey/rsc2 等，响应含第三方集成名）
      const THIRD_PARTY_RE = /intercom|zendesk|crisp|tawk|hotjar|analytics|google-analytics|googletagmanager|gtm|facebook\.com\/tr|clarity|mixpanel|segment|sentry|bugsnag|rollbar|amplitude|posthog|fullstory|heap|rsc2\.|sourceConfig|writeKey|segment\.io|cdn\.segment/i;
      page.on('response', async (resp: any) => {
        try {
          const respUrl = resp.url() || '';
          if (THIRD_PARTY_RE.test(respUrl)) return;
          const ct = resp.headers()['content-type'] || '';
          // 下载响应：Content-Disposition 文件名通常含版本（如 Notion-7.29.0.msix）
          const cd = resp.headers()['content-disposition'] || '';
          if (cd) {
            const fn = cd.match(/filename=["']?([^"';]+)["']?/i)?.[1] || '';
            const vs = extractVersionsFromFilename(fn);
            for (const v of vs) networkCount.set(v, (networkCount.get(v) || 0) + 1);
          }
          if (!/json/i.test(ct)) return;
          const body = await resp.text();
          if (body && body.length < 2_000_000) {
            const vs = extractVersionsFromJson(body);
            // 每个响应内去重后计数一次；产品版本会跨多个响应重复出现，SDK/接口版本只出现一次
            for (const v of new Set(vs)) networkCount.set(v, (networkCount.get(v) || 0) + 1);
          }
        } catch {
          // 忽略解析失败
        }
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout || 15000 });
      await page.waitForTimeout(3000); // 给 XHR 留出返回时间
      const text = await page.content();
      // 2. 运行时全局态：读 __NEXT_DATA__ / __INITIAL_STATE__ / window 上的版本
      const globals = await page.evaluate(() => {
        const out: string[] = [];
        const collect = (obj: any, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 3) return;
          for (const [k, val] of Object.entries(obj)) {
            if (/version/i.test(k) && typeof val === 'string' && /\d/.test(val) && val.length <= 30) out.push(val);
            else if (typeof val === 'object') collect(val, depth + 1);
          }
        };
        const nd = (window as any).__NEXT_DATA__;
        if (nd) collect(nd);
        const is = (window as any).__INITIAL_STATE__;
        if (is) collect(is);
        return out;
      }).catch(() => []);
      globals.forEach((v: string) => globalVersions.add(v));
      // 3. 主下载按钮定位：最大/最突出的 download 链接
      const cta = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
        const scored = links
          .map((a) => {
            const href = a.href || '';
            const txt = (a.textContent || '').trim();
            const score = (/download|下载|获取|get|install/i.test(href + ' ' + txt) ? 2 : 0) +
              (/win|mac|linux|windows|dmg|exe|msi|apk|deb|rpm|zip|64|arm/i.test(href + ' ' + txt) ? 1 : 0) +
              Math.min(txt.length / 20, 1);
            return { a, href, txt, score };
          })
          .filter((x) => x.score >= 2)
          .sort((x, y) => y.score - x.score);
        const out: string[] = [];
        for (const s of scored.slice(0, 3)) {
          const m = s.href.match(/v?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3}/);
          if (m) out.push(m[0]);
          const m2 = s.txt.match(/v?(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3}/);
          if (m2) out.push(m2[0]);
        }
        return out;
      }).catch(() => []);
      cta.forEach((v: string) => ctaVersions.add(v));

      const networkVersions = [...networkCount.entries()]
        .map(([version, count]) => ({ version, count }))
        .sort((a, b) => b.count - a.count); // 按出现响应数降序
      const result = {
        status: 200,
        text,
        networkVersions,
        globalVersions: [...globalVersions],
        ctaVersions: [...ctaVersions],
        ts: Date.now(),
      };
      cacheSet(cacheKey3, result as any);
      return { text, networkVersions, globalVersions: [...globalVersions], ctaVersions: [...ctaVersions] };
    } finally {
      await context.close();
    }
  } catch (e: any) {
    return { text: '', networkVersions: [], globalVersions: [...globalVersions], ctaVersions: [...ctaVersions] };
  }
}
