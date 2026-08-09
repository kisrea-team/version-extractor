// LLM 版本提取（低置信回退）：给候选清单 + 产品名，让纯文字模型找出当前版本。
// 依赖污染/版本线竞争（Obsidian 的 Mathjax、Surge 的 Ponte、MongoDB 的 mongosh 等）
// 打分模型分不开，纯文字 LLM 靠"完整页面 + 产品名"能区分。
//
// NVIDIA diffusiongemma-26b-a4b-it，多 key 每次调用轮换一个；一次不通立刻换 modelbest
// MiniCPM-V-4.6-1B 兜底。并行 12。
import { readFileSync, existsSync } from 'fs';
import { cleanWithTrafilatura } from './trafilatura';

const NV_BASE = 'https://integrate.api.nvidia.com/v1';
const NV_MODEL = 'google/diffusiongemma-26b-a4b-it';

// modelbest 回退（NVIDIA 超时/全失败时）：MiniCPM-V-4.6-1B 小且快，兜底不拖慢批量 eval
const MB_BASE = 'https://api.modelbest.cn/v1';
const MB_MODEL = 'MiniCPM-V-4.6-1B';

// 多 key 轮询池：从 env NVIDIA_KEYS（逗号分隔）或本地 gitignored 文件读取
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
let keyIndex = 0;
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
export function extractVersionFromLlmText(answer: string): string | null {
  if (!answer) return null;
  const m = answer.match(/(?:v)?(\d+(?:\.\d+){1,3})/);
  if (!m) return null;
  return 'v' + m[1];
}

const SYSTEM_MSG = 'You extract the current version of a product from a page that may also mention dependencies/components ("updated Electron to X", "mongosh to X"), other products\' requirements ("version X or higher" after a list of app names), and old versions. Be careful: only return the target product\'s OWN current latest stable version. Return ONLY the version number.';

// 调 NVIDIA diffusiongemma：单次尝试，一次不通（429/错误/空内容/超时）立刻交回调用方换 modelbest。
// key 轮询 = 每次【调用】首次访问用不同 key（nextKey 跨调用轮换），不在单次调用内换 key 重试。
async function callNvidia(prompt: string, timeout: number): Promise<string | null> {
  const release = await acquireLlmSlot();
  try {
    const key = nextKey();
    if (!key) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${NV_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: NV_MODEL,
          messages: [{ role: 'system', content: SYSTEM_MSG }, { role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 200,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null; // 429/403/500 → 一次不通，交回调用方换 modelbest
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

export interface LlmCandidate { version: string; scopes?: string[]; contexts?: Array<{ text: string; scope: string }>; prob?: number; }
export async function extractVersionWithLlm(
  html: string,
  productName: string,
  opts: { timeout?: number; candidates?: LlmCandidate[] } = {}
): Promise<string | null> {
  if (KEYS.length === 0) return null;
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  let prompt: string;
  if (opts.candidates && opts.candidates.length > 0) {
    // 按版本号降序：修 MongoDB/禅道/Thunderbird（正确版本是数字最大的）。
    // 注意：依赖/组件版本往往数字更大反而排前面，所以提示词里明确"最上面不一定是产品版本"。
    const cv = (v: string) => v.replace(/^v/i, '').split('.').map(Number);
    const ordered = [...opts.candidates].sort((a, b) => {
      const x = cv(a.version), y = cv(b.version);
      for (let i = 0; i < 4; i += 1) {
        const xi = x[i] || 0, yi = y[i] || 0;
        if (xi !== yi) return yi - xi;
      }
      return 0;
    });
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
      return `- ${c.version} [${scope}] …${pickCtx(c)}…`;
    }).join('\n');
    prompt = `Product: ${productName}\n\nPage title: ${title}\n\nVersion-like numbers found on the page (ordered by version number — NOT by what is newest for the product):\n${candList}\n\nEach line shows the text around that number. The number belongs to whoever the text names right before it: "Chromium: 138.0.7204" means 138.0.7204 is the Chromium version; "updated Electron to 37.6.0" means 37.6.0 is Electron's; "requires HelperApp 7.1 or higher" means 7.1 is HelperApp's. These component/OS/library versions are often numerically LARGER than the product's own version, so the largest number is usually NOT the answer.\n${productName}'s OWN current version is the one attached to "${productName}": it appears in a release title/heading (like "${productName} X.Y.Z" or "Version X.Y.Z"), in a download link, or as the newest entry of ${productName}'s version list. Return ONLY ${productName}'s own current latest stable version as a number.`;
  } else {
    // 回退：Trafilatura 正文前段
    const text = (await cleanWithTrafilatura(html)) || '';
    const cleanText = text.replace(/\s+/g, ' ').trim();
    prompt = `Product: ${productName}\n\nPage title: ${title}\n\nThe content below is its changelog/release history (newest usually first). Find ${productName}'s OWN current latest stable version; ignore other components and "requires X or higher" mentions of other products. Return ONLY the version number.\n\nPage content:\n${cleanText.slice(0, 5000)}`;
  }
  // NVIDIA 一次不通（429/500/空内容）或超时 → 立刻换 modelbest 兜底
  try {
    const v = await callNvidia(prompt, opts.timeout || 60000);
    if (v) return v;
  } catch { /* 超时/网络异常 → 换 modelbest */ }
  try {
    return await callModelbest(prompt, opts.timeout || 60000);
  } catch {
    return null;
  }
}
