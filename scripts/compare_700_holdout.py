#!/usr/bin/env python3
"""
跨页泛化对比（74 个未参与训练页面）：
纯启发式 vs 旧 clean 分类器 vs 新 700 分类器。

评估方式与 compare_classifier.py 一致：每个页面取 argmax 概率作为 BERT 胜者，
与 expectedVersion 比较（matches 前缀匹配）。
"""
import json
import joblib
from collections import defaultdict
from sentence_transformers import SentenceTransformer
import numpy as np


def matches(actual, label):
    a = str(actual).lstrip('vV')
    l = str(label).lstrip('vV')
    return a == l or a.startswith(l + '.') or l.startswith(a + '.')


def clean_text(text):
    return ''.join(ch for ch in str(text) if ord(ch) <= 0xFFFF and not 0xD800 <= ord(ch) <= 0xDFFF)


def main():
    candidates = [json.loads(l) for l in open('data/compare-candidates.jsonl', encoding='utf-8') if l.strip()]
    pages = [json.loads(l) for l in open('data/compare-pages.jsonl', encoding='utf-8') if l.strip()]
    print(f"候选 {len(candidates)} / 页面 {len(pages)}")

    embedder = SentenceTransformer(joblib.load('data/embedder-clean.joblib'))
    texts = [clean_text(c['text']) for c in candidates]
    X = []
    for start in range(0, len(texts), 8192):
        end = min(start + 8192, len(texts))
        X.append(embedder.encode(texts[start:end], batch_size=512, show_progress_bar=False,
                                 normalize_embeddings=True, device='cuda'))
    X = np.concatenate(X, axis=0)

    by_url = defaultdict(list)
    for c, p in zip(candidates, X):
        c['vec'] = p
        by_url[c['url']].append(c)

    models = [
        ('纯启发式', None),
        ('旧 clean', joblib.load('data/classifier-clean.joblib')),
        ('新 700', joblib.load('data/classifier-700.joblib')),
    ]

    for name, clf in models:
        rows = []
        for pg in pages:
            cands = by_url.get(pg['url'], [])
            if clf is not None:
                vecs = np.array([c['vec'] for c in cands]) if cands else np.empty((0, 384))
                if vecs.size:
                    probs = clf.predict_proba(vecs)[:, 1]
                    best = cands[int(np.argmax(probs))]
                    bert_m = matches(best['version'], pg['expectedVersion'])
                    bert_ver = best['version']
                    expected_in = any(matches(c['version'], pg['expectedVersion']) for c in cands)
                else:
                    bert_m, bert_ver, expected_in = False, None, False
                rows.append(('bert', bert_m, bert_ver, expected_in))
            else:
                rows.append(('heur', pg['heurMatches'], pg['heurVersion'],
                             pg['heurExpectedInTop5']))

        hits = sum(1 for r in rows if r[1])
        pool = [r for r in rows if r[3]]
        pool_hits = sum(1 for r in pool if r[1])
        print(f"=== {name} ===")
        print(f"  命中 expectedVersion: {hits}/{len(rows)} ({hits/len(rows):.1%})")
        if pool:
            print(f"  (仅真值在候选池) {pool_hits}/{len(pool)} ({pool_hits/len(pool):.1%})")
        print()


if __name__ == '__main__':
    main()
