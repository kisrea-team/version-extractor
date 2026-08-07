#!/usr/bin/env python3
"""
BERT 向量 + 分类器：候选版本是否为产品版本

流程：
1. 读 data/candidates.jsonl（候选 + 上下文 + 0/1 + url）
2. 类别平衡：下采样负样本（保留全部正样本）
3. 冻结 BERT(sentence-transformers) encode → 向量
4. 【关键】按【项目 url】切分训练/测试（非按候选）—— 防止数据泄漏
5. 逻辑回归分类器（class_weight=balanced）
6. 报告：准确率/F1/PR，与"全负"基线对比（测对新项目的泛化）
7. 保存模型

用法：python scripts/train_classifier.py
"""
import argparse
import json
import random
from collections import defaultdict
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, classification_report, confusion_matrix
import joblib

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def load_balanced(candidates_path, max_neg_per_pos=3, seed=42):
    samples = [json.loads(l) for l in open(candidates_path, encoding='utf-8') if l.strip()]
    unknown = sum(1 for s in samples if s.get('label') not in (0, 1))
    labeled = [s for s in samples if s.get('label') in (0, 1)]
    positives = [s for s in labeled if s['label'] == 1]
    negatives_by_url = defaultdict(list)
    positives_by_url = defaultdict(int)
    for sample in positives:
        positives_by_url[sample['url']] += 1
    for sample in labeled:
        if sample['label'] == 0:
            negatives_by_url[sample['url']].append(sample)

    rng = random.Random(seed)
    negatives = []
    for url in sorted(negatives_by_url):
        candidates = negatives_by_url[url]
        rng.shuffle(candidates)
        cap = max(1, positives_by_url[url] * max_neg_per_pos)
        negatives.extend(candidates[:cap])

    balanced = positives + negatives
    rng.shuffle(balanced)
    return balanced, len(positives), len(negatives), unknown


def split_by_url(samples, seed=42):
    urls = sorted({s['url'] for s in samples})
    rng = random.Random(seed)
    rng.shuffle(urls)
    n_train_urls = max(1, int(len(urls) * 0.8))
    train_urls = set(urls[:n_train_urls])
    test_urls = set(urls[n_train_urls:])
    tr = [i for i, s in enumerate(samples) if s['url'] in train_urls]
    te = [i for i, s in enumerate(samples) if s['url'] in test_urls]
    return tr, te, train_urls, test_urls


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', default='data/candidates-clean.jsonl')
    parser.add_argument('--classifier-output', default='data/classifier-clean.joblib')
    parser.add_argument('--embedder-output', default='data/embedder-clean.joblib')
    parser.add_argument('--error-output', default='data/classifier-clean-errors.jsonl')
    args = parser.parse_args()

    print("加载候选样本...")
    samples, n_pos, n_neg, n_unknown = load_balanced(args.input)
    print(f"按项目平衡后: 正 {n_pos} / 负 {n_neg}（共 {len(samples)}，过滤 unknown {n_unknown}）")

    texts = [s['text'] for s in samples]
    y = [s['label'] for s in samples]

    print(f"BERT 提取向量 ({MODEL_NAME}) ...")
    model = SentenceTransformer(MODEL_NAME)
    X = model.encode(texts, batch_size=32, show_progress_bar=True, normalize_embeddings=True)

    tr, te, train_urls, test_urls = split_by_url(samples)
    print(f"按项目切分: 训练 {len(train_urls)} 项目 / 测试 {len(test_urls)} 项目（候选 {len(tr)} / {len(te)}）")
    print(f"训练分布: 正 {sum(y[i] == 1 for i in tr)} / 负 {sum(y[i] == 0 for i in tr)}")
    print(f"测试分布: 正 {sum(y[i] == 1 for i in te)} / 负 {sum(y[i] == 0 for i in te)}")

    Xtr, Xte = X[tr], X[te]
    ytr, yte = [y[i] for i in tr], [y[i] for i in te]
    base_acc = max(yte.count(0), yte.count(1)) / len(yte) if yte else 0

    print("训练逻辑回归分类器...")
    clf = LogisticRegression(max_iter=1000, class_weight='balanced', C=1.0)
    clf.fit(Xtr, ytr)
    pred = clf.predict(Xte)
    probabilities = clf.predict_proba(Xte)[:, 1]

    print("\n" + "=" * 50)
    print(f"全负基线准确率: {base_acc:.3f}")
    print(f"分类器准确率(对新项目泛化): {accuracy_score(yte, pred):.3f}")
    print(f"F1:             {f1_score(yte, pred):.3f}")
    print(f"精确率/召回率:  {precision_score(yte, pred):.3f} / {recall_score(yte, pred):.3f}")
    print("混淆矩阵 [真实0/1 × 预测0/1]:")
    print(confusion_matrix(yte, pred, labels=[0, 1]))
    print("\n" + classification_report(yte, pred, target_names=['负(非产品版本)', '正(产品版本)'], zero_division=0))

    with open(args.error_output, 'w', encoding='utf-8') as out:
        for index, actual, predicted, probability in zip(te, yte, pred, probabilities):
            if actual == predicted:
                continue
            sample = samples[index]
            out.write(json.dumps({
                'url': sample['url'],
                'version': sample.get('version'),
                'text': sample['text'],
                'scopes': sample.get('scopes', []),
                'labelReason': sample.get('labelReason'),
                'actual': int(actual),
                'predicted': int(predicted),
                'probability': round(float(probability), 6),
            }, ensure_ascii=False) + '\n')

    joblib.dump(clf, args.classifier_output)
    joblib.dump(MODEL_NAME, args.embedder_output)
    print(f"\n已保存 {args.classifier_output}")
    print(f"误判样本已保存 {args.error_output}")


if __name__ == "__main__":
    main()
