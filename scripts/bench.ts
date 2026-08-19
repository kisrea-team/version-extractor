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
import { readFileSync, writeSync } from 'fs';
import { extractFromUrl, closeBrowser } from '../src/pipeline';
import { fetchPage } from '../src/crawler';
import { shouldTrustExtraction } from '../src/version-extract';

// 抓取磁盘缓存：默认开启（改模型重跑不用重新抓页）
// ⚠️ 2026-08-16 修复 falsy 兜底 bug：原写法 `|| '.bench-cache'` 让 BENCH_CACHE_DIR=''（空串，
// 意图是禁用缓存）被当 falsy 兜回默认目录 → 一直读 24h 前的旧快照 → 页面已更新却记为 FAIL
// （Framer/Clockify/Surge 三例假 FAIL 皆源于此）。现在显式支持 off/0/false/空串禁用。
{
  const raw = process.env.BENCH_CACHE_DIR;
  const disabled = raw !== undefined && ['', 'off', '0', 'false', 'no'].includes(raw.trim().toLowerCase());
  if (disabled) {
    delete process.env.BENCH_CACHE_DIR; // crawler 读不到 → 不走缓存
    console.log('[bench] 缓存已禁用（实时抓取）');
  } else if (!raw) {
    process.env.BENCH_CACHE_DIR = '.bench-cache';
  }
}

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
  // norm: 去 v 前缀 + 去 -/+ build 后缀(ImageMagick 7.1.2-29 vs v7.1.2 提取截断, 双向匹配)
  const norm = (s: string) => s.replace(/^v/i, '').split('-')[0].split('+')[0];
  const a = norm(actual);
  const e = norm(prefix);
  // 双向匹配: 提取=期望, 或互为前缀(页面只显示短版本如 13.1 vs DB 完整版 13.1.0, 或带 build 号)
  return a === e || a.startsWith(e + '.') || e.startsWith(a + '.');
}

function parseArgs(argv: string[]) {
  const args: { cases?: string; probe?: string; noRegistry?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cases') args.cases = argv[i + 1];
    if (argv[i] === '--probe') args.probe = argv[i + 1];
    if (argv[i] === '--no-registry') args.noRegistry = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const noRegistry = args.noRegistry;

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

  writeSync(1, `\n=== 更新数据提取基准 (${cases.length} 例) ===\n\n`);
  writeSync(1, `${'站点'.padEnd(12)} ${'期望'.padEnd(10)} ${'版本提取'.padEnd(16)} 判定 置信 日志 浏览器\n`);
  writeSync(1, `${'-'.repeat(80)}\n`);

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
    llmUsed: boolean;
    llmAnswer: string | null;
    llmOk: boolean | null;
    // ⚠️ 2026-08-16 失败层归因：期望版本是否进入候选池
    //   FAIL + inPool=true  → 选择层问题（rank/LLM 选错，候选是对的）
    //   FAIL + inPool=false → 采集层问题（真版本没被采集到，任何选择器都救不了）
    //   FAIL + poolSize=0   → 采集层彻底失败（页面无候选/抓取失败）
    inPool: boolean | null;
    poolSize: number;
  }

  // 每例结果实时写出：fs.writeSync(1, ...) 同步写 fd 1，绕过 Node 对文件的 stdout 缓冲，
  // 重定向到日志也能逐行看到进度（否则 80 例 ~6KB 要等进程结束才落盘）。
  function printRow(r: CaseResult): void {
    const confIcon = { high: '🟢高', medium: '🟡中', low: '🔴低' }[r.conf] || r.conf;
    // FAIL 行附带失败层标记：📥采集层(真版本没进池) / 🎯选择层(在池里选错) / 🚫池空
    let layer = '';
    if (!r.versionPass && r.versionCounted && r.expected) {
      layer = r.poolSize === 0 ? ' 🚫池空' : r.inPool ? ' 🎯选择层' : ' 📥采集层';
    }
    writeSync(1, `${r.name.padEnd(12)} ${(r.expected || '(无)').padEnd(10)} ${(r.extracted || '—').padEnd(16)} ${r.verdict} ${confIcon} ${r.changelogOk} ${r.browser}${layer}\n`);
  }

  async function runCase(c: TestCase): Promise<CaseResult> {
    // 待人工用例跳过（不参与评分）
    if (c.skip) {
      return { name: c.name, expected: '', extracted: null, verdict: '跳过(待人工)', conf: '—', changelogOk: '—', browser: '', versionPass: false, versionCounted: false, changelogPass: false, changelogCounted: false, llmUsed: false, llmAnswer: null, llmOk: null, inPool: null, poolSize: 0 };
    }
    // LLM 回退需要 productName 才会触发；用 c.name 当产品名，并记录每次 LLM 判定结果
    let llmUsed = false;
    let llmAnswer: string | null = null;
    const out = await extractFromUrl(c.url, {
      token: process.env.GITHUB_TOKEN,
      registryKey: noRegistry ? undefined : c.registryKey,
      noRegistry,
      skipBrowser: process.env.SKIP_BROWSER === '1',
      productName: c.name,
      onLlm: (info) => { llmUsed = true; llmAnswer = info.answer; },
    });
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

    // 失败层归因：期望版本是否在候选池里
    // ⚠️ 用 allCandidates（完整池）而非 candidates（top-8 展示截断）——否则"没进 top-8"
    // 会被误判成"采集层没抓到"，把选择层问题记到采集层账上。
    const pool = out.version?.allCandidates?.length
      ? out.version.allCandidates.map(String)
      : (out.version?.candidates || []).map((x) => String(x.version || ''));
    const poolSize = pool.length;
    const bare = (v: string) => v.replace(/^v/i, '').trim();
    const expBare = bare(c.expectedVersion || '');
    const inPool = !expBare ? null : pool.some((p) => {
      const pb = bare(p);
      return pb.startsWith(expBare) || expBare.startsWith(pb);
    });

    const r: CaseResult = {
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
      llmUsed,
      llmAnswer,
      llmOk: llmUsed ? matchesPrefix(llmAnswer ?? '', c.expectedVersion) : null,
      inPool,
      poolSize,
    };
    printRow(r); // 完成即输出，实时可见
    return r;
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

  const CONCURRENCY = 1; // 串行防 OOM(本机/VPS 均 3.8G 内存): Playwright 页面不释放, 任何并发都会累积内存; 串行+缓存命中可跑完整基准
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
  }

  console.log('\n' + '='.repeat(60));
  console.log(`版本号提取准确率: ${versionPass}/${versionTotal} = ${(versionPass / Math.max(versionTotal, 1) * 100).toFixed(0)}%`);
  console.log(`更新日志提取成功率: ${changelogPass}/${changelogTotal} = ${(changelogPass / Math.max(changelogTotal, 1) * 100).toFixed(0)}%`);

  // ⚠️ 2026-08-16 失败层归因 + 候选召回率：区分"采集层拿不到"与"选择层选错"，
  // 否则端到端准确率无法指导优化方向（改 rank/LLM 只影响选择层那部分）。
  const scored = results.filter((r) => r.versionCounted && r.expected);
  const withPool = scored.filter((r) => r.inPool !== null);
  const recall = withPool.filter((r) => r.inPool).length;
  const fails = scored.filter((r) => !r.versionPass);
  const failPoolEmpty = fails.filter((r) => r.poolSize === 0);
  const failCollect = fails.filter((r) => r.poolSize > 0 && r.inPool === false);
  const failSelect = fails.filter((r) => r.inPool === true);
  console.log('\n=== 失败层归因 ===');
  console.log(`候选召回率(期望版本进完整池): ${recall}/${withPool.length} = ${(recall / Math.max(withPool.length, 1) * 100).toFixed(0)}%`);
  console.log(`FAIL ${fails.length} 例 → 🚫池空 ${failPoolEmpty.length} | 📥采集层漏召回 ${failCollect.length} | 🎯选择层选错 ${failSelect.length}`);
  if (failPoolEmpty.length) console.log('  🚫池空(抓取/渲染失败或页面无候选):', failPoolEmpty.map((r) => r.name).join(' '));
  if (failCollect.length) console.log('  📥采集层(池非空但真版本未进池):', failCollect.map((r) => `${r.name}(池${r.poolSize})`).join(' '));
  if (failSelect.length) console.log('  🎯选择层(真版本在池内但选错):', failSelect.map((r) => `${r.name}: 选${r.extracted}期望${r.expected}`).join(' | '));
  console.log(`\n上限估计: 修好选择层可达 ${((versionPass + failSelect.length) / Math.max(versionTotal, 1) * 100).toFixed(0)}%；采集层是剩余 ${failPoolEmpty.length + failCollect.length} 例的瓶颈`);

  // LLM 兜底判定：只统计真正咨询过 LLM 的用例（margin<0.1 + 有产品名才触发）
  const llmCases = results.filter((r) => r.llmUsed);
  const llmRight = llmCases.filter((r) => r.llmOk);
  const llmWrong = llmCases.filter((r) => r.llmOk === false && r.llmAnswer);
  const llmNone = llmCases.filter((r) => !r.llmAnswer);
  console.log('\n=== LLM 兜底判定 ===');
  console.log(`咨询 ${llmCases.length} 例 | 答对 ${llmRight.length} | 答错 ${llmWrong.length} | 无答案 ${llmNone.length}`);
  if (llmRight.length) console.log('答对:', llmRight.map((r) => `${r.name}=${r.llmAnswer}`).join(' '));
  if (llmWrong.length) console.log('答错:\n    ' + llmWrong.map((r) => `${r.name} 期望${r.expected} LLM=${r.llmAnswer} 最终=${r.extracted}`).join('\n    '));
  if (llmNone.length) console.log('无答案:', llmNone.map((r) => r.name).join(' '));
  console.log('');
  await closeBrowser();
}

main().catch((e) => {
  console.error('基准测试失败:', e.message || e);
  process.exit(1);
});
