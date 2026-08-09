#!/usr/bin/env python3
"""输出新 700 模型 vs 旧 clean 模型在 74 页 holdout 上的逐页差异详情。"""
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

    old = joblib.load('data/classifier-clean.joblib')
    new = joblib.load('data/classifier-700.joblib')

    rows = []
    for pg in pages:
        cands = by_url.get(pg['url'], [])
        if not cands:
            continue
        vecs = np.array([c['vec'] for c in cands])
        po = old.predict_proba(vecs)[:, 1]
        pn = new.predict_proba(vecs)[:, 1]
        io = int(np.argmax(po)); inn = int(np.argmax(pn))
        rows.append({
            'name': pg['name'], 'expected': pg['expectedVersion'],
            'heur': pg['heurVersion'], 'heurConf': pg['heurConfidence'],
            'oldVer': cands[io]['version'], 'oldProb': round(float(po[io]), 3), 'oldMatch': matches(cands[io]['version'], pg['expectedVersion']),
            'newVer': cands[inn]['version'], 'newProb': round(float(pn[inn]), 3), 'newMatch': matches(cands[inn]['version'], pg['expectedVersion']),
        })

    print("=== 新 700 提升（旧错→新对）===")
    for r in rows:
        if r['oldMatch'] != r['newMatch'] and r['newMatch']:
            print(f"  {r['name']:18s} 期望={r['expected']:10s} 旧={r['oldVer']}({r['oldProb']}) → 新={r['newVer']}({r['newProb']})")
    print("\n=== 新 700 退化（旧对→新错）===")
    for r in rows:
        if r['oldMatch'] != r['newMatch'] and not r['newMatch']:
            print(f"  {r['name']:18s} 期望={r['expected']:10s} 旧={r['oldVer']}({r['oldProb']}) → 新={r['newVer']}({r['newProb']})")


if __name__ == '__main__':
    main()
