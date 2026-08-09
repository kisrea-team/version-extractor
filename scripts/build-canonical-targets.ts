// 从 700 本地 HTML 快照生成可追溯的 canonical current target。
// 旧人工 current 标注仅供审计对照；没有唯一强页面证据的页面进入 review，不用于训练。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { collectCandidates } from './export-candidates';

type Context = { text: string; scope: string };
type Candidate = { version: string; contexts: Context[]; tag?: string; paths?: string[] };
type Target = {
  pageId: string;
  url: string;
  name: string;
  snapshotHash: string;
  priorCurrent: string[];
  canonicalVersion?: string;
  evidenceType?: string;
  evidenceQuote?: string;
  confidence: 'high' | 'review';
  reason?: string;
};

const CURRENT_WORDS = /\b(?:latest|current|stable|newest|recommended|release(?:d)?|download)\b|最新|当前|稳定|发布|下载/i;
const FIXES = JSON.parse(readFileSync('data/expected-fixes.json', 'utf8'));
const GENERIC = new Set(['news', 'releases', 'release', 'release-notes', 'history', 'version', 'notes', 'note', 'changelog', 'app', 'desktop', 'mobile', 'wiki', 'blog', 'page', 'for', 'and', 'the', 'of', 'help', 'support', 'stable', 'beta', 'pro', 'mac', 'windows', 'linux', 'updates', 'update']);
const bare = (v: string) => v.replace(/^v/i, '');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function productTerms(name: string): string[] {
  const text = name.toLowerCase().replace(/v?\d+(\.\d+)*/g, ' ').replace(/[|–—·():[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
  const terms = [text, ...text.split(' ').filter((w) => w.length >= 3 && !GENERIC.has(w))];
  return [...new Set(terms.filter(Boolean))];
}

function htmlFor(pageId: string): string {
  for (const batch of readdirSync('data/annotation-batches')) {
    const f = join('data/annotation-batches', batch, 'html', pageId + '.html');
    if (existsSync(f)) return readFileSync(f, 'utf8');
  }
  return '';
}

function titleOf(html: string): string {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function exactVersionIn(text: string, version: string): boolean {
  const v = bare(version);
  return new RegExp(`(?<![0-9.])v?${escape(v)}(?![0-9.])`, 'i').test(text);
}

function productAnchor(html: string, terms: string[], version: string): boolean {
  const v = escape(bare(version));
  return terms.some((term) => new RegExp(`(?:${escape(term)})[\\s<>&;:_-]{0,40}v?${v}(?![0-9.])`, 'i').test(html));
}

function currentContext(contexts: Context[], version: string): Context | null {
  return contexts.find((c) => exactVersionIn(c.text, version) && CURRENT_WORDS.test(c.text)) || null;
}

function evidenceFor(candidate: Candidate, title: string, html: string, terms: string[]) {
  const ctx = candidate.contexts;
  const structured = ctx.find((c) => c.scope === 'structured' && /(?:latest|current|stable|version|release)/i.test(c.text));
  const heading = ctx.find((c) => c.scope === 'heading' && CURRENT_WORDS.test(c.text));
  const download = ctx.find((c) => c.scope === 'download-link');
  const current = currentContext(ctx, candidate.version);
  const inTitle = exactVersionIn(title, candidate.version);
  const anchored = productAnchor(html, terms, candidate.version);
  let score = 0;
  const reasons: string[] = [];
  if (structured) { score += 10; reasons.push('structured-current'); }
  if (inTitle && anchored) { score += 9; reasons.push('title-product'); }
  else if (inTitle) { score += 6; reasons.push('title'); }
  if (heading) { score += 6; reasons.push('heading-current'); }
  if (current) { score += 5; reasons.push('current-context'); }
  if (download && anchored) { score += 5; reasons.push('download-product'); }
  else if (download && current) { score += 3; reasons.push('download-current'); }
  if (anchored) { score += 3; reasons.push('product-anchor'); }
  const evidence = structured || (inTitle ? { text: title, scope: 'title' } : null) || heading || current || download || ctx[0];
  return { score, evidence, reasons: reasons.join('+') || 'weak' };
}

function choicesForVersion(raw: Candidate[], version: string, title: string, html: string, terms: string[]) {
  return raw.filter((candidate) => bare(candidate.version) === bare(version) || bare(candidate.version).startsWith(bare(version) + '.'))
    .map((candidate) => ({ candidate, ...evidenceFor(candidate, title, html, terms) }));
}

const rows = readFileSync('data/ds700-ctx/train-ready.jsonl', 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const byPage = new Map<string, any[]>();
for (const row of rows) {
  if (!byPage.has(row.pageId)) byPage.set(row.pageId, []);
  byPage.get(row.pageId)!.push(row);
}

const accepted: Target[] = [];
const review: Target[] = [];
for (const [pageId, labels] of byPage) {
  const first = labels[0];
  const html = htmlFor(pageId);
  const priorCurrent = labels.filter((x) => x.label === 'current_product' && x.temporalStatus === 'current').map((x) => 'v' + bare(x.version));
  if (!html || !priorCurrent.length) continue;
  const raw = collectCandidates(html) as Candidate[];
  const title = titleOf(html);
  const terms = productTerms(first.name);
  const base: Target = { pageId, url: first.url, name: first.name, snapshotHash: createHash('sha256').update(html).digest('hex'), priorCurrent, confidence: 'review' };
  // 目标版本必须来自人工 current 标注或人工审计修正；页面证据只验证，不从全候选自由选最大/最高分。
  const trustedVersions = FIXES[first.url] ? [FIXES[first.url]] : priorCurrent;
  const choices = trustedVersions.flatMap((v) => choicesForVersion(raw, v, title, html, terms));
  const top = choices.sort((a, b) => b.score - a.score)[0];
  if (!top || top.score < 5) {
    review.push({ ...base, reason: `target-not-verified:${trustedVersions.join('/')}:${top?.score || 0}` });
    continue;
  }
  const incompatible = trustedVersions.filter((v) => !choices.some((x) => bare(x.candidate.version) === bare(v)));
  if (incompatible.length) {
    review.push({ ...base, reason: `target-not-collected:${incompatible.join('/')}` });
    continue;
  }
  accepted.push({ ...base, canonicalVersion: top.candidate.version, evidenceType: top.reasons, evidenceQuote: top.evidence?.text.slice(0, 240), confidence: 'high' });
}

writeFileSync('data/canonical-targets.jsonl', accepted.map((x) => JSON.stringify(x)).join('\n') + '\n');
writeFileSync('data/canonical-review.jsonl', review.map((x) => JSON.stringify(x)).join('\n') + '\n');
console.log(`high-confidence targets: ${accepted.length}`);
console.log(`review/excluded: ${review.length}`);
console.log('→ data/canonical-targets.jsonl + data/canonical-review.jsonl');
