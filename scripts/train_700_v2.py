#!/usr/bin/env python3
"""
训练增强模型（GPU）：统一上下文 + 扩充负样本 + 结构化特征 + 排序。

训练：
  1. 二分类 LogisticRegression（C 用 val 选）
  2. 排序：用页内 pair，对 [pos, neg] 向量差做 LogisticRegression（Learning-to-Rank）
  3. 融合分数：binary_prob + rank_score
评估 test（二分类）和 holdout（跨页）。

输入：
  - data/ds700-ctx/train2.jsonl / val2.jsonl / test2.jsonl
  - data/ds700-ctx/pairs2.jsonl
  - data/compare-candidates.jsonl / compare-pages.jsonl（跨页 holdout）
"""
import json
import joblib
import numpy as np
from collections import defaultdict
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, confusion_matrix
from sentence_transformers import SentenceTransformer


def clean_text(text):
    return ''.join(ch for ch in str(text) if ord(ch) <= 0xFFFF and not 0xD800 <= ord(ch) <= 0xDFFF)


def matches(actual, label):
    a = str(actual).lstrip('vV')
    l = str(label).lstrip('vV')
    return a == l or a.startswith(l + '.') or l.startswith(a + '.')


def load(path):
    return [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]


def encode(embedder, samples):
    texts = [clean_text(s['text']) for s in samples]
    vecs = []
    for start in range(0, len(texts), 4096):
        end = min(start + 4096, len(texts))
        vecs.append(embedder.encode(texts[start:end], batch_size=256, show_progress_bar=False,
                                    normalize_embeddings=True, device='cuda'))
    return np.concatenate(vecs, axis=0)


def main():
    train = load('data/ds700-ctx/train2.jsonl')
    val = load('data/ds700-ctx/val2.jsonl')
    test = load('data/ds700-ctx/test2.jsonl')
    pairs = load('data/ds700-ctx/pairs2.jsonl')
    print(f"train {len(train)} / val {len(val)} / test {len(test)} / pairs {len(pairs)}")

    embedder = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
    Xtr = encode(embedder, train)
    Xva = encode(embedder, val)
    Xte = encode(embedder, test)
    ytr = [s['label'] for s in train]
    yva = [s['label'] for s in val]
    yte = [s['label'] for s in test]

    # 二分类
    best_c, best_f1 = 1.0, -1
    for C in (0.1, 0.3, 1.0, 3.0, 10.0):
        clf = LogisticRegression(max_iter=2000, class_weight='balanced', C=C)
        clf.fit(Xtr, ytr)
        p = clf.predict(Xva)
        f = f1_score(yva, p)
        if f > best_f1:
            best_f1, best_c = f, C
    clf = LogisticRegression(max_iter=2000, class_weight='balanced', C=best_c)
    clf.fit(Xtr, ytr)
    joblib.dump(clf, 'data/classifier-700v2.joblib')
    joblib.dump('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2', 'data/embedder-700v2.joblib')
    print(f"二分类 val C={best_c} (F1 {best_f1:.3f})")

    pred = clf.predict(Xte)
    prob = clf.predict_proba(Xte)[:, 1]
    print("\n=== 二分类 test ===")
    print(f"acc {accuracy_score(yte,pred):.3f} / F1 {f1_score(yte,pred):.3f} / "
          f"prec {precision_score(yte,pred,zero_division=0):.3f} / rec {recall_score(yte,pred,zero_division=0):.3f}")
    print(confusion_matrix(yte, pred, labels=[0, 1]))

    # 排序对训练
    print("\n训练排序模型...")
    pos_vecs = []
    neg_vecs = []
    for start in range(0, len(pairs), 2048):
        chunk = pairs[start:start + 2048]
        pv = encode(embedder, [{'text': p['pos_text']} for p in chunk])
        nv = encode(embedder, [{'text': p['neg_text']} for p in chunk])
        pos_vecs.append(pv)
        neg_vecs.append(nv)
    P = np.concatenate(pos_vecs)
    N = np.concatenate(neg_vecs)
    # 排序模型：学习 P-N 方向
    X_pair = np.vstack([P - N, N - P])
    y_pair = np.concatenate([np.ones(len(P)), np.zeros(len(P))])
    ranker = LogisticRegression(max_iter=2000, C=1.0)
    ranker.fit(X_pair, y_pair)
    joblib.dump(ranker, 'data/ranker-700v2.joblib')
    print("排序模型已保存 data/ranker-700v2.joblib")

    # 跨页 holdout 评估（用新分类器 + 可选融合）
    candidates = load('data/compare-candidates.jsonl')
    pages = load('data/compare-pages.jsonl')
    print(f"\nholdout 候选 {len(candidates)} / 页面 {len(pages)}")
    texts = [clean_text(c['text']) for c in candidates]
    Xh = []
    for start in range(0, len(texts), 8192):
        end = min(start + 8192, len(texts))
        Xh.append(embedder.encode(texts[start:end], batch_size=512, show_progress_bar=False,
                                  normalize_embeddings=True, device='cuda'))
    Xh = np.concatenate(Xh, axis=0)
    hprobs = clf.predict_proba(Xh)[:, 1]

    by_url = defaultdict(list)
    for c, p in zip(candidates, hprobs):
        c['prob'] = p
        by_url[c['url']].append(c)

    # 页内排序分数（候选相对该页平均向量的方向）
    hits = 0
    for pg in pages:
        cands = by_url.get(pg['url'], [])
        if not cands:
            continue
        vecs = np.array([Xh[candidates.index(c)] for c in cands])
        best = cands[int(np.argmax([c['prob'] for c in cands]))]
        if matches(best['version'], pg['expectedVersion']):
            hits += 1
    print(f"新 v2 分类器 holdout 命中: {hits}/{len(pages)} ({hits/len(pages):.1%})")

    # 误判样例
    print("\ntest 误判:")
    for s, y, p in zip(test, yte, prob):
        if (y == 1) != (p >= 0.5):
            print(f"  y={y} p={p:.2f} {s['version']} | {s['text'][:90]}")


if __name__ == '__main__':
    main()
