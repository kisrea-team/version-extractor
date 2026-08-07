// 评估：哪些用例页面本身无可靠版本信号（该删测试集）
// 方法：启发式(84%) + LightGBM 都试，对比期望，判断页面是否有版本信号
import { fetchPage } from '../src/crawler';
import { extractVersionFromHtml } from '../src/version-extract';
import { extractVersionWithLgb } from '../src/lgb-score';

const cases = [
  { name: 'eagle', url: 'https://eagle.cool/blog/post/eagle4-build20', expected: 'v4' },
  { name: 'shottr', url: 'https://shottr.cc', expected: 'v1' },
  { name: 'affinity-designer', url: 'https://affinity.serif.com/en-us/designer/', expected: 'v2' },
  { name: 'rectangle', url: 'https://rectangleapp.com/pro/downloads/updates.xml', expected: 'v3' },
  { name: 'kdenlive', url: 'https://kdenlive.org/en/download/', expected: 'v25' },
  { name: 'sketch', url: 'https://www.sketch.com/releases/mac/', expected: 'v2025' },
  { name: 'gitkraken', url: 'https://www.gitkraken.com/download', expected: 'v11' },
  { name: 'bitwarden', url: 'https://bitwarden.com/help/releasenotes/', expected: 'v2026' },
];

for (const c of cases) {
  const r = await fetchPage(c.url);
  const dls = [...r.text.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1])
    .filter((x) => /\.(dmg|exe|msi|zip|tar\.gz|appimage)/i.test(x));
  const h = extractVersionFromHtml(r.text);
  const l = await extractVersionWithLgb(r.text);
  console.log(`${c.name.padEnd(18)} 期望=${c.expected.padEnd(8)} 启发式=${(h.version || '—').padEnd(14)}(${h.confidence}) LGB=${(l.version || '—').padEnd(14)}(${l.confidence}) 下载链=${dls.length}`);
}
