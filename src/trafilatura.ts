// Trafilatura 正文清洗（TS 侧统一入口）
//
// 调用 scripts/trafilatura_clean.py（Python）把 HTML 整页/区块清洗成干净 Markdown。
// 结构无关：不猜 changelog 容器，交给成熟正文提取算法。
import { spawn, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';

// 探测可用的 python 命令：容器/裸机环境可能只有 python3 或 python（Debian slim 无 python 别名）
const PYTHON_BIN = (() => {
  for (const cand of ['python3', 'python']) {
    try {
      const r = spawnSync(cand, ['-c', 'import trafilatura; print(trafilatura.__version__)'], { timeout: 10000 });
      if (r.status === 0) return cand;
    } catch { /* 尝试下一个 */ }
  }
  return 'python3'; // 默认兜底，运行时失败会在调用处静默降级
})();

// 调用 Python Trafilatura 清洗 HTML → Markdown（干净正文，无导航/残片/版权）
export async function cleanWithTrafilatura(html: string, opts: { precision?: boolean; recall?: boolean } = {}): Promise<string | null> {
  const f = join(tmpdir(), `chg-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(f, html, 'utf-8');
  // tsx ESM 下 __dirname 不可用，用 process.cwd()（脚本需从项目根目录运行）
  const script = join(process.cwd(), 'scripts', 'trafilatura_clean.py');
  const args = [script, f, '--format', 'markdown'];
  if (opts.precision) args.push('--precision');
  if (opts.recall) args.push('--recall');
  return new Promise<string | null>((resolve) => {
    const child = spawn(PYTHON_BIN, args, { windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 20000);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const out = stdout.trim();
      resolve(out || null);
    });
  }).finally(async () => {
    try { unlinkSync(f); } catch { /* ignore */ }
  });
}
