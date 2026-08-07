#!/usr/bin/env python3
"""
对比评估：旧 clean 分类器 vs 新 700 分类器，在 700 标注数据的 test 集上。
"""
import json
import joblib
import numpy as np
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, confusion_matrix
from sentence_transformers import SentenceTransformer


def load_split(path):
    return [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]


def main():
    test = load_split('data/ds700-clean/test.jsonl')
    yte = [s['label'] for s in test]
    texts = [str(s['text']) for s in test]

    embedder = SentenceTransformer(joblib.load('data/embedder-clean.joblib'))
    X = []
    for start in range(0, len(texts), 4096):
        end = min(start + 4096, len(texts))
        X.append(embedder.encode(texts[start:end], batch_size=256, show_progress_bar=False,
                                 normalize_embeddings=True, device='cuda'))
    X = np.concatenate(X, axis=0)

    models = [
        ('旧 clean', joblib.load('data/classifier-clean.joblib')),
        ('新 700', joblib.load('data/classifier-700.joblib')),
    ]
    print(f"test 样本 {len(test)}（正 {sum(1 for y in yte if y==1)} / 负 {sum(1 for y in yte if y==0)}）\n")
    for name, clf in models:
        pred = clf.predict(X)
        prob = clf.predict_proba(X)[:, 1]
        print(f"=== {name} ===")
        print(f"  acc {accuracy_score(yte,pred):.3f} / F1 {f1_score(yte,pred):.3f} / "
              f"prec {precision_score(yte,pred,zero_division=0):.3f} / rec {recall_score(yte,pred,zero_division=0):.3f}")
        print(f"  混淆矩阵\n{confusion_matrix(yte,pred,labels=[0,1])}")
        # 负样本误判详情
        print("  负样本判错的:")
        for s, y, p in zip(test, yte, prob):
            if y == 0 and p >= 0.5:
                print(f"    p={p:.3f} {s['version']} | {s['text'][:100]}")
        print()


if __name__ == '__main__':
    main()
