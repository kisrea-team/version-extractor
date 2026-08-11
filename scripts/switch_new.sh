#!/bin/bash
# 恢复新模型为当前(对比完成后)
cd /root/ve-docker-api
cp data/lgb-rank3.joblib.new-20260811 data/lgb-rank3.joblib 2>/dev/null
echo "已恢复新模型"
md5sum data/lgb-rank3.joblib
