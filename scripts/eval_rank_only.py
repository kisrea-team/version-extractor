#!/usr/bin/env python3
"""纯 rank 选择能力评测(消除抓取噪声 + 注册表掩盖)

设计动机(2026-08-16)：58 例端到端基准测不出 rank 改进，因为
  (a) 大量案例走注册表确定性路径，rank 不参与；
  (b) fastcrw/lightpanda 实时抓取波动(±几例)淹没 rank 改进幅度。
本harness三管齐下隔离 rank：
  1. 固定快照——每页抓一次缓存到磁盘，新旧模型用**完全相同的候选池**，零抓取噪声；
  2. 无注册表——直接对页面候选跑 filter→rank，不让注册表短路；
  3. 无 LLM——只看 rank top-1，不让 LLM 兜底掩盖 rank 错误。
新旧模型(149页 vs 249页训练)在同一候选池上对拼，差异纯来自模型本身。

用法: python3 scripts/eval_rank_only.py            # 抓取+缓存+双模型对拼
      python3 scripts/eval_rank_only.py --cached   # 复用已缓存快照
"""
import json, os, re, sys, subprocess, hashlib
from urllib import request as urlreq

VE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = '/tmp/rank_eval_snapshots'
FASTCRW = 'http://127.0.0.1:3000'
os.makedirs(CACHE, exist_ok=True)

bench = json.load(open(f'{VE}/benchmark/bench-hard-fixed.json'))
train_urls = {json.loads(l)['url'].rstrip('/') for l in open(f'{VE}/data/train3.jsonl')}
# 无泄漏 holdout：排除训练集页 + 排除期望值为空(无版本页)的
cases = [c for c in bench
         if c['url'].rstrip('/') not in train_urls and c.get('expectedVersion')]
print(f'holdout: {len(cases)} 例(58 - 训练重叠 - 空期望)', flush=True)


def fetch_cached(url):
    key = hashlib.sha1(url.encode()).hexdigest()[:16]
    fp = f'{CACHE}/{key}.html'
    if os.path.exists(fp) and os.path.getsize(fp) > 500:
        return open(fp, encoding='utf-8', errors='ignore').read()
    if '--cached' in sys.argv:
        return ''
    body = json.dumps({'url': url, 'formats': ['html'], 'render_js': True, 'wait_for': 4000}).encode()
    req = urlreq.Request(f'{FASTCRW}/v1/scrape', data=body, headers={'Content-Type': 'application/json'})
    try:
        with urlreq.urlopen(req, timeout=75) as r:
            html = (json.loads(r.read()).get('data') or {}).get('html') or ''
    except Exception as e:
        print(f'  抓取失败 {url[:50]}: {str(e)[:40]}', flush=True)
        return ''
    if html:
        open(fp, 'w', encoding='utf-8').write(html)
    return html


# 1) 抓取所有页(带 lightpanda 自愈)
def cdp_ok():
    try:
        urlreq.urlopen(f'http://127.0.0.1:9222/json/version', timeout=6); return True
    except Exception: return False

def ensure_cdp():
    if cdp_ok(): return
    subprocess.run(['pkill', '-f', '/root/.local/bin/lightpanda'], capture_output=True)
    import time; time.sleep(2)
    subprocess.Popen(['setsid', 'nohup', '/root/.local/bin/lightpanda'],
                     stdout=open('/tmp/lightpanda.log','a'), stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, start_new_session=True)
    import time
    for _ in range(10):
        time.sleep(2)
        if cdp_ok(): return

if '--cached' not in sys.argv:
    ensure_cdp()
    for i, c in enumerate(cases, 1):
        fetch_cached(c['url'])
        if i % 10 == 0:
            print(f'  抓取 {i}/{len(cases)}', flush=True)
            ensure_cdp()

# 2) 用 TS 侧导出每页候选池 + 双模型 rank 分(复用生产 collectCandidates/filter/buildRankFeatureRows)
#    这里通过一个 tsx 子进程完成(避免 py/ts 重复实现候选逻辑)
ts_driver = r'''
import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { collectCandidates } from './scripts/export-candidates';
import { predictCandidateVersions, buildRankFeatureRows, predictRankScores } from './src/lgb-score';

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const CACHE = '/tmp/rank_eval_snapshots';
const bare = (v: string) => v.replace(/^v/i, '');
const matches = (a: string, b: string) => bare(a) === bare(b) || bare(a).startsWith(bare(b) + '.') || bare(b).startsWith(bare(a) + '.');

(async () => {
  const results: any[] = [];
  for (const c of cases) {
    const key = createHash('sha1').update(c.url).digest('hex').slice(0, 16);
    const fp = `${CACHE}/${key}.html`;
    if (!existsSync(fp)) { results.push({ name: c.name, skip: 'no-snapshot' }); continue; }
    const html = readFileSync(fp, 'utf8');
    const cands = collectCandidates(html);
    if (!cands.length) { results.push({ name: c.name, expected: c.expectedVersion, poolSize: 0, inPool: false }); continue; }
    const scored = await predictCandidateVersions(cands);
    const valid = scored.filter((s) => Number.isFinite(s.prob) && s.prob >= 0);
    const rows = buildRankFeatureRows(html, valid, cands, c.name);
    const rankScores = await predictRankScores(rows);
    let top = '';
    if (rankScores) {
      let bi = 0; for (let i = 1; i < rankScores.length; i++) if (rankScores[i] > rankScores[bi]) bi = i;
      top = valid[bi]?.version || '';
    }
    const inPool = valid.some((s) => matches(s.version, c.expectedVersion));
    results.push({ name: c.name, expected: c.expectedVersion, top, hit: top ? matches(top, c.expectedVersion) : false, poolSize: valid.length, inPool });
  }
  console.log('___RESULTS___' + JSON.stringify(results));
  process.exit(0);
})();
'''
open(f'{VE}/_rank_driver.ts', 'w').write(ts_driver)


def run_with_model(model_path, label):
    # 临时替换 lgb-rank3.joblib，让 worker 加载指定模型
    prod = f'{VE}/data/lgb-rank3.joblib'
    bak = f'{VE}/data/lgb-rank3.joblib.evalbak'
    same = os.path.abspath(model_path) == os.path.abspath(prod)
    if not same:
        subprocess.run(['cp', prod, bak], check=True)
        subprocess.run(['cp', model_path, prod], check=True)
    try:
        env = {**os.environ, 'NODE_OPTIONS': '--experimental-sqlite --max-old-space-size=1400'}
        r = subprocess.run(['npx', 'tsx', '_rank_driver.ts', f'{VE}/benchmark/bench-hard-fixed.json'],
                           cwd=VE, capture_output=True, text=True, timeout=900, env=env)
        out = r.stdout
        marker = out.find('___RESULTS___')
        if marker < 0:
            print(f'{label} 驱动失败:', (r.stderr or out)[-400:]); return None
        return json.loads(out[marker + len('___RESULTS___'):])
    finally:
        if not same:
            subprocess.run(['mv', bak, prod], check=True)


print('\n=== 双模型对拼(同候选池) ===', flush=True)
res_new = run_with_model(f'{VE}/data/lgb-rank3.joblib', '新(249页)')
res_old = run_with_model('/tmp/lgb-rank3_37col_backup.joblib', '旧(149页)')

if res_new and res_old:
    nm = {r['name']: r for r in res_new}
    om = {r['name']: r for r in res_old}
    common = [n for n in nm if n in om and not nm[n].get('skip') and nm[n].get('inPool')]
    # inPool 过滤：只在"真版本进了候选池"的页上比 rank(否则是采集层问题，与 rank 无关)
    n_hit = sum(1 for n in common if nm[n]['hit'])
    o_hit = sum(1 for n in common if om[n]['hit'])
    print(f'\nrank 可判定页(真版本在候选池内): {len(common)}')
    print(f'  旧模型(149页): {o_hit}/{len(common)} = {o_hit/max(len(common),1)*100:.1f}%')
    print(f'  新模型(249页): {n_hit}/{len(common)} = {n_hit/max(len(common),1)*100:.1f}%')
    print(f'  净变化: {n_hit-o_hit:+d} 例')
    fixed = [n for n in common if not om[n]['hit'] and nm[n]['hit']]
    broke = [n for n in common if om[n]['hit'] and not nm[n]['hit']]
    print(f'\n新修复({len(fixed)}): ' + ', '.join(f"{n}({om[n]['top']}→{nm[n]['top']})" for n in fixed))
    print(f'新打破({len(broke)}): ' + ', '.join(f"{n}({om[n]['top']}→{nm[n]['top']})" for n in broke))
    # 长列表子集
    lc = [n for n in common if nm[n]['poolSize'] >= 30]
    if lc:
        print(f'\n长列表子集(池>=30, {len(lc)}例):')
        print(f'  旧 {sum(1 for n in lc if om[n]["hit"])}/{len(lc)} | 新 {sum(1 for n in lc if nm[n]["hit"])}/{len(lc)}')
    json.dump({'new': res_new, 'old': res_old}, open('/tmp/rank_eval_result.json', 'w'), ensure_ascii=False, indent=1)
    print('\n→ /tmp/rank_eval_result.json')
