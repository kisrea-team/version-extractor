// LLM 版本提取（低置信回退）：给候选清单 + 产品名，让纯文字模型找出当前版本。
// 依赖污染/版本线竞争（Obsidian 的 Mathjax、Surge 的 Ponte、MongoDB 的 mongosh 等）
// 打分模型分不开，纯文字 LLM 靠"完整页面 + 产品名"能区分。
//
// NVIDIA diffusiongemma-26b-a4b-it，多 key 每次调用轮换一个；一次不通立刻换 modelbest
// MiniCPM-V-4.6-1B 兜底。并行 12。
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { cleanWithTrafilatura } from './trafilatura';

const NV_BASE = 'https://integrate.api.nvidia.com/v1';
const NV_MODEL = process.env.NV_MODEL || 'google/diffusiongemma-26b-a4b-it';

// ⚠️ 2026-08-12 Resin 代理池限流解法: NVIDIA 按出口 IP+model 限流, 换 key 没用(IP 没变)。
// 限流/超时/失败 → 走 Resin 代理(http://Default.<account>:TOKEN@127.0.0.1:2260)换出口 IP。
// 每个 account 锚定不同健康节点 = 不同出口 IP(已验证: t1→18.180.61.65 JP, t3→东京)。
import { ProxyAgent } from 'undici';
const RESIN_TOKEN = (() => {
  try {
    return readFileSync(resolve(process.cwd(), '/root/resin/.env'), 'utf-8').match(/RESIN_PROXY_TOKEN=(\S+)/)?.[1] || '';
  } catch { return ''; }
})();
const RESIN_ACCOUNTS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];

// modelbest 回退（NVIDIA 超时/全失败时）：MiniCPM-V-4.6-1B 小且快，兜底不拖慢批量 eval
const MB_BASE = 'https://api.modelbest.cn/v1';
const MB_MODEL = 'MiniCPM-V-4.6-1B';

// ⚠️ 2026-08-14 Google AI Studio 兜底: env GOOGLE_AI_KEY 设置时优先于 NVIDIA
// 模型 gemma-4-26b-a4b-it (AI Studio 免费层, 限速严格 → 串行 + 间隔 1.2s)
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GOOGLE_MODEL = process.env.GOOGLE_LLM_MODEL || 'gemma-4-26b-a4b-it';

function loadGoogleKey(): string {
  if (process.env.GOOGLE_AI_KEY) return process.env.GOOGLE_AI_KEY.trim();
  try {
    const env = readFileSync(resolve(process.cwd(), 'data/google-ai-key.env'), 'utf-8');
    return env.match(/GOOGLE_AI_KEY=(\S+)/)?.[1] || '';
  } catch { return ''; }
}

let googleLastCall = 0;
async function callGoogle(prompt: string, timeout: number): Promise<string | null> {
  const key = loadGoogleKey();
  if (!key) return null;
  const wait = googleLastCall + 1200 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  googleLastCall = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(`${GOOGLE_BASE}/models/${GOOGLE_MODEL}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_MSG }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 150 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (process.env.DEBUG_LLM) console.error(`[llm-google] http-${res.status} ${Date.now() - t0}ms`);
      return null;
    }
    const j: any = await res.json();
    const answer = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
    if (process.env.DEBUG_LLM) console.error(`[llm-google] 成功 ${Date.now() - t0}ms answer="${(answer || '').replace(/\n/g, ' ').slice(0, 80)}"`);
    if (!answer) return null;
    return extractVersionFromLlmText(answer);
  } catch (e: any) {
    if (process.env.DEBUG_LLM) console.error(`[llm-google] ${String(e).slice(0, 60)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ⚠️ 2026-08-14 硅基流动 LLM: deepseek-ai/DeepSeek-V4-Flash (env LLM_PROVIDER=sf 时启用)
// key 复用 data/siliconflow-key.env 的 SILICONFLOW_KEY
const SF_BASE = 'https://api.siliconflow.cn/v1';
const SF_MODEL = process.env.SF_LLM_MODEL || 'deepseek-ai/DeepSeek-V4-Flash';

function loadSiliconflowKey(): string {
  if (process.env.SILICONFLOW_KEY) return process.env.SILICONFLOW_KEY.trim();
  try {
    const env = readFileSync(resolve(process.cwd(), 'data/siliconflow-key.env'), 'utf-8');
    return env.match(/SILICONFLOW_KEY=(\S+)/)?.[1] || '';
  } catch { return ''; }
}

async function callSiliconflow(prompt: string, timeout: number): Promise<string | null> {
  const key = loadSiliconflowKey();
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(`${SF_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: SF_MODEL,
        messages: [{ role: 'system', content: SYSTEM_MSG }, { role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (process.env.DEBUG_LLM) console.error(`[llm-sf] http-${res.status} ${Date.now() - t0}ms`);
      return null;
    }
    const j: any = await res.json();
    const answer = j.choices?.[0]?.message?.content || '';
    if (process.env.DEBUG_LLM) console.error(`[llm-sf] 成功 ${Date.now() - t0}ms answer="${(answer || '').replace(/\n/g, ' ').slice(0, 80)}"`);
    if (!answer) return null;
    return extractVersionFromLlmText(answer);
  } catch (e: any) {
    if (process.env.DEBUG_LLM) console.error(`[llm-sf] ${String(e).slice(0, 60)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function loadKeys(): string[] {
  const fromEnv = (process.env.NVIDIA_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  try {
    if (existsSync('data/nvidia-keys.json')) {
      const arr = JSON.parse(readFileSync('data/nvidia-keys.json', 'utf-8'));
      if (Array.isArray(arr) && arr.length) return arr.filter((k) => typeof k === 'string' && k.startsWith('nvapi-'));
    }
  } catch { /* ignore */ }
  return [];
}
let KEYS = loadKeys();
// 轮换改为随机起始(2026-08-12): 串行单测/多进程时每个进程 keyIndex=0 导致前几个 key 被反复打,
// 后 45 个 key 闲置 → 前几个 key 限流 429/503。随机起始让每次进程/调用从不同 key 开始。
let keyIndex = Math.floor(Math.random() * Math.max(KEYS.length, 1));
function nextKey(): string | null {
  if (KEYS.length === 0) return null;
  const k = KEYS[keyIndex % KEYS.length];
  keyIndex += 1;
  return k;
}

// modelbest key：env MODELBEST_KEY 或 data/modelbest-key.txt（gitignored，不提交）
function loadModelbestKey(): string {
  if (process.env.MODELBEST_KEY) return process.env.MODELBEST_KEY.trim();
  try { return readFileSync('data/modelbest-key.txt', 'utf-8').trim(); } catch { return ''; }
}

// 并行 12：批量 eval 并发跑，NVIDIA 一次不通立刻换 modelbest（小模型快），不靠串行拖稳定
const MAX_CONCURRENT = 12;
let llmInflight = 0;
const llmQueue: Array<() => void> = [];
async function acquireLlmSlot(): Promise<() => void> {
  if (llmInflight >= MAX_CONCURRENT) await new Promise<void>((resolve) => llmQueue.push(() => resolve()));
  llmInflight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    llmInflight -= 1;
    llmQueue.shift()?.();
  };
}

// 从 LLM 输出里提取版本号
// 模型回答常先复述候选清单("v5.64.396 [visible] ...")再给结论("答案是 5.23.1")。
// 取第一个版本号会抓到复述里的错误版本——应取【结论位置】的版本号:
//   ① 优先"答案/结论是"关键词后的版本
//   ② 否则取最后出现的版本号(模型惯例:结论在末尾)
export function extractVersionFromLlmText(answer: string): string | null {
  if (!answer) return null;
  const RE = /(?:v)?(\d+(?:\.\d+){1,3})/g;
  // ① 结论关键词后的版本号
  const conclusion = answer.match(/(?:答案|answer|conclusion|final|is|:)\s*(?:v)?(\d+(?:\.\d+){1,3})/i);
  if (conclusion) return 'v' + conclusion[1];
  // ② 最后出现的版本号
  const all = [...answer.matchAll(RE)];
  if (all.length === 0) return null;
  return 'v' + all[all.length - 1][1];
}

const SYSTEM_MSG = 'You extract the current version of a product from a page that may also mention dependencies/components ("updated Electron to X", "mongosh to X"), other products\' requirements ("version X or higher" after a list of app names), and old versions. Be careful: only return the target product\'s OWN current latest stable version. Return ONLY the version number.';

// 调 NVIDIA Nemotron：失败换 key 重试(translate_en.py 模式: 全局轮询, 每次调用换 key)。
// 限流(429/503)/超时/空内容/提取失败 → 换下一个 key 重试, 最多 MAX_ATTEMPTS 次, 全失败才交回 modelbest。
async function callNvidia(prompt: string, timeout: number): Promise<string | null> {
  const release = await acquireLlmSlot();
  try {
    const MAX_ATTEMPTS = 4;
    let lastErr = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const key = nextKey();
      if (!key) return null;
      // ⚠️ 2026-08-12 限流解法: attempt 0 直连试一次, 失败(限流/超时)后立即走 Resin 代理
      // (换 account=换出口 IP)。NVIDIA 按出口 IP+model 限流——直连换 key 无效, 必须换 IP;
      // ⚠️ 2026-08-13 修复: 之前 attempt 0-1 直连(两次等待), 限流时白等 2×超时。改为 attempt>=1 全走代理。
      const useProxy = attempt >= 1 && RESIN_TOKEN;
      let proxyAgent: InstanceType<typeof ProxyAgent> | null = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const t0 = Date.now();
      try {
        if (useProxy) {
          const acct = RESIN_ACCOUNTS[attempt % RESIN_ACCOUNTS.length];
          proxyAgent = new ProxyAgent(`http://Default.${acct}:${RESIN_TOKEN}@127.0.0.1:2260`);
          if (process.env.DEBUG_LLM) console.error(`[llm] attempt${attempt} 走代理 account=${acct} (换出口IP)`);
        }
        const res = await fetch(`${NV_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
          body: JSON.stringify({
            model: NV_MODEL,
            messages: [{ role: 'system', content: SYSTEM_MSG }, { role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 150, // ⚠️ 2026-08-12 200→150: 100 截断(v26.2 丢 .5), 200 够但生成慢; 150 平衡速度与完整性
            // diffusiongemma: 支持 thinkingConfig; MINIMAL = 最快(归属判断够用), 比 LOW 少思考 tokens
            // ⚠️ 其他模型(llama-3.1-8b 等)不支持 thinkingConfig, 参数会导致 400
            ...(NV_MODEL.includes('diffusiongemma') ? { thinkingConfig: { thinkingLevel: process.env.THINKING_LEVEL || 'MINIMAL' } } : {}),
        }),
          signal: controller.signal,
        });
        if (!res.ok) { lastErr = `http-${res.status}`; if (process.env.DEBUG_LLM) console.error(`[llm] attempt${attempt} key#${keyIndex - 1} http-${res.status} ${Date.now() - t0}ms`); continue; }
        const j: any = await res.json();
        const answer = j.choices?.[0]?.message?.content || '';
        if (process.env.DEBUG_LLM) {
          const u = j.usage || {};
          console.error(`[llm] attempt${attempt} 成功 ${Date.now() - t0}ms prompt_tokens=${u.prompt_tokens ?? '?'} completion_tokens=${u.completion_tokens ?? '?'} total=${u.total_tokens ?? '?'} answer="${(answer || '').replace(/\n/g, ' ').slice(0, 80)}"`);
        }
        if (!answer) { lastErr = 'empty'; continue; }
        const extracted = extractVersionFromLlmText(answer);
        if (extracted) return extracted;
        lastErr = 'extract-fail';
      } catch (e: any) {
        lastErr = e?.message?.slice(0, 60) || 'fetch-fail';
      } finally {
        clearTimeout(timer);
        if (proxyAgent) { try { proxyAgent.close(); } catch { /* 忽略 */ } }
      }
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); // 退避
    }
    return null; // 全部 key 失败 → 交回调用方换 modelbest
  } finally {
    release();
  }
}

// modelbest 兜底调用（单 key，OpenAI 兼容）；NVIDIA 超时/全失败时接住，不让批量 eval 被拖死
async function callModelbest(prompt: string, timeout: number): Promise<string | null> {
  const key = loadModelbestKey();
  if (!key) return null;
  const release = await acquireLlmSlot();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${MB_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MB_MODEL,
          messages: [{ role: 'system', content: SYSTEM_MSG }, { role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 200,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const j: any = await res.json();
      const answer = j.choices?.[0]?.message?.content || '';
      if (!answer) return null;
      return extractVersionFromLlmText(answer);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    release();
  }
}

export interface LlmCandidate { version: string; scopes?: string[]; contexts?: Array<{ text: string; scope: string }>; prob?: number; paths?: string[]; }
export async function extractVersionWithLlm(
  html: string,
  productName: string,
  opts: { timeout?: number; candidates?: LlmCandidate[]; seed?: string } = {}
): Promise<string | null> {
  if (KEYS.length === 0) return null;
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  let prompt: string;
  if (opts.candidates && opts.candidates.length > 0) {
    // 按版本号降序：修 MongoDB/禅道/Thunderbird（正确版本是数字最大的）。
    // 注意：依赖/组件版本往往数字更大反而排前面，所以提示词里明确"最上面不一定是产品版本"。
    const cv = (v: string) => v.replace(/^v/i, '').split('.').map(Number);
    // 传入的 candidates 已按归属强度排序(lgb-score.ts 的 llmOrdered: heading 3 + 产品名 2 + famMax 1)。
    // ⚠️ 不再内部重排! 否则 Lens Studio 的 v5.23.1(heading 证据, 排 #0)会被 llm.ts 的
    // "产品名共现+版本号降序"重排到后面, LLM 看不到强证据候选(v38 实测 heading 权重无效的根因)
    const ordered = [...opts.candidates];
    // 每个候选选"最强上下文"并截版本号周围窗口，让版本归属词可见：
    //   ① 含产品名的上下文（release 标题 "Windsurf v3.6.27 August 1"）优先；
    //   ② 否则标题/下载/结构化 scope；
    //   ③ 否则 contexts[0]。
    // 窗口含版本号前 40 字符——"Chromium: 138.0.7204" / "updated Electron to 37.6.0" 的归属词就在前文。
    const pickCtx = (c: LlmCandidate): string => {
      const product = productName.toLowerCase();
      const bare = c.version.replace(/^v/i, '');
      const texts = (c.contexts || []).map((x) => x.text.replace(/\s+/g, ' '));
      let t = texts.find((s) => s.toLowerCase().includes(product)) || '';
      if (!t) {
        const scoped = c.contexts?.find((x) => ['heading', 'download-link', 'title', 'structured'].includes(x.scope));
        if (scoped) t = scoped.text.replace(/\s+/g, ' ');
      }
      if (!t) t = texts[0] || '';
      const idx = t.indexOf(bare);
      if (idx < 0) return t.slice(0, 110);
      return t.slice(Math.max(0, idx - 40), Math.min(t.length, idx + 70));
    };
    const candList = ordered.slice(0, 40).map((c) => {
      const scope = c.scopes?.[0] || '';
      const isSeed = opts.seed && c.version === opts.seed;
      const paths = c.paths && c.paths.length ? c.paths.slice(0, 2).join(' | ') : '';
      const pathTag = paths ? ` <${paths}>` : '';
      return `- ${isSeed ? '★ ' : ''}${c.version} [${scope}]${pathTag} …${pickCtx(c)}…`;
    }).join('\n');
    if (process.env.DEBUG_LLM) console.error('[llm-cands]', candList);
    prompt = `Find ${productName}'s own current version.
Candidates are sorted by evidence strength (product-name mention, heading, download link) — the top ones are far more likely to be the answer.
The candidate marked ★ is the rank model's first choice. Prefer it unless the page clearly shows it is NOT the current version (e.g. it's a preview/beta/dev/build version, or another candidate is explicitly labeled as the current/stable version).
Lines where the version belongs to another product/component (Camera Kit, System Requirements, dependencies like "requires X or higher", "updated to X") are NOT ${productName}'s version. The numerically largest version is usually NOT the answer.
Each candidate shows its DOM structure path in <...>: h2/h3/li means a changelog/release heading, td/th means a compatibility-matrix cell (NOT the product's version), a means a link, p/strong means body text. Prefer candidates in h2/h3/li (declaration positions) over td (matrix) or a (generic link).
${candList}
${productName}'s version: `;
  } else {
    // 回退：Trafilatura 正文前段
    const text = (await cleanWithTrafilatura(html)) || '';
    const cleanText = text.replace(/\s+/g, ' ').trim();
    prompt = `Product: ${productName}\n\nPage title: ${title}\n\nThe content below is its changelog/release history (newest usually first). Find ${productName}'s OWN current latest stable version; ignore other components and "requires X or higher" mentions of other products. Return ONLY the version number.\n\nPage content:\n${cleanText.slice(0, 5000)}`;
  }
  // ⚠️ 2026-08-14 硅基流动优先(env LLM_PROVIDER=sf 时): deepseek-ai/DeepSeek-V4-Flash
  if (process.env.LLM_PROVIDER === 'sf') {
    const sv = await callSiliconflow(prompt, opts.timeout || 20000);
    if (sv) return sv;
  }
  // ⚠️ 2026-08-14 Google 优先(配了 GOOGLE_AI_KEY 时): gemma-4-26b-a4b-it 串行限速,
  // 失败(限流/超时)才回退 NVIDIA(多 key+resin 代理)
  if (loadGoogleKey()) {
    const gv = await callGoogle(prompt, opts.timeout || 20000);
    if (gv) return gv;
  }
  // NVIDIA 失败(429/500/空内容/超时)直接返回 null, 不再调 modelbest 兜底(2026-08-13)
  try {
    return await callNvidia(prompt, opts.timeout || 20000);
  } catch {
    return null;
  }
}
