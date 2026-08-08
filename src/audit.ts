// 请求级提取审计：把每次版本提取的决策过程落库（SQLite），便于 API 调取排查
// （页面 HTML、候选+上下文、rank seed/margin、LLM 选择、最终结果）。
// 候选/上下文与训练集同源（collectCandidates），可直接对照训练数据看模型喂了什么。
// 用 node:sqlite（Node 22.5+ 内置，Docker 镜像 Node 22 需 NODE_OPTIONS=--experimental-sqlite）。
// AUDIT_DB：默认 data/audit.db；设为空串可关闭。每 URL 一行（重复提取覆盖），候选/上下文入库。
import { mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname } from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.AUDIT_DB === undefined ? 'data/audit.db' : process.env.AUDIT_DB;
let db: DatabaseSync | null = null;

export interface AuditCandidate {
  version: string;
  scopes: string[];
  contexts: Array<{ scope: string; text: string }>;
  tag?: string | null;
  paths?: string[];
  prob?: number | null;
  isSeed?: boolean; // rank seed
}

export interface AuditDecision {
  productName?: string | null;
  filterThreshold: number;
  candidates: AuditCandidate[];
  rank?: { seed: string | null; margin: number | null; strong: boolean | null } | null;
  llm?: { triggered: boolean; margin: number | null; answer: string | null } | null;
  final: { version: string | null; confidence: string; source: string | null; suggestedRegex?: string | null };
}

export interface AuditEntry extends AuditDecision {
  ts: string;
  url: string;
  htmlLength: number;
  html: string;
}

function openDb(): DatabaseSync | null {
  if (!DB_PATH) return null;
  if (db) return db;
  try {
    mkdirSync(dirname(DB_PATH) || '.', { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS extractions (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL, ts TEXT NOT NULL, productName TEXT,
        htmlLength INTEGER, html TEXT, filterThreshold REAL,
        rankSeed TEXT, rankMargin REAL, rankStrong INTEGER,
        llmTriggered INTEGER, llmMargin REAL, llmAnswer TEXT,
        finalVersion TEXT, finalConfidence TEXT, finalSource TEXT, suggestedRegex TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_url ON extractions(url);
      CREATE INDEX IF NOT EXISTS idx_final ON extractions(finalVersion);
      CREATE INDEX IF NOT EXISTS idx_llm ON extractions(llmTriggered, llmAnswer);
      CREATE TABLE IF NOT EXISTS candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        extractionId TEXT NOT NULL REFERENCES extractions(id),
        version TEXT NOT NULL, scopes TEXT, tag TEXT, prob REAL, isSeed INTEGER, contexts TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cand_ext ON candidates(extractionId);
      CREATE INDEX IF NOT EXISTS idx_cand_ver ON candidates(version);
    `);
    return db;
  } catch (e) {
    console.error('[audit] 打开审计库失败:', (e as Error).message);
    return null;
  }
}

export function recordAudit(entry: AuditEntry): void {
  const d = openDb();
  if (!d) return;
  try {
    const id = createHash('sha1').update(entry.url).digest('hex').slice(0, 24);
    const up = d.prepare(`INSERT INTO extractions (id,url,ts,productName,htmlLength,html,filterThreshold,rankSeed,rankMargin,rankStrong,llmTriggered,llmMargin,llmAnswer,finalVersion,finalConfidence,finalSource,suggestedRegex)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, productName=excluded.productName, htmlLength=excluded.htmlLength, html=excluded.html,
        filterThreshold=excluded.filterThreshold, rankSeed=excluded.rankSeed, rankMargin=excluded.rankMargin, rankStrong=excluded.rankStrong,
        llmTriggered=excluded.llmTriggered, llmMargin=excluded.llmMargin, llmAnswer=excluded.llmAnswer,
        finalVersion=excluded.finalVersion, finalConfidence=excluded.finalConfidence, finalSource=excluded.finalSource, suggestedRegex=excluded.suggestedRegex`);
    up.run(
      id, entry.url, entry.ts, entry.productName || null, entry.htmlLength, entry.html, entry.filterThreshold,
      entry.rank?.seed ?? null, entry.rank?.margin ?? null, entry.rank?.strong == null ? null : (entry.rank.strong ? 1 : 0),
      entry.llm?.triggered ? 1 : 0, entry.llm?.margin ?? null, entry.llm?.answer ?? null,
      entry.final.version, entry.final.confidence, entry.final.source, entry.final.suggestedRegex ?? null,
    );
    d.prepare('DELETE FROM candidates WHERE extractionId = ?').run(id);
    const ci = d.prepare('INSERT INTO candidates (extractionId, version, scopes, tag, prob, isSeed, contexts) VALUES (?,?,?,?,?,?,?)');
    for (const c of entry.candidates) {
      ci.run(id, c.version, JSON.stringify(c.scopes || []), c.tag || null, c.prob ?? null, c.isSeed ? 1 : 0, JSON.stringify(c.contexts || []));
    }
  } catch (e) {
    console.error('[audit] 写入失败:', (e as Error).message);
  }
}
