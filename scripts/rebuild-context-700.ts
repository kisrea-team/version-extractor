/**
 * 用与推理一致的 collectCandidates 上下文，为 700 条标注重建训练文本。
 *
 * 输入：
 *  - data/dataset-annotated-700.json（或 ds700.tmp.json）：标注 + htmlFile 路径
 * 输出：
 *  - data/ds700-ctx/annotations-with-context.jsonl
 *    每条：pageId / url / name / version / label / noiseType / evidenceQuote /
 *           text（候选 + collectCandidates 上下文，与推理 compare-candidates.jsonl 同格式）/
 *           scopes / hasExpectedVersion / pageExpected
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { collectCandidates, chooseContexts, matches } from './export-candidates';

function buildText(version: string, contexts: Array<{ text: string; scope: string }>): string {
  return `候选: ${version} [SEP] 上下文: ${contexts.map((x) => `[${x.scope}] ${x.text}`).join(' | ').slice(0, 480)}`;
}

async function main() {
  const ds: any = JSON.parse(readFileSync('ds700.tmp.json', 'utf-8'));
  const pages: any[] = ds.pages;
  const annotations: any[] = ds.annotations;
  const pageMap = new Map(pages.map((p: any) => [p.pageId, p]));

  const out: any[] = [];
  let ok = 0, noHtml = 0, versionNotFound = 0;

  for (const ann of annotations) {
    if (!ann.version) continue;
    const page = pageMap.get(ann.pageId);
    if (!page || !page.htmlFile || !existsSync(page.htmlFile)) { noHtml += 1; continue; }
    const html = readFileSync(page.htmlFile, 'utf-8');
    const candidates = collectCandidates(html, true);
    // 找到与标注版本匹配的候选
    const match = candidates.find((c) => matches(c.version, ann.version));
    if (!match) { versionNotFound += 1; continue; }
    const contexts = chooseContexts(match);
    if (contexts.length === 0) continue;
    out.push({
      pageId: ann.pageId,
      url: page.url,
      name: page.name,
      version: ann.version,
      label: ann.label,
      noiseType: ann.noiseType,
      evidenceQuote: ann.evidenceQuote,
      text: buildText(match.version, contexts),
      scopes: contexts.map((x) => x.scope),
      pageStatus: ann.pageStatus,
      temporalStatus: ann.temporalStatus,
      confidence: ann.confidence,
      pageExpected: page.expected,
    });
    ok += 1;
  }

  writeFileSync('data/ds700-ctx/annotations-with-context.jsonl', out.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`重建: ${ok} 条（无 HTML ${noHtml} / 版本不在候选池 ${versionNotFound}）`);
  console.log('→ data/ds700-ctx/annotations-with-context.jsonl');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}
