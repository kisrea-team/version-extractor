// 注册表自动发现：给 URL + 产品名 → 多渠道搜索 → homepage 域名匹配 → 版本号
//
// 原理（实验验证）：
//   - 嵌入/reranker 模型分不清"产品本体 vs SDK"（候选描述都含产品名 → 相似度假象）
//   - homepage 域名匹配是硬信号：产品本体仓库的 homepage 域名 == 产品官网域名（相等或子域）
//   - brew cask 本体 23/23 全中，无关 SDK 零误匹配
//
// 渠道：brew casks（本地缓存过滤）、GitHub repo search、npm search
// 版本来源：cask.json 的 version 字段 / GitHub releases / npm latest
// 命中返回候选列表（域名已匹配），由 pipeline 结合页面版本做合理性过滤

import { compareVersions, stripVersionPrefix } from './version-extract';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface RegistryCandidate {
  source: 'brew' | 'github' | 'npm';
  name: string;          // 仓库/包名（如 "1password"、"1Password/for-open-source"）
  version: string;       // 注册表当前版本（v 前缀规范化）
  homepage: string;      // 仓库主页
  registryKey: string;   // 可传给 queryRegistry 的 key（如 brew:1password）
  matchedDomain: string; // 命中的域名（用于审计）
  desc?: string;         // 描述（SDK/预发布过滤用）
  prerelease?: boolean;  // 预发布变体（beta/nightly/snapshot）—— pick 时排后
  fromUrl?: boolean;     // URL 直接解析的候选（最强信号，绝对优先）
}

// ── 域名工具 ──
export function extractDomain(u: string): string {
  const m = String(u || '').match(/https?:\/\/([^/]+)/i);
  if (!m) return '';
  let d = m[1].toLowerCase().split(':')[0];
  if (d.startsWith('www.')) d = d.slice(4);
  return d;
}

// 相等或一方是另一方的子域（developer.1password.com ↔ 1password.com）
export function domainMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

// ── brew casks：全量清单本地缓存 + 过滤 ──
const BREW_CACHE = '.reg-cache/brew-registry.json';
const BREW_TTL = 7 * 24 * 3600 * 1000; // 7 天

interface BrewCask {
  token: string;
  homepage: string;
  version: string;
  desc?: string;
  kind: 'cask' | 'formula';
}

async function loadBrewRegistry(): Promise<BrewCask[]> {
  try {
    if (existsSync(BREW_CACHE)) {
      const obj = JSON.parse(readFileSync(BREW_CACHE, 'utf-8'));
      if (Date.now() - (obj.ts || 0) < BREW_TTL) return obj.entries;
    }
  } catch { /* 缓存损坏则重下 */ }
  // cask = GUI 桌面应用（vscode/chrome/7zip）；formula = CLI/开发库（python/node/git）
  // CLI 工具只在 formula 里，只查 cask 会漏掉 python/node/git 这类
  const fetchers = [
    { url: 'https://formulae.brew.sh/api/cask.json', kind: 'cask' as const },
    { url: 'https://formulae.brew.sh/api/formula.json', kind: 'formula' as const },
  ];
  const entries: BrewCask[] = [];
  const results = await Promise.allSettled(fetchers.map((f) => fetch(f.url, { headers: { 'User-Agent': 'version-extractor' }, signal: AbortSignal.timeout(30000) })));
  for (let i = 0; i < fetchers.length; i += 1) {
    const res = results[i];
    if (res.status !== 'fulfilled' || !res.value.ok) continue;
    try {
      const raw = (await res.value.json()) as any[];
      for (const c of raw) {
        const token = typeof c.token === 'string' ? c.token : (Array.isArray(c.name) ? c.name[0] || '' : String(c.name || ''));
        if (!token) continue;
        entries.push({
          token,
          homepage: c.homepage || '',
          version: String(c.version || '').split(',')[0] || '',
          desc: c.desc || '',
          kind: fetchers[i].kind,
        });
      }
    } catch { /* 单个包列表解析失败跳过 */ }
  }
  try {
    mkdirSync('.reg-cache', { recursive: true });
    writeFileSync(BREW_CACHE, JSON.stringify({ ts: Date.now(), entries }));
  } catch { /* 缓存写失败忽略 */ }
  return entries;
}

// brew 直查兜底：全量列表（cask.json/formula.json 4-5MB）在部分网络会超时，
// 改为按产品名直查单个 formula/cask 端点（小请求），命中即候选。
async function searchBrewDirect(productName: string, urlDomain: string): Promise<RegistryCandidate[]> {
  const key = productName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return [];
  const out: RegistryCandidate[] = [];
  for (const kind of ['formula', 'cask'] as const) {
    try {
      const r = await fetch(`https://formulae.brew.sh/api/${kind}/${encodeURIComponent(key)}.json`, {
        headers: { 'User-Agent': 'version-extractor' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const d = (await r.json()) as { homepage?: string; version?: string | string[]; desc?: string };
      const cd = extractDomain(d.homepage || '');
      if (!domainMatch(cd, urlDomain)) continue;
      const raw = Array.isArray(d.version) ? d.version[0] : d.version;
      const ver = String(raw || '').split(',')[0].trim();
      out.push({
        source: 'brew',
        name: key,
        version: ver && ver !== 'latest' ? (ver.startsWith('v') ? ver : `v${ver}`) : '',
        homepage: d.homepage || '',
        registryKey: `brew:${key}`,
        matchedDomain: cd,
        desc: d.desc || '',
      });
    } catch { /* 单个查询超时跳过 */ }
  }
  return out;
}

// brew 候选：产品名 token 包含匹配（去符号）→ homepage 域名匹配在 discover 层做
// entries 同时含 casks（GUI）与 formulas（CLI），统一 key brew:<token>（queryHomebrew 自动探测）
function searchBrewCasks(productName: string, urlDomain: string, entries: BrewCask[]): RegistryCandidate[] {
  const key = productName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return [];
  const out: RegistryCandidate[] = [];
  for (const c of entries) {
    const tok = c.token.toLowerCase().replace(/[^a-z0-9]/g, '');
    // token 与产品名精确相等，或 token 包含产品名 / 产品名包含 token（避免子串误匹配过短）
    const hit = tok === key || (tok.length >= 4 && (tok.includes(key) || key.includes(tok)));
    if (!hit) continue;
    const cd = extractDomain(c.homepage);
    if (!domainMatch(cd, urlDomain)) continue;
    // 预发布变体（vlc@nightly / 1password@beta）降权：保留但排在稳定版后面（pick 时处理）
    const prerelease = /@(?:beta|nightly|snapshot|alpha|dev|rc)\b/i.test(c.token);
    out.push({
      source: 'brew',
      name: c.token,
      version: c.version ? (c.version.startsWith('v') ? c.version : `v${c.version}`) : '',
      homepage: c.homepage,
      registryKey: `brew:${c.token}`,
      matchedDomain: cd,
      desc: c.desc,
      prerelease,
    });
  }
  return out;
}

// ── GitHub repo search：官方仓库 homepage 域名匹配 ──
async function searchGithub(productName: string, urlDomain: string, token?: string): Promise<RegistryCandidate[]> {
  const q = encodeURIComponent(productName);
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'version-extractor' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com/search/repositories?q=${q}&per_page=10`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return [];
  const d = (await r.json()) as { items?: Array<{ full_name: string; homepage: string | null; description: string | null }> };
  const out: RegistryCandidate[] = [];
  for (const it of d.items || []) {
    const cd = extractDomain(it.homepage || '');
    if (!domainMatch(cd, urlDomain)) continue;
    out.push({
      source: 'github',
      name: it.full_name,
      version: '', // 版本需另查 releases（fetchDiscoveredVersion）
      homepage: it.homepage || '',
      registryKey: `github:${it.full_name}`,
      matchedDomain: cd,
      desc: it.description || '',
    });
  }
  return out;
}

// ── npm search：SDK 干扰最多，但域名匹配能过滤 ──
async function searchNpm(productName: string, urlDomain: string): Promise<RegistryCandidate[]> {
  const r = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(productName)}&size=10`, {
    headers: { 'User-Agent': 'version-extractor' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return [];
  const d = (await r.json()) as { objects?: Array<{ package: { name: string; version: string; description?: string; links?: { homepage?: string } } }> };
  const out: RegistryCandidate[] = [];
  for (const o of d.objects || []) {
    const p = o.package;
    const cd = extractDomain(p.links?.homepage || '');
    if (!domainMatch(cd, urlDomain)) continue;
    out.push({
      source: 'npm',
      name: p.name,
      version: p.version ? (p.version.startsWith('v') ? p.version : `v${p.version}`) : '',
      homepage: p.links?.homepage || '',
      registryKey: `npm:${p.name}`,
      matchedDomain: cd,
      desc: p.description || '',
    });
  }
  return out;
}

// ── 统一入口：给定 URL + 产品名 → 域名匹配通过的候选列表 ──
export async function discoverRegistry(
  url: string,
  opts: { productName?: string; token?: string } = {}
): Promise<RegistryCandidate[]> {
  const urlDomain = extractDomain(url);
  if (!urlDomain) return [];
  const name = (opts.productName || '').trim();
  if (!name) return [];

  // GitHub URL 本身就是最强信号：直接解析 owner/repo 作为候选（版本待查 releases），
  // 解决"官网域名≠GitHub"的产品（如 mpv：本体仓库 homepage 是 mpv.io，域名匹配会漏掉）
  const urlCandidates: RegistryCandidate[] = [];
  const ghMatch = url.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (ghMatch && !/\/releases?\/|\.git/i.test(ghMatch[0])) {
    const full = `${ghMatch[1]}/${ghMatch[2].replace(/\.git$/, '')}`;
    urlCandidates.push({
      source: 'github',
      name: full,
      version: '',
      homepage: `https://github.com/${full}`,
      registryKey: `github:${full}`,
      matchedDomain: 'github.com (URL 直接解析)',
      fromUrl: true,
    });
  }

  const entries = await loadBrewRegistry();
  // 渠道独立容错：一个渠道超时/失败不影响其他（GitHub search 15s 超时是常态，不能拖垮 brew）
  const [brew, brewDirect, gh, npm] = await Promise.allSettled([
    searchBrewCasks(name, urlDomain, entries),
    searchBrewDirect(name, urlDomain),
    searchGithub(name, urlDomain, opts.token),
    searchNpm(name, urlDomain),
  ]);
  const brewCands = [
    ...(brew.status === 'fulfilled' ? brew.value : []),
    ...(brewDirect.status === 'fulfilled' ? brewDirect.value : []),
  ];
  const seenBrew = new Set<string>();
  const uniqueBrew = brewCands.filter((c) => (seenBrew.has(c.registryKey) ? false : (seenBrew.add(c.registryKey), true)));
  const cands: RegistryCandidate[] = [
    ...urlCandidates, // URL 直接解析的最可信，排最前
    ...uniqueBrew,
    ...(gh.status === 'fulfilled' ? gh.value : []),
    ...(npm.status === 'fulfilled' ? npm.value : []),
  ];
  return cands;
}

// ── 版本补齐：GitHub 候选需查 releases 拿最新 tag + release body（即 changelog）──
export async function fetchGithubRelease(
  fullName: string,
  token?: string
): Promise<{ version: string; changelog: string | null; date: string | null } | null> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'version-extractor' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const r = await fetch(`https://api.github.com/repos/${fullName}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { tag_name?: string; body?: string | null; published_at?: string | null };
    if (!d.tag_name) return null;
    // 剥离 npm 包名/分支前缀污染(共享清洗): @scope/pkg@1.2.3 → 1.2.3, desktop-v0.0.11 → v0.0.11
    const v = stripVersionPrefix(d.tag_name).replace(/^v/i, '');
    return {
      version: `v${v}`,
      changelog: d.body && d.body.trim().length > 50 ? d.body.trim() : null,
      date: d.published_at || null,
    };
  } catch {
    return null;
  }
}

// 候选去重排序：
//   0. URL 直接解析的候选绝对优先（用户 URL 是最强信号，不受 brew 子串误伤影响）
//   1. 预发布变体（@beta/@nightly）排最后
//   2. 渠道优先级 brew(0) > github(1) > npm(2)（npm SDK 干扰最多，brew 命中即胜）
//   3. 同渠道内：有版本号的按版本大优先，无版本号（github 待查 releases）排前
// 不用 SDK 词表：词表是脆弱枚举，会误伤产品（如 Postman "API development platform"）；
// 渠道优先级已经天然规避 npm/github 的 SDK 干扰（brew 命中就赢）。
export function pickBestCandidate(cands: RegistryCandidate[]): RegistryCandidate | null {
  if (cands.length === 0) return null;
  const stable = cands.filter((c) => !c.prerelease);
  const pool = stable.length > 0 ? stable : cands;
  const srcRank = (c: RegistryCandidate) => {
    if (c.fromUrl) return -100; // URL 直接解析绝对优先
    return c.source === 'brew' ? 0 : c.source === 'github' ? 1 : 2;
  };
  const sorted = [...pool].sort((a, b) => {
    const ra = srcRank(a), rb = srcRank(b);
    if (ra !== rb) return ra - rb;
    // 同渠道：有版本号的按版本大优先，无版本号（github 待查 releases）排前
    const va = a.version.replace(/^v/, ''), vb = b.version.replace(/^v/, '');
    if (/^\d/.test(va) && /^\d/.test(vb)) return compareVersions(vb, va);
    if (/^\d/.test(va)) return -1;
    if (/^\d/.test(vb)) return 1;
    return 0;
  });
  return sorted[0];
}
