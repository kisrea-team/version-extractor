// LLM 版本提取（低置信回退）：给足够页面语境 + 产品名，让纯文字模型找出当前版本。
// 依赖污染/版本线竞争（Obsidian 的 Mathjax、Surge 的 Ponte、MongoDB 的 mongosh 等）
// 打分模型分不开，纯文字 LLM 靠"完整页面 + 产品名"能区分。
import { cleanWithTrafilatura } from './trafilatura';

const NV_BASE = 'https://integrate.api.nvidia.com/v1';
const NV_MODEL = 'google/diffusiongemma-26b-a4b-it';

function nvKey(): string {
  return process.env.NVIDIA_API_KEY || process.env.NV_API_KEY || '';
}

// ── 令牌桶限流：NVIDIA 上限 40 rpm，留 12.5% 余量 → 35/min，防 429 与并发堆积 ──
const RATE_PER_MIN = Number(process.env.LLM_RATE_PER_MIN || 35);
let rateTokens = RATE_PER_MIN;
let rateLastRefill = Date.now();
async function waitForRateToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    rateTokens = Math.min(RATE_PER_MIN, rateTokens + ((now - rateLastRefill) / 60000) * RATE_PER_MIN);
    rateLastRefill = now;
    if (rateTokens >= 1) { rateTokens -= 1; return; }
    await new Promise((r) => setTimeout(r, 2500));
  }
}
// 并发信号量：最多 4 个 LLM 调用同时进行（eval 并发 12 时防止 NVIDIA 连接堆积挂起）
const MAX_CONCURRENT = Number(process.env.LLM_MAX_CONCURRENT || 4);
let llmInflight = 0;
const llmQueue: Array<() => void> = [];
async function acquireLlmSlot(): Promise<() => void> {
  if (llmInflight >= MAX_CONCURRENT) await new Promise((r) => llmQueue.push(r));
  llmInflight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    llmInflight -= 1;
    llmQueue.shift()?.();
  };
}

// 从 LLM 输出里提取版本号（容忍 "v1.2.3" / "1.2.3" / 前后有解释文字）
export function extractVersionFromLlmText(answer: string): string | null {
  if (!answer) return null;
  const m = answer.match(/(?:v)?(\d+(?:\.\d+){1,3})/);
  if (!m) return null;
  return 'v' + m[1];
}

// 触发条件由调用方决定（rank margin 低等）。这里只负责：Trafilatura 抽正文 → LLM → 版本号。
export async function extractVersionWithLlm(
  html: string,
  productName: string,
  opts: { timeout?: number; apiKey?: string } = {}
): Promise<string | null> {
  const key = opts.apiKey || nvKey();
  if (!key) return null;
  // 1. Trafilatura 抽可读正文（版本列表页最新版通常在前）
  const text = (await cleanWithTrafilatura(html)) || '';
  const cleanText = text.replace(/\s+/g, ' ').trim();
  // 2. 拼 prompt：产品名 + 标题 + 正文前段
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const prompt = `Product: ${productName}\n\nPage title: ${title}\n\nThe content below is its changelog/release history (newest usually first). Find ${productName}'s OWN current latest stable version; ignore other components and "requires X or higher" mentions of other products. Return ONLY the version number.\n\nPage content:\n${cleanText.slice(0, 5000)}`;
  // 3. 调 NVIDIA diffusiongemma（先限流 + 取并发槽）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 60000);
  await waitForRateToken();
  const release = await acquireLlmSlot();
  try {
    const res = await fetch(`${NV_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: NV_MODEL,
        messages: [
          { role: 'system', content: 'Extract the product\'s own current version. Ignore dependencies/components and "requires X or higher" mentions. Return ONLY the version number.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const answer = j.choices?.[0]?.message?.content || '';
    return extractVersionFromLlmText(answer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    release();
  }
}
