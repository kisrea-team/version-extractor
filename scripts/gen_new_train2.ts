// 重新标注新数据: 真正的 historical = 版本标题位置(## v1.0.0 / <h2>v1.0.0</h2> / release 列表条目)
// 页面其他位置的数字(SVG坐标/JS版本/日期/正文) = non_product
// 输出: data/new-train2.jsonl
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

// 从 HTML 提取"版本标题位置"的版本集合: h1/h2/h3 标题、## 标题、release 列表
function versionHeadings(html: string): Set<string> {
  const out = new Set<string>();
  // <h1>-<h3> 标题里的版本
  for (const m of html.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = m[2].replace(/<[^>]+>/g, ' ').trim();
    const vm = text.match(/(?:v)?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/);
    if (vm) out.add(vm[1]);
  }
  // Markdown 标题 ## v1.0.0 / ### 1.2.3
  for (const m of html.matchAll(/^#{1,4}\s+.*?(v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/gim)) {
    out.add(m[1].replace(/^v/i, ''));
  }
  // release 条目链接(/releases/tag/v1.0.0)
  for (const m of html.matchAll(/releases\/tag\/(?:v)?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/gi)) {
    out.add(m[1].replace(/^v/i, ''));
  }
  return out;
}

const rows: any[] = [];
let pages = 0;
for (const c of cases) {
  const pid = pidFor(c.url);
  const htmlFile = join('data/new-pages/html', pid + '.html');
  let html = '';
  try { html = readFileSync(htmlFile, 'utf-8'); } catch { continue; }
  if (!html) continue;
  const cands = collectCandidates(html);
  if (cands.length === 0) continue;
  const real = c.expectedVersion || '';
  const headings = versionHeadings(html);
  pages++;
  for (const cand of cands) {
    const v = cand.version.startsWith('v') ? cand.version : 'v' + cand.version;
    let label: string;
    let noiseType = '';
    if (real && matches(v, real)) {
      label = 'current_product';
    } else if (headings.has(bare(v))) {
      // 出现在版本标题位置 = 真历史版本
      label = 'historical_product';
      noiseType = 'historical';
    } else {
      // 页面其他地方的数字 = 噪声(SVG坐标/JS版本/日期/正文)
      label = 'non_product';
      noiseType = 'no-heading-evidence';
    }
    rows.push({
      pageId: pid, url: c.url, name: c.name, version: v, label, noiseType,
      temporalStatus: label === 'historical_product' ? 'historical' : 'not-applicable',
      confidence: 'high',
      text: `候选: ${cand.version} [SEP] 上下文: ${(cand.contexts || []).slice(0, 3).map((x: any) => `[${x.scope}] ${String(x.text).slice(0, 80)}`).join(' ')}`,
      scopes: JSON.stringify((cand.contexts || []).map((x: any) => x.scope)),
      source: 'benchmark-real', pageStatus: 'product-page',
    });
  }
}

writeFileSync('data/new-train2.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const cnt: Record<string, number> = {};
for (const r of rows) cnt[r.label] = (cnt[r.label] || 0) + 1;
console.log(`生成 ${rows.length} 条, ${pages} 页`);
console.log('label 分布:', JSON.stringify(cnt));
