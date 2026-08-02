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
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchPage(url: string, opts: { timeout?: number; retries?: number } = {}): Promise<FetchResult> {
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
      return { status: resp.statusCode, text: typeof resp.body === 'string' ? resp.body : String(resp.body) };
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
