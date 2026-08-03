/**
 * 修正 LogUp 语料的 expectedVersion：用"正则在当前页现抓值 R"作为唯一真值
 *
 * DB 的 latest_version/version_regex 可能是过时快照。正则在当前页匹配到的是
 * 站点自己的方法在当前页的活提取，是最可靠的真值来源。
 *
 * 用法：
 *   npx tsx scripts/correct-logup-corpus.ts
 *   输出：修正后的 benchmark/logup-cases.json（expectedVersion 已填真值，垃圾/失效留空待人工）
 */
import { readFileSync, writeFileSync } from 'fs';
import { fetchPage } from '../src/crawler';

function norm(v: string): string {
  const t = String(v || '').trim();
  return /^v/i.test(t) ? t : `v${t}`;
}

// 正则在当前页现抓；过滤垃圾（纯哈希/纯字母/超长/纯日期误判）
function regexLive(html: string | null, re: string | null): string | null {
  if (!html || !re) return null;
  try {
    const m = new RegExp(re).exec(html);
    const raw = m ? (m[1] !== undefined ? m[1] : m[0]) : null;
    if (!raw) return null;
    const t = raw.trim();
    if (!/\d/.test(t)) return null; // 无数字不算版本
    if (/^[0-9a-f]{16,}$/i.test(t)) return null; // 哈希
    if (t.length > 30) return null;
    if (/^[A-Za-z]+$/.test(t)) return null; // 纯字母
    return norm(t);
  } catch {
    return null;
  }
}

async function main() {
  const file = 'benchmark/logup-cases.json';
  const cases = JSON.parse(readFileSync(file, 'utf-8'));

  // 并行处理（高并发 8）：逐个抓页+正则
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

  const fixed = await mapWithConcurrency(cases, 8, async (c: any) => {
    const page = await fetchPage(c.url);
    const R = regexLive(page.text, c.versionRegex);
    return R;
  });

  let fixedCount = 0;
  let manual = 0;
  cases.forEach((c: any, i: number) => {
    if (fixed[i]) {
      c.expectedVersion = fixed[i];
      c.skip = false;
      fixedCount += 1;
    } else {
      c.expectedVersion = '';
      c.skip = true; // 正则失效/垃圾，待人工
      manual += 1;
    }
  });

  writeFileSync(file, JSON.stringify(cases, null, 2));
  console.log(`已修正 ${fixedCount} 例(正则现抓真值)，留空待人工 ${manual} 例`);
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
