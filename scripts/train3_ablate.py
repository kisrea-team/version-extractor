#!/usr/bin/env python3
"""37/38/39 列三方对照（同 URL 分组、同种子、同超参）

用法: python3 scripts/train3_ablate.py            # 三方对照，不落盘模型
      python3 scripts/train3_ablate.py --save 39  # 对照后把指定变体存成 lgb-rank3.joblib

⚠️ 只改特征列，其他全部固定：分组切分 seed=42、LGBMRanker 超参与 train3_lgb.py 一致。
   避免 2026-08-13 的"静默回退假象"——那次实验脚本改了列数但生产代码没同步，
   lgb_worker 报 n_features_in_ 不匹配后调用方 catch 静默回退启发式，测出一堆假提升。
"""
import json
import sys
from collections import defaultdict

import joblib
import lightgbm as lgb
import numpy as np

BASE = [
    'prob', 'has_v', 'n_seg', 'n_digits_total', 'major', 'minor', 'patch',
    'is_clean', 'is_yearish', 'is_short_major',
    'scope_dl', 'scope_structured', 'scope_heading', 'scope_visible', 'scope_noise',
    'page_candidate_count', 'same_major_count', 'higher_count', 'rank_pct',
    'is_global_max', 'is_same_major_latest', 'occurrence_count', 'first_position_pct',
    'scope_count', 'independent_scope_count', 'product_anchor', 'title_product_anchor',
    'product_name_present', 'same_major_path_match', 'same_major_path_share',
    'latest_annotated',
    'same_major_minor_count', 'sequence_member', 'sequence_latest',
    'page_type_download', 'page_type_history', 'page_type_article', 'page_type_error',
]
# ⚠️ 2026-08-16 修正基线定义：BASE 抄自 train3_lgb.py 的 FEATS，含 latest_annotated
# 共 38 列，但推理侧 buildRankFeatureRows 只算 37 列（无 latest_annotated），
# 生产模型 n_features_in_=37 —— 训练脚本与推理代码本就错位一列。
# 因此真实生产基线是 PROD37，而非 BASE。四方对照同时回答：
#   (a) 把 latest_annotated 接上推理有无收益  (b) 两个新特征在扩充数据上是否有效
PROD37 = [f for f in BASE if f != 'latest_annotated']
VARIANTS = {
    'prod37': PROD37,
    'base38': BASE,
    'decl39': BASE + ['decl_word_distance'],
    'both40': BASE + ['decl_word_distance', 'nearby_date_recency'],
}

rows = [json.loads(l) for l in open('data/train3.jsonl', encoding='utf-8') if l.strip()]
pages = defaultdict(list)
for row in rows:
    pages[row['url']].append(row)
urls = sorted(pages)
rng = np.random.RandomState(42)
rng.shuffle(urls)
n = len(urls)
split = {
    'train': urls[:int(n * 0.70)],
    'val': urls[int(n * 0.70):int(n * 0.85)],
    'test': urls[int(n * 0.85):],
}
# ⚠️ 2026-08-17 配比消融：--brew-max 限制训练集里的 brew 页数（val/test 不动）。
#    背景：249页(brew~100) 62.1% > 726页(brew 577) 58.6%，怀疑 brew 占比过高的
#    分布偏移；但砍掉 homepage 噪声页也无效(406页=62.1%)。本消融在保留全部
#    噪声页的前提下，只调 brew 数量，找甜点。
if '--brew-max' in sys.argv:
    brew_max = int(sys.argv[sys.argv.index('--brew-max') + 1])
    train_brew = [u for u in split['train'] if pages[u][0].get('source') == 'brew']
    train_other = [u for u in split['train'] if pages[u][0].get('source') != 'brew']
    if len(train_brew) > brew_max:
        train_brew = sorted(train_brew)[:brew_max]  # 确定性截断
    split['train'] = train_other + train_brew
    print(f'  配比消融: brew {len(train_brew)} 页 (上限 {brew_max}), 非brew {len(train_other)} 页')
print(f'数据: {len(rows)} 行 / {n} 页  '
      f'(train {len(split["train"])} / val {len(split["val"])} / test {len(split["test"])})')


def version_tuple(version):
    values = []
    for part in str(version).lstrip('vV').split('-')[0].split('+')[0].split('.')[:4]:
        try:
            values.append(int(part))
        except ValueError:
            values.append(0)
    return tuple(values + [0] * (4 - len(values)))


def train_one(feats):
    def matrix(group_urls):
        return np.asarray([[float(r[f]) for f in feats] for u in group_urls for r in pages[u]], dtype=float)

    def labels(group_urls):
        return np.asarray([int(r['label']) if r['label'] in (1, 2) else 0
                           for u in group_urls for r in pages[u]], dtype=int)

    def groups(group_urls):
        return [len(pages[u]) for u in group_urls]

    model = lgb.LGBMRanker(
        objective='lambdarank', metric='ndcg', ndcg_at=[1, 3, 5], label_gain=[0, 1, 3],
        n_estimators=500, learning_rate=0.035, num_leaves=31, max_depth=7,
        min_child_samples=20, reg_lambda=1.0, random_state=42, verbosity=-1, n_jobs=8,
    )
    model.fit(matrix(split['train']), labels(split['train']), group=groups(split['train']),
              eval_set=[(matrix(split['val']), labels(split['val']))],
              eval_group=[groups(split['val'])],
              callbacks=[lgb.early_stopping(60, verbose=False)])
    return model


def evaluate(model, feats, group_urls, long_only=None):
    """long_only: None=全部, int=只评候选数>=N 的页（长列表子集，新特征的目标场景）"""
    hits = total = 0
    rr = 0.0
    for url in group_urls:
        qr = pages[url]
        if long_only is not None and len(qr) < long_only:
            continue
        scores = model.predict(np.asarray([[float(r[f]) for f in feats] for r in qr], dtype=float))
        ranked = [qr[i] for i in np.argsort(-np.asarray(scores), kind='stable')]
        canonical = next(r for r in qr if r['label'] == 2)['version']
        total += 1
        if str(ranked[0]['version']).lstrip('vV') == str(canonical).lstrip('vV'):
            hits += 1
        for i, r in enumerate(ranked, 1):
            if r['label'] == 2:
                rr += 1.0 / i
                break
    return hits, total, rr / max(total, 1)


results = {}
models = {}
for name, feats in VARIANTS.items():
    missing = sorted({f for r in rows for f in feats if f not in r})
    if missing:
        print(f'{name} 列缺失特征: {missing} → 跳过')
        continue
    m = train_one(feats)
    models[name] = (m, feats)
    line = [f'\n=== {name} 列 ===']
    for sname in ('val', 'test'):
        h, t, mrr = evaluate(m, feats, split[sname])
        line.append(f'  {sname}: {h}/{t} = {h / max(t, 1) * 100:.1f}%  MRR={mrr:.3f}')
        results[(name, sname)] = (h, t, mrr)
    # 长列表子集（>=30 候选）：新特征的目标场景，Fork(183)/1Password(92)/Rytr(48) 都在这
    for thr in (30,):
        h, t, mrr = evaluate(m, feats, split['test'], long_only=thr)
        line.append(f'  test(候选>={thr}): {h}/{t} = {h / max(t, 1) * 100:.1f}%  MRR={mrr:.3f}')
        results[(name, f'long{thr}')] = (h, t, mrr)
    imp = sorted(zip(feats, m.feature_importances_), key=lambda x: -x[1])
    new_imp = [f'{k}={v}' for k, v in imp if k in ('decl_word_distance', 'nearby_date_recency')]
    rank_of = {k: i + 1 for i, (k, _) in enumerate(imp)}
    if new_imp:
        line.append('  新特征重要性: ' + ', '.join(new_imp)
                    + '  (排名 ' + ', '.join(f'{k}#{rank_of[k]}/{len(feats)}'
                                            for k in ('decl_word_distance', 'nearby_date_recency')
                                            if k in rank_of) + ')')
    line.append('  top8: ' + ', '.join(f'{k}={v}' for k, v in imp[:8]))
    print('\n'.join(line))

print('\n' + '=' * 62)
print('对照汇总 (同分组 seed=42)')
for sname in ('val', 'test', 'long30'):
    parts = []
    for name in VARIANTS:
        if (name, sname) in results:
            h, t, mrr = results[(name, sname)]
            parts.append(f'{name}列 {h}/{t}={h / max(t, 1) * 100:.1f}%')
    print(f'  {sname:8s}: ' + ' | '.join(parts))

if '--save' in sys.argv:
    pick = sys.argv[sys.argv.index('--save') + 1]
    m, feats = models[pick]
    joblib.dump(m, 'data/lgb-rank3.joblib')
    joblib.dump(feats, 'data/lgb-rank3-cols.joblib')
    print(f'\n已保存 {pick} 列模型 → data/lgb-rank3.joblib '
          f'(n_features_in_={m.n_features_in_}, cols={len(feats)})')
