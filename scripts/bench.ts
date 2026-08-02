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
import { classifySource, enrichSource } from '../src/sources';
import { extractVersionFromHtml, shouldTrustExtraction } from '../src/version-extract';
import { extractChangelog } from '../src/changelog';
import { fetchPage } from '../src/crawler';

interface TestCase {
  name: string;
  url: string;
  expectedVersion: string;
  currentDbVersion?: string;
  expectChangelog?: boolean;
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
    const source = await enrichSource(classifySource(url));
    console.log(`URL: ${url}`);
    console.log(`来源: ${source.type}${source.note ? ` (${source.note})` : ''}`);
    if (source.type === 'changelog-page') {
      const r = await fetchPage(url, { timeout: 15000 });
      if (!r.error && r.text) {
        const v = extractVersionFromHtml(r.text);
        console.log(`版本: ${v.version || '—'} | 置信 ${v.confidence} | 正则: ${v.suggestedRegex}`);
        const cl = extractChangelog(source, { pageHtml: r.text, version: v.version || undefined });
        console.log(`日志: ${cl ? `✅ ${cl.content.slice(0, 120).replace(/\n/g, ' ')}...` : '❌ 未提取到'}`);
      }
    } else {
      const cl = await extractChangelog(source, { version: undefined });
      console.log(`日志: ${cl ? `✅ 版本 ${cl.version} | ${cl.content.slice(0, 120).replace(/\n/g, ' ')}...` : '❌ 未提取到'}`);
    }
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
  console.log('站点'.padEnd(12), '期望'.padEnd(10), '版本提取'.padEnd(16), '判定', '置信', '日志');
  console.log('-'.repeat(76));

  // 单例处理（可并行）
  interface CaseResult {
    name: string;
    expected: string;
    extracted: string | null;
    verdict: string;
    conf: string;
    changelogOk: string | boolean;
    versionPass: boolean;
    versionCounted: boolean;
    changelogPass: boolean;
    changelogCounted: boolean;
  }
  async function runCase(c: TestCase): Promise<CaseResult> {
    const source = await enrichSource(classifySource(c.url));
    let verdict = '?';
    let conf = '—';
    let extracted: string | null = null;
    let changelogOk: string | boolean = '—';
    let versionPass = false;
    let versionCounted = false;
    let changelogPass = false;
    let changelogCounted = false;

    if (source.type === 'changelog-page') {
      const r = await fetchPage(c.url, { timeout: 15000 });
      if (!r.error && r.text) {
        const e = extractVersionFromHtml(r.text);
        extracted = e.version;
        conf = e.confidence;
        versionCounted = true;
        if (c.expectedVersion === '') verdict = extracted ? 'FAIL(误报)' : 'PASS';
        else verdict = extracted && matchesPrefix(extracted, c.expectedVersion) ? 'PASS' : 'FAIL';
        versionPass = verdict.startsWith('PASS');
        if (c.expectChangelog) {
          changelogCounted = true;
          const cl = extractChangelog(source, { pageHtml: r.text, version: extracted || undefined });
          changelogOk = cl && cl.content.length > 20 ? '✅' : '❌';
          changelogPass = changelogOk === '✅';
        }
      } else {
        verdict = '❌抓取失败';
      }
    } else {
      changelogCounted = true;
      const cl = await extractChangelog(source);
      extracted = cl?.version || null;
      conf = cl?.confidence || '—';
      changelogOk = cl && cl.content.length > 20 ? '✅' : '❌';
      changelogPass = changelogOk === '✅';
      versionCounted = true;
      if (c.expectedVersion === '') verdict = extracted ? 'FAIL(误报)' : 'PASS';
      else verdict = extracted && matchesPrefix(extracted, c.expectedVersion) ? 'PASS' : 'FAIL';
      versionPass = verdict.startsWith('PASS');
    }

    return { name: c.name, expected: c.expectedVersion, extracted, verdict, conf, changelogOk, versionPass, versionCounted, changelogPass, changelogCounted };
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

  const CONCURRENCY = 6; // 并发抓取数，可调
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
    console.log(r.name.padEnd(12), (r.expected || '(无)').padEnd(10), (r.extracted || '—').padEnd(16), r.verdict, confIcon, r.changelogOk);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`版本号提取准确率: ${versionPass}/${versionTotal} = ${(versionPass / Math.max(versionTotal, 1) * 100).toFixed(0)}%`);
  console.log(`更新日志提取成功率: ${changelogPass}/${changelogTotal} = ${(changelogPass / Math.max(changelogTotal, 1) * 100).toFixed(0)}%`);
  console.log('');
}

main().catch((e) => {
  console.error('基准测试失败:', e.message || e);
  process.exit(1);
});
