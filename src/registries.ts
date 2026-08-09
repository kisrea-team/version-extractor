// 结构化版本源：包注册表确定性获取最新版本（不猜 HTML、不靠 AI）
//
// 优先级最高的版本来源。版本是注册表里的"命名字段"，不是从页面猜测。
//
// 支持：
//   winget:  https://github.com/microsoft/winget-pkgs 的 manifest 目录
//            key 形如 "winget:7zip.7zip"（publisher.package）
//   brew:    https://formulae.brew.sh/api/formula/<名>.json → versions.stable
//            key 形如 "brew:node"（formula 名）
//   flathub: https://flathub.org/api/v2/appstream/<appid>
//            key 形如 "flathub:org.videolan.VLC"
import { compareVersions } from './version-extract';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export interface RegistryResult {
  source: 'winget' | 'brew' | 'flathub';
  version: string;
  date?: string | null;
  confidence: 'high';
  registryKey: string;
}

const WINGET_REPO = 'microsoft/winget-pkgs';

// 内存缓存：同一 registryKey 只查一次（GitHub API 未认证配额 60/h，基准 58 例并发会打爆）
const registryCache = new Map<string, RegistryResult>();
// 磁盘持久缓存：跨进程复用成功结果，避免每次基准都耗 GitHub 配额
const REG_CACHE_DIR = '.reg-cache';
function regCachePath(key: string): string {
  return join(REG_CACHE_DIR, createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json');
}
function regCacheGet(key: string): RegistryResult | null {
  try {
    const f = regCachePath(key);
    if (!existsSync(f)) return null;
    const obj = JSON.parse(readFileSync(f, 'utf-8'));
    if (Date.now() - (obj.ts || 0) > 7 * 24 * 3600 * 1000) return null; // 7 天 TTL
    return obj.result;
  } catch {
    return null;
  }
}
function regCacheSet(key: string, result: RegistryResult) {
  try {
    mkdirSync(REG_CACHE_DIR, { recursive: true });
    writeFileSync(regCachePath(key), JSON.stringify({ result, ts: Date.now() }));
  } catch {
    // 忽略缓存写失败
  }
}

function wingetPath(wingetId: string): string | null {
  const dot = wingetId.indexOf('.');
  if (dot <= 0 || dot >= wingetId.length - 1) return null;
  const publisher = wingetId.slice(0, dot);
  const pkg = wingetId.slice(dot + 1);
  const first = publisher[0].toLowerCase(); // GitHub 路径大小写敏感：首字母段小写，publisher/package 保留原样
  if (!/^[a-z0-9]$/.test(first)) return null;
  return `manifests/${first}/${publisher}/${pkg}`;
}

async function ghFetch(path: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'version-extractor' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com/repos/${WINGET_REPO}/contents/${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`winget http ${r.status}`);
  return r.json();
}

// winget 版本目录：优先 GitHub API；API 限流(403)时回退到网页版目录(HTML 抓取，无配额限制)
async function listWingetVersionDirs(path: string, token?: string): Promise<string[]> {
  try {
    const dirs = (await ghFetch(path, token)) as Array<{ name: string; type: string }>;
    return (Array.isArray(dirs) ? dirs : []).filter((d) => d.type === 'dir').map((d) => d.name);
  } catch (e: any) {
    if (e?.message !== 'winget http 403') throw e; // 只有限流才回退
  }
  // 网页版目录：GitHub tree 页面 HTML 里嵌了 JSON 数据，提取目录名
  const html = await fetch(`https://github.com/${WINGET_REPO}/tree/master/${path}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36' },
    signal: AbortSignal.timeout(20000),
  }).then((r) => r.text());
  // GitHub 网页把目录项编码在 react payload 里：形如 "path":"...","name":"7.2.14"
  const names = [...html.matchAll(/"name":"((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3})"/g)].map((m) => m[1]);
  const uniq = [...new Set(names)];
  if (uniq.length === 0) throw new Error('winget web listing failed');
  return uniq;
}

// winget：列 manifest 版本目录，取语义版本最高的
export async function queryWinget(wingetId: string, opts: { token?: string } = {}): Promise<RegistryResult> {
  const path = wingetPath(wingetId);
  if (!path) throw new Error(`invalid winget id: ${wingetId}`);
  const names = await listWingetVersionDirs(path, opts.token);
  const versions = names.filter((n) => /^\d/.test(n)).sort(compareVersions);
  const latest = versions[versions.length - 1];
  if (!latest) throw new Error(`winget ${wingetId}: no versions`);
  return { source: 'winget', version: `v${latest}`, confidence: 'high', registryKey: wingetId };
}

// Homebrew：formula 优先，404 回退 cask（GUI 应用只有 cask；formula 的 versions.stable / cask 的 version 字符串）
export async function queryHomebrew(name: string): Promise<RegistryResult> {
  let r = await fetch(`https://formulae.brew.sh/api/formula/${encodeURIComponent(name)}.json`, { signal: AbortSignal.timeout(15000) });
  if (r.status === 404) {
    r = await fetch(`https://formulae.brew.sh/api/cask/${encodeURIComponent(name)}.json`, { signal: AbortSignal.timeout(15000) });
  }
  if (!r.ok) throw new Error(`brew http ${r.status}`);
  const d = (await r.json()) as { versions?: { stable?: string | string[] }; version?: string };
  const stableRaw = Array.isArray(d.versions?.stable) ? d.versions.stable[0] : d.versions?.stable || d.version;
  const stable = String(stableRaw || '').split(',')[0].trim() || null;
  if (!stable || stable === 'latest') throw new Error(`brew ${name}: no stable version`);
  return { source: 'brew', version: stable.startsWith('v') ? stable : `v${stable}`, confidence: 'high', registryKey: name };
}

// Flathub：appstream 元数据
export async function queryFlathub(appId: string): Promise<RegistryResult> {
  const r = await fetch(`https://flathub.org/api/v2/appstream/${encodeURIComponent(appId)}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`flathub http ${r.status}`);
  const d = (await r.json()) as { metadata?: { current_release?: { version?: string; release_date?: string | null } } };
  const v = d.metadata?.current_release?.version;
  if (!v) throw new Error(`flathub ${appId}: no version`);
  return { source: 'flathub', version: v.startsWith('v') ? v : `v${v}`, confidence: 'high', registryKey: appId, date: d.metadata?.current_release?.release_date || null };
}

// 统一入口：registry key 形如 "winget:7zip.7zip" / "brew:node" / "flathub:org.videolan.VLC"
export async function queryRegistry(registryKey: string, opts: { token?: string } = {}): Promise<RegistryResult> {
  const cached = registryCache.get(registryKey);
  if (cached) return cached;
  const diskCached = regCacheGet(registryKey);
  if (diskCached) {
    registryCache.set(registryKey, diskCached);
    return diskCached;
  }
  const colon = registryKey.indexOf(':');
  const kind = colon > 0 ? registryKey.slice(0, colon) : 'winget';
  const key = colon > 0 ? registryKey.slice(colon + 1) : registryKey;
  let result: RegistryResult;
  if (kind === 'brew') result = await queryHomebrew(key);
  else if (kind === 'flathub') result = await queryFlathub(key);
  else result = await queryWinget(key, opts);
  registryCache.set(registryKey, result);
  regCacheSet(registryKey, result);
  return result;
}

// ── L3 结构化源优先（文档 three-tier-extractor.md P3）──
// 官方 JSON 端点确定性给出版本，无需猜 HTML。按 URL 域名匹配已知端点。
export interface OfficialEndpointResult {
  version: string;
  changelog?: { content: string; date?: string | null } | null;
}
const OFFICIAL_ENDPOINTS: Array<{ host: RegExp; fetch: (url: string) => Promise<OfficialEndpointResult | string | null> }> = [
  {
    // iTunes lookup：id=... 或 bundleId=... → results[0].version（App Store 确定性版本）
    // 同时提取 releaseNotes 作为 changelog（官方干净日志，避免整页 JSON 被当正文清洗）
    host: /itunes\.apple\.com\/lookup|apps\.apple\.com/,
    fetch: async (url) => {
      const r = await fetch(url, { headers: { 'User-Agent': 'version-extractor' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const d = await r.json();
      const app = d?.results?.[0];
      if (!app?.version) return null;
      const notes = (app.releaseNotes || '').trim();
      return {
        version: `v${app.version}`,
        changelog: notes.length > 0 ? { content: notes, date: app.currentVersionReleaseDate || null } : null,
      };
    },
  },
  {
    // go.dev/dl/?mode=json → [{version:"go1.26.5",...}] 只返回稳定版
    host: /go\.dev|golang\.org/,
    fetch: async () => {
      const r = await fetch('https://go.dev/dl/?mode=json', { headers: { 'User-Agent': 'version-extractor' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const d = await r.json();
      if (Array.isArray(d) && d[0]?.version) return d[0].version.replace(/^go/, 'v');
      return null;
    },
  },
  {
    // python.org/downloads/ 最新版：官方下载页提取稳定版（排除 rc/beta）
    host: /python\.org/,
    fetch: async (url) => {
      const r = await fetch('https://www.python.org/downloads/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const text = await r.text();
      const stable = text.match(/Download Python\s+(\d+\.\d+\.\d+)/i);
      if (stable) return `v${stable[1]}`;
      return null;
    },
  },
  {
    // postgresql.org/versions.json → [{major:"18",current:true,...}]
    host: /postgresql\.org/,
    fetch: async () => {
      const r = await fetch('https://www.postgresql.org/versions.json', { headers: { 'User-Agent': 'version-extractor' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const d = await r.json();
      const cur = (Array.isArray(d) ? d : []).filter((x: any) => x.current);
      if (cur[0]?.major) return `v${cur[0].major}`;
      return null;
    },
  },
  {
    // blackmagicdesign.com → 官方产品页 "DaVinci Resolve 21"
    host: /blackmagicdesign\.com/,
    fetch: async () => {
      const r = await fetch('https://www.blackmagicdesign.com/products/davinciresolve', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null;
      const text = await r.text();
      const m = text.match(/DaVinci Resolve\s+(\d{1,2})/i);
      if (m) return `v${m[1]}`;
      return null;
    },
  },
  {
    // jdk.java.net → "JDK 28" 等最新特性版本
    host: /jdk\.java\.net/,
    fetch: async () => {
      const r = await fetch('https://jdk.java.net/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const text = await r.text();
      const versions = [...text.matchAll(/JDK\s+(\d{1,2})/gi)].map((m) => parseInt(m[1], 10));
      if (versions.length > 0) return `v${Math.max(...versions)}`;
      return null;
    },
  },
  {
    // filezilla-project.org → 下载页 meta "Download FileZilla Client 3.70.6"
    host: /filezilla-project\.org/,
    fetch: async () => {
      const r = await fetch('https://filezilla-project.org/download.php?type=client', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null;
      const text = await r.text();
      const m = text.match(/Download FileZilla Client\s+(\d+\.\d+\.\d+)/i);
      if (m) return `v${m[1]}`;
      return null;
    },
  },
  {
    // grafana.com → 官方下载页 meta "Version 12.4.1"
    host: /grafana\.com/,
    fetch: async () => {
      const r = await fetch('https://grafana.com/oss/grafana/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null;
      const text = await r.text();
      const m = text.match(/Version\s+(\d+\.\d+\.\d+)/i) || text.match(/v(\d+\.\d+\.\d+)/);
      if (m) return `v${m[1]}`;
      return null;
    },
  },
  {
    // redis.io → 官方稳定版：/download 页面最新版信息稀少且历史下载文件占主导，
    // 改用 GitHub redis/redis releases（权威 tag）。无 token 时也够低频使用。
    host: /redis\.io/,
    fetch: async () => {
      const r = await fetch('https://api.github.com/repos/redis/redis/releases/latest', {
        headers: { 'User-Agent': 'version-extractor', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) return null;
      const d = await r.json();
      if (d?.tag_name && /^\d/.test(d.tag_name)) return `v${d.tag_name}`;
      return null;
    },
  },
];

export async function queryOfficialEndpoint(url: string): Promise<OfficialEndpointResult | null> {
  for (const ep of OFFICIAL_ENDPOINTS) {
    if (ep.host.test(url)) {
      try {
        const v = await ep.fetch(url);
        if (!v) continue;
        return typeof v === 'string' ? { version: v } : v;
      } catch {
        // 端点失败则继续
      }
    }
  }
  return null;
}

// 由软件名生成候选 winget id（name.name / name），供 resolve 尝试
export function wingetCandidates(name: string): string[] {
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!clean) return [];
  const ids = new Set<string>([`${clean}.${clean}`]);
  // 常见变体：去掉年份/常见词
  const base = clean.replace(/studio$/, '').replace(/desktop$/, '');
  if (base && base !== clean) ids.add(`${base}.${base}`);
  ids.add(clean);
  return [...ids];
}

// 尝试用软件名自动解析出可用的 registry key（有限启发：优先 winget 候选 + brew 原样）
export async function resolveRegistry(
  name: string,
  opts: { token?: string; tryBrew?: boolean } = {}
): Promise<RegistryResult | null> {
  // winget 候选
  for (const id of wingetCandidates(name)) {
    try {
      return await queryWinget(id, opts);
    } catch {
      // 继续试下一个
    }
  }
  // brew 原样名
  if (opts.tryBrew !== false) {
    const brewName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    try {
      return await queryHomebrew(brewName);
    } catch {
      // ignore
    }
  }
  return null;
}
