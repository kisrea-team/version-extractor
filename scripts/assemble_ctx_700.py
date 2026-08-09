#!/usr/bin/env python3
"""
训练集装配：统一上下文 + 扩充负样本 + 结构化特征 + historical 排序。

输入：data/ds700-ctx/train-ready.jsonl（统一上下文，标签 current/historical/non_product/ambiguous）
输出：
  - data/ds700-ctx/train2.jsonl / val2.jsonl / test2.jsonl（二分类，按 URL 切分）
  - data/ds700-ctx/pairs2.jsonl（页内排序对：current > historical > non_product）
"""
import json
import os
import random
import re
from collections import defaultdict

SRC = 'data/ds700-ctx/train-ready.jsonl'
OUT = 'data/ds700-ctx'


def add_structured_features(sample):
    """在文本尾部拼入结构化特征，帮助区分依赖/build。"""
    scopes = sample.get('scopes', [])
    text = sample['text']
    feats = []
    if 'download-link' in scopes:
        feats.append('下载链接中')
    if 'structured' in scopes:
        feats.append('结构化字段')
    if 'noise' in scopes and len(scopes) == 1:
        feats.append('噪声上下文')
    v = str(sample.get('version', '')).lstrip('vV')
    if re.match(r'^\d{1,2}$', v):
        feats.append('主版本号')
    if re.search(r'rc|beta|alpha|pre', str(sample.get('version', ''))):
        feats.append('预发布')
    if re.search(r'^\d{4,}$', v):
        feats.append('大整数')
    if feats:
        text = text[:460] + ' [特征: ' + ', '.join(feats) + ']'
    return text


def main():
    rows = [json.loads(l) for l in open(SRC, encoding='utf-8') if l.strip()]
    # 过滤没有版本号的
    rows = [r for r in rows if r.get('version')]
    print(f"读入 {len(rows)} 条")

    # 二分类样本：current=1；historical + non_product=0（模型必须学会"历史版本≠当前版本"）
    binary = []
    for r in rows:
        if r['label'] == 'current_product':
            binary.append({**r, 'label': 1})
        elif r['label'] in ('historical_product', 'non_product'):
            binary.append({**r, 'label': 0})

    # 结构化特征 + 清洗
    for s in binary:
        s['text'] = add_structured_features(s)
    for s in binary:
        s['text'] = ''.join(ch for ch in s['text'] if ord(ch) <= 0xFFFF and not 0xD800 <= ord(ch) <= 0xDFFF)

    # 按 URL 分组切分
    urls = sorted({s['url'] for s in binary if s.get('url')})
    rng = random.Random(42)
    rng.shuffle(urls)
    n_test = max(1, int(len(urls) * 0.2))
    n_val = max(1, int(len(urls) * 0.15))
    test_urls = set(urls[:n_test])
    val_urls = set(urls[n_test:n_test + n_val])
    train_urls = set(urls[n_test + n_val:])

    train, val, test = [], [], []
    for s in binary:
        u = s.get('url')
        if u in test_urls:
            test.append(s)
        elif u in val_urls:
            val.append(s)
        else:
            train.append(s)
    print(f"二分类: train {len(train)} (正{sum(1 for s in train if s['label']==1)}) / "
          f"val {len(val)} / test {len(test)}")

    def save(name, samples):
        with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
            for s in samples:
                f.write(json.dumps(s, ensure_ascii=False) + '\n')

    save('train2.jsonl', train)
    save('val2.jsonl', val)
    save('test2.jsonl', test)

    # 页内排序对
    pairs = []
    by_page = defaultdict(list)
    for r in rows:
        if r['label'] in ('current_product', 'historical_product', 'non_product'):
            by_page[r['pageId']].append(r)
    for pid, lst in by_page.items():
        cur = [r for r in lst if r['label'] == 'current_product']
        hist = [r for r in lst if r['label'] == 'historical_product']
        neg = [r for r in lst if r['label'] == 'non_product']
        # current > historical
        for c in cur:
            for h in hist:
                pairs.append({'pos_text': c['text'], 'neg_text': h['text'],
                              'pos': c['version'], 'neg': h['version'], 'pageId': pid})
        # current > non_product
        for c in cur:
            for n in neg[:3]:
                pairs.append({'pos_text': c['text'], 'neg_text': n['text'],
                              'pos': c['version'], 'neg': n['version'], 'pageId': pid})
    save('pairs2.jsonl', pairs)
    print(f"排序对: {len(pairs)}")

    # 汇总
    with open(os.path.join(OUT, 'summary2.json'), 'w', encoding='utf-8') as f:
        json.dump({
            'read': len(rows),
            'binary_train': len(train), 'binary_val': len(val), 'binary_test': len(test),
            'pairs': len(pairs),
            'train_urls': len(train_urls), 'val_urls': len(val_urls), 'test_urls': len(test_urls),
        }, f, ensure_ascii=False, indent=2)
    print("→ summary2.json")


if __name__ == '__main__':
    main()
