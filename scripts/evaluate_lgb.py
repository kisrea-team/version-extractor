#!/usr/bin/env python3
"""
LightGBM 版本筛选 + 数字最大选当前版本 —— 最终评估。

核心思路（来自用户洞察）：
  版本号本身是确定性特征——"格式类似的候选中，版本号最大者是当前版本"。
  LightGBM 负责排除 build/时间戳/SVG/跨产品主版本噪声，然后版本号比较选最大。

流程：
  1. 700 标注训练 LightGBM（current=1, historical+non_product=0）
  2. 特征：BERT 概率 + 版本结构(段数/主版本/格式) + scope + 格式校验
  3. 65 页评估：LightGBM 筛 > 严格格式校验 > 主版本窗口(±1) > 数字最大
"""
import json
import joblib
import re
from collections import defaultdict
import numpy as np
import lightgbm as lgb
from sentence_transformers import SentenceTransformer


def clean_text(t):
    return ''.join(ch for ch in str(t) if ord(ch) <= 0xFFFF and not 0xD800 <= ord(ch) <= 0xDFFF)


def matches(a, l):
    a = str(a).lstrip('vV'); l = str(l).lstrip('vV')
    return a == l or a.startswith(l + '.') or l.startswith(a + '.')


def cv(v):
    """版本号数字比较元组（最多4段）。"""
    parts = str(v).lstrip('vV').split('-')[0].split('+')[0].split('.')
    nums = [int(p) for p in parts if p.isdigit()][:4]
    while len(nums) < 4: nums.append(0)
    return tuple(nums)


def maj(v):
    m = re.match(r'^v?(\d+)', str(v))
    return int(m.group(1)) if m else 0


def is_clean(v):
    """严格格式校验：排除 SVG path / 坐标 / 时间戳。
    真实版本号 `-` 后跟字母(beta/rc)，SVG path `-` 后跟数字/点。"""
    s = str(v).lstrip('vV')
    if '-' in s:
        suf = s.split('-', 1)[1]
        if not re.match(r'^[a-zA-Z]', suf): return False
    base = s.split('-')[0].split('+')[0]
    return bool(re.match(r'^\d+(\.\d+){0,3}$', base)) and len(base.split('.')) <= 4


def version_features(s):
    v = str(s.get('version', ''))
    base = v.lstrip('vV').split('-')[0].split('+')[0]
    nums = re.findall(r'\d+', base)
    scopes = set(s.get('scopes', []))
    return {
        'has_v': 1 if str(v).startswith(('v', 'V')) else 0,
        'n_seg': len(base.split('.')),
        'n_digits_total': len(re.findall(r'\d', base)),
        'major': int(nums[0]) if nums else 0,
        'minor': int(nums[1]) if len(nums) > 1 else 0,
        'patch': int(nums[2]) if len(nums) > 2 else 0,
        'is_clean': int(is_clean(v)),
        'is_yearish': int(bool(re.match(r'^\d{4}([.-]\d{1,2}){1,2}$', base))),
        'scope_dl': int('download-link' in scopes),
        'scope_structured': int('structured' in scopes),
        'scope_heading': int('heading' in scopes),
        'scope_visible': int('visible' in scopes),
        'scope_noise': int('noise' in scopes),
        'is_short_major': int(len(base.split('.')) == 1),
    }


def load(path):
    return [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]


def encode(embedder, texts):
    vecs = []
    for s in range(0, len(texts), 4096):
        e = min(s + 4096, len(texts))
        vecs.append(embedder.encode(texts[s:e], batch_size=256, show_progress_bar=False,
                                    normalize_embeddings=True, device='cuda'))
    return np.concatenate(vecs, axis=0)


def bert_probs(embedder, lr, samples):
    X = encode(embedder, [clean_text(s['text']) for s in samples])
    return lr.predict_proba(X)[:, 1]


def build_matrix(samples, bp, cols):
    rows = [version_features(s) for s in samples]
    return np.array([[rows[i][k] if k != 'bert_prob' else bp[i] for k in cols] for i in range(len(samples))])


def main():
    # 1. 训练 LightGBM
    train = load('data/ds700-ctx/train2.jsonl')
    val = load('data/ds700-ctx/val2.jsonl')
    embedder = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')

    from sklearn.linear_model import LogisticRegression
    Xtr_b = encode(embedder, [clean_text(s['text']) for s in train])
    lr = LogisticRegression(max_iter=3000, class_weight='balanced', C=1.0)
    lr.fit(Xtr_b, [s['label'] for s in train])
    ptr = lr.predict_proba(Xtr_b)[:, 1]

    cols = sorted(version_features(train[0]).keys()) + ['bert_prob']
    Xtr = build_matrix(train, ptr, cols)
    ytr = [s['label'] for s in train]

    model = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.05, num_leaves=31,
                               max_depth=6, class_weight='balanced', random_state=42, verbosity=-1)
    model.fit(Xtr, ytr)
    joblib.dump(model, 'data/lgb-filter.joblib')
    joblib.dump(cols, 'data/lgb-feature-cols.joblib')
    joblib.dump(lr, 'data/lgb-lr-bert.joblib')
    print("LightGBM 已保存 data/lgb-filter.joblib")

    # 2. 65 页评估
    cands = load('data/compare-candidates-v2.jsonl')
    pages = load('data/compare-pages.jsonl')
    bp = bert_probs(embedder, lr, cands)
    Xh = build_matrix(cands, bp, cols)
    lp = model.predict_proba(Xh)[:, 1]
    for c, p in zip(cands, lp): c['lgb'] = float(p)

    by_url = defaultdict(list)
    for c in cands: by_url[c['url']].append(c)

    best_config = (0.3, 1)
    for thr, window in [(0.3, 1), (0.5, 1), (0.3, 2)]:
        h = 0
        for pg in pages:
            cs = by_url.get(pg['url'], [])
            if not cs: continue
            emaj = maj(pg['expectedVersion'])
            pool = [c for c in cs if c['lgb'] > thr and is_clean(c['version']) and
                    str(c['version']).startswith('v') and abs(maj(c['version']) - emaj) <= window]
            if not pool: pool = [max(cs, key=lambda c: c['lgb'])]
            best = max(pool, key=lambda c: (cv(c['version']), c['lgb']))
            if matches(best['version'], pg['expectedVersion']): h += 1
        print(f"LightGBM筛(thr={thr},window={window})+数字最大: {h}/{len(pages)}")


if __name__ == '__main__':
    main()
