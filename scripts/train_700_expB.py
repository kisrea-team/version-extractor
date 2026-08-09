#!/usr/bin/env python3
"""实验 B：统一上下文 + 纯标注样本（无 auto-noise），训练并测 holdout。"""
import json
import joblib
import random
from collections import defaultdict
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score
from sentence_transformers import SentenceTransformer


def clean_text(t):
    return ''.join(ch for ch in str(t) if ord(ch) <= 0xFFFF and not 0xD800 <= ord(ch) <= 0xDFFF)


def matches(a, l):
    a = str(a).lstrip('vV'); l = str(l).lstrip('vV')
    return a == l or a.startswith(l + '.') or l.startswith(a + '.')


def encode(embedder, samples):
    texts = [clean_text(s['text']) for s in samples]
    vecs = []
    for s in range(0, len(texts), 4096):
        e = min(s + 4096, len(texts))
        vecs.append(embedder.encode(texts[s:e], batch_size=256, show_progress_bar=False,
                                    normalize_embeddings=True, device='cuda'))
    return np.concatenate(vecs, axis=0)


def main():
    ann = [json.loads(l) for l in open('data/ds700-ctx/train-only-annotated.jsonl', encoding='utf-8') if l.strip()]
    # 按 URL 切分（80/20 简单二分，因样本少）
    urls = sorted({s['url'] for s in ann})
    rng = random.Random(42); rng.shuffle(urls)
    n_test = max(1, int(len(urls) * 0.2))
    test_urls = set(urls[:n_test])
    train = [s for s in ann if s['url'] not in test_urls]
    test = [s for s in ann if s['url'] in test_urls]
    print(f"B 方案: train {len(train)} / test {len(test)}")

    embedder = SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
    Xtr, Xte = encode(embedder, train), encode(embedder, test)
    ytr, yte = [s['label'] for s in train], [s['label'] for s in test]
    clf = LogisticRegression(max_iter=2000, class_weight='balanced', C=1.0)
    clf.fit(Xtr, ytr)
    joblib.dump(clf, 'data/classifier-700vB.joblib')
    pred = clf.predict(Xte)
    print(f"B test acc {np.mean([p == y for p, y in zip(pred, yte)]):.3f} / "
          f"F1 {f1_score(yte, pred, zero_division=0):.3f}")

    # holdout 74
    cands = [json.loads(l) for l in open('data/compare-candidates.jsonl', encoding='utf-8') if l.strip()]
    pages = [json.loads(l) for l in open('data/compare-pages.jsonl', encoding='utf-8') if l.strip()]
    Xh = []
    for s in range(0, len(cands), 8192):
        e = min(s + 8192, len(cands))
        Xh.append(embedder.encode([clean_text(c['text']) for c in cands[s:e]], batch_size=512,
                                  show_progress_bar=False, normalize_embeddings=True, device='cuda'))
    Xh = np.concatenate(Xh, axis=0)
    by = defaultdict(list)
    for c, p in zip(cands, Xh): c['vec'] = p; by[c['url']].append(c)
    h = 0
    for pg in pages:
        cs = by.get(pg['url'], [])
        if not cs: continue
        vecs = np.array([c['vec'] for c in cs])
        best = cs[int(np.argmax(clf.predict_proba(vecs)[:, 1]))]
        if matches(best['version'], pg['expectedVersion']): h += 1
    print(f"B holdout: {h}/{len(pages)}")


if __name__ == '__main__':
    main()
