#!/bin/bash
# 切旧模型 + 备份新模型
cd /root/ve-docker-api
# 当前是新模型 → 备份为 .new, 切回旧
cp data/lgb-rank3.joblib data/lgb-rank3.joblib.new-20260811 2>/dev/null
cp data/lgb-rank3.joblib.bak-20260811 data/lgb-rank3.joblib
echo "已切到旧模型(2026-08-08)"
md5sum data/lgb-rank3.joblib data/lgb-rank3.joblib.bak-20260811 | awk '{print $1}'
