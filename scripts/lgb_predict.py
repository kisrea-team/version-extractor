#!/usr/bin/env python3
"""LightGBM candidate filter and page-ranker inference entry point.

stdin: {"mode": "filter"|"rank", "rows": [[...], ...]}
filter -> {"probs": [[negative, positive], ...]}
rank   -> {"scores": [float, ...]}
"""
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def load_model(base, mode):
    import joblib
    if mode == 'rank':
        model_path = os.path.join(base, '..', 'data', 'lgb-rank3.joblib')
    else:
        model_path = os.path.join(base, '..', 'data', 'lgb-filter-nodl.joblib')
    return joblib.load(model_path)


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        sys.stderr.write('empty-input\n')
        sys.exit(2)
    try:
        payload = json.loads(raw)
        mode = payload.get('mode', 'filter')
        rows = payload.get('rows', [])
        if mode not in ('filter', 'rank'):
            raise ValueError('unknown mode')
    except Exception as exc:
        sys.stderr.write(f'bad-input: {exc}\n')
        sys.exit(2)

    if not rows:
        sys.stdout.write(json.dumps({'scores' if mode == 'rank' else 'probs': []}))
        return

    base = os.path.dirname(os.path.abspath(__file__))
    try:
        model = load_model(base, mode)
        if mode == 'rank':
            scores = model.predict(rows).tolist()
            if not all(isinstance(score, (int, float)) for score in scores):
                raise ValueError('non-numeric rank score')
            sys.stdout.write(json.dumps({'scores': scores}, ensure_ascii=False))
        else:
            probs = model.predict_proba(rows).tolist()
            sys.stdout.write(json.dumps({'probs': probs}, ensure_ascii=False))
    except Exception as exc:
        sys.stderr.write(f'lgb-{mode}-failed: {exc}\n')
        sys.exit(3)


if __name__ == '__main__':
    main()
