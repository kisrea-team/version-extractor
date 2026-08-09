#!/usr/bin/env python3
"""
对比评估：纯启发式 vs 新 BERT 分类器（在未参与训练的 74 个新页面上）

1. 读 data/compare-candidates.jsonl（BERT 候选池，含 MAJOR 主版本）
2. 冻结 BERT encode → 每个候选的 P(产品版本)
3. 每页取 argmax 概率 → BERT 胜者版本；与纯启发式胜者、expectedVersion 真值对比
4. 报告：命中率、两者一致/分歧、分歧样例
"""
import json
import os
from collections import defaultdict
from sentence_transformers import SentenceTransformer
import joblib

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')


def matches(actual, label):
    a = str(actual).lstrip('vV')
    l = str(label).lstrip('vV')
    return a == l or a.startswith(l + '.') or l.startswith(a + '.')


def clean_text(text):
    # The installed tokenizers build rejects page glyphs outside its UTF-16-safe range.
    return ''.join(ch for ch in str(text) if ord(ch) <= 0xFFFF and not 0xD800 <= ord(ch) <= 0xDFFF)


def main():
    candidates = [json.loads(l) for l in open('data/compare-candidates.jsonl', encoding='utf-8') if l.strip()]
    pages = [json.loads(l) for l in open('data/compare-pages.jsonl', encoding='utf-8') if l.strip()]
    print(f"候选: {len(candidates)} 条 / 页面: {len(pages)} 条")

    print("BERT 提取向量 + 分类...")
    embedder = SentenceTransformer(joblib.load('data/embedder-clean.joblib'))
    clf = joblib.load('data/classifier-clean.joblib')
    texts = [clean_text(c['text']) for c in candidates]
    vectors = []
    for start in range(0, len(texts), 8192):
        end = min(start + 8192, len(texts))
        print(f"  编码 {start + 1}-{end}/{len(texts)}", flush=True)
        vectors.append(embedder.encode(
            texts[start:end],
            batch_size=512,
            show_progress_bar=False,
            normalize_embeddings=True,
        ))
    import numpy as np
    X = np.concatenate(vectors, axis=0)
    probs = clf.predict_proba(X)[:, 1]
    for c, p in zip(candidates, probs):
        c['prob'] = round(float(p), 5)

    by_url = defaultdict(list)
    for c in candidates:
        by_url[c['url']].append(c)

    rows = []
    for p in pages:
        cands = by_url.get(p['url'], [])
        bert_winner = max(cands, key=lambda c: c['prob'], default=None)
        exp_cands = [c for c in cands if matches(c['version'], p['expectedVersion'])]
        exp_best_prob = max((c['prob'] for c in exp_cands), default=None)
        rows.append({
            'url': p['url'],
            'name': p['name'],
            'expectedVersion': p['expectedVersion'],
            'heurVersion': p['heurVersion'],
            'heurConfidence': p['heurConfidence'],
            'heurMatches': p['heurMatches'],
            'bertVersion': bert_winner['version'] if bert_winner else None,
            'bertProb': bert_winner['prob'] if bert_winner else None,
            'bertMatches': bool(bert_winner and matches(bert_winner['version'], p['expectedVersion'])),
            'expectedInPool': bool(exp_cands),
            'expectedBestProb': exp_best_prob,
            'bertWinnerScopes': bert_winner.get('scopes', []) if bert_winner else [],
            'bertWinnerIsSemver': bert_winner.get('isSemver') if bert_winner else None,
        })

    heur_ok = sum(1 for r in rows if r['heurMatches'])
    bert_ok = sum(1 for r in rows if r['bertMatches'])
    both = sum(1 for r in rows if r['heurMatches'] and r['bertMatches'])
    heur_only = sum(1 for r in rows if r['heurMatches'] and not r['bertMatches'])
    bert_only = sum(1 for r in rows if not r['heurMatches'] and r['bertMatches'])
    neither = sum(1 for r in rows if not r['heurMatches'] and not r['bertMatches'])
    # 真值进入候选池的页面子集（排除"期望版本根本没被提取出来"的情况）
    pool_rows = [r for r in rows if r['expectedInPool']]
    pool_heur = sum(1 for r in pool_rows if r['heurMatches'])
    pool_bert = sum(1 for r in pool_rows if r['bertMatches'])

    n = len(rows)
    print("\n" + "=" * 60)
    print(f"新页面对比（未参与训练，n={n}）")
    print(f"  纯启发式命中 expectedVersion : {heur_ok}/{n} ({heur_ok / n:.1%})")
    print(f"  BERT 胜者命中 expectedVersion : {bert_ok}/{n} ({bert_ok / n:.1%})")
    print(f"  两者都中 / 仅启发式 / 仅 BERT / 都错: {both} / {heur_only} / {bert_only} / {neither}")
    if pool_rows:
        print(f"\n  仅看 expectedVersion 在候选池的页面 (n={len(pool_rows)}):")
        print(f"    启发式 {pool_heur} ({pool_heur / len(pool_rows):.1%}) | BERT {pool_bert} ({pool_bert / len(pool_rows):.1%})")

    with open('data/compare-report.jsonl', 'w', encoding='utf-8') as out:
        for r in rows:
            out.write(json.dumps(r, ensure_ascii=False) + '\n')

    print("\n--- 分歧样例（启发式 与 BERT 结论不一致）---")
    for r in rows:
        if r['heurMatches'] == r['bertMatches']:
            continue
        tag = '启发式对/BERT错' if r['heurMatches'] else 'BERT对/启发式错'
        print(f"  [{tag}] {r['name']:20s} 期望={r['expectedVersion']:8s} "
              f"启发式={str(r['heurVersion']):10s}({r['heurConfidence']}) "
              f"BERT={str(r['bertVersion']):10s}(p={r['bertProb']})")
    print("\n→ data/compare-report.jsonl")


if __name__ == '__main__':
    main()
