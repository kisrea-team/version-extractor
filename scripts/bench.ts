/**
 * 软件更新数据提取模型基准测试
 *
 * 用法：
 *   npx tsx scripts/bench.ts                      # 内置测试集
 *   npx tsx scripts/bench.ts --cases cases.json   # 自定义语料
 *   npx tsx scripts/bench.ts --probe <url>        # 单源探查
 *
 * 测试集 JSON：
 *   [{ "name":"nodejs","url":"https://nodejs.org/en/download/",
 *      "expectedVersion":"v24","currentDbVersion":"v23","expectChangelog":false }]
 *   - expectedVersion: 前缀匹配；'' = 期望提取不到
 *   - expectChangelog: 期望能提取到更新日志内容
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { extractFromUrl, closeBrowser } from '../src/pipeline';
import { fetchPage } from '../src/crawler';
import { shouldTrustExtraction } from '../src/version-extract';

// 开启抓取磁盘缓存（改模型重跑不用重新抓页）
process.env.BENCH_CACHE_DIR = process.env.BENCH_CACHE_DIR || '.bench-cache';

interface TestCase {
  name: string;
  url: string;
  expectedVersion: string;
  currentDbVersion?: string;
  expectChangelog?: boolean;
  registryKey?: string; // 可选：结构化版本源，如 "winget:7zip.7zip" / "brew:node"
  versionRegex?: string; // 可选：DB 的 version_regex，作为"站点信任的精确方法"基准
  skip?: boolean; // 待人工核实的用例，跳过评分
}

function normalizeVersion(v: string): string {
  const t = String(v || '').trim();
  return /^v/i.test(t) ? t : `v${t}`;
}

const BUILTIN_CASES: TestCase[] = [
  { name: 'nodejs', url: 'https://nodejs.org/en/download/', expectedVersion: 'v24', currentDbVersion: 'v23' },
  { name: 'python', url: 'https://www.python.org/downloads/', expectedVersion: 'v3.1', currentDbVersion: 'v3.13' },
  { name: 'blender', url: 'https://www.blender.org/download/', expectedVersion: 'v5', currentDbVersion: 'v4' },
  { name: 'gimp', url: 'https://www.gimp.org/downloads/', expectedVersion: 'v3', currentDbVersion: 'v2' },
  // GitHub 项目：版本号 + 日志都应可靠
  { name: 'next.js', url: 'https://github.com/vercel/next.js/releases', expectedVersion: 'v16', expectChangelog: true },
  { name: 'vscode', url: 'https://github.com/microsoft/vscode/releases', expectedVersion: 'v1', expectChangelog: true },
];

function matchesPrefix(actual: string, prefix: string): boolean {
  const norm = (s: string) => s.replace(/^v/i, '');
  const a = norm(actual);
  const e = norm(prefix);
  return a === e || a.startsWith(e + '.');
}

function parseArgs(argv: string[]) {
  const args: { cases?: string; probe?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cases') args.cases = argv[i + 1];
    if (argv[i] === '--probe') args.probe = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.probe) {
    const url = args.probe;
    const out = await extractFromUrl(url, { token: process.env.GITHUB_TOKEN, skipBrowser: process.env.SKIP_BROWSER === '1' });
    console.log(`URL: ${url}`);
    console.log(`来源: ${out.source.type}${out.source.note ? ` (${out.source.note})` : ''}${out.neededBrowser ? ' | 走了浏览器渲染' : ''}`);
    console.log(`版本: ${out.version.version || '—'} | 置信 ${out.version.confidence} | 正则: ${out.version.suggestedRegex}`);
    if (out.version.candidates?.length) {
      console.log('候选:');
      for (const c of out.version.candidates) console.log(`  ${c.version}  score=${c.score}  下载链接=${c.inDownloadUrl}  来源=${c.scope}`);
    }
    console.log(`日志: ${out.changelog ? `✅ 版本 ${out.changelog.version} | ${out.changelog.content.slice(0, 120).replace(/\n/g, ' ')}...` : '❌ 未提取到'}`);
    await closeBrowser();
    return;
  }

  const cases: TestCase[] = args.cases
    ? JSON.parse(readFileSync(args.cases, 'utf-8'))
    : (() => {
        const file = new URL('../benchmark/cases.json', import.meta.url);
        try {
          return JSON.parse(readFileSync(file, 'utf-8'));
        } catch {
          return BUILTIN_CASES;
        }
      })();

  console.log(`\n=== 更新数据提取基准 (${cases.length} 例) ===\n`);
  console.log('站点'.padEnd(12), '期望'.padEnd(10), '版本提取'.padEnd(16), '判定', '置信', '日志', '浏览器');
  console.log('-'.repeat(80));

  // 单例处理（可并行）
  interface CaseResult {
    name: string;
    expected: string;
    extracted: string | null;
    verdict: string;
    conf: string;
    changelogOk: string | boolean;
    browser: string;
    versionPass: boolean;
    versionCounted: boolean;
    changelogPass: boolean;
    changelogCounted: boolean;
  }
  async function runCase(c: TestCase): Promise<CaseResult> {
    // 待人工用例跳过（不参与评分）
    if (c.skip) {
      return { name: c.name, expected: '', extracted: null, verdict: '跳过(待人工)', conf: '—', changelogOk: '—', browser: '', versionPass: false, versionCounted: false, changelogPass: false, changelogCounted: false };
    }
    const out = await extractFromUrl(c.url, { token: process.env.GITHUB_TOKEN, registryKey: c.registryKey, skipBrowser: process.env.SKIP_BROWSER === '1' });
    const extracted = out.version?.version || null;
    const conf = out.version?.confidence || '—';
    let verdict: string;
    if (c.expectedVersion === '') verdict = extracted ? 'FAIL(误报)' : 'PASS';
    else verdict = extracted && matchesPrefix(extracted, c.expectedVersion) ? 'PASS' : 'FAIL';

    let changelogOk: string | boolean = '—';
    let changelogPass = false;
    let changelogCounted = false;
    if (c.expectChangelog) {
      changelogCounted = true;
      changelogOk = out.changelog && out.changelog.content.length > 20 ? '✅' : '❌';
      changelogPass = changelogOk === '✅';
    }

    return {
      name: c.name,
      expected: c.expectedVersion,
      extracted,
      verdict,
      conf: String(conf),
      changelogOk,
      browser: out.neededBrowser ? '🖥️' : out.registryVersion ? '📦' : '',
      versionPass: verdict.startsWith('PASS'),
      versionCounted: true,
      changelogPass,
      changelogCounted,
    };
  }

  // 并发限流执行
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

  const CONCURRENCY = 8; // 高并发：Playwright 单浏览器多页面，got-scraping 并发安全；缓存命中案例不吃内存
  const results = await mapWithConcurrency(cases, CONCURRENCY, runCase);

  let versionPass = 0;
  let versionTotal = 0;
  let changelogPass = 0;
  let changelogTotal = 0;

  for (const r of results) {
    if (r.versionCounted) versionTotal += 1;
    if (r.versionPass) versionPass += 1;
    if (r.changelogCounted) changelogTotal += 1;
    if (r.changelogPass) changelogPass += 1;
    const confIcon = { high: '🟢高', medium: '🟡中', low: '🔴低' }[r.conf] || r.conf;
    console.log(r.name.padEnd(12), (r.expected || '(无)').padEnd(10), (r.extracted || '—').padEnd(16), r.verdict, confIcon, r.changelogOk, r.browser);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`版本号提取准确率: ${versionPass}/${versionTotal} = ${(versionPass / Math.max(versionTotal, 1) * 100).toFixed(0)}%`);
  console.log(`更新日志提取成功率: ${changelogPass}/${changelogTotal} = ${(changelogPass / Math.max(changelogTotal, 1) * 100).toFixed(0)}%`);
  console.log('');
  await closeBrowser();
}

main().catch((e) => {
  console.error('基准测试失败:', e.message || e);
  process.exit(1);
});
