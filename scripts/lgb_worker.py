#!/usr/bin/env python3
"""常驻推理 worker: 读 stdin 行 JSON {mode, rows}, 写 stdout 行 JSON 结果。
一次加载 filter+rank 模型, 复用进程, 避免每次 spawn 的启动开销。"""
import sys
import json
import joblib
import numpy as np

MODELS = {}
COLS = {}

def load_models():
    base = '/root/ve-docker-api/data'
    MODELS['filter'] = joblib.load(f'{base}/lgb-filter-nodl.joblib')
    MODELS['rank'] = joblib.load(f'{base}/lgb-rank3.joblib')

def predict(mode, rows):
    model = MODELS[mode]
    X = np.array(rows, dtype=float)
    if X.shape[1] != model.n_features_in_:
        return {'error': f'{mode} 列数不匹配: 输入 {X.shape[1]} vs 模型 {model.n_features_in_}'}
    if mode == 'filter':
        probs = model.predict_proba(X)
        return {'probs': [[float(row[0]), float(row[1])] for row in probs]}
    else:
        scores = model.predict(X)
        return {'scores': [float(s) for s in scores]}

def main():
    load_models()
    sys.stderr.write('[worker] models loaded\n')
    sys.stderr.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            out = predict(req.get('mode'), req.get('rows', []))
        except Exception as e:
            out = {'error': str(e)[:200]}
        sys.stdout.write(json.dumps(out) + '\n')
        sys.stdout.flush()

if __name__ == '__main__':
    main()
