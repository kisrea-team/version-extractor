/**
 * 爬取多版本发布页 → 构造 current > historical 排序对。
 *
 * 目标：下载页 / 版本发布页天然含"当前版本 + 历史版本"，是排序模型的
 * 核心训练素材（解决"当前 vs 旧版本"缺口）。
 *
 * 对每个 URL：
 *  1. 静态抓取 HTML
 *  2. 提取候选版本（宽松正则 + collectCandidates）
 *  3. 用页面锚点（当前版本字符串）标 current，同系列其他版本标 historical
 *  4. 构造 (current, historical) 排序对
 *
 * 输出：data/sort-crawl/raw.jsonl（含候选 + 上下文）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { collectCandidates, chooseContexts, matches, norm } from './export-candidates';
import { fetchPage } from '../src/crawler';

const SITES: Array<{ name: string; url: string; current: string; note: string }> = [
  // 注意：站点必须不在 65 页对比集（data/compare-pages.jsonl）内，避免排序训练与评估数据泄漏
  { name: 'curl', url: 'https://curl.se/download.html', current: 'v8.21', note: '官方下载页，当前版本' },
  { name: 'gnupg', url: 'https://gnupg.org/download/index.html', current: 'v2.5', note: '官方下载页含历史版本' },
  { name: 'perl', url: 'https://www.cpan.org/src/README.html', current: 'v5.42', note: 'CPAN 源码目录含历史版本' },
  { name: 'docker', url: 'https://docs.docker.com/engine/release-notes/', current: 'v28', note: '引擎发布说明含版本' },
  { name: 'mariadb', url: 'https://mariadb.com/kb/en/mariadb-versions/', current: 'v12.3', note: '版本支持表' },
  { name: 'sqlite', url: 'https://www.sqlite.org/changes.html', current: 'v3.53', note: '变更历史含版本' },
  { name: 'gcc', url: 'https://gcc.gnu.org/releases.html', current: 'v15', note: '官方发布列表' },
  { name: 'openssl', url: 'https://www.openssl.org/source/', current: 'v3.6', note: '源码目录含历史版本' },
  { name: 'kubernetes', url: 'https://kubernetes.io/releases/', current: 'v1.36', note: '版本支持矩阵' },
];

function buildText(version: string, contexts: Array<{ text: string; scope: string }>): string {
  return `候选: ${version} [SEP] 上下文: ${contexts.map((x) => `[${x.scope}] ${x.text}`).join(' | ').slice(0, 480)}`;
}

async function main() {
  mkdirSync('data/sort-crawl', { recursive: true });
  const out: any[] = [];
  let pairs = 0;

  for (const site of SITES) {
    console.log(`抓取 ${site.name} (${site.url}) ...`);
    const r = await fetchPage(site.url, { timeout: 25000 });
    if (r.error || !r.text) { console.log(`  [fail] ${r.error}`); continue; }
    const cands = collectCandidates(r.text, true);
    console.log(`  候选 ${cands.length} 个`);

    // 当前版本候选 + 历史版本（同页可见语义上下文中的其他版本号）
    const cur = cands.filter((c) => matches(c.version, site.current));
    const hist = cands.filter((c) => {
      if (matches(c.version, site.current)) return false;
      // 必须出现在可见语义上下文（heading/visible/download-link/structured），排除纯 noise（SVG/JS/坐标）
      const hasSemantic = c.contexts.some((x) => x.scope !== 'noise');
      if (!hasSemantic) return false;
      // 过滤明显的日期/年份（2026、2026.08）
      const v = c.version.replace(/^v/i, '');
      if (/^\d{4}([.-]\d{1,2})?$/.test(v)) return false;
      if (/^\d{4}[.-]\d{1,2}[.-]\d{1,2}/.test(v)) return false;
      return true;
    });

    let sitePairs = 0;
    for (const c of cur) {
      const ctx = chooseContexts(c);
      if (ctx.length === 0) continue;
      const curText = buildText(c.version, ctx);
      for (const h of hist.slice(0, 20)) {
        const hctx = chooseContexts(h);
        if (hctx.length === 0) continue;
        out.push({
          pos_text: curText, neg_text: buildText(h.version, hctx),
          pos: c.version, neg: h.version,
          site: site.name, url: site.url,
        });
        sitePairs += 1;
      }
    }
    pairs += sitePairs;
    console.log(`  当前候选 ${cur.length} / 历史候选 ${hist.length} / 排序对 +${sitePairs}`);
  }

  writeFileSync('data/sort-crawl/raw.jsonl', out.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`\n共 ${pairs} 排序对 → data/sort-crawl/raw.jsonl`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}
