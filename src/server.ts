// HTTP API 服务：POST 一个 URL → 返回最新版本号 / 版本信息 / 更新日志
//
// 用法：
//   POST /extract
//   { "url": "https://www.python.org/downloads/",
//     "fields": ["version", "changelog"],   // 可选；不传则全部返回
//     "registryKey": "winget:7zip.7zip",    // 可选；确定性注册表源优先
//     "productName": "python" }             // 可选；调用方已知产品名 → 触发产品锚点 + LLM 兜底
//   → { "url": ..., "version": {...}, "changelog": {...}, "elapsedMs": ... }
//
//   GET /health → { ok: true, active: n }
//
// 并发限制：MAX_CONCURRENT（默认 2）个提取请求并行，超出返回 503。
// 单请求超时：EXTRACT_TIMEOUT_MS（默认 90s），超时返回 504。
// 浏览器常驻（不 closeBrowser），多请求复用同一 Chromium 实例。
import { createServer } from 'node:http';
import { extractFromUrl } from './pipeline';

const PORT = Number(process.env.PORT || 3000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS || 90000);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const VALID_FIELDS = ['version', 'changelog'];
let active = 0;

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/[\[\]]/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0' || host === '::' || host === '::1') return true;
  const octets = host.split('.').map(Number);
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = octets;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return false;
}

function validateTargetUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || isBlockedHostname(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: import('node:http').IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c;
      if (body.length > maxBytes) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleExtract(rawBody: string, res: import('node:http').ServerResponse): Promise<void> {
  let parsed: { url?: string; fields?: string[]; registryKey?: string; productName?: string };
  try {
    parsed = JSON.parse(rawBody || '{}');
  } catch {
    return sendJson(res, 400, { error: 'invalid json body' });
  }

  const url = typeof parsed.url === 'string' ? validateTargetUrl(parsed.url.trim()) : null;
  if (!url) return sendJson(res, 400, { error: 'url must be an http(s) URL with a public hostname' });
  // 产品名（logup 已知项目的产品名）：传给提取器 → 产品锚点特征 + 低 margin 时触发 LLM 兜底
  const productName = typeof parsed.productName === 'string' && parsed.productName.trim() ? parsed.productName.trim() : undefined;

  let fields: string[];
  if (parsed.fields === undefined) {
    fields = [...VALID_FIELDS];
  } else if (Array.isArray(parsed.fields) && parsed.fields.length > 0) {
    fields = parsed.fields.filter((f) => VALID_FIELDS.includes(f));
    if (fields.length === 0) {
      return sendJson(res, 400, { error: `fields must be a subset of [${VALID_FIELDS.join(', ')}]` });
    }
  } else {
    return sendJson(res, 400, { error: `fields must be a non-empty array of [${VALID_FIELDS.join(', ')}]` });
  }

  if (active >= MAX_CONCURRENT) {
    return sendJson(res, 503, { error: `server busy (${active}/${MAX_CONCURRENT} running), retry later` });
  }
  active += 1;
  const start = Date.now();
  try {
    const out = await Promise.race([
      extractFromUrl(url, { token: GITHUB_TOKEN, registryKey: parsed.registryKey, productName }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('extract timeout')), EXTRACT_TIMEOUT_MS)),
    ]);
    const result: Record<string, unknown> = { url, elapsedMs: Date.now() - start };
    if (fields.includes('version')) result.version = out.version;
    if (fields.includes('changelog')) result.changelog = out.changelog;
    sendJson(res, 200, result);
  } catch (e: any) {
    const timeout = e?.message === 'extract timeout';
    sendJson(res, timeout ? 504 : 500, { url, error: timeout ? 'extract timeout' : String(e?.message || e) });
  } finally {
    active -= 1;
  }
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    return sendJson(res, 200, { ok: true, service: 'version-extractor', active });
  }
  if (req.method === 'POST' && req.url === '/extract') {
    readBody(req)
      .then((body) => handleExtract(body, res))
      .catch((e: Error) => sendJson(res, 400, { error: e.message }));
    return;
  }
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`version-extractor API listening on :${PORT} (max ${MAX_CONCURRENT} concurrent, ${EXTRACT_TIMEOUT_MS}ms timeout)`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
