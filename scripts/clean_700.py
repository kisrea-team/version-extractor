#!/usr/bin/env python3
"""
清洗 700 条标注数据并生成训练集。

步骤：
1. 去重（同 pageId+version+label 只留一条，合并证据）
2. 从 ambiguous 中把证据明确支持 build/SDK/API/OS/dependency 的转负
3. current_product → 正；non_product → 负；historical 单独保留；ambiguous 排除
4. 可选合并旧 candidates-clean 的明确 noise 负样本补充
5. 输出 training/validation/holdout 三份（按 URL 分组切分）
"""
import json
import os
import random
import re
from collections import defaultdict

DATASET = 'ds700.tmp.json'
OLD_NEG = 'data/candidates-clean.jsonl'
OUT_DIR = 'data/ds700-clean'
os.makedirs(OUT_DIR, exist_ok=True)

# 明确可转负的噪声语义（出现在证据/note 中）
NEG_SEMANTICS = re.compile(
    r'build|sdk|api version|os version|minimum|dependency|jquery|bootstrap|'
    r'node\.?js v|npm|\.js|\.css|\.map|chunk|webpack|svg|viewBox|coordinates|'
    r'csp|beacon|cloudflare|sdk/|api/|protobuf|schema version', re.I)


def build_text(version, anns):
    """候选 + 证据上下文，与旧训练格式一致。"""
    contexts = []
    seen = set()
    for a in anns:
        q = (a.get('evidenceQuote') or '').strip()
        if not q:
            continue
        scopes = a.get('evidenceTypes') or ['visible']
        scope = scopes[0] if scopes else 'visible'
        if (scope, q) in seen:
            continue
        seen.add((scope, q))
        contexts.append(f"[{scope}] {q}")
    if not contexts:
        return None
    return f"候选: {version} [SEP] 上下文: " + " | ".join(contexts)[:480]


def main():
    d = json.load(open(DATASET, encoding='utf-8'))
    anns = d['annotations']
    pmap = {p['pageId']: p for p in d['pages']}
    print(f"原始标注: {len(anns)} 条")

    # ---------- 1. 去重 ----------
    groups = defaultdict(list)
    for a in anns:
        groups[(a['pageId'], a['version'], a['label'])].append(a)
    dedup = []
    for key, lst in groups.items():
        first = dict(lst[0])
        # 合并证据
        seen_ev = set()
        ev_types = []
        quotes = []
        for a in lst:
            for s in (a.get('evidenceTypes') or []):
                if s not in seen_ev:
                    seen_ev.add(s); ev_types.append(s)
            q = (a.get('evidenceQuote') or '').strip()
            if q and q not in quotes:
                quotes.append(q)
        first['evidenceTypes'] = ev_types
        first['evidenceQuote'] = ' | '.join(quotes)[:300]
        first['dupCount'] = len(lst)
        dedup.append(first)
    print(f"去重后: {len(dedup)} 条（移除 {len(anns) - len(dedup)} 重复）")

    # ---------- 2. ambiguous 可靠转负 ----------
    converted = 0
    for a in dedup:
        if a['label'] != 'ambiguous':
            continue
        v = str(a.get('version') or '')
        text = (a.get('evidenceQuote') or '') + ' ' + (a.get('note') or '')
        if not v:
            continue
        if NEG_SEMANTICS.search(text) and ('build' in text.lower() or 'sdk' in text.lower()
                                           or 'api' in text.lower() or 'minimum' in text.lower()
                                           or 'jquery' in text.lower() or 'bootstrap' in text.lower()
                                           or 'viewBox' in text or 'svg' in text.lower()):
            a['label'] = 'non_product'
            a['noiseType'] = a.get('noiseType') or 'build'
            a['convertedFrom'] = 'ambiguous'
            converted += 1
    print(f"ambiguous 转 non_product: {converted}")

    # ---------- 3. 分类 ----------
    pos, neg, hist, amb = [], [], [], []
    for a in dedup:
        if a['label'] == 'current_product':
            pos.append(a)
        elif a['label'] == 'non_product':
            neg.append(a)
        elif a['label'] == 'historical_product':
            hist.append(a)
        else:
            amb.append(a)
    print(f"正 {len(pos)} / 负 {len(neg)} / historical {len(hist)} / ambiguous {len(amb)}")

    # 负样本补充：ambiguous 中已转的已计入 neg

    # ---------- 4. 构建 text ----------
    def make_samples(lst, label):
        out = []
        for a in lst:
            v = a.get('version')
            if not v:
                continue
            text = build_text(v, [a])
            if not text:
                continue
            out.append({
                'text': text,
                'label': label,
                'version': v,
                'url': a.get('url') or pmap.get(a['pageId'], {}).get('url'),
                'scopes': a.get('evidenceTypes') or [],
                'labelSource': a.get('label') + ('/ambiguous' if a.get('convertedFrom') else ''),
                'pageId': a['pageId'],
                'confidence': a.get('confidence'),
            })
        return out

    pos_s = make_samples(pos, 1)
    neg_s = make_samples(neg, 0)
    hist_s = make_samples(hist, None)  # 保留，不进二分类
    amb_s = make_samples(amb, None)
    print(f"构建文本: 正 {len(pos_s)} / 负 {len(neg_s)} / historical {len(hist_s)} / ambiguous {len(amb_s)}")

    # ---------- 5. 合并旧明确噪声负样本（仅补充训练集，限量）----------
    merge_old = os.environ.get('MERGE_OLD_NEG', '0') == '1'
    extra_neg = 0
    if merge_old and os.path.exists(OLD_NEG):
        # 旧负样本只允许进入训练集；按 URL 限量，避免测试集被旧噪声淹没
        old_cap = int(os.environ.get('OLD_NEG_CAP', '6'))
        new_urls = {s['url'] for s in pos_s + neg_s}
        by_url = defaultdict(list)
        for line in open(OLD_NEG, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            s = json.loads(line)
            if s['label'] != 0 or s['url'] in new_urls:
                continue
            if not all('noise' in sc for sc in s.get('scopes', [])):
                continue
            by_url[s['url']].append(s)
        for url, lst in by_url.items():
            for s in lst[:old_cap]:
                neg_s.append({'text': s['text'], 'label': 0, 'version': s.get('version'),
                              'url': s['url'], 'scopes': s.get('scopes', []),
                              'labelSource': 'old-explicit-noise', 'pageId': None, 'confidence': None,
                              'oldNeg': True})
                extra_neg += 1
        print(f"合并旧明确噪声负样本(训练限定): {extra_neg}")

    # ---------- 6. 按 URL 分组切分 ----------
    def save(name, samples):
        with open(os.path.join(OUT_DIR, name), 'w', encoding='utf-8') as f:
            for s in samples:
                f.write(json.dumps(s, ensure_ascii=False) + '\n')
        print(f"  → {OUT_DIR}/{name}: {len(samples)}")

    all_samples = pos_s + neg_s
    urls = sorted({s['url'] for s in all_samples if s.get('url')})
    rng = random.Random(42)
    rng.shuffle(urls)
    n_test = max(1, int(len(urls) * 0.2))
    n_val = max(1, int(len(urls) * 0.15))
    test_urls = set(urls[:n_test])
    val_urls = set(urls[n_test:n_test + n_val])
    train_urls = set(urls[n_test + n_val:])

    train, val, test = [], [], []
    for s in all_samples:
        if s.get('oldNeg'):
            train.append(s)
            continue
        u = s.get('url')
        if u in test_urls:
            test.append(s)
        elif u in val_urls:
            val.append(s)
        else:
            train.append(s)

    print(f"\n按 URL 切分: 训练 {len(train_urls)} URL / 验证 {len(val_urls)} / 测试 {len(test_urls)}")
    for name, samples in [('train.jsonl', train), ('val.jsonl', val), ('test.jsonl', test),
                          ('historical.jsonl', hist_s), ('ambiguous.jsonl', amb_s)]:
        save(name, samples)
    for name, samples in [('train', train), ('val', val), ('test', test)]:
        p = sum(1 for s in samples if s['label'] == 1)
        print(f"  {name}: 正 {p} / 负 {len(samples) - p}")

    # 汇总
    with open(os.path.join(OUT_DIR, 'summary.json'), 'w', encoding='utf-8') as f:
        json.dump({
            'annotations_original': len(anns),
            'annotations_dedup': len(dedup),
            'pos': len(pos), 'neg': len(neg), 'hist': len(hist), 'amb': len(amb),
            'ambiguous_converted_to_neg': converted,
            'old_neg_merged': extra_neg,
            'train_urls': len(train_urls), 'val_urls': len(val_urls), 'test_urls': len(test_urls),
        }, f, ensure_ascii=False, indent=2)
    print("\n→ summary.json")


if __name__ == '__main__':
    main()
