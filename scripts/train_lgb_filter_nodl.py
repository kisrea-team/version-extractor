#!/usr/bin/env python3
"""
lgb-filter-nodl 重训(2026-08-12 多样本版): 纯结构化 14 列, 无 BERT。

数据: ds700-ctx/train2.jsonl(1887) + ds700-clean/train.jsonl(258) 训练,
      ds700-ctx/val2.jsonl(449) 验证。label 1=当前产品版本, 0=非。
列序必须与 src/lgb-score.ts buildFeatureRow 完全一致(不是字母序!):
  has_v, is_clean, is_short_major, is_yearish, major, minor,
  n_digits_total, n_seg, patch, scope_dl, scope_heading, scope_noise,
  scope_structured, scope_visible
"""
import json
import joblib
import re
import numpy as np
import lightgbm as lgb
from sklearn.metrics import accuracy_score, f1_score

COLS = ['has_v', 'is_clean', 'is_short_major', 'is_yearish', 'major', 'minor',
        'n_digits_total', 'n_seg', 'patch', 'scope_dl', 'scope_heading',
        'scope_noise', 'scope_structured', 'scope_visible']

def version_features(s):
    v = str(s.get('version', ''))
    base = v.lstrip('vV').split('-')[0].split('+')[0]
    nums = re.findall(r'\d+', base)
    scopes = set(s.get('scopes', []))
    clean = bool(re.match(r'^\d+(\.\d+){0,3}$', base))
    return {
        'has_v': 1 if v.startswith(('v', 'V')) else 0,
        'is_clean': int(clean),
        'is_short_major': int(len(base.split('.')) == 1),
        'is_yearish': int(bool(re.match(r'^\d{4}([.-]\d{1,2}){1,2}$', base))),
        'major': int(nums[0]) if nums else 0,
        'minor': int(nums[1]) if len(nums) > 1 else 0,
        'n_digits_total': len(re.findall(r'\d', base)),
        'n_seg': len(base.split('.')),
        'patch': int(nums[2]) if len(nums) > 2 else 0,
        'scope_dl': int('download-link' in scopes),
        'scope_heading': int('heading' in scopes),
        'scope_noise': int('noise' in scopes),
        'scope_structured': int('structured' in scopes),
        'scope_visible': int('visible' in scopes),
    }

def load(path):
    return [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]

def to_matrix(samples):
    return np.array([[version_features(s)[k] for k in COLS] for s in samples], dtype=float)

def main():
    # 2026-08-12 混合样本版: 基准缓存(105页/7318) + ds700 train2(1887) + ds700-clean(258) + val2(449)
    # label 语义对齐: 都是"是否当前产品版本"的近似(基准期望 / ds700 current)
    train = (load('data/filter-bench-train.jsonl') +
             load('data/ds700-ctx/train2.jsonl') +
             load('data/ds700-clean/train.jsonl') +
             load('data/ds700-ctx/val2.jsonl'))
    # 按 url 去重(同页多源), 保留 label=1 优先
    by_key: dict = {}
    for s in train:
        k = (s.get('url', ''), s.get('version', ''))
        cur = by_key.get(k)
        if cur is None or (s.get('label', 0) == 1 and cur.get('label', 0) == 0):
            by_key[k] = s
    train = list(by_key.values())
    ytr = [s['label'] for s in train]
    pos = sum(1 for y in ytr if y == 1)
    print(f"train(去重后) {len(train)} (正 {pos} / 负 {len(train)-pos})")

    Xtr_all = to_matrix(train)
    # 随机 10% 验证(混合集内切分, 跨源泛化看推理)
    rng = np.random.RandomState(42)
    idx = rng.permutation(len(train))
    nval = max(1, len(train) // 10)
    va_idx, tr_idx = idx[:nval], idx[nval:]
    Xtr, Xva = Xtr_all[tr_idx], Xtr_all[va_idx]
    ytr = [train[i]['label'] for i in tr_idx]
    yva = [train[i]['label'] for i in va_idx]
    print(f"切分: train {len(tr_idx)} / val {len(va_idx)}")

    model = lgb.LGBMClassifier(
        n_estimators=400, learning_rate=0.05, num_leaves=31, max_depth=6,
        class_weight='balanced', random_state=42, verbosity=-1,
    )
    model.fit(Xtr, ytr)
    acc = accuracy_score(yva, model.predict(Xva))
    f1 = f1_score(yva, model.predict(Xva), zero_division=0)
    print(f"LightGBM val acc {acc:.3f} / F1 {f1:.3f}")

    joblib.dump(model, 'data/lgb-filter-nodl.joblib')
    joblib.dump(COLS, 'data/lgb-nodl-cols.joblib')
    print("→ data/lgb-filter-nodl.joblib (14列)")

if __name__ == '__main__':
    main()
