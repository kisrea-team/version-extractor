#!/usr/bin/env python3
"""训练页面内版本排序模型：每个 URL 一个 query，canonical=2、alias=1、历史/噪声=0。"""
import json
import hashlib
from collections import defaultdict

import joblib
import lightgbm as lgb
import numpy as np

rows = [json.loads(line) for line in open('data/train3.jsonl', encoding='utf-8') if line.strip()]
FEATS = [
    'prob', 'has_v', 'n_seg', 'n_digits_total', 'major', 'minor', 'patch',
    'is_clean', 'is_yearish', 'is_short_major',
    'scope_dl', 'scope_structured', 'scope_heading', 'scope_visible', 'scope_noise',
    'page_candidate_count', 'same_major_count', 'higher_count', 'rank_pct',
    'is_global_max', 'is_same_major_latest', 'occurrence_count', 'first_position_pct',
    'scope_count', 'independent_scope_count', 'product_anchor', 'title_product_anchor',
    'product_name_present', 'same_major_path_match', 'same_major_path_share',
    'same_major_minor_count', 'sequence_member', 'sequence_latest',
    'page_type_download', 'page_type_history', 'page_type_article', 'page_type_error',
]

missing = sorted({f for row in rows for f in FEATS if f not in row})
if missing:
    raise RuntimeError(f'缺少特征: {missing}')
if any(not np.isfinite(float(row[f])) for row in rows for f in FEATS):
    raise RuntimeError('训练特征包含非有限值')

pages = defaultdict(list)
for row in rows:
    pages[row['url']].append(row)
urls = sorted(pages)
# 固定 URL 分组切分。80 不在 train3，因此不会与基准页泄漏。
rng = np.random.RandomState(42)
rng.shuffle(urls)
n = len(urls)
split = {
    'train': urls[:int(n * 0.70)],
    'val': urls[int(n * 0.70):int(n * 0.85)],
    'test': urls[int(n * 0.85):],
}

for name, group_urls in split.items():
    group_rows = [row for url in group_urls for row in pages[url]]
    print(f"{name}: {len(group_urls)}页 / {len(group_rows)}候选 / canonical={sum(row['label'] == 2 for row in group_rows)}")


def matrix(group_urls):
    return np.asarray([[float(row[f]) for f in FEATS] for url in group_urls for row in pages[url]], dtype=float)


def labels(group_urls):
    return np.asarray([int(row['label']) if row['label'] in (1, 2) else 0 for url in group_urls for row in pages[url]], dtype=int)


def groups(group_urls):
    return [len(pages[url]) for url in group_urls]

X_train, y_train = matrix(split['train']), labels(split['train'])
X_val, y_val = matrix(split['val']), labels(split['val'])
X_test, y_test = matrix(split['test']), labels(split['test'])

group_train, group_val, group_test = groups(split['train']), groups(split['val']), groups(split['test'])

model = lgb.LGBMRanker(
    objective='lambdarank',
    metric='ndcg',
    ndcg_at=[1, 3, 5],
    label_gain=[0, 1, 3],
    n_estimators=500,
    learning_rate=0.035,
    num_leaves=31,
    max_depth=7,
    min_child_samples=20,
    reg_lambda=1.0,
    random_state=42,
    verbosity=-1,
    n_jobs=16,
)
model.fit(
    X_train,
    y_train,
    group=group_train,
    eval_set=[(X_val, y_val)],
    eval_group=[group_val],
    callbacks=[lgb.early_stopping(60, verbose=False)],
)

joblib.dump(model, 'data/lgb-rank3.joblib')
joblib.dump(FEATS, 'data/lgb-rank3-cols.joblib')
manifest = json.load(open('data/train3-manifest.json', encoding='utf-8'))
artifact_meta = {
    'model': 'lgb-rank3',
    'objective': 'lambdarank',
    'features': FEATS,
    'train_pages': len(split['train']),
    'val_pages': len(split['val']),
    'test_pages': len(split['test']),
    'train_manifest_pages': manifest.get('usablePages'),
    'train_manifest_rows': manifest.get('rows'),
    'manifest_hash': hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(),
}
json.dump(artifact_meta, open('data/lgb-rank3-meta.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)


def version_tuple(version):
    values = []
    for part in str(version).lstrip('vV').split('-')[0].split('+')[0].split('.')[:4]:
        try:
            values.append(int(part))
        except ValueError:
            values.append(0)
    return tuple(values + [0] * (4 - len(values)))


def is_hit(best, query_rows):
    canonical = next(row for row in query_rows if row['label'] == 2)['version']
    return str(best['version']).lstrip('vV') == str(canonical).lstrip('vV')


def evaluate(group_urls, score_fn):
    hits = 0
    total = 0
    reciprocal = 0.0
    ndcg1 = 0.0
    for url in group_urls:
        query_rows = pages[url]
        scores = np.asarray(score_fn(query_rows), dtype=float)
        order = np.argsort(-scores, kind='stable')
        ranked = [query_rows[i] for i in order]
        total += 1
        if is_hit(ranked[0], query_rows):
            hits += 1
            ndcg1 += 1.0
        for index, row in enumerate(ranked, 1):
            if row['label'] == 2:
                reciprocal += 1.0 / index
                break
    return hits, total, reciprocal / max(total, 1), ndcg1 / max(total, 1)


def rank_scores(query_rows):
    return model.predict(np.asarray([[float(row[f]) for f in FEATS] for row in query_rows], dtype=float))


def prob_scores(query_rows):
    return np.asarray([row['prob'] for row in query_rows])


def numeric_scores(query_rows):
    return np.asarray([version_tuple(row['version']) for row in query_rows], dtype=float).dot(np.asarray([10**9, 10**6, 10**3, 1]))

for name, group_urls in split.items():
    learned = evaluate(group_urls, rank_scores)
    prob = evaluate(group_urls, prob_scores)
    numeric = evaluate(group_urls, numeric_scores)
    print(f"\n=== {name} ===")
    print(f"rank seed: {learned[0]}/{learned[1]} = {learned[0] / max(learned[1], 1) * 100:.1f}%  MRR={learned[2]:.3f}")
    print(f"prob max:  {prob[0]}/{prob[1]} = {prob[0] / max(prob[1], 1) * 100:.1f}%  MRR={prob[2]:.3f}")
    print(f"numeric max: {numeric[0]}/{numeric[1]} = {numeric[0] / max(numeric[1], 1) * 100:.1f}%  MRR={numeric[2]:.3f}")

importance = sorted(zip(FEATS, model.feature_importances_), key=lambda item: -item[1])
print('\n特征重要性 top20:', ', '.join(f'{name}={value}' for name, value in importance[:20]))

with open('data/train3-test.jsonl', 'w', encoding='utf-8') as output:
    for url in split['test']:
        query_rows = pages[url]
        scores = rank_scores(query_rows)
        best = query_rows[int(np.argmax(scores))]
        canonical = next(row for row in query_rows if row['label'] == 2)
        output.write(json.dumps({
            'url': url,
            'expected': canonical['version'],
            'learned': best['version'],
            'seedScore': float(np.max(scores)),
        }, ensure_ascii=False) + '\n')
print(f'\n→ data/train3-test.jsonl（{len(split["test"])}页）')
