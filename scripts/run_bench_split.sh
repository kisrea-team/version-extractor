#!/usr/bin/env bash
# 分批跑基准防 OOM: 418 例拆 4 批, 每批独立进程, 汇总结果
# 用法: bash run_bench_split.sh <cases.json> <batch_size>
cd "$(dirname "$0")/.."
CASES="${1:-benchmark/ve-benchmark-all.json}"
BATCH="${2:-110}"
export NODE_OPTIONS="--max-old-space-size=3072"
if [ -f .gh-token.env ]; then
  GITHUB_TOKEN=$(grep -oE "GITHUB_TOKEN=.*" .gh-token.env | cut -d= -f2)
  export GITHUB_TOKEN
fi

python3 - "$CASES" "$BATCH" << 'PYEOF'
import json, sys
cases = json.load(open(sys.argv[1]))
batch = int(sys.argv[2])
for i in range(0, len(cases), batch):
    chunk = cases[i:i+batch]
    json.dump(chunk, open(f'/tmp/bench-chunk-{i//batch}.json', 'w'), ensure_ascii=False)
print(f'{len(cases)} 例 → {len(cases)//batch + 1} 批')
PYEOF

for f in /tmp/bench-chunk-*.json; do
  echo "=== 跑 $f ==="
  npx tsx scripts/bench.ts --cases "$f" > "${f%.json}.log" 2>&1
  echo "EXIT=$?"
done

# 汇总
python3 - << 'PYEOF'
import glob, re
total_pass = total_fail = 0
fails = []
for log in glob.glob('/tmp/bench-chunk-*.log'):
    txt = open(log, encoding='utf-8', errors='replace').read()
    for line in txt.splitlines():
        if 'PASS' in line: total_pass += 1
        elif 'FAIL' in line:
            total_fail += 1
            fails.append(line.strip())
print(f'\n=== 汇总: PASS {total_pass} + FAIL {total_fail} = {total_pass+total_fail}, 准确率 {total_pass*100//max(total_pass+total_fail,1)}% ===')
for f in fails:
    print('FAIL:', f)
PYEOF
