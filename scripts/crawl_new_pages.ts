// 抓取 76 个新训练页面的 HTML 快照
// 用法: npx tsx scripts/crawl_new_pages.ts
import { fetchPage } from '../src/crawler';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';

const cases = JSON.parse(readFileSync('/tmp/new_train_html.json', 'utf-8'));
const OUT = 'data/new-pages';
mkdirSync(OUT, { recursive: true });
mkdirSync(OUT + '/html', { recursive: true });

async function main() {
  let ok = 0, fail = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const pid = createHash('sha1').update(c.url).digest('hex').slice(0, 12);
    const f = `${OUT}/html/${pid}.html`;
    if (existsSync(f)) { ok++; console.log(`[${i + 1}/${cases.length}] ${c.name} 缓存`); continue; }
    try {
      const r = await fetchPage(c.url, { timeout: 25000 });
      if (r.text && r.text.length > 500) {
        writeFileSync(f, r.text);
        ok++;
        console.log(`[${i + 1}/${cases.length}] ${c.name.slice(0, 30)}: ${r.text.length} bytes`);
      } else {
        fail++;
        console.log(`[${i + 1}/${cases.length}] ${c.name.slice(0, 30)}: 空/失败`);
      }
    } catch (e: any) {
      fail++;
      console.log(`[${i + 1}/${cases.length}] ${c.name.slice(0, 30)}: ERR ${String(e).slice(0, 50)}`);
    }
  }
  console.log(`\n完成: ${ok} 成功, ${fail} 失败`);
}
main();
