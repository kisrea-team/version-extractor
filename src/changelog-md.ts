// 更新日志分节：remark AST 版本锚定（取代整页 Trafilatura 裸文本）
//
// Trafilatura 清洗出的 markdown → mdast AST → 找含目标版本号的 heading 节点 →
// 取该节点到下一个「同级或更高级 heading」之间的所有节点 = 该版本专属段落。
// 无版本号时取第一个版本标题（changelog 页通常新→旧排列）→ 最新版。
// 从标题提取 date（"2026-07-24 (3.53.4)" → 2026-07-24）。
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import type { Root, Heading, Nodes } from 'mdast';
import { normalizeVersion } from './changelog';

export interface MdVersionSection {
  version: string; // 归一化 'v3.53.4'
  title: string;   // 版本标题文本 '2026-07-24 (3.53.4)'
  date: string | null;
  content: string; // 该版本正文（markdown，不带头标题）
}

// 取节点纯文本（text/inlineCode/strong/emphasis 等），用于从标题找版本号
function headingText(node: Heading): string {
  let out = '';
  const walk = (n: Nodes): void => {
    if (n.type === 'text' || n.type === 'inlineCode') out += (n as { value?: string }).value || '';
    else if ('children' in n && Array.isArray(n.children)) n.children.forEach(walk);
  };
  node.children.forEach(walk);
  return out.trim();
}

// 标题文本里找版本号（X.Y[.Z[.W]]，日期 2026-07-24 用横线不会误匹配）
function versionInText(text: string): string | null {
  const m = text.match(/v?\d+(?:\.\d+){1,3}/);
  return m ? normalizeVersion(m[0]) : null;
}

export function extractMdVersionSection(md: string, version?: string | null): MdVersionSection | null {
  if (!md) return null;
  const tree = unified().use(remarkParse).parse(md) as Root;
  const children = tree.children as Nodes[];
  const want = version ? normalizeVersion(version) : null;

  // 找目标 heading：给定版本 → 第一个含该版本的标题；否则 → 第一个版本标题（最新）
  let startPos = -1;
  let targetLevel = 0;
  let targetTitle = '';
  let targetVersion: string | null = null;
  for (let i = 0; i < children.length; i += 1) {
    const n = children[i];
    if (n.type !== 'heading') continue;
    const title = headingText(n as Heading);
    const hv = versionInText(title);
    if (!hv) continue;
    if (want) {
      if (hv === want) { startPos = i; targetLevel = (n as Heading).depth; targetTitle = title; targetVersion = hv; break; }
    } else if (targetVersion === null) {
      startPos = i; targetLevel = (n as Heading).depth; targetTitle = title; targetVersion = hv; break;
    }
  }
  if (startPos < 0 || !targetVersion) return null;

  // 截止：下一个同级或更高级 heading（含非版本标题，如 "Other"/"See also"）
  let endPos = children.length;
  for (let i = startPos + 1; i < children.length; i += 1) {
    const n = children[i];
    if (n.type === 'heading' && (n as Heading).depth <= targetLevel) { endPos = i; break; }
  }
  const body = { type: 'root', children: children.slice(startPos + 1, endPos) } as Root;
  const content = unified().use(remarkStringify).stringify(body).trim().replace(/\n{3,}/g, '\n\n');
  if (!content) return null;

  const date = targetTitle.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] || null;
  return { version: targetVersion, title: targetTitle, date, content };
}
