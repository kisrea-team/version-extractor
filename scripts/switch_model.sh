#!/bin/bash
# 切换模型: 用法 switch_model.sh [new|old]
cd /root/ve-docker-api
case "$1" in
  new)
    cp data/lgb-rank3.joblib.bak-20260811 data/lgb-rank3.joblib 2>/dev/null
    # 新模型已经是当前的, 恢复用备份
    cp data/lgb-rank3.joblib data/lgb-rank3.joblib.new-20260811
    echo "当前 = 新模型(备份为 .new-20260811)"
    ;;
  old)
    cp data/lgb-rank3.joblib.bak-20260811 data/lgb-rank3.joblib
    echo "当前 = 旧模型(2026-08-08)"
    ;;
  *)
    echo "用法: switch_model.sh [new|old]"
    ;;
esac
ls -la data/lgb-rank3.joblib
