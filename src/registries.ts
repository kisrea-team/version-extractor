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

export interface RegistryResult {
  source: 'winget' | 'brew' | 'flathub';
  version: string;
  date?: string | null;
  confidence: 'high';
  registryKey: string;
}

const WINGET_REPO = 'microsoft/winget-pkgs';

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
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com/repos/${WINGET_REPO}/contents/${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`winget http ${r.status}`);
  return r.json();
}

// winget：列 manifest 版本目录，取语义版本最高的
export async function queryWinget(wingetId: string, opts: { token?: string } = {}): Promise<RegistryResult> {
  const path = wingetPath(wingetId);
  if (!path) throw new Error(`invalid winget id: ${wingetId}`);
  const dirs = (await ghFetch(path, opts.token)) as Array<{ name: string; type: string }>;
  const versions = (Array.isArray(dirs) ? dirs : [])
    .filter((d) => d.type === 'dir' && /^\d/.test(d.name))
    .map((d) => d.name)
    .sort(compareVersions);
  const latest = versions[versions.length - 1];
  if (!latest) throw new Error(`winget ${wingetId}: no versions`);
  return { source: 'winget', version: `v${latest}`, confidence: 'high', registryKey: wingetId };
}

// Homebrew：formulae API 的 versions.stable 字段
export async function queryHomebrew(formula: string): Promise<RegistryResult> {
  const r = await fetch(`https://formulae.brew.sh/api/formula/${encodeURIComponent(formula)}.json`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`brew http ${r.status}`);
  const d = (await r.json()) as { versions?: { stable?: string } };
  const stable = d.versions?.stable;
  if (!stable) throw new Error(`brew ${formula}: no stable version`);
  return { source: 'brew', version: stable.startsWith('v') ? stable : `v${stable}`, confidence: 'high', registryKey: formula };
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
  const colon = registryKey.indexOf(':');
  const kind = colon > 0 ? registryKey.slice(0, colon) : 'winget';
  const key = colon > 0 ? registryKey.slice(colon + 1) : registryKey;
  if (kind === 'brew') return queryHomebrew(key);
  if (kind === 'flathub') return queryFlathub(key);
  return queryWinget(key, opts);
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
