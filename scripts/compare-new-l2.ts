/**
 * 候选池增强（L2 渲染）：静态快照里拿不到版本的 SPA 页面，用 Playwright 渲染后重提候选。
 *
 * 流程：
 *  1. 静态 collectCandidates（与 compare-new.ts 相同）
 *  2. 找出 expectedVersion 不在候选池的页面 → 渲染（fetchPageRenderedDeep，带缓存）
 *  3. 从渲染 HTML 重跑 collectCandidates + networkVersions/globalVersions/ctaVersions 补候选
 *  4. 合并去重 → data/compare-candidates-v2.jsonl
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { extractVersionFromHtml } from '../src/version-extract';
import { collectCandidates, chooseContexts, matches, norm } from './export-candidates';
import { fetchPageRenderedDeep, closeBrowser } from '../src/crawler';

const SEMVER_RE = /\bv?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/i;

function buildText(version: string, contexts: Array<{ text: string; scope: string }>): string {
  return `候选: ${version} [SEP] 上下文: ${contexts.map((x) => `[${x.scope}] ${x.text}`).join(' | ').slice(0, 480)}`;
}

async function main() {
  const ds = JSON.parse(readFileSync('data/dataset.json', 'utf-8'));
  const pages = ds.filter((d: any) => !d.label && d.expectedVersion && d.htmlFile && existsSync(d.htmlFile));
  console.log(`页面: ${pages.length}`);

  // 静态候选
  const candByUrl = new Map<string, any[]>();
  for (const p of pages) {
    const html = readFileSync(p.htmlFile, 'utf-8');
    const cands = collectCandidates(html, true).map((cand) => {
      const contexts = chooseContexts(cand);
      if (contexts.length === 0) return null;
      return {
        url: p.url, name: p.name, expectedVersion: p.expectedVersion,
        version: cand.version,
        text: buildText(cand.version, contexts), scopes: contexts.map((x) => x.scope),
        isSemver: SEMVER_RE.test(cand.version.replace(/^v/i, '')),
        isExpected: matches(cand.version, p.expectedVersion),
        source: 'static',
      };
    }).filter(Boolean);
    candByUrl.set(p.url, cands as any[]);
  }
  const covered = pages.filter((p: any) => (candByUrl.get(p.url) || []).some((c) => c.isExpected));
  console.log(`静态候选覆盖: ${covered.length}/${pages.length}`);

  // 渲染缺失页面
  const toRender = pages.filter((p: any) => !(candByUrl.get(p.url) || []).some((c) => c.isExpected));
  console.log(`需渲染: ${toRender.length} 页`);
  let rendered = 0;
  for (const p of toRender) {
    const deep = await fetchPageRenderedDeep(p.url);
    if (!deep.text) { console.log(`  [fail] ${p.name}`); continue; }
    const added: any[] = [];
    const seen = new Set((candByUrl.get(p.url) || []).map((c) => c.version));
    const push = (version: string, scope: string, ctxText: string) => {
      const v = norm(version);
      if (seen.has(v)) return;
      seen.add(v);
      added.push({
        url: p.url, name: p.name, expectedVersion: p.expectedVersion, version: v,
        text: buildText(v, [{ text: ctxText.slice(0, 180), scope }]),
        scopes: [scope], isSemver: SEMVER_RE.test(v.replace(/^v/i, '')),
        isExpected: matches(v, p.expectedVersion), source: 'l2-render',
      });
    };
    // 渲染后 DOM 候选
    for (const cand of collectCandidates(deep.text, true)) {
      const contexts = chooseContexts(cand);
      if (contexts.length === 0) continue;
      const v = cand.version;
      if (!seen.has(v)) {
        seen.add(v);
        added.push({
          url: p.url, name: p.name, expectedVersion: p.expectedVersion, version: v,
          text: buildText(v, contexts), scopes: contexts.map((x) => x.scope),
          isSemver: SEMVER_RE.test(v.replace(/^v/i, '')),
          isExpected: matches(v, p.expectedVersion), source: 'l2-render',
        });
      }
    }
    // 网络响应版本（产品版本跨多个响应）
    for (const nv of deep.networkVersions || []) {
      if (nv.count >= 2) push(nv.version, 'structured', `network response (${nv.count}次): ${nv.version}`);
    }
    // 全局态
    for (const gv of deep.globalVersions || []) push(gv, 'structured', `global state: ${gv}`);
    // CTA
    for (const cv of deep.ctaVersions || []) push(cv, 'download-link', `download button: ${cv}`);

    candByUrl.set(p.url, [...(candByUrl.get(p.url) || []), ...added]);
    rendered += 1;
    const ok = added.some((c) => c.isExpected);
    console.log(`  [${ok ? 'hit' : 'miss'}] ${p.name} (${p.expectedVersion}) +${added.length} 候选`);
  }
  console.log(`渲染完成: ${rendered}/${toRender.length}`);

  // 汇总输出
  const all: any[] = [];
  for (const cands of candByUrl.values()) all.push(...cands);
  writeFileSync('data/compare-candidates-v2.jsonl', all.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const covered2 = pages.filter((p: any) => (candByUrl.get(p.url) || []).some((c) => c.isExpected));
  console.log(`最终候选覆盖: ${covered2.length}/${pages.length}`);
  console.log(`候选总数: ${all.length}`);
  console.log('→ data/compare-candidates-v2.jsonl');
  await closeBrowser();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => { console.error('失败:', e.message); await closeBrowser(); process.exit(1); });
}
