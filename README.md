# version-extractor (VE)

从软件官网 / 包注册表 / GitHub / App Store 提取「当前稳定版本号 + 更新日志」的生产级提取器。

**核心思路**：版本选择不是"找一个更强的正则/LLM"，而是**失败模式驱动的分层决策管线** —— 确定性源（注册表 / 官方端点）命中即答案，学习型排序器（LightGBM 隐式净化 + LambdaRank 页内排序）处理 HTML 长尾，LLM 仅在排序模型摇摆时做最后裁决（不到 20% 查询）。

> 📄 设计原理与实证评估见论文：**[《我们何时知道一个软件版本才是"那个"版本？》](docs/paper.md)** —— 含三个设计原理（分层确定性 / 学习型隐式净化 / LLM 克制调用）、10 类噪声形态学、15 组排序特征推导、标注体系与失败案例分析。

## 效果

| 配置 | 准确率 | 说明 |
|---|---|---|
| 最大版本号启发式（净化后数值最大） | 44.8% | 历史 29 例集（对照） |
| 纯结构规则（簇内最大 + 位置最早） | 75.0% | 历史 76 例集（对照） |
| **完整管线 + NVIDIA LLM** | **70.9%** | 当前 55 例独立验证集 |
| **完整管线 + DeepSeek-V4 + reranker** | **74.5%** | 当前 55 例独立验证集 |

- LLM 兜底在干净基准上贡献 **+17.3%**（纯模型 65.5% → 完整链路 82.8%），但调用占比不到 20%
- 失败主导因素是**页面根本不声明版本**（营销页 / JS-only SPA / 博客式 what's new）—— 信息论极限，任何提取器都无法回答

## 架构：确定性优先，逐级兜底

```
① 包注册表（winget / Homebrew / Flathub / npm / Go proxy）  ← 版本是命名字段，命中即确定性
② 官方端点（GitHub Releases API / iTunes lookup / 官方 JSON / RSS）
③ HTML 层：
     多 scope 候选采集（title/meta/heading/visible/download-link/structured/noise）
     → LightGBM 过滤（37 特征：版本结构 + scope + BERT 概率，隐式净化）
     → LambdaRank 页内排序（15 组特征：结构 / scope 锚定 / 序列家族 / 页面类型）
     → 同-major 家族锚定（前缀归族，族内取最大，防跨 major 跳跃）
④ LLM 兜底（rank margin < 0.5 / 通道冲突 / p12 差异时触发）：
     NVIDIA diffusiongemma-26b 多 key 轮询 + Resin 代理换 IP
     → 可选 DeepSeek-V4-Flash（硅基流动）→ 可选 Google gemma（AI Studio），env 开关
⑤ changelog 提取：版本锚定 + Trafilatura 清洗 + 结构质量门控（JSON dump/数字 dump/导航拦截）
```

**核心思想**：

1. **真实版本号会反复出现** —— 标题、meta、下载链接、正文多处；垃圾版本（JS 资产/构建号）只出现一次、不在下载链接里。
2. **版本选择靠结构，不靠名字** —— rank 学的是「最新 release 标题 / 产品名锚点 / 版本序列最新端 / 下载链接」这类跨站可迁移的信号；词表只作有界硬过滤。
3. **噪声与真版本在形式上不可分**（SVG 坐标、统计数字）→ 净化必须学习型，手工规则有边际天花板。
4. **LLM 只救长尾** —— 低 margin 才咨询，候选清单 + 产品名给足上下文。
5. **每次提取都带置信度** —— 高置信免 LLM；低置信升级 LLM / 浏览器。

## 使用

```bash
npm install
npx playwright install chromium      # 首次（JS 渲染兜底）
python -m pip install trafilatura     # changelog 正文清洗

# 单 URL：获取版本号 + 最新日志
npx tsx scripts/probe.ts <url>       # 或 npm run probe -- <url>

# 基准测试（55 例独立验证集，并行 12，含 LLM 准确性报告）
BENCH_CACHE_DIR=.bench-cache npm run bench:cases

# 700 训练集 changelog 批量评估
npx tsx scripts/eval-changelog-700.ts
```

单入口 `extractFromUrl(url)` 一次返回 `{ version, changelog }`：

```ts
import { extractFromUrl } from './src/pipeline';
const out = await extractFromUrl('https://www.python.org/news/', { token: '' });
out.version    // { version: 'v3.15.0', source, confidence }
out.changelog  // { version: 'v3.15.0', content: '...', date }
```

### 提取示例（真实案例）

**Bandizip 官网**（`https://en.bandisoft.com/bandizip/`）—— 页面同时含 Windows 8.1 系统要求、文件格式列表和一句 "Latest version: v7.45" 声明。噪声候选（v8.1/v1.0）分高，真版本 v7.45 分最低：

```json
POST /extract  {"url": "https://en.bandisoft.com/bandizip/", "fields": ["version"], "productName": "Bandizip"}
```

```json
{
  "url": "https://en.bandisoft.com/bandizip/",
  "elapsedMs": 6200,
  "version": {
    "version": "v7.45",
    "source": "visible",
    "confidence": "high",
    "candidates": [
      { "version": "v8.1",  "score": 78, "scope": "visible", "inDownloadUrl": false },
      { "version": "v1.0",  "score": 71, "scope": "visible", "inDownloadUrl": false },
      { "version": "v7.45", "score": 11, "scope": "visible", "inDownloadUrl": false }
    ]
  }
}
```

内部链路：rank 选出 seed v8.1（噪声）→ **Qwen3-Reranker 把 v7.45 顶到第一**（0.76 vs 0.01，读懂了 "Latest version:" 硬声明）→ ★ 标记跟随 → LLM（DeepSeek-V4-Flash）裁决答 v7.45。这就是论文里"候选显著性 > 阅读理解"的活例。

## HTTP API / Docker 部署

常驻 HTTP API，可只返回版本号、只返回日志，或两者都要。服务复用 Playwright 浏览器实例。

```bash
# 本地运行
npm run serve

# Docker 构建与启动
docker build -t version-extractor .
docker run --rm -p 3000:3000 version-extractor
```

### `POST /extract`

```json
{ "url": "https://www.python.org/downloads/", "fields": ["version", "changelog"] }
```

`fields` 可选 `version` / `changelog`；不传默认全部。返回：

```json
{
  "url": "https://www.python.org/downloads/",
  "elapsedMs": 1200,
  "version": { "version": "v3.14.6", "source": "official-endpoint", "confidence": "high" },
  "changelog": null
}
```

`GET /health` 返回服务状态。环境变量：`PORT`（3000）、`MAX_CONCURRENT`（2）、`EXTRACT_TIMEOUT_MS`（90000）、`GITHUB_TOKEN`、`AUDIT_DB`、`NVIDIA_KEYS` / `MODELBEST_KEY` / `GOOGLE_AI_KEY` / `SILICONFLOW_KEY`（LLM key，也可放 gitignored 文件）、`LLM_PROVIDER`（`nvidia` 默认 / `sf` DeepSeek 硅基流动）。对外暴露应在反向代理层加鉴权限流；服务拒绝本机/私网目标。

## 基准与数据集

- **`benchmark/bench-hard-fixed.json`（58 例）**：当前权威基准 —— 独立验证期望值 + 移除 SaaS 无版本类。成绩：NVIDIA 70.9% / DeepSeek+reranker 74.5%（55 例匹配集）。
- **`benchmark/bench-new30.json`（30 例）**：官网/changelog 基准，fastCRW render_js 渲染抓取。历史成绩：26/30 = 87% → 28/30 = 93%（带 latest 特征）。
- **`benchmark/ve-benchmark-all.json`（362 例）**：全面验证语料（GitHub 101 例全部通过 releases API 复核）。
- **`data/ds700-clean/`（533 条候选）**：训练数据 —— 四标签标注（current/historical/non/ambiguous）+ 十类噪声，防泄漏分组。

**成绩记录口径**：`--no-registry` + `FETCHER=fastcrw` + `render_js:true`；判定为 `vX` 前缀匹配；缓存 `.bench-cache/` 使改模型重跑不重新抓页。

**关键方法论**：
1. **时间对齐**：快照标注只能用快照时点的版本验证，不能用今天的版本改。
2. **官方源可能误导**：官网常列 dev/beta 版（Inkscape 官网有 1.5 dev，稳定版是 1.4.4），必须以权威第三方 + 多源交叉为准。
3. **页面无版本是常态**：约 20% 官网（营销页/博客列表页/登录页）确实没有版本号，属信息论极限，应从基准剔除而非优化。

## 审计（可查询的决策记录）

每次提取把决策过程落 SQLite（`data/audit.db`，Node 内置 `node:sqlite`，零依赖）：页面 HTML、候选 + 上下文、rank seed/margin、LLM 是否触发及答案、最终版本/置信度/来源。

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/audit.db');
d.prepare('SELECT url,finalVersion,llmTriggered,llmAnswer FROM extractions WHERE llmTriggered=1').all()"
```

环境变量：`AUDIT_DB`（默认 `data/audit.db`，空串关闭）。

## 模块

```
src/
├── registries.ts       包注册表：winget manifest / brew / flathub / npm / go.dev
├── version-extract.ts  版本号提取：启发式 + 版本序列检测 + 置信度
├── lgb-score.ts        LightGBM 过滤 + LambdaRank 排序 + seed-anchored 归族 + LLM 触发
├── llm.ts              LLM 兜底：NVIDIA diffusiongemma 多 key + DeepSeek/Google 开关，并行 12
├── reranker.ts         Qwen3-Reranker-8B 候选重排（★ 语义接管，Bandizip 类修复）
├── audit.ts            请求级审计：决策过程落 SQLite
├── changelog.ts        更新日志提取：GitHub / RSS / 纯文本 / 列表跟随 / 质量门控
├── changelog-lgb.ts    changelog 页主路径：Trafilatura 清洗 + 版本选择
├── sources.ts          更新源识别（含 npm registry 等 JSON 端点分类）
├── pipeline.ts         高层管道：注册表 → HTML → LGB → LLM → 浏览器渲染 → 日志
├── crawler.ts          抓取层：UA 轮换 + TLS 指纹 + 重试 + 磁盘缓存 + Playwright 渲染
└── types.ts            共享类型
```

## 已知边界（诚实记录）

- **依赖/组件版本压过产品**：页面出现 Chromium/Electron/其他库的更高版本时，rank 可能选错；margin 盲区（自信选错）不会触发 LLM。
- **深 JS 渲染站 / SPA**：版本常藏在接口/运行时态里 → 由 L2 网络拦截解决；个别站即使渲染也难提取。
- **changelog 页版本只在 JS 接口/下载文件名里**（如 notion）：需 L2 浏览器 + 下载文件名提取。
- **多版本线语义**（Node.js LTS vs Latest、RoboForm 主程序 vs 扩展、stable vs beta）：判别信息在上下文里，但 15 特征排序器学不到，属模型边界（论文 §6）。
- **非 GitHub / 无 RSS 的长尾站日志提取**仍是弱环节。

## 论文

**[《我们何时知道一个软件版本才是"那个"版本？—— 版本选择问题的失败模式驱动设计》](docs/paper.md)**

三个设计原理 + 失败案例分析：
1. **分层确定性**（P1）：版本是命名字段时就别猜（注册表/官方端点短路）
2. **学习型隐式净化**（P2）：噪声与真版本形式上不可分 → 净化必须学习型
3. **LLM 克制调用**（P3）：触发策略比模型选择重要（83% 页面模型结论一致，瓶颈是候选显著性）

含 10 类噪声形态学、15 组排序特征推导、四标签标注体系、55 例独立验证基准与失败归因。

## License

[GNU General Public License v3.0](LICENSE) — 自由软件，允许再分发与修改，但衍生作品必须同样以 GPL 发布。

Copyright (C) 2026 kisrea-team
