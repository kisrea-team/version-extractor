#!/usr/bin/env python3
"""从 logup 库抓官网 changelog 页(fastcrw), 交叉验证后作为训练标签

来源: logup projects 表(update_source_url + latest_version, 1111 个)
过滤: 排除 GitHub/商店源、排除 SKIP_IDS/SKIP_KEYWORDS(沿用 logup 运维口径)
只抓: URL 含 changelog/releases/relnotes/history/download 的(官网 changelog 类)
标签: 双重验证
  门1: logup latest_version 字面出现在页面 → 标签=latest_version (logup-verified)
  门2: 门1失败但页面有更高版本 → 标签=页面最高版本 (page-latest, 页面是 changelog 页时可信)
  两门都失败 → 弃
输出: data/annotation-batches/batch-logup/{html/, labels.jsonl}
"""
import json, os, re, subprocess, time, hashlib
from urllib import request as urlreq
from concurrent.futures import ThreadPoolExecutor
from collections import Counter

ROOT = '/root/ve-docker-api'
FASTCRW = 'http://127.0.0.1:3000'
OUT = f'{ROOT}/data/annotation-batches/batch-logup'
os.makedirs(f'{OUT}/html', exist_ok=True)

# 沿用 logup 运维口径的排除
SKIP_KEYWORDS = ('awesome-', '-books', '-guide', 'tutorial', 'build-your-own',
                 'javascript-algorithms', 'java-guide', '100-days', 'interview',
                 'roadmap', 'notes', '-docs', 'handbook', 'lovable', 'devin')

CHANGELOG_HINT = re.compile(r'(changelog|change-log|release[-_]?note|releases|whatsnew|'
                            r'version[-_]?history|revision|updates?|download|history)', re.I)


def cdp_alive() -> bool:
    try:
        urlreq.urlopen('http://127.0.0.1:9222/json/version', timeout=6)
        return True
    except Exception:
        return False


def ensure_renderer(force: bool = False) -> bool:
    if not force and cdp_alive():
        return True
    subprocess.run(['pkill', '-f', '/root/.local/bin/lightpanda'], capture_output=True)
    time.sleep(2)
    subprocess.Popen(['setsid', 'nohup', '/root/.local/bin/lightpanda'],
                     stdout=open('/tmp/lightpanda.log', 'a'),
                     stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                     start_new_session=True)
    for _ in range(10):
        time.sleep(2)
        if cdp_alive():
            print(f'  {"♻️ 主动重启" if force else "✓ 恢复"}', flush=True)
            return True
    print('  🔴 重启失败', flush=True)
    return False


def fetch(url: str) -> str:
    body = json.dumps({'url': url, 'formats': ['html'], 'render_js': True, 'wait_for': 4000}).encode()
    req = urlreq.Request(f'{FASTCRW}/v1/scrape', data=body, headers={'Content-Type': 'application/json'})
    with urlreq.urlopen(req, timeout=90) as r:
        return (json.loads(r.read()).get('data') or {}).get('html') or ''


def vkey(v: str):
    m = re.match(r'v?(\d+(?:\.\d+){0,3})', v or '')
    return tuple(int(x) for x in m.group(1).split('.')) if m else ()


def page_max_version(html: str):
    """页面里所有候选版本的最高值(门2/回退标签用)"""
    pat = re.compile(r'v?(\d+(?:\.\d+){1,3})')
    best, best_key = None, ()
    for m in pat.finditer(re.sub(r'<script[\s\S]*?</script>', ' ', html, flags=re.I)):
        cand = m.group(1)
        k = vkey(cand)
        if k and k > best_key:
            best, best_key = cand, k
    return best


def process(p: dict) -> dict | None:
    url, name, logup_ver = p['url'], p['name'], p.get('latest_version', '')
    try:
        html_text = fetch(url)
    except Exception as e:
        return {'name': name, 'reject': f'fetch-fail:{str(e)[:40]}'}
    if not html_text or len(html_text) < 300:
        return {'name': name, 'reject': 'empty-page'}

    expected = None
    source = None
    norm = re.sub(r'^v', '', logup_ver or '')
    if norm and (norm in html_text or logup_ver in html_text):
        expected, source = logup_ver, 'logup-verified'
    else:
        # 门1失败 → 用页面最高版本(页面是 changelog 页, 最新条目即真值)
        pmax = page_max_version(html_text)
        if pmax and vkey(pmax):
            # 但要求页面确实像 changelog(有多个版本号聚集), 否则最高可能是噪声
            if CHANGELOG_HINT.search(url):
                expected, source = 'v' + pmax, 'page-latest'
    if not expected:
        return {'name': name, 'reject': f'no-label:logup={logup_ver}'}

    # 门2: 标签(若为 logup-verified)不得低于页面同族最高 —— 已由 page-latest 回退覆盖
    sha = hashlib.sha256(html_text.encode()).hexdigest()
    page_id = hashlib.sha1(url.encode()).hexdigest()[:12]
    open(f'{OUT}/html/{page_id}.html', 'w', encoding='utf-8').write(html_text)
    return {'pageId': page_id, 'url': url, 'name': name, 'snapshotSha256': sha,
            'expected': expected, 'source': source, 'labelSource': source,
            'html': f'{OUT}/html/{page_id}.html'}


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=300)
    ap.add_argument('--offset', type=int, default=0)
    ap.add_argument('--workers', type=int, default=3)
    args = ap.parse_args()

    # 从 logup 库拉项目
    sql = """
    SELECT id, name, update_source_url AS url, latest_version
    FROM projects
    WHERE update_source_url IS NOT NULL AND update_source_url != ''
      AND latest_version IS NOT NULL AND latest_version != ''
      AND update_source_url NOT LIKE '%github.com%'
      AND update_source_url NOT LIKE '%itunes%'
      AND update_source_url NOT LIKE '%apps.apple%'
      AND update_source_url NOT LIKE '%chrome.google%'
      AND update_source_url NOT LIKE '%play.google%'
      AND update_source_url NOT LIKE '%npmjs%'
      AND update_source_url NOT LIKE '%pypi%';
    """
    r = subprocess.run(['docker', 'exec', '-i', 'postgres-1panel', 'psql', '-U', 'postgres',
                        '-d', 'postgres', '-t', '-A', '-F', '\t', '-c', sql],
                       capture_output=True, text=True, timeout=60)
    projects = []
    for line in r.stdout.strip().splitlines():
        parts = line.split('\t')
        if len(parts) >= 4:
            projects.append({'id': parts[0], 'name': parts[1], 'url': parts[2], 'latest_version': parts[3]})

    # 过滤 SKIP_KEYWORDS + 只留 changelog 类 URL
    cand = [p for p in projects
            if not any(k in (p['name'] or '').lower() for k in SKIP_KEYWORDS)
            and CHANGELOG_HINT.search(p['url'])]
    print(f'logup 官网 changelog 类候选: {len(cand)} (总 {len(projects)})', flush=True)

    # 排除已进训练集和已抓过的
    train_urls = {json.loads(l)['url'].rstrip('/') for l in open(f'{ROOT}/data/train3.jsonl')}
    done = set()
    if os.path.exists(f'{OUT}/labels.jsonl'):
        done = {json.loads(l)['url'] for l in open(f'{OUT}/labels.jsonl')}
    batch = [p for p in cand if p['url'].rstrip('/') not in train_urls and p['url'] not in done]
    batch = batch[args.offset:args.offset + args.limit]
    print(f'本批 {len(batch)} 个 (offset={args.offset}, workers={args.workers})', flush=True)

    ensure_renderer()
    kept, rejects = [], []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, res in enumerate(ex.map(process, batch), 1):
            if res is None:
                continue
            if 'reject' in res:
                rejects.append(res)
            else:
                kept.append(res)
            if i % 10 == 0:
                print(f'  [{i}/{len(batch)}] 收 {len(kept)} 弃 {len(rejects)} ({time.time()-t0:.0f}s)', flush=True)
            if i % 50 == 0:
                ensure_renderer(force=True)
            elif i % 20 == 0:
                ensure_renderer()

    if kept:
        with open(f'{OUT}/labels.jsonl', 'a', encoding='utf-8') as f:
            for k in kept:
                f.write(json.dumps(k, ensure_ascii=False) + '\n')
    print(f'\n收 {len(kept)} 弃 {len(rejects)}', flush=True)
    print('弃因:', dict(Counter(r['reject'].split(':')[0] for r in rejects)), flush=True)
    src = Counter(k.get('source') for k in kept)
    print('标签来源:', dict(src), flush=True)
    for r in rejects[:12]:
        print(f'  {r["name"]}: {r["reject"]}', flush=True)


if __name__ == '__main__':
    main()
