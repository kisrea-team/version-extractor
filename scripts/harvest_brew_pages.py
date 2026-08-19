#!/usr/bin/env python3
"""用 brew cask 注册表 + fastcrw 现抓官网，双源交叉验证生成新训练标签。

为什么这条路数据是"对"的（三重保证）：
  1. **ground truth 来自命名字段**：brew cask 的 `version` 是注册表显式字段（不是从
     页面猜的），由 Homebrew CI 的 livecheck 机器人维护 —— 与"从页面提取"完全独立。
  2. **双源一致才收**：只有当 brew 版本**字面出现在现抓页面文本里**才生成标签。
     这同时保证了 (a) 两个独立源相互印证，(b) 标签必然在候选池内（可学习）。
  3. **单调性门**：若页面里存在比 brew 更高的同族版本，说明 brew 落后于页面 →
     此时 brew 版本不是"当前版本" → 弃用该页。这道门专门防注册表滞后。

时间对齐：brew 数据与页面都是"现在"抓的，天然同步；标签与快照 SHA-256 绑定，
永久有效（详见 build_snapshot_labels.py 的设计说明）。

用法: python3 scripts/harvest_brew_pages.py [--limit N] [--workers N] [--out DIR]
"""
import argparse, hashlib, json, os, re, subprocess, sys, time
import html as H
from concurrent.futures import ThreadPoolExecutor
from urllib import request as urlreq

VE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FASTCRW = os.environ.get('FASTCRW_URL', 'http://127.0.0.1:3000')
CASK_API = 'https://formulae.brew.sh/api/cask.json'

# 明显不是"产品官网"的宿主：代码托管/包索引页版本语义不同（tag 列表/依赖），
# 以及会把整站导航当内容的聚合站。这里只做宿主级排除，不做内容词表过滤。
SKIP_HOST = re.compile(
    r'(github\.com|gitlab\.com|sourceforge\.net|apps\.apple\.com|itunes\.apple\.com|'
    r'play\.google\.com|chromewebstore\.google\.com|microsoft\.com/store|'
    r'pypi\.org|npmjs\.com|rubygems\.org|crates\.io|videohelp\.com)', re.I)

# 是否探测常见版本页路径（--no-probe 关闭）。默认开：官网首页多不显版本，
# 且 changelog/releases 页是长候选列表页，正是当前 rank 的短板场景。
PROBE_PATHS = True
# 版本页链接线索（只用于"该跟哪个链接"，不参与版本真假判定）
VERSION_PAGE_HINT = re.compile(
    r'(changelog|change-log|release[-_]?note|releases|whatsnew|what-s-new|what%27s-new|'
    r'version[-_]?history|revision|updates?|download)', re.I)
MAX_PROBE = 4        # 每站最多跟 4 个候选版本页（控制抓取成本）
MIN_POOL = 2         # 候选池至少 2 个版本号（单候选页无排序学习价值）


def strip_tags(s: str) -> str:
    s = re.sub(r'<script[\s\S]*?</script>', ' ', s, flags=re.I)
    s = re.sub(r'<style[\s\S]*?</style>', ' ', s, flags=re.I)
    return H.unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', s)))


def vkey(v: str):
    parts = []
    for p in re.split(r'[.\-_]', v.lstrip('vV'))[:4]:
        m = re.match(r'\d+', p)
        parts.append(int(m.group(0)) if m else 0)
    return tuple(parts + [0] * (4 - len(parts)))


def fetch(url: str, timeout: int = 75):
    body = json.dumps({'url': url, 'formats': ['html'],
                       'render_js': True, 'wait_for': 4000}).encode()
    req = urlreq.Request(f'{FASTCRW}/v1/scrape', data=body,
                         headers={'Content-Type': 'application/json'})
    with urlreq.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read()).get('data') or {}
    return d.get('html') or ''


def discover_version_pages(home: str, raw: str) -> list:
    """从首页 HTML 里发现"版本页"链接（changelog/releases/download/history...）。

    比硬拼路径可靠：不同站点路径千差万别（/changelog vs /release-notes vs
    /en/whatsnew vs /support/updates），拼路径大多 404，而首页导航里必然有真链接。
    """
    from urllib.parse import urljoin, urlparse
    host = urlparse(home).netloc
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>([\s\S]{0,80}?)</a>', raw, re.I):
        href, anchor = m.group(1), strip_tags(m.group(2))
        blob = (href + ' ' + anchor).lower()
        if not VERSION_PAGE_HINT.search(blob):
            continue
        u = urljoin(home + '/', href)
        if urlparse(u).netloc != host:      # 只跟同站链接
            continue
        if u.rstrip('/') in seen:
            continue
        seen.add(u.rstrip('/'))
        # 语义强的（changelog/release）优先于弱的（download/news）
        pri = 0 if re.search(r'(changelog|release|version|history|whatsnew|what-s-new)', blob) else 1
        out.append((pri, u))
    out.sort()
    return [u for _, u in out[:MAX_PROBE]]


def process(cask: dict) -> dict | None:
    token, ver, home = cask['token'], str(cask['version']), cask['homepage']
    # brew 的 version 可能带 ,build 或 _revision 后缀，取主版本段
    core = re.split(r'[,_]', ver)[0].strip()
    if not re.match(r'^\d+(\.\d+){1,3}$', core):
        return {'token': token, 'reject': 'version-not-numeric', 'version': ver}

    ck = vkey(core)
    home = home.rstrip('/')

    def evaluate(u: str):
        """返回 (pool, raw) 若该页通过两道门，否则 None"""
        try:
            raw = fetch(u)
        except Exception:
            return None
        if len(raw) < 800:
            return None
        text = strip_tags(raw)
        # 门 1: brew 版本必须字面出现 → 双源一致 + 标签必在候选池内
        if not re.search(r'(?<![\d.])' + re.escape(core) + r'(?![\d.])', text):
            return None, raw
        # 门 2: 单调性 —— 页面有更高同族版本说明 brew 落后，brew 版本≠当前版本
        allv = {x for x in re.findall(r'(?<![\d.])(\d+(?:\.\d+){1,3})(?![\d.])', text)}
        if [x for x in allv if vkey(x)[0] == ck[0] and vkey(x) > ck]:
            return None, raw
        return len([x for x in allv if len(x.split('.')) >= 2]), raw

    best = None          # (pool, url, raw)
    r0 = evaluate(home)
    home_raw = ''
    if r0 is None:
        return {'token': token, 'reject': 'home-fetch-fail'}
    if isinstance(r0, tuple) and r0[0] is None:
        home_raw = r0[1]                      # 首页无版本/被单调性拒 → 去找版本页
    elif isinstance(r0, tuple):
        best = (r0[0], home, r0[1])
        home_raw = r0[1]

    # 无论首页是否命中，都尝试版本页：changelog 类页候选池更大，训练价值更高
    for u in discover_version_pages(home, home_raw):
        r = evaluate(u)
        if r is None or (isinstance(r, tuple) and r[0] is None):
            continue
        if best is None or r[0] > best[0]:
            best = (r[0], u, r[1])

    if best is None:
        # 页面无版本号 → 不是样本（用户明确要求：无版本号的不算样本，也不提取）
        return {'token': token, 'reject': 'no-version-on-any-page', 'version': core}

    pool, url, raw = best
    if pool < MIN_POOL:
        return {'token': token, 'reject': f'pool-too-small:{pool}'}
    pid = hashlib.sha1(url.encode()).hexdigest()[:12]
    # brew 的 name 是数组（多语言别名），取首个
    nm = cask.get('name')
    if isinstance(nm, list):
        nm = nm[0] if nm else ''
    return {'token': token, 'pageId': pid, 'url': url, 'name': str(nm or token),
            'version': 'v' + core, 'html': raw, 'poolSize': pool,
            'desc': (cask.get('desc') or '')[:80]}


def cdp_alive() -> bool:
    try:
        with urlreq.urlopen('http://127.0.0.1:9222/json/version', timeout=6):
            return True
    except Exception:
        return False


_pages_since_restart = [0]


def ensure_renderer(force: bool = False) -> bool:
    """确保 lightpanda CDP 可用。

    ⚠️ 2026-08-16/17 实测两种失效：
      (1) 崩溃：BrokenPipe / JS 边界异常 → CDP 挂
      (2) 内存泄漏：长时间连续渲染 total-vm 爆到 136GB，被内核 OOM 杀
          （连带 harvest 进程一起 SIGTERM）
    因此不能只"死了才重启"，必须**每 N 页主动重启**释放累积内存。
    force=True 时无条件重启，即使 CDP 还活着。
    """
    if not force and cdp_alive():
        return True
    subprocess.run(['pkill', '-f', '/root/.local/bin/lightpanda'], capture_output=True)
    time.sleep(2)
    subprocess.Popen(['setsid', 'nohup', '/root/.local/bin/lightpanda'],
                     stdout=open('/tmp/lightpanda.log', 'a'),
                     stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                     start_new_session=True)
    _pages_since_restart[0] = 0
    for _ in range(10):
        time.sleep(2)
        if cdp_alive():
            if force:
                print('  ♻️ lightpanda 已主动重启（释放累积内存）', flush=True)
            else:
                print('  ✓ lightpanda 已恢复', flush=True)
            return True
    print('  🔴 lightpanda 重启失败，后续页面渲染将失效', flush=True)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=60)
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--offset', type=int, default=0)
    ap.add_argument('--out', default=f'{VE}/data/annotation-batches/batch-brew')
    ap.add_argument('--min-pool', type=int, default=0, help='只保留候选池 >= N 的页')
    args = ap.parse_args()

    with urlreq.urlopen(CASK_API, timeout=90) as r:
        casks = json.loads(r.read())
    pool = [c for c in casks
            if c.get('homepage') and c.get('version') not in (None, '', 'latest')
            and not SKIP_HOST.search(c['homepage'])]
    pool.sort(key=lambda c: c['token'])
    batch = pool[args.offset:args.offset + args.limit]
    print(f'cask 总数 {len(casks)} → 可用 {len(pool)} → 本批 {len(batch)} '
          f'(offset={args.offset}, workers={args.workers})', flush=True)

    os.makedirs(f'{args.out}/html', exist_ok=True)
    kept, rejects = [], []
    t0 = time.time()
    ensure_renderer()   # 抓取前先确认渲染器可用
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, res in enumerate(ex.map(process, batch), 1):
            if res is None:
                continue
            if 'reject' in res:
                rejects.append(res)
            else:
                if res['poolSize'] >= args.min_pool:
                    kept.append(res)
                else:
                    rejects.append({'token': res['token'], 'reject': f'pool-too-small:{res["poolSize"]}'})
            if i % 10 == 0:
                print(f'  [{i}/{len(batch)}] 收 {len(kept)} 弃 {len(rejects)} '
                      f'({time.time()-t0:.0f}s)', flush=True)
            # 每 50 页无条件主动重启：防内存泄漏累积到被 OOM 杀
            # （2026-08-17 教训：120 页太慢，swap 满时 20 页就 OOM 了）
            if i % 50 == 0:
                ensure_renderer(force=True)
            elif i % 20 == 0:
                ensure_renderer()

    # 落快照 + 标签（与 snapshot-labels.jsonl 同格式，哈希锚定）
    labels = []
    for k in kept:
        hp = f'{args.out}/html/{k["pageId"]}.html'
        with open(hp, 'w', encoding='utf-8') as f:
            f.write(k['html'])
        labels.append({
            'pageId': k['pageId'], 'url': k['url'], 'name': k['name'],
            'snapshotSha256': hashlib.sha256(k['html'].encode('utf-8', 'ignore')).hexdigest(),
            'snapshotFile': os.path.relpath(hp, VE),
            'currentVersion': k['version'],
            'evidenceType': 'brew-cask-cross-verified',
            'evidence': f'brew cask {k["token"]} version={k["version"].lstrip("v")}; '
                        f'该版本字面出现于现抓页面且页面无更高同族版本',
            'confidence': 'high',
            'labeler': 'brew-cask registry × fastcrw page (dual-source + monotonicity gate)',
            'source': 'brew-cross', 'poolSize': k['poolSize'],
        })

    lp = f'{args.out}/labels.jsonl'
    mode = 'a' if os.path.exists(lp) else 'w'
    with open(lp, mode, encoding='utf-8') as f:
        for r in labels:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

    from collections import Counter
    reasons = Counter(r['reject'].split(':')[0] for r in rejects)
    print(f'\n=== 结果 ({time.time()-t0:.0f}s) ===')
    print(f'收: {len(kept)} 页  弃: {len(rejects)} 页  收率 {len(kept)/max(len(batch),1)*100:.0f}%')
    print(f'弃因分布: {dict(reasons)}')
    if kept:
        pools = sorted(k['poolSize'] for k in kept)
        print(f'候选池: 中位 {pools[len(pools)//2]}, >=30: {sum(1 for x in pools if x>=30)}, '
              f'>=80: {sum(1 for x in pools if x>=80)}')
        print(f'\n样例:')
        for k in sorted(kept, key=lambda x: -x['poolSize'])[:10]:
            print(f"  {k['version']:<12} 池{k['poolSize']:<5} {k['name'][:26]:<28} {k['url'][:42]}")
    print(f'\n→ {lp} (+{len(labels)} 条)')


if __name__ == '__main__':
    main()
