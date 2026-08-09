// 序列检测专项评估：对全部 83 例跑 detectVersionSequence，对比期望版本
// 目标：看序列检测命中/漏掉/误判哪些，为判据优化提供依据（不接入 pipeline，独立评估）
import { readFileSync } from 'fs';
import { fetchPage } from '../src/crawler';
import { detectVersionSequence } from '../src/version-extract';

process.env.BENCH_CACHE_DIR = process.env.BENCH_CACHE_DIR || '.bench-cache';

function matchesPrefix(actual: string | null, prefix: string): boolean {
  if (!actual) return false;
  const normA = (s: string) => s.replace(/^v/i, '');
  const a = normA(actual || '');
  const e = normA(prefix);
  return a === e || a.startsWith(e + '.');
}

const cases = JSON.parse(readFileSync('benchmark/cases.json', 'utf-8'));
let hit = 0, miss = 0, wrong = 0, total = 0;
const missList: string[] = [];
const wrongList: string[] = [];

for (const c of cases) {
  if (c.expectedVersion === '') continue;
  const r = await fetchPage(c.url);
  if (!r.text) continue;
  total += 1;
  const seq = detectVersionSequence(r.text);
  const seqV = seq?.latest || null;
  const correct = matchesPrefix(seqV, c.expectedVersion);
  if (seqV && correct) hit += 1;
  else if (seqV && !correct) { wrong += 1; wrongList.push(`${c.name}: 期望${c.expectedVersion} 序列选${seqV} (${seq?.series.slice(0, 6).join(',')})`); }
  else { miss += 1; missList.push(`${c.name}: 期望${c.expectedVersion} 序列无`); }
}

console.log(`\n=== 序列检测专项评估 (${total} 例) ===`);
console.log(`命中: ${hit} | 漏掉: ${miss} | 误判: ${wrong}`);
console.log(`序列命中率: ${(hit / total * 100).toFixed(0)}% (命中/总数), 正确率: ${(hit / (hit + wrong) * 100).toFixed(0)}% (命中/有输出)`);
console.log('\n=== 误判（序列有输出但选错）===');
wrongList.forEach((x) => console.log('  ' + x));
console.log('\n=== 漏掉（序列无输出但应有）===');
missList.forEach((x) => console.log('  ' + x));
