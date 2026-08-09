/**
 * holdout 回归评估（非GitHub，严格）
 *
 * 用法：
 *   GITHUB_TOKEN=... npx tsx scripts/eval-holdout.ts [--file benchmark/logup-cases-holdout.json]
 *
 * 评分（双指标）：
 *   strict:   V 与正则现抓 R 匹配 → PASS（正则可能过时，V>R 时管道其实对）
 *   honest:   V 匹配 R，或 V > R（管道找到更新版本，正则过时）→ PASS
 * 正则失效/管道漏 → FAIL。不跳过任何用例。
 */
import { readFileSync } from 'fs';
import { fetchPage } from '../src/crawler';
import { extractFromUrl, closeBrowser } from '../src/pipeline';
import { compareVersions } from '../src/version-extract';

function norm(v: string): string {
  const t = String(v || '').trim();
  return /^v/i.test(t) ? t : `v${t}`;
}
function matchesPrefix(actual: string, prefix: string): boolean {
  const a = actual.replace(/^v/i, ''), e = prefix.replace(/^v/i, '');
  return a === e || a.startsWith(e + '.');
}

async function main() {
  const fileArg = process.argv.find((a, i) => process.argv[i - 1] === '--file');
  const file = fileArg || 'benchmark/logup-cases-holdout.json';
  const cases = JSON.parse(readFileSync(file, 'utf-8'));
  const skipBrowser = process.env.SKIP_BROWSER === '1';

  // 并行处理（高并发），每例完成后立即输出
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

  const outcomes = await mapWithConcurrency(cases, 8, async (c: any) => {
    const page = await fetchPage(c.url, { retries: 3 });
    let R: string | null = null;
    if (page.text && !page.error) {
      try {
        const m = new RegExp(c.versionRegex).exec(page.text);
        if (m) R = norm(m[1] !== undefined ? m[1] : m[0]);
      } catch {}
    }
    let V: string | null = null;
    try { V = (await extractFromUrl(c.url, { token: process.env.GITHUB_TOKEN, registryKey: c.registryKey, skipBrowser })).version?.version || null; } catch { V = null; }
    return { name: c.name, url: c.url, R, V, fetchError: page.error && !page.text ? page.error : null };
  });

  let strict = 0, honest = 0, total = 0, regFail = 0, fetchFail = 0;
  const detail: string[] = [];
  for (const o of outcomes) {
    const name = (o.name || '').slice(0, 20);
    if (o.fetchError) { fetchFail += 1; detail.push(`${name.padEnd(22)} 抓取失败`); continue; }
    total += 1;
    if (!o.R) { regFail += 1; detail.push(`${name.padEnd(22)} 正则失效`); continue; }
    if (o.V && matchesPrefix(o.V, o.R)) { strict += 1; honest += 1; detail.push(`${name.padEnd(22)} ✅ ${o.V}`); }
    else if (o.V && compareVersions(o.V, o.R) > 0) { honest += 1; detail.push(`${name.padEnd(22)} ⬆${o.V}>正则${o.R}`); }
    else { detail.push(`${name.padEnd(22)} ❌ 正则${o.R} 管道${o.V}`); }
  }

  detail.forEach((d) => console.log(d));
  console.log('='.repeat(60));
  console.log(`strict(严格): ${strict}/${total} = ${(strict / total * 100).toFixed(0)}%`);
  console.log(`honest(正则过时也计对): ${honest}/${total} = ${(honest / total * 100).toFixed(0)}%`);
  console.log(`正则失效 ${regFail} | 抓取失败 ${fetchFail} | 共 ${cases.length}`);
  await closeBrowser();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
