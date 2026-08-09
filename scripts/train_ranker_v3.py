#!/usr/bin/env python3
"""
重训排序模型：合并人工标注排序对 + 爬取的 current>historical 对。
验证在 65 页对比集上融合后的退化改善。

排序模型：学习 (current_vec - historical_vec) 的方向，
用 LogisticRegression 对差分向量二分类训练。
"""
import json
import joblib
import numpy as np
from collections import defaultdict
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score
from sentence_transformers import SentenceTransformer


def clean_text(t):
    return ''.join(ch for ch in str(t) if ord(ch) <= 0xFFFF and not 0xD800 <= ord(ch) <= 0xDFFF)


def matches(a, l):
    a = str(a).lstrip('vV'); l = str(l).lstrip('vV')
    return a == l or a.startswith(l + '.') or l.startswith(a + '.')


def load(path):
    return [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]


def encode(embedder, texts):
    vecs = []
    for s in range(0, len(texts), 4096):
        e = min(s + 4096, len(texts))
        vecs.append(embedder.encode(texts[s:e], batch_size=256, show_progress_bar=False,
                                    normalize_embeddings=True, device='cuda'))
    return np.concatenate(vecs, axis=0)


def main():
    # 排序对：现有 pairs2 + 爬取对
    pairs2 = load('data/ds700-ctx/pairs2.jsonl')
    crawl = load('data/sort-crawl/raw.jsonl')
    pairs = pairs2 + crawl
    print(f"排序对: pairs2 {len(pairs2)} + crawl {len(crawl)} = {len(pairs)}")

    embedder = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')

    # 编码正/负
    pos_texts = [clean_text(p['pos_text']) for p in pairs]
    neg_texts = [clean_text(p['neg_text']) for p in pairs]
    P = encode(embedder, pos_texts)
    N = encode(embedder, neg_texts)

    # 排序模型：学习 P-N 方向（正=current 应排在历史前）
    X_pair = np.vstack([P - N, N - P])
    y_pair = np.concatenate([np.ones(len(P)), np.zeros(len(P))])
    ranker = LogisticRegression(max_iter=3000, C=1.0)
    ranker.fit(X_pair, y_pair)
    # 内部准确率
    pred = ranker.predict(X_pair)
    print(f"排序模型内部 acc: {accuracy_score(y_pair, pred):.3f}")
    joblib.dump(ranker, 'data/ranker-700v3.joblib')
    print("→ data/ranker-700v3.joblib")

    # 65 页对比集融合评估
    cands = load('data/compare-candidates-v2.jsonl')
    pages = load('data/compare-pages.jsonl')
    print(f"\n对比集: 候选 {len(cands)} / 页面 {len(pages)}")
    texts = [clean_text(c['text']) for c in cands]
    X = encode(embedder, texts)
    by_url = defaultdict(list)
    for c, p in zip(cands, X): c['vec'] = p; by_url[c['url']].append(c)

    clf = joblib.load('data/classifier-700.joblib')
    w = ranker.coef_[0]
    print("\n=== 融合评估（分类器 + 排序）===")
    for alpha in (0.0, 0.5, 0.7, 1.0, 1.5):
        hits = 0
        for pg in pages:
            cs = by_url.get(pg['url'], [])
            if not cs: continue
            vecs = np.array([c['vec'] for c in cs])
            p_clf = clf.predict_proba(vecs)[:, 1]
            if alpha > 0:
                pr = (vecs - vecs.mean(axis=0)) @ w
                pr = (pr - pr.min()) / (pr.max() - pr.min() + 1e-9)
                score = p_clf + alpha * pr
            else:
                score = p_clf
            best = cs[int(np.argmax(score))]
            if matches(best['version'], pg['expectedVersion']): hits += 1
        print(f"  alpha={alpha}: {hits}/{len(pages)}")


if __name__ == '__main__':
    main()
