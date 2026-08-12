// 硅基流动 reranker 客户端: 产品名 query + 候选文档 → 归属分数
// 用 Pro/BAAI/bge-reranker-v2-m3, key 从 data/siliconflow-key.env 读

import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadKey(): { key: string; model: string } {
  try {
    const env = readFileSync(resolve(process.cwd(), 'data/siliconflow-key.env'), 'utf-8');
    const key = env.match(/SILICONFLOW_KEY=(\S+)/)?.[1] || '';
    const model = env.match(/SILICONFLOW_RERANKER=(\S+)/)?.[1] || 'Pro/BAAI/bge-reranker-v2-m3';
    return { key, model };
  } catch {
    return { key: process.env.SILICONFLOW_KEY || '', model: process.env.SILICONFLOW_RERANKER || 'Pro/BAAI/bge-reranker-v2-m3' };
  }
}

export interface RerankItem {
  index: number;
  relevance_score: number;
}

// 批量 rerank: query=产品名(拼接页面标题语义), documents=候选上下文
// 返回 Map<候选索引, score>
export async function rerankProductVersions(
  productName: string,
  candidates: { version: string; context: string }[],
  opts: { timeout?: number } = {}
): Promise<{ index: number; score: number }[]> {
  if (candidates.length === 0) return [];
  const { key, model } = loadKey();
  if (!key) return [];
  // 候选上下文精简: 取版本号附近文本(前 60 后 40, 避免把别的版本/系统要求拉进来)
  // Termius 案例 v16.04 上下文 "Ubuntu 16.04 or later" + 附近 "9.43.0" 混在一起, 取全上下文会被骗
  const docs = candidates.map((c) => {
    const idx = c.context.indexOf(c.version.replace(/^v/i, ''));
    const base = idx >= 0 ? c.context.slice(Math.max(0, idx - 40), idx + 60) : c.context.slice(0, 100);
    return `[${c.version}] ${base}`;
  });
  // ⚠️ query 回退 "latest stable version"(2026-08-12): "download version" 改动影响 LLM 争议集排序,
  // v52 测试显示旧25 60% 与禁语义门无关——嫌疑是 query 改动。回退验证。
  const query = `${productName} latest stable version`;
  try {
    const resp = await fetch('https://api.siliconflow.cn/v1/rerank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, query, documents: docs, top_n: docs.length }),
      signal: AbortSignal.timeout(opts.timeout || 5000),
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    const results: RerankItem[] = data?.results || [];
    return results.map((r) => ({ index: r.index, score: r.relevance_score }));
  } catch {
    return []; // reranker 失败 → 调用方回退原逻辑
  }
}
