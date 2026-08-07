#!/usr/bin/env python3
"""
基于 700 条新标注数据训练 BERT 候选分类器（GPU）。

流程：
1. 读 data/ds700-clean/train.jsonl / val.jsonl / test.jsonl
2. 冻结 SentenceTransformer encode → 向量（GPU）
3. LogisticRegression（class_weight=balanced）在 train 上训练，val 选参
4. 在 test 上报告，并与旧 clean 分类器在同一 test 上对比
"""
import json
import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, classification_report, confusion_matrix
from sentence_transformers import SentenceTransformer

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def load_split(path):
    return [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]


def encode(embedder, samples):
    texts = [str(s['text']) for s in samples]
    vecs = []
    for start in range(0, len(texts), 4096):
        end = min(start + 4096, len(texts))
        vecs.append(embedder.encode(texts[start:end], batch_size=256,
                                    show_progress_bar=False, normalize_embeddings=True,
                                    device='cuda'))
    return np.concatenate(vecs, axis=0)


def main():
    train = load_split('data/ds700-clean/train.jsonl')
    val = load_split('data/ds700-clean/val.jsonl')
    test = load_split('data/ds700-clean/test.jsonl')
    print(f"train {len(train)} / val {len(val)} / test {len(test)}")

    embedder = SentenceTransformer(MODEL_NAME)
    Xtr = encode(embedder, train)
    Xva = encode(embedder, val)
    Xte = encode(embedder, test)
    ytr = [s['label'] for s in train]
    yva = [s['label'] for s in val]
    yte = [s['label'] for s in test]

    # 简单 val 选择 C
    best_c, best_f1 = 1.0, -1
    for C in (0.1, 0.3, 1.0, 3.0, 10.0):
        clf = LogisticRegression(max_iter=2000, class_weight='balanced', C=C)
        clf.fit(Xtr, ytr)
        p = clf.predict(Xva)
        f = f1_score(yva, p)
        if f > best_f1:
            best_f1, best_c = f, C
    print(f"val 选择 C={best_c} (val F1 {best_f1:.3f})")

    clf = LogisticRegression(max_iter=2000, class_weight='balanced', C=best_c)
    clf.fit(Xtr, ytr)
    pred = clf.predict(Xte)
    prob = clf.predict_proba(Xte)[:, 1]

    print("\n" + "=" * 55)
    print("新模型 test 指标:")
    print(f"  准确率 {accuracy_score(yte, pred):.3f} / F1 {f1_score(yte, pred):.3f} / "
          f"精确率 {precision_score(yte, pred, zero_division=0):.3f} / 召回率 {recall_score(yte, pred, zero_division=0):.3f}")
    print("  混淆矩阵:")
    print(confusion_matrix(yte, pred, labels=[0, 1]))
    print(classification_report(yte, pred, target_names=['负', '正'], zero_division=0))

    # 保存
    joblib.dump(clf, 'data/classifier-700.joblib')
    joblib.dump(MODEL_NAME, 'data/embedder-700.joblib')
    print("→ data/classifier-700.joblib")

    # 误判样例
    print("\n误判样例:")
    for s, y, p in zip(test, yte, prob):
        if (y == 1) != (p >= 0.5):
            print(f"  y={y} p={p:.3f} {s['version']} | {s['text'][:110]}")


if __name__ == '__main__':
    main()
