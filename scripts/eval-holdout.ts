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

  let strict = 0, honest = 0, total = 0, regFail = 0, fetchFail = 0;
  const detail: string[] = [];
  for (const c of cases) {
    const page = await fetchPage(c.url, { retries: 3 }); // 重试防瞬时失败
    let R: string | null = null;
    if (page.text && !page.error) {
      try {
        const m = new RegExp(c.versionRegex).exec(page.text);
        if (m) R = norm(m[1] !== undefined ? m[1] : m[0]);
      } catch {}
    }
    if (page.error && !page.text) { fetchFail += 1; detail.push(`${(c.name || '').slice(0, 16)} 抓取失败`); continue; }
    let V: string | null = null;
    try { V = (await extractFromUrl(c.url, { token: process.env.GITHUB_TOKEN })).version?.version || null; } catch { V = null; }

    total += 1;
    if (!R) { regFail += 1; detail.push(`${(c.name || '').slice(0, 16)} 正则失效`); continue; }
    if (V && matchesPrefix(V, R)) { strict += 1; honest += 1; detail.push(`${(c.name || '').slice(0, 16)} ✅`); }
    else if (V && compareVersions(V, R) > 0) { honest += 1; detail.push(`${(c.name || '').slice(0, 16)} ⬆${V}>正则${R}(管道对,正则过时)`); }
    else { detail.push(`${(c.name || '').slice(0, 16)} ❌ 正则${R} 管道${V}`); }
  }

  detail.forEach((d) => console.log(d));
  console.log('='.repeat(60));
  console.log(`strict(严格): ${strict}/${total} = ${(strict / total * 100).toFixed(0)}%`);
  console.log(`honest(正则过时也计对): ${honest}/${total} = ${(honest / total * 100).toFixed(0)}%`);
  console.log(`正则失效 ${regFail} | 抓取失败 ${fetchFail} | 共 ${cases.length}`);
  await closeBrowser();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
