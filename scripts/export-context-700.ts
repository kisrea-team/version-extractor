/**
 * 统一上下文 + 自动扩充负样本 —— 生成训练集。
 *
 * 对每个有标注的页面：
 *  1. collectCandidates(html, true) 生成候选池（与推理 compare-candidates.jsonl 同源）
 *  2. 匹配标注版本 → 用人工标签（current_product=1 / non_product=0 / historical / ambiguous）
 *  3. 页面其余候选若全部处于 noise scope → 自动标负（与旧 explicit-noise 策略一致）
 *
 * 输出：data/ds700-ctx/train-ready.jsonl（含 label 0/1，ambiguous/historical 保留 label 字段但不入二分类）
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { collectCandidates, chooseContexts, matches } from './export-candidates';

// 强噪声锚点：候选出现在这些上下文里才判为明确非产品版本。
// 避免把 MongoDB isStableBranch 这类真实产品版本分支列表误标为负。
const STRONG_NOISE_RE: RegExp[] = [
  /(viewBox|path[ ]?d=|points=|d=["']M\d|font-size|line-height|\bfill[=:]|\bstroke[=:])/i, // SVG/CSS 几何
  /(\.js\?|\.css\?|\.min\.js|\.map\?|node_modules|webpack|chunk\.[0-9a-f]+|static\.parastorage|cdn|\.js["']|\.css["'])/i,
  /(buildNumber\s*[:=]|build_number|sdkVersion\s*[:=]|apiVersion\s*[:=]|minimumOsVersion\s*[:=]|schemaVersion\s*[:=]|protocolVersion\s*[:=]|pkgVersion\s*[:=])/i,
  /(window\._wpemojiSettings|RudderStack|analytics\._writeKey|parastorage|wixui)/i, // JS SDK 嵌件
];

function buildText(version: string, contexts: Array<{ text: string; scope: string }>): string {
  return `候选: ${version} [SEP] 上下文: ${contexts.map((x) => `[${x.scope}] ${x.text}`).join(' | ').slice(0, 480)}`;
}

async function main() {
  const ds = JSON.parse(readFileSync('ds700.tmp.json', 'utf-8'));
  const pages = ds.pages;
  const annotations = ds.annotations;
  const pageMap = new Map(pages.map((p: any) => [p.pageId, p]));
  const annByPage = new Map<string, any[]>();
  for (const ann of annotations) {
    if (!ann.version) continue;
    const list = annByPage.get(ann.pageId) || [];
    list.push(ann);
    annByPage.set(ann.pageId, list);
  }

  const out: any[] = [];
  let labeled = 0, autoNeg = 0, matched = 0;
  const AUTO_NEG_PER_PAGE = 20;

  for (const page of pages) {
    const anns = annByPage.get(page.pageId);
    if (!anns || !page.htmlFile || !existsSync(page.htmlFile)) continue;
    const html = readFileSync(page.htmlFile, 'utf-8');
    const candidates = collectCandidates(html, true);
    let autoNegForPage = 0;

    for (const cand of candidates) {
      const contexts = chooseContexts(cand);
      if (contexts.length === 0) continue;
      // 匹配标注
      const ann = anns.find((a) => matches(a.version, cand.version));
      if (ann) {
        out.push({
          pageId: page.pageId, url: page.url, name: page.name,
          version: cand.version, label: ann.label, noiseType: ann.noiseType,
          temporalStatus: ann.temporalStatus, confidence: ann.confidence,
          text: buildText(cand.version, contexts), scopes: contexts.map((x) => x.scope),
          source: 'annotated', pageStatus: ann.pageStatus,
        });
        labeled += 1;
        if (ann.label === 'current_product') matched += 1;
        continue;
      }
      // 自动负样本：候选【只】出现在 noise 上下文，且命中强噪声锚点。
      // 真实版本只要出现在可见正文/下载链接/标题等，就绝不自动标负。
      const allNoise = cand.contexts.length > 0 && cand.contexts.every((c) => c.scope === 'noise');
      const isStrongNoise = allNoise && cand.contexts.some((c) => STRONG_NOISE_RE.some((re) => re.test(c.text)));
      if (isStrongNoise && autoNegForPage < AUTO_NEG_PER_PAGE) {
        autoNegForPage += 1;
        out.push({
          pageId: page.pageId, url: page.url, name: page.name,
          version: cand.version, label: 'non_product', noiseType: 'auto-noise',
          temporalStatus: 'not-applicable', confidence: 'auto',
          text: buildText(cand.version, contexts), scopes: contexts.map((x) => x.scope),
          source: 'auto-noise', pageStatus: 'mixed',
        });
        autoNeg += 1;
      }
    }
  }

  writeFileSync('data/ds700-ctx/train-ready.jsonl', out.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`标注样本 ${labeled}（含 current ${matched}）/ 自动 noise 负样本 ${autoNeg} / 共 ${out.length}`);
  console.log('→ data/ds700-ctx/train-ready.jsonl');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
}
