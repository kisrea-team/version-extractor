// Reranker 客户端: 产品名 query + 候选文档 → 归属分数
//
// ⚠️ 2026-08-14 切换 tumuer router 的 Qwen/Qwen3-Reranker-8B:
//   bge-reranker-v2-m3 在 Bandizip(Windows 8.1 噪声 vs "Latest version: v7.45" 硬声明)上排错,
//   Qwen3-Reranker-8B 正确把 v7.45 顶到第一(0.84 vs 0.09/0.01) → 喂 LLM 答对 v7.45
//   端点: https://router.tumuer.me/v1/rerank (openai 兼容, 浏览器 UA 过 Cloudflare)
//   回退: 硅基流动 bge-reranker-v2-m3

import { readFileSync } from 'fs';
import { resolve } from 'path';

const TUMUER_BASE = 'https://router.tumuer.me/v1';
const TUMUER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function loadConfig(): { key: string; model: string; base: string } {
  // tumuer router key 优先 (data/tumuer-key.env)
  try {
    const env = readFileSync(resolve(process.cwd(), 'data/tumuer-key.env'), 'utf-8');
    const tkey = env.match(/TUMUER_KEY=(\S+)/)?.[1] || '';
    const tmodel = env.match(/TUMUER_RERANKER=(\S+)/)?.[1] || 'Qwen/Qwen3-Reranker-8B';
    if (tkey) return { key: tkey, model: tmodel, base: TUMUER_BASE };
  } catch { /* fallthrough */ }
  // 回退: 硅基流动 bge
  try {
    const env = readFileSync(resolve(process.cwd(), 'data/siliconflow-key.env'), 'utf-8');
    const key = env.match(/SILICONFLOW_KEY=(\S+)/)?.[1] || '';
    const model = env.match(/SILICONFLOW_RERANKER=(\S+)/)?.[1] || 'Pro/BAAI/bge-reranker-v2-m3';
    return { key, model, base: 'https://api.siliconflow.cn/v1' };
  } catch {
    return { key: process.env.SILICONFLOW_KEY || '', model: 'Pro/BAAI/bge-reranker-v2-m3', base: 'https://api.siliconflow.cn/v1' };
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
  const { key, model, base } = loadConfig();
  if (!key) return [];
  // 候选上下文精简: 取版本号附近文本(前 60 后 40, 避免把别的版本/系统要求拉进来)
  // Termius 案例 v16.04 上下文 "Ubuntu 16.04 or later" + 附近 "9.43.0" 混在一起, 取全上下文会被骗
  const docs = candidates.map((c) => {
    const idx = c.context.indexOf(c.version.replace(/^v/i, ''));
    const win = idx >= 0 ? c.context.slice(Math.max(0, idx - 40), idx + 60) : c.context.slice(0, 100);
    return `[${c.version}] ${win}`;
  });
  // ⚠️ query 回退 "latest stable version"(2026-08-12): "download version" 改动影响 LLM 争议集排序,
  // v52 测试显示旧25 60% 与禁语义门无关——嫌疑是 query 改动。回退验证。
  const query = `${productName} latest stable version`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (base === TUMUER_BASE) headers['User-Agent'] = TUMUER_UA; // tumuer 需浏览器 UA 过 Cloudflare
  try {
    const t0 = Date.now();
    const resp = await fetch(`${base}/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, query, documents: docs, top_n: docs.length }),
      signal: AbortSignal.timeout(opts.timeout || 10000),
    });
    if (!resp.ok) {
      if (process.env.DEBUG_LLM) console.error(`[rerank] http-${resp.status} ${Date.now() - t0}ms (${docs.length} docs)`);
      return [];
    }
    const data: any = await resp.json();
    const results: RerankItem[] = data?.results || [];
    if (process.env.DEBUG_LLM) console.error(`[rerank] 成功 ${Date.now() - t0}ms: ${results.map((r) => `${r.index}:${r.relevance_score.toFixed(3)}`).join(' ')}`);
    return results.map((r) => ({ index: r.index, score: r.relevance_score }));
  } catch (e: any) {
    if (process.env.DEBUG_LLM) console.error(`[rerank] 失败 ${String(e).slice(0, 60)}`);
    return []; // reranker 失败 → 调用方回退原逻辑
  }
}
