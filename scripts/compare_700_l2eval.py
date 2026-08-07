#!/usr/bin/env python3
"""
用增强候选池（L2 渲染 + 宽松正则）评估纯启发式 / 旧 clean / 新700 / 融合。

输入：data/compare-candidates-v2.jsonl、data/compare-pages.jsonl
"""
import json
import joblib
import numpy as np
from collections import defaultdict
from sentence_transformers import SentenceTransformer


def clean_text(t):
    return ''.join(ch for ch in str(t) if ord(ch) <= 0xFFFF and not 0xD800 <= ord(ch) <= 0xDFFF)


def matches(a, l):
    a = str(a).lstrip('vV'); l = str(l).lstrip('vV')
    return a == l or a.startswith(l + '.') or l.startswith(a + '.')


def main():
    cands = [json.loads(l) for l in open('data/compare-candidates-v2.jsonl', encoding='utf-8') if l.strip()]
    pages = [json.loads(l) for l in open('data/compare-pages.jsonl', encoding='utf-8') if l.strip()]
    print(f"候选 {len(cands)} / 页面 {len(pages)}")

    embedder = SentenceTransformer(joblib.load('data/embedder-clean.joblib'))
    texts = [clean_text(c['text']) for c in cands]
    X = []
    for s in range(0, len(texts), 8192):
        e = min(s + 8192, len(texts))
        X.append(embedder.encode(texts[s:e], batch_size=512, show_progress_bar=False,
                                 normalize_embeddings=True, device='cuda'))
    X = np.concatenate(X, axis=0)

    by_url = defaultdict(list)
    for c, p in zip(cands, X):
        c['vec'] = p
        by_url[c['url']].append(c)

    models = {
        '旧 clean': joblib.load('data/classifier-clean.joblib'),
        '新 700': joblib.load('data/classifier-700.joblib'),
    }
    rank = joblib.load('data/ranker-700v2.joblib')
    w = rank.coef_[0]
    clf700 = models['新 700']

    # 先算启发式
    hits_h = sum(1 for pg in pages if pg['heurMatches'])
    pool_in = sum(1 for pg in pages if (by_url.get(pg['url'], []) or []) and
                  any(matches(c['version'], pg['expectedVersion']) for c in by_url[pg['url']]))
    print(f"\n启发式: {hits_h}/{len(pages)} | 候选池覆盖 {pool_in}/{len(pages)}")

    for name, clf in models.items():
        h = 0
        for pg in pages:
            cs = by_url.get(pg['url'], [])
            if not cs: continue
            vecs = np.array([c['vec'] for c in cs])
            best = cs[int(np.argmax(clf.predict_proba(vecs)[:, 1]))]
            if matches(best['version'], pg['expectedVersion']): h += 1
        print(f"{name}: {h}/{len(pages)}")

    # 融合（明确用新700分类器）
    for alpha in (0.5, 0.7, 1.0):
        hh = 0
        for pg in pages:
            cs = by_url.get(pg['url'], [])
            if not cs: continue
            vecs = np.array([c['vec'] for c in cs])
            p_clf = clf700.predict_proba(vecs)[:, 1]
            pr = (vecs - vecs.mean(axis=0)) @ w
            pr = (pr - pr.min()) / (pr.max() - pr.min() + 1e-9)
            best = cs[int(np.argmax(p_clf + alpha * pr))]
            if matches(best['version'], pg['expectedVersion']): hh += 1
        print(f"融合(新700+排序) alpha={alpha}: {hh}/{len(pages)}")


if __name__ == '__main__':
    main()
