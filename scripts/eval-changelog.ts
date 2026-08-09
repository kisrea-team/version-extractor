/**
 * 版本日志提取基线评估（GitHub / RSS / changelog页 三类）
 *
 * 用法：
 *   GITHUB_TOKEN=... npx tsx scripts/eval-changelog.ts
 *
 * 报告每例：日志是否提取到、内容长度、来源、置信度、内容前80字符。
 */
import { classifySource, enrichSource } from '../src/sources';
import { extractChangelog } from '../src/changelog';
import { extractVersionWithLgb } from '../src/lgb-score';
import { fetchPage, closeBrowser } from '../src/crawler';

// 测试用例：GitHub / RSS / changelog页 三类
const CASES = [
  { name: 'next.js(GitHub)', url: 'https://github.com/vercel/next.js/releases', type: 'github' },
  { name: 'vscode(GitHub)', url: 'https://github.com/microsoft/vscode/releases', type: 'github' },
  { name: 'nodejs(GitHub)', url: 'https://github.com/nodejs/node/releases', type: 'github' },
  { name: 'vscode(RSS)', url: 'https://code.visualstudio.com/feed.xml', type: 'rss' },
  { name: 'python(changelog页)', url: 'https://www.python.org/news/', type: 'page' },
  { name: 'blender(changelog页)', url: 'https://www.blender.org/download/releases/', type: 'page' },
  { name: 'obsidian(changelog页)', url: 'https://obsidian.md/changelog/', type: 'page' },
  { name: 'nginx(changelog页)', url: 'https://nginx.org/en/CHANGES', type: 'page' },
  { name: 'postgresql(changelog页)', url: 'https://www.postgresql.org/docs/release/', type: 'page' },
  { name: 'gimp(changelog页)', url: 'https://www.gimp.org/news/', type: 'page' },
];

async function main() {
  console.log('用例'.padEnd(20), '来源'.padEnd(16), '结果', '长度', '内容预览');
  console.log('-'.repeat(90));
  let ok = 0, total = 0;

  for (const c of CASES) {
    const source = await enrichSource(classifySource(c.url));
    let entry = null;
    try {
      if (source.type === 'changelog-page') {
        const page = await fetchPage(c.url);
        if (page.text) {
          // 模拟完整管道：版本锚点用 LightGBM 归族（与生产 extractFromUrl 同一选择器）
          const version = (await extractVersionWithLgb(page.text)).version || undefined;
          entry = await extractChangelog(source, { pageHtml: page.text, version, token: process.env.GITHUB_TOKEN });
        }
      } else {
        entry = await extractChangelog(source, { token: process.env.GITHUB_TOKEN });
      }
    } catch (e: any) {
      console.log(c.name.padEnd(20), source.type.padEnd(16), '❌异常', '—', String(e?.message || e).slice(0, 40));
      continue;
    }

    total += 1;
    if (entry && entry.content && entry.content.length > 20) {
      ok += 1;
      console.log(
        c.name.padEnd(20),
        source.type.padEnd(16),
        '✅',
        String(entry.content.length).padEnd(5),
        `${entry.version || ''} ${entry.content.slice(0, 60).replace(/\n/g, ' ')}...`
      );
    } else {
      console.log(c.name.padEnd(20), source.type.padEnd(16), '❌', '—', '未提取到(或内容过短)');
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`更新日志提取成功率: ${ok}/${total} = ${(ok / Math.max(total, 1) * 100).toFixed(0)}%`);
  await closeBrowser();
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
