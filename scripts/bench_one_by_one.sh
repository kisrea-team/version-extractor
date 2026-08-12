#!/usr/bin/env bash
# 逐例跑 no-registry 基准(每例独立进程防 OOM)
# 用法: bash bench_one_by_one.sh <cases.json> [--no-registry]
cd "$(dirname "$0")/.."
CASES="${1:-benchmark/bench-brew-sample.json}"
FLAG="${2:-}"
export NODE_OPTIONS="--max-old-space-size=2048"
if [ -f .gh-token.env ]; then
  GITHUB_TOKEN=$(grep -oE "GITHUB_TOKEN=.*" .gh-token.env | cut -d= -f2)
  export GITHUB_TOKEN
fi

python3 - "$CASES" << 'PYEOF'
import json, sys
cases = json.load(open(sys.argv[1]))
for i, c in enumerate(cases):
    json.dump([c], open(f'/tmp/one-{i}.json', 'w'), ensure_ascii=False)
print(f'{len(cases)} 例, 每例单跑')
PYEOF

for f in /tmp/one-*.json; do
  echo "=== $(basename $f) ==="
  npx tsx scripts/bench.ts --cases "$f" $FLAG > "${f%.json}.log" 2>&1
  grep -E "PASS|FAIL" "${f%.json}.log" | head -1
  # 每例后清浏览器缓存内存
  pkill -f chrome-linux 2>/dev/null
  sleep 2
done

# 汇总
python3 - << 'PYEOF'
import glob
tp = tf = 0
fails = []
for log in glob.glob('/tmp/one-*.log'):
    for line in open(log, encoding='utf-8', errors='replace'):
        if 'PASS' in line: tp += 1
        elif 'FAIL' in line:
            tf += 1
            fails.append(line.strip())
print(f'\n=== 汇总: PASS {tp} + FAIL {tf} = {tp+tf}, 准确率 {tp*100//max(tp+tf,1)}% ===')
for f in fails: print('FAIL:', f)
PYEOF
