/**
 * 分析 LogUp 语料每个用例的三个候选真值，用于人工判定并修正 expectedVersion
 *
 * 输出每行：name | DB快照L | 正则现抓R | 管道提取V | 注册表
 * 三个活源（R/V/注册表）取"唯一真值"：注册表>正则现抓>管道（越高越权威，需一致）
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { extractFromUrl, closeBrowser } from '../src/pipeline';
import { fetchPage } from '../src/crawler';
import { resolveRegistry } from '../src/registries';

const require = createRequire(import.meta.url);

function norm(v: string): string {
  const t = String(v || '').trim();
  return /^v/i.test(t) ? t : `v${t}`;
}

function regexLive(html: string | null, re: string | null): string | null {
  if (!html || !re) return null;
  try {
    const m = new RegExp(re).exec(html);
    return m ? norm(m[1] !== undefined ? m[1] : m[0]) : null;
  } catch {
    return null;
  }
}

async function main() {
  const cases = JSON.parse(readFileSync('benchmark/logup-cases.json', 'utf-8'));
  console.log('用例'.padEnd(14), 'DB快照'.padEnd(12), '正则现抓'.padEnd(12), '管道提取'.padEnd(12), '注册表');
  console.log('-'.repeat(70));
  for (const c of cases) {
    const L = c.currentDbVersion ? norm(c.currentDbVersion) : null;
    // 管道提取
    let V: string | null = null;
    try {
      const out = await extractFromUrl(c.url, { token: process.env.GITHUB_TOKEN });
      V = out.version?.version || null;
    } catch {
      V = null;
    }
    // 正则现抓
    const page = await fetchPage(c.url);
    const R = regexLive(page.text, c.versionRegex);
    console.log(
      (c.name || '').slice(0, 13).padEnd(14),
      (L || '—').padEnd(12),
      (R || '—').padEnd(12),
      (V || '—').padEnd(12)
    );
  }
  await closeBrowser();
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
