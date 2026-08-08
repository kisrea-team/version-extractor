// 700训练集 changelog 页面批量评估（并发）：内容是否提取 + 版本号是否匹配 current 真值
import { readFileSync } from 'fs';
import { classifySource, enrichSource } from '../src/sources';
import { extractChangelog } from '../src/changelog';
import { extractVersionWithLgb } from '../src/lgb-score';
import { fetchPage, closeBrowser } from '../src/crawler';

// 从 700 训练集收集 changelog 性质 URL + current 真值
// 用人工审计的 expected-fixes.json 覆盖过期/错误期望（Bandizip/Kdenlive 等）
const FIXES: Record<string, string> = JSON.parse(readFileSync('data/expected-fixes.json', 'utf-8'));
const data = new Map<string, { name: string; current: string | null }>();
for (const line of readFileSync('data/ds700-ctx/train2.jsonl', 'utf-8').split('\n').filter(Boolean)) {
  const d = JSON.parse(line);
  const cur = data.get(d.url) || { name: d.name, current: null };
  if (d.temporalStatus === 'current' && d.label === 1 && d.version) cur.current = d.version;
  data.set(d.url, cur);
}
for (const [url, v] of Object.entries(FIXES)) {
  const existing = data.get(url);
  if (existing) existing.current = v; // 只覆盖 eval 已有用例，不新增
}
const cases = [...data.entries()]
  .filter(([u, v]) => /(changelog|releases?|news|release-notes|history|updates?|version|log)/i.test(u))
  .map(([url, v]) => ({ url, name: v.name, expected: v.current }))
  .filter((c) => c.expected); // 只要 current 真值明确的

// 产品名提取（eval 作为"调用方"传入 productName）：从训练集 name 提取准确产品名。
// 训练集 name 已维护为准确产品名（如 "GIMP"、"Thunderbird"）；生产 API 由调用方显式传入。
// 产品代码（extractVersionWithLgb / extractChangelog）不内置任何映射，只接受传入的 productName。
const GENERIC_WORDS = new Set(['news', 'releases', 'release', 'release-notes', 'history', 'version', 'notes', 'note', 'changelog', 'app', 'desktop', 'mobile', 'wiki', 'blog', 'page', 'for', 'and', 'the', 'of', 'help', 'support', 'stable', 'beta', 'pro', 'mac', 'windows', 'linux', 'updates', 'update']);
function productNameFrom(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name
    .toLowerCase()
    .replace(/v?\d+(\.\d+)*/g, ' ')      // 去掉版本号（GIMP 3 → GIMP）
    .replace(/[|–—·():[\]{}]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !GENERIC_WORDS.has(w));
  const first = cleaned[0];
  return first || undefined;
}

function match(actual: string | null, expected: string | null): boolean {
  if (!actual || !expected) return false;
  const a = actual.replace(/^v/i, ''), e = expected.replace(/^v/i, '');
  return a === e || a.startsWith(e + '.') || e.startsWith(a + '.');
}

interface CaseResult {
  name: string;
  expected: string;
  entryVersion: string | null;
  version: string | null;
  length: number;
  pass: boolean;
  hasContent: boolean;
  verOk: boolean;
  error?: string;
}

// 抓取重试：并发限流/瞬时超时会返回空 text，重试 3 次（退避 1.5s/3s）救回。
// 真网络封锁（vivaldi ETIMEDOUT）重试也救不回，仍记为抓取失败。
async function fetchWithRetry(url: string, attempts = 3, timeout = 15000): Promise<{ text: string; status: number }> {
  let last: { text: string; status: number } = { text: '', status: 0 };
  for (let i = 0; i < attempts; i += 1) {
    const r = await fetchPage(url, { timeout });
    if (r.text && r.text.length > 0) return r;
    last = { text: r.text || '', status: r.status };
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  return last;
}

async function runCase(c: { url: string; name: string; expected: string | null }): Promise<CaseResult> {
  const result: CaseResult = { name: c.name, expected: c.expected || '', entryVersion: null, version: null, length: 0, pass: false, hasContent: false, verOk: false };
  const source = await enrichSource(classifySource(c.url));
  let entry: Awaited<ReturnType<typeof extractChangelog>> = null;
  let version: string | null = null;
  try {
    if (source.type === 'changelog-page') {
      const page = await fetchWithRetry(c.url);
      if (!page.text) { result.error = '抓取失败'; return result; }
      const productName = productNameFrom(c.name);
      version = (await extractVersionWithLgb(page.text, { productName })).version || null;
      entry = await extractChangelog(source, { pageHtml: page.text, version: version || undefined, productName, token: process.env.GITHUB_TOKEN });
    } else {
      entry = await extractChangelog(source, { version: undefined, token: process.env.GITHUB_TOKEN });
    }
  } catch (e: any) {
    result.error = String(e?.message || e).slice(0, 30);
    return result;
  }
  result.entryVersion = entry?.version || null;
  result.version = version;
  result.length = entry?.content?.length || 0;
  result.hasContent = result.length > 100;
  result.verOk = match(entry?.version || null, c.expected) || match(version, c.expected);
  result.pass = result.hasContent && result.verOk;
  return result;
}

// 并发限流执行
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

console.log('用例'.padEnd(20), '期望'.padEnd(10), '版本'.padEnd(12), '长度'.padEnd(6), '结果');
console.log('-'.repeat(72));

// 每例 150s 硬超时，防单页（LLM/Trafilatura）卡死拖垮整批
function runCaseWithTimeout(c: { url: string; name: string; expected: string | null }): Promise<CaseResult> {
  return Promise.race([
    runCase(c),
    new Promise<CaseResult>((resolve) => setTimeout(() => {
      resolve({ name: c.name, expected: c.expected || '', entryVersion: null, version: null, length: 0, pass: false, hasContent: false, verOk: false, error: '超时' });
    }, 150000)),
  ]);
}

// 并发 12：低 margin 页会走 LLM 回退（Trafilatura Python + NVIDIA 调用），
// 每例 150s 硬超时防单页卡死；进度逐例打印便于定位。
const results = await mapWithConcurrency(cases, 12, async (c) => {
  const r = await runCaseWithTimeout(c);
  if (r.error) { console.log(`${r.name.padEnd(20)} ${r.expected.padEnd(10)} ${r.error}`); }
  else {
    const mark = r.pass ? '✅' : `❌${r.hasContent ? '' : ' 无内容'}${r.verOk ? '' : ' 版本错'}`;
    console.log(`${r.name.padEnd(20)} ${r.expected.padEnd(10)} ${(r.entryVersion || r.version || '—').padEnd(12)} ${String(r.length).padEnd(6)} ${mark}`);
  }
  return r;
});

let ok = 0, total = 0;
for (const r of results) {
  if (r.error) { console.log(r.name.padEnd(20), r.expected.padEnd(10), r.error); continue; }
  total += 1;
  if (r.pass) ok += 1;
  console.log(
    r.name.padEnd(20),
    r.expected.padEnd(10),
    (r.entryVersion || r.version || '—').padEnd(12),
    String(r.length).padEnd(6),
    r.pass ? '✅' : `❌${r.hasContent ? '' : ' 无内容'}${r.verOk ? '' : ' 版本错'}`
  );
}
console.log('\n' + '='.repeat(50));
console.log(`changelog 提取成功率: ${ok}/${total}`);
await closeBrowser();
