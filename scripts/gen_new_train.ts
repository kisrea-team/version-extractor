// 从新快照生成候选级训练数据(用 380 基准真实版本标注)
// 复用 export-candidates 的 collectCandidates(与训练特征同源)
// 输出: data/new-train.jsonl (与 train-ready.jsonl 同格式)
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { collectCandidates } from '../scripts/export-candidates';

const cases = JSON.parse(readFileSync('data/new-pages-cases.json', 'utf-8'));
const bare = (v: string) => String(v || '').replace(/^v/i, '');
const matches = (a: string, b: string) => {
  const x = bare(a), y = bare(b);
  return x === y || x.startsWith(y + '.') || y.startsWith(x + '.');
};

function pidFor(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}

const rows: any[] = [];
let pages = 0, noCand = 0;
for (const c of cases) {
  const pid = pidFor(c.url);
  const htmlFile = join('data/new-pages/html', pid + '.html');
  let html = '';
  try { html = readFileSync(htmlFile, 'utf-8'); } catch { /* 无快照 */ }
  if (!html) { noCand++; continue; }
  const cands = collectCandidates(html);
  if (cands.length === 0) { noCand++; continue; }
  const real = c.expectedVersion || '';
  pages++;
  for (const cand of cands) {
    const label = real && matches(cand.version, real) ? 'current_product'
      : /^\d{4}[-.]/.test(bare(cand.version)) && !matches(cand.version, real) ? 'non_product' // 年份式非版本
      : 'historical_product'; // 保守: 页面里其他版本算历史(不是噪声)
    rows.push({
      pageId: pid,
      url: c.url,
      name: c.name,
      version: cand.version.startsWith('v') ? cand.version : 'v' + cand.version,
      label,
      noiseType: label === 'current_product' ? '' : 'candidate',
      temporalStatus: label === 'historical_product' ? 'historical' : 'not-applicable',
      confidence: 'high',
      text: `候选: ${cand.version} [SEP] 上下文: ${(cand.contexts || []).slice(0, 3).map((x: any) => `[${x.scope}] ${String(x.text).slice(0, 80)}`).join(' ')}`,
      scopes: JSON.stringify((cand.contexts || []).map((x: any) => x.scope)),
      source: 'benchmark-real',
      pageStatus: 'product-page',
    });
  }
}

writeFileSync('data/new-train.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`生成 ${rows.length} 条候选, ${pages} 页(含候选), ${noCand} 页无候选`);
const cnt: Record<string, number> = {};
for (const r of rows) cnt[r.label] = (cnt[r.label] || 0) + 1;
console.log('label 分布:', JSON.stringify(cnt));
