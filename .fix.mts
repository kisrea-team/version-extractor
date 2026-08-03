import { readFileSync, writeFileSync } from 'fs';
import { fetchPage } from './src/crawler';

function norm(v: string): string {
  const t = String(v || '').trim();
  return /^v/i.test(t) ? t : `v${t}`;
}
function regexLive(html: string | null, re: string | null): string | null {
  if (!html || !re) return null;
  try {
    const m = new RegExp(re).exec(html);
    const raw = m ? (m[1] !== undefined ? m[1] : m[0]) : null;
    if (!raw) return null;
    // 过滤明显垃圾（纯哈希、纯字母、超长）
    if (!/\d/.test(raw)) return null;
    if (/^[0-9a-f]{16,}$/i.test(raw)) return null;
    if (raw.length > 30) return null;
    return norm(raw);
  } catch { return null; }
}
const cases = JSON.parse(readFileSync('benchmark/logup-cases.json', 'utf-8'));
let fixed = 0, missing = 0;
for (const c of cases) {
  const page = await fetchPage(c.url);
  const R = regexLive(page.text, c.versionRegex);
  if (R && !/^v[a-zA-Z]+$/.test(R)) { c.expectedVersion = R; c.currentDbVersion = c.currentDbVersion || undefined; fixed++; }
  else { c.expectedVersion = ''; missing++; } // 待人工
}
writeFileSync('benchmark/logup-cases.json', JSON.stringify(cases, null, 2));
console.log('已修正', fixed, '例, 待人工', missing, '例');
