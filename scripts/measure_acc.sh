#!/usr/bin/env bash
# ve 基准测量: 跑真实基准, 输出版本准确率百分比(最后一行非空 = 数字)
# 用法: scripts/measure_acc.sh [cases.json]
cd "$(dirname "$0")/.."
CASES="${1:-benchmark/ve-benchmark-real.json}"
export NODE_OPTIONS="--max-old-space-size=3072"
if [ -f .gh-token.env ]; then
  GITHUB_TOKEN=$(grep -oE "GITHUB_TOKEN=.*" .gh-token.env | cut -d= -f2)
  export GITHUB_TOKEN
fi
OUT=$(npx tsx scripts/bench.ts --cases "$CASES" 2>/dev/null)
ACC=$(echo "$OUT" | grep -oE '版本号提取准确率: [0-9]+/[0-9]+ = [0-9]+%' | grep -oE '[0-9]+%' | tr -d '%')
if [ -z "$ACC" ]; then
  echo "ERROR: 无法解析准确率"
  exit 1
fi
echo "$ACC"
