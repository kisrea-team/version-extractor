/**
 * 导出统一数据集（为 MarkupLM / 后续模型训练铺路）
 *
 * 把各批次语料合并去重，为每个用例抓取原始 HTML 快照，生成带标签的 manifest。
 * 标签 = 正则在当前页现抓值 R（这是"唯一真值"的活标注）。
 *
 * 输出：
 *   data/dataset.json      合并去重后的 manifest（labels + 元数据，已提交）
 *   data/html/<id>.html    每个用例的原始 HTML 快照（gitignored，可重新生成）
 *
 * 用法：
 *   GITHUB_TOKEN=... npx tsx scripts/export-dataset.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { fetchPage } from '../src/crawler';

function norm(v: string): string {
  const t = String(v || '').trim();
  return /^v/i.test(t) ? t : `v${t}`;
}

async function main() {
  const corpusFiles = [
    'benchmark/cases.json',
    'benchmark/logup-cases.json',
    'benchmark/logup-cases-holdout.json',
    'benchmark/logup-cases-batch3.json',
  ];
  const byUrl = new Map<string, any>();
  for (const f of corpusFiles) {
    const batch = f.replace('benchmark/', '').replace('.json', '');
    let cases: any[] = [];
    try { cases = JSON.parse(readFileSync(f, 'utf-8')); } catch { continue; }
    for (const c of cases) {
      const url = (c.url || '').trim();
      if (!url) continue;
      const existing = byUrl.get(url);
      if (!existing) {
        byUrl.set(url, { ...c, batch, _url: url });
      } else {
        // 合并：优先已有的标签/registryKey，记录多批次来源
        existing.batch = existing.batch + ',' + batch;
        if (!existing.registryKey && c.registryKey) existing.registryKey = c.registryKey;
        if (!existing.expectedVersion && c.expectedVersion) existing.expectedVersion = c.expectedVersion;
      }
    }
  }

  mkdirSync('data/html', { recursive: true });

  // 并行抓取（高并发 8），避免 243 页串行超时
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

  const items = [...byUrl.values()];
  const outcomes = await mapWithConcurrency(items, 8, async (c: any) => {
    const id = createHash('sha1').update(c._url).digest('hex').slice(0, 12);
    const page = await fetchPage(c._url, { retries: 2 });
    let label: string | null = null;
    if (page.text && !page.error && c.versionRegex) {
      try {
        const m = new RegExp(c.versionRegex).exec(page.text);
        if (m) label = norm(m[1] !== undefined ? m[1] : m[0]);
      } catch {}
    }
    if (page.text && !page.error) {
      writeFileSync(join('data/html', `${id}.html`), page.text);
      return { ...c, id, label, htmlOk: true };
    }
    return { ...c, id, label, htmlOk: false };
  });

  const manifest: any[] = [];
  let fetched = 0;
  let failed = 0;
  for (const c of outcomes) {
    if (c.htmlOk) fetched += 1;
    else failed += 1;
    manifest.push({
      id: c.id,
      name: c.name,
      url: c._url,
      batch: c.batch,
      versionRegex: c.versionRegex || null,
      expectedVersion: c.expectedVersion || c.label || null,
      currentDbVersion: c.currentDbVersion || null,
      registryKey: c.registryKey || null,
      label: c.label, // 正则现抓活标注（唯一真值）
      labelSource: c.label ? 'regex-live' : null,
      htmlFile: `data/html/${c.id}.html`,
      fetchedAt: new Date().toISOString(),
    });
  }

  writeFileSync('data/dataset.json', JSON.stringify(manifest, null, 2));
  console.log(`统一数据集: ${manifest.length} 例（合并自 ${corpusFiles.length} 批）`);
  console.log(`HTML 快照: 抓取 ${fetched}，失败 ${failed} → data/html/`);
  console.log(`有活标注(label): ${manifest.filter((m) => m.label).length} 例`);
}

main().catch((e) => { console.error('导出失败:', e.message); process.exit(1); });
