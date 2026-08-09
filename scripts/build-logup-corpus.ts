/**
 * 从 LogUp 数据库拉取真实项目，生成扩展基准语料
 *
 * 用法：
 *   DATABASE_URL="postgresql://..." npx tsx scripts/build-logup-corpus.ts [--count 55] [--out benchmark/logup-cases.json]
 *
 * 选取标准：有 update_source_url + version_regex 的项目（站点自己信任的精确方法）
 * 输出 { name, url, currentDbVersion, versionRegex }，配合 bench 的 versionRegex 基准模式评分。
 */
import { Client } from 'pg';

async function main() {
  const count = Number(process.argv.find((a, i) => process.argv[i - 1] === '--count') || 55);
  const out = process.argv.find((a, i) => process.argv[i - 1] === '--out') || 'benchmark/logup-cases.json';
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL 未设置');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 有 regex 的项目：优先非 GitHub（启发式难度大），再补 GitHub
  const rows = await client.query(
    `SELECT name, update_source_url, version_regex, latest_version
     FROM projects
     WHERE update_source_url IS NOT NULL AND version_regex IS NOT NULL
       AND LENGTH(version_regex) BETWEEN 3 AND 120
     ORDER BY (update_source_url NOT LIKE '%github.com%') DESC, id DESC`
  );

  const cases: any[] = [];
  const seen = new Set<string>();
  for (const r of rows.rows) {
    if (cases.length >= count) break;
    const url = (r.update_source_url || '').trim();
    const name = (r.name || '').trim();
    if (!url || !r.version_regex || seen.has(url)) continue;
    seen.add(url);
    cases.push({
      name: name.length > 40 ? name.slice(0, 40) : name,
      url,
      expectedVersion: '', // 由 versionRegex 在运行时计算参考版本
      currentDbVersion: r.latest_version || undefined,
      versionRegex: r.version_regex,
    });
  }

  const { writeFileSync } = await import('fs');
  writeFileSync(out, JSON.stringify(cases, null, 2));
  const gh = cases.filter((c) => /github\.com/.test(c.url)).length;
  console.log(`已生成 ${cases.length} 例 → ${out}（GitHub ${gh} / 非GitHub ${cases.length - gh}）`);
  await client.end();
}

main().catch((e) => {
  console.error('生成失败:', e.message);
  process.exit(1);
});
