// 重新标注新数据: 更严格的 noise 分类(对齐 700 数据集的标注风格)
// 规则: 匹配真实版本=current; 年份式/超长段/单段大数/非semver=non_product; 其他页面版本=historical
import { readFileSync, writeFileSync } from 'fs';

const rows = readFileSync('data/new-train.jsonl', 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const bare = (v: string) => String(v || '').replace(/^v/i, '');
const matches = (a: string, b: string) => {
  const x = bare(a), y = bare(b);
  return x === y || x.startsWith(y + '.') || y.startsWith(x + '.');
};

function isNoise(version: string, label: string): boolean {
  if (label === 'current_product') return false;
  const v = bare(version);
  const nums = v.split(/[.+-]/).filter(Boolean);
  // 年份式(2024.11 / 2026.2)
  if (/^\d{4}/.test(v) && parseInt(v.slice(0, 4), 10) >= 1900 && parseInt(v.slice(0, 4), 10) <= 2100) return true;
  // 超长段(≥6位, 非年份)
  if (nums.some((n) => n.length >= 6)) return true;
  // 单段大数(如 v365, v666)
  if (nums.length === 1 && parseInt(nums[0], 10) > 100) return true;
  // 版本号超过4段
  if (nums.length > 4) return true;
  // 含非数字字符(如 3_7_20260808)
  if (/[a-z_]/i.test(v) && !/-/.test(v)) return true;
  return false;
}

let fixed = 0;
for (const r of rows) {
  if (r.label === 'historical_product' && isNoise(r.version, r.label)) {
    r.label = 'non_product';
    r.noiseType = 'build-or-coordinate';
    fixed++;
  }
}

writeFileSync('data/new-train.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const cnt: Record<string, number> = {};
for (const r of rows) cnt[r.label] = (cnt[r.label] || 0) + 1;
console.log(`修正 ${fixed} 条 historical → non_product`);
console.log('新数据 label:', JSON.stringify(cnt));
