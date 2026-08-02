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

async function getBrowser(): Promise<any> {
  if (!browserPromise) {
    const { chromium } = await import('playwright');
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
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
