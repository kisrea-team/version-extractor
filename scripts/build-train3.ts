// 从本地 HTML 重建页面内排序数据。
// 训练特征只使用候选、页面和同-major组；不使用跨-major归族结果。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { collectCandidates } from './export-candidates';
import { predictCandidateVersions } from '../src/lgb-score';
import { detectVersionSequence } from '../src/version-extract';

type PageSpec = { url: string; name: string; expected: string; html: string; source: '700' | '80' | 'brew' | 'logup'; histVersions: Set<string> };
const bare = (v: string) => v.replace(/^v/i, '');
const parts = (v: string) => bare(v).split(/[.+-]/)[0].split('.').map((x) => Number(x) || 0);
const compare = (a: string, b: string) => { const x = parts(a), y = parts(b); for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const matches = (a: string, b: string) => bare(a) === bare(b) || bare(a).startsWith(bare(b) + '.') || bare(b).startsWith(bare(a) + '.');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GENERIC = new Set(['news','releases','release','release-notes','history','version','notes','note','changelog','app','desktop','mobile','wiki','blog','page','for','and','the','of','help','support','stable','beta','pro','mac','windows','linux','updates','update']);
const FIXES = JSON.parse(readFileSync('data/expected-fixes.json', 'utf8'));
const REMOVE = new Set(JSON.parse(readFileSync('data/remove-pages.json', 'utf8')));
function productName(name: string): string { return name.toLowerCase().replace(/v?\d+(\.\d+)*/g, ' ').replace(/[|–—·():[\]{}]/g, ' ').split(/\s+/).find((w) => w.length >= 2 && !GENERIC.has(w)) || ''; }
function htmlFor700(pid: string): string {
  for (const batch of readdirSync('data/annotation-batches')) { const f = join('data/annotation-batches', batch, 'html', pid + '.html'); if (existsSync(f)) return readFileSync(f, 'utf8'); }
  return '';
}
function chooseCanonical(versions: string[]): string | null {
  const uniq = [...new Set(versions.map((v) => 'v' + bare(v)))];
  const maximal = uniq.filter((v) => !uniq.some((other) => other !== v && bare(other).startsWith(bare(v) + '.')));
  if (maximal.length === 1) return maximal[0];
  // 多个 current 若同一 major/minor 只是格式别名，取更具体/更高者；不兼容冲突则拒绝。
  const majors = new Set(maximal.map((v) => parts(v)[0]));
  if (majors.size === 1 && maximal.length > 0) return maximal.sort(compare).pop()!;
  return null;
}
function pageList(): { pages: PageSpec[]; conflicts: any[]; recallMiss: any[] } {
  const pages: PageSpec[] = [], conflicts: any[] = [], recallMiss: any[] = [];
  const targets = readFileSync('data/canonical-targets.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ready = readFileSync('data/ds700-ctx/train-ready.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byPage = new Map<string, any[]>();
  for (const r of ready) { if (!byPage.has(r.pageId)) byPage.set(r.pageId, []); byPage.get(r.pageId)!.push(r); }
  for (const target of targets) {
    if (REMOVE.has(target.url)) continue;
    const rows = byPage.get(target.pageId) || [];
    const html = htmlFor700(target.pageId);
    if (!html) { recallMiss.push({ source: '700', pageId: target.pageId, url: target.url, reason: 'missing-html' }); continue; }
    const histVersions = new Set(rows.filter((r) => r.label === 'historical_product').map((r) => 'v' + bare(r.version)));
    pages.push({ source: '700', url: target.url, name: target.name, expected: target.canonicalVersion, html, histVersions });
  }
  // ⚠️ 2026-08-16 新增 brew-cross 页（+100 页，其中 58 页候选池≥30 的长列表）：
  //   标签 = brew cask 注册表 version（命名字段，Homebrew CI livecheck 维护）
  //   ∩ 该版本字面出现于同时抓取的页面 ∩ 页面无更高同族版本（单调性门）
  //   三重保证使标签独立于"从页面提取"这一过程本身，不存在自举偏差。
  //   107 条已逐条复检（门1/门2 复现 + 快照 SHA-256 校验 0 失配）；审计发现
  //   "页面最大版本"多为 OS 版本/价格/文件大小噪声，正是要学会拒绝的形态。
  //
  //   收益（scripts/train3_ablate.py 四方对照实测）：
  //     长列表页 9 → 58 页后，同一 37 列模型 test 60.9% → 73.7%，
  //     长列表子集 33.3% → 66.7%（翻倍）。
  //   ——长列表排序短板的真因是"训练集没有长列表页"，不是缺特征：
  //     试过的 nearby_date_recency / decl_word_distance 两个特征单元验证判别
  //     方向正确（Fork 1.0 vs 0.48、Termius 0.5 vs 0），但对照实验 val 涨 test 跌
  //     （过拟合），且 both40 在长列表上反降到 50%，故不并入（实现保留在
  //     src/decl-date-features.ts 供后续更大数据量时重试）。
  const brewLabels = 'data/annotation-batches/batch-brew/labels.jsonl';
  if (existsSync(brewLabels)) {
    const seen = new Set(pages.map((p) => p.url.replace(/\/$/, '')));
    const byId = new Map<string, any>();
    for (const line of readFileSync(brewLabels, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      byId.set(r.pageId, r);   // 去重：多轮抓取可能重复 pageId
    }
    for (const r of byId.values()) {
      if (REMOVE.has(r.url) || seen.has(r.url.replace(/\/$/, ''))) continue;
      // ⚠️ 2026-08-17 配比消融：不再砍 brew homepage（噪声页反而是"拒绝非版本数字"的
      //    有用样本），占比由 train3_ablate.py 的 --brew-max 控制（默认全量）
      const f = join(process.cwd(), r.snapshotFile);
      if (!existsSync(f)) { recallMiss.push({ source: 'brew', pageId: r.pageId, url: r.url, reason: 'missing-html' }); continue; }
      // brew 页无 historical 标注 → 空集（featureRows 按"同 major 且低于 target"兜底推断）
      pages.push({ source: 'brew', url: r.url, name: r.name, expected: r.currentVersion, html: readFileSync(f, 'utf8'), histVersions: new Set() });
    }
  }
  // ⚠️ 2026-08-17 新增 logup 官网 changelog 页（+79 页）：
  //   标签 = logup latest_version 交叉验证（门1: 字面出现 → logup-verified）
  //         失败时回退页面最高版本（page-latest, changelog 页最新条目即真值）
  //   标签来源记录在 labelSource，可审计
  const logupLabels = 'data/annotation-batches/batch-logup/labels.jsonl';
  if (existsSync(logupLabels)) {
    const seen = new Set(pages.map((p) => p.url.replace(/\/$/, '')));
    const byId = new Map<string, any>();
    for (const line of readFileSync(logupLabels, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      byId.set(r.pageId, r);
    }
    for (const r of byId.values()) {
      if (REMOVE.has(r.url) || seen.has(r.url.replace(/\/$/, ''))) continue;
      const f = r.html || join(process.cwd(), r.snapshotFile);
      if (!existsSync(f)) { recallMiss.push({ source: 'logup', pageId: r.pageId, url: r.url, reason: 'missing-html' }); continue; }
      pages.push({ source: 'logup', url: r.url, name: r.name, expected: r.expected || r.currentVersion, html: readFileSync(f, 'utf8'), histVersions: new Set() });
    }
  }
  // 80 基准故意不进入训练：其 expected 多为粗前缀且部分快照已过期/损坏。
  return { pages, conflicts, recallMiss };
}
function numeric(v: string) { return parts(v); }
function featureRows(p: PageSpec, scored: Array<{ version: string; prob: number }>, raw: any[], target: string) {
  const valid = scored.filter((s) => Number.isFinite(s.prob));
  const allNums = valid.map((s) => numeric(s.version));
  const globalMax = [...valid].sort((a, b) => compare(a.version, b.version)).pop()?.version || '';
  const prod = productName(p.name), prodRe = prod ? new RegExp('(?:' + esc(prod) + ')[\\s-]*v?(\\d+(?:\\.\\d+){1,3})', 'gi') : null;
  const title = (p.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ');
  const pageType = /error|403 forbidden|404 not found/i.test(p.html) ? 'error'
    : /download/i.test(p.html.slice(0, 30000)) ? 'download'
    : /changelog|release|history|version/i.test(p.html.slice(0, 30000)) ? 'history'
    : /news|blog/i.test(p.html.slice(0, 30000)) ? 'article' : 'page';
  const seq = detectVersionSequence(p.html);
  const byMajor = new Map<number, typeof valid>();
  for (const s of valid) { const m = numeric(s.version)[0] || 0; if (!byMajor.has(m)) byMajor.set(m, []); byMajor.get(m)!.push(s); }
  const rows: any[] = [];
  for (const s of valid) {
    const c = raw.find((x) => x.version === s.version);
    const base = bare(s.version).split(/[+-]/)[0]; const ns = numeric(s.version); const major = ns[0] || 0;
    const group = byMajor.get(major) || [];
    const ordered = [...group].sort((a, b) => compare(a.version, b.version));
    const higher = valid.filter((x) => compare(x.version, s.version) > 0).length;
    const occurrences = (p.html.match(new RegExp('(?<![0-9.])' + esc(bare(s.version)) + '(?![0-9.])', 'gi')) || []).length;
    const first = p.html.toLowerCase().indexOf(bare(s.version).toLowerCase());
    const anchor = prodRe ? [...p.html.matchAll(prodRe)].some((m) => bare(s.version) === bare('v' + m[1]) || bare(s.version).startsWith(m[1] + '.')) : false;
    const titleAnchor = new RegExp(esc(prod) + '[\\s-]*v?' + esc(bare(s.version)), 'i').test(title);
    const scopes = new Set(c?.contexts?.map((x: any) => x.scope) || []);
    const paths = c?.paths || [];
    const pathCounts = new Map<string, number>();
    for (const q of group) { const rc = raw.find((x) => x.version === q.version); for (const path of rc?.paths || []) pathCounts.set(path, (pathCounts.get(path) || 0) + 1); }
    const dominantPath = [...pathCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const sameMajorLatest = ordered.at(-1)?.version === s.version;
    const row = {
      version: s.version, url: p.url, source: p.source, expected: target,
      label: bare(s.version) === bare(target) ? 2 : matches(s.version, target) ? 1 : 0,
      hist: p.histVersions.has(s.version) ? 1 : (p.histVersions.size === 0 && major === (parts(target)[0] || 0) && compare(s.version, target) < 0 ? 1 : 0),
      prob: s.prob, major, minor: ns[1] || 0, patch: ns[2] || 0, n_seg: base.split('.').length, n_digits_total: (base.match(/\d/g) || []).length,
      has_v: /^v/i.test(s.version) ? 1 : 0, is_clean: /^\d+(\.\d+){0,3}$/.test(base) ? 1 : 0, is_yearish: /^\d{4}([.-]\d{1,2}){1,2}$/.test(base) ? 1 : 0, is_short_major: base.split('.').length === 1 ? 1 : 0,
      scope_dl: scopes.has('download-link') ? 1 : 0, scope_structured: scopes.has('structured') ? 1 : 0, scope_heading: scopes.has('heading') ? 1 : 0, scope_visible: scopes.has('visible') ? 1 : 0, scope_noise: scopes.has('noise') ? 1 : 0,
      page_candidate_count: valid.length, same_major_count: group.length, higher_count: higher, rank_pct: valid.length ? higher / valid.length : 0,
      is_global_max: bare(s.version) === bare(globalMax) ? 1 : 0, is_same_major_latest: sameMajorLatest ? 1 : 0,
      occurrence_count: occurrences, first_position_pct: first >= 0 ? first / Math.max(p.html.length, 1) : 1, scope_count: c?.contexts?.length || 0, independent_scope_count: scopes.size,
      product_anchor: anchor ? 1 : 0, title_product_anchor: titleAnchor ? 1 : 0, product_name_present: prod && (c?.contexts || []).some((x: any) => new RegExp('\\b' + esc(prod) + '\\b', 'i').test(x.text)) ? 1 : 0,
      // ⚠️ 语义标注特征(2026-08-12): 页面明确写 "Latest/Current/Stable version: X" 时该候选是当前版
      // Bandizip v7.45 有 "Latest version:" 标注但 prob 低, filter 模型看不到语义只能打低分
      latest_annotated: (c?.contexts || []).some((x: any) => /(?:latest|current|stable|newest)\s+version\s*[:=]\s*["']?v?\d/i.test(x.text)) ? 1 : 0,
      same_major_path_match: dominantPath && paths.includes(dominantPath) ? 1 : 0, same_major_path_share: dominantPath && paths.includes(dominantPath) ? (pathCounts.get(dominantPath) || 0) / Math.max(group.length, 1) : 0,
      same_major_minor_count: new Set(group.map((x) => numeric(x.version).slice(0, 2).join('.'))).size, sequence_member: seq?.series.some((v) => matches(s.version, v)) ? 1 : 0, sequence_latest: seq && matches(s.version, seq.latest) ? 1 : 0, page_type_download: pageType === 'download' ? 1 : 0, page_type_history: pageType === 'history' ? 1 : 0, page_type_article: pageType === 'article' ? 1 : 0, page_type_error: pageType === 'error' ? 1 : 0,
    };
    rows.push(row);
  }
  return rows;
}
const pySem = (() => { let active = 0; const q: Array<() => void> = []; const limit = 4; return { acquire: async () => { if (active >= limit) await new Promise<void>((resolve) => q.push(() => resolve())); active++; }, release: () => { active--; q.shift()?.(); } }; })();
async function runPage(p: PageSpec) {
  const raw = collectCandidates(p.html); if (!raw.length) return [];
  const cs = raw.map((x) => ({ version: x.version, scopes: x.contexts.map((y) => y.scope), contexts: x.contexts, tag: x.tag, paths: x.paths }));
  await pySem.acquire(); let scored; try { scored = await predictCandidateVersions(cs); } finally { pySem.release(); }
  if (process.env.DEBUG_BT3) console.error(`[bt3] ${p.url.slice(0, 60)} candidates=${raw.length} scored=${scored.length}`);
  // 与生产 seed 路径一致：只对过滤后（prob>0.3、非日期）候选训练排序。
  const eligible = scored.filter((s) => Number.isFinite(s.prob) && s.prob > 0.3 && !/^v?\d{4}[-.]\d{2}[-.]\d{2}$/.test(s.version));
  return featureRows(p, eligible, raw, p.expected);
}
async function map20<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> { const out = new Array<R>(items.length); let next = 0; async function worker() { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } } await Promise.all(Array.from({ length: Math.min(20, items.length) }, worker)); return out; }
const built = pageList();
console.log(`页面清单 ${built.pages.length} 页，700标签冲突 ${built.conflicts.length}，80/目标召回缺失 ${built.recallMiss.length}`);
const result = (await map20(built.pages, runPage)).flat();
const grouped = new Map<string, any[]>(); for (const r of result) { if (!grouped.has(r.url)) grouped.set(r.url, []); grouped.get(r.url)!.push(r); }
const usable = [...grouped.values()].filter((rs) => rs.some((r) => r.label === 2));
const rows = usable.flat();
const report = { pages: built.pages.length, usablePages: usable.length, conflicts: built.conflicts, recallMiss: built.recallMiss, rows: rows.length, positives: rows.filter((r) => r.label === 2).length, aliases: rows.filter((r) => r.label === 1).length };
writeFileSync('data/train3-manifest.json', JSON.stringify(report, null, 2));
writeFileSync('data/train3.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`可训练 ${usable.length} 页 / ${rows.length} 行，canonical正例 ${report.positives}，alias ${report.aliases}`);
console.log('→ data/train3.jsonl + data/train3-manifest.json');
