# 软件更新数据提取（规则化为主，LLM 对长尾兜底）

从软件官网 / 包注册表 / GitHub 提取「最新版本号 + 更新日志」。确定性规则优先（注册表 / 官方端点 / GitHub API / 启发式），LightGBM 筛选候选，LambdaRank 页面内排序选种子，纯文字 LLM 仅对低置信长尾兜底。

## 架构：确定性优先，逐级兜底

```
① 包注册表（winget / Homebrew / Flathub）   ← 版本是命名字段，命中即确定性
② GitHub API（release / tag）                ← 权威
③ 官方 RSS / JSON 更新清单（latest.json 等）
④ L1 静态 HTML：
     候选收集（多 scope 上下文）→ LightGBM 过滤 → LambdaRank 页内排序（seed）
     → 同-major 归族确认版本线 → 预发布感知取最新端
⑤ LLM 兜底（rank margin < 0.1 且有产品名时）：
     NVIDIA diffusiongemma-26b 一次不通立刻换 modelbest MiniCPM-V-4.6-1B
⑥ L2 Playwright 渲染（JS 站 / 低置信才升级）
```

**版本选择**（`LightGBM` 过滤 + `LambdaRank` 排序）：候选版本经过滤模型排除垃圾（build/SVG/时间戳），rank 模型在**页面内**排序选出种子（特征含 scope / 产品名锚点 / 版本序列最新端 / 同-major 组结构），归族只确认种子所在版本线、不跨 major 改选。低 margin（模型摇摆）才咨询 LLM，用候选清单 + 产品名让模型拿页面语境定夺。

**LLM 兜底**：NVIDIA `google/diffusiongemma-26b-a4b-it` 多 key 轮询（每次调用换一个），一次不通（429/错误/超时）立刻切 modelbest `MiniCPM-V-4.6-1B`。并行 12。key 从 gitignored 文件 / env 读取，不提交。

**更新日志**（版本锚定 + Trafilatura）：用已知版本号定位，`Trafilatura` 整页提取正文转 Markdown。覆盖 GitHub release body、RSS、纯文本（nginx CHANGES）、列表跟随（postgresql）、博客（python/gimp）、JS 渲染（obsidian）。

设计文档见 [`docs/three-tier-extractor.md`](docs/three-tier-extractor.md)。

## 模块

```
src/
├── registries.ts       包注册表：winget manifest / brew / flathub
├── version-extract.ts  版本号提取：启发式 + 版本序列检测 + 置信度
├── lgb-score.ts        LightGBM 过滤 + LambdaRank 排序 + seed-anchored 归族 + LLM 触发
├── llm.ts              LLM 兜底：NVIDIA diffusiongemma 多 key + modelbest 回退，并行 12
├── audit.ts            请求级审计：决策过程（页面/候选/rank/LLM/最终）落 SQLite
├── changelog.ts        更新日志提取：GitHub / RSS / 纯文本 / 列表跟随 / 质量门控
├── changelog-lgb.ts    changelog 页主路径：Trafilatura 清洗 + 版本选择
├── sources.ts          更新源识别
├── pipeline.ts         高层管道：注册表 → HTML → LGB → LLM → 浏览器渲染 → 日志
├── crawler.ts          抓取层：UA 轮换 + TLS 指纹 + 重试 + 磁盘缓存 + Playwright 渲染
└── types.ts            共享类型
```

## 审计（可查询的决策记录）

每次提取把决策过程落 SQLite（`data/audit.db`，Node 内置 `node:sqlite`，零依赖）：页面 HTML、候选 + 上下文（与训练集同源）、rank seed/margin、LLM 是否触发及答案、最终版本/置信度/来源。重复提取同 URL 覆盖，候选/上下文入库。

```bash
# 查询（node:sqlite）
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/audit.db');
d.prepare('SELECT url,finalVersion,llmTriggered,llmAnswer FROM extractions WHERE llmTriggered=1').all()"
```

环境变量：`AUDIT_DB`（默认 `data/audit.db`，空串关闭）。后续 API 可直接查：某 URL 完整决策 / LLM 答错的页 / 候选里出现过某版本的页。

## 核心思想

1. **真实版本号会反复出现** —— 标题、meta、下载链接、正文多处；垃圾版本（JS 资产/构建号）只出现一次、不在下载链接里。
2. **版本选择靠结构，不靠名字** —— rank 学的是「最新 release 标题 / 产品名锚点 / 版本序列最新端 / 下载链接」这类跨站可迁移的信号；词表（标准名/许可证）只作有界硬过滤。
3. **LLM 只救长尾** —— rank 低 margin 才咨询，候选清单 + 产品名给足上下文；组件版本（Electron/Chromium）由"归属词紧邻版本号"的上下文呈现让模型区分。
4. **每次提取都带置信度** —— 高置信免 LLM；低置信（margin < 0.1）升级 LLM / 浏览器。
5. **注册表/结构化源优先** —— 主流软件根本不走 HTML 猜测。

## 使用

```bash
npm install
npx playwright install chromium      # 首次（JS 渲染兜底）
python -m pip install trafilatura     # changelog 正文清洗

# 单 URL：获取版本号 + 最新日志
npx tsx scripts/probe.ts <url>       # 或 npm run probe -- <url>

# 基准测试（80 例真值语料，并行 12，含 LLM 准确性报告）
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

## HTTP API / Docker 部署

常驻 HTTP API，发送网址后可选择只返回版本号、只返回日志，或同时返回两者。服务复用 Playwright 浏览器实例。

```bash
# 本地运行
npm run serve

# Docker 构建与启动
docker build -t version-extractor .
docker run --rm -p 3000:3000 version-extractor
```

### `POST /extract`

请求体：

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

`GET /health` 返回服务状态。环境变量：`PORT`（3000）、`MAX_CONCURRENT`（2）、`EXTRACT_TIMEOUT_MS`（90000）、`GITHUB_TOKEN`、`AUDIT_DB`、`NVIDIA_KEYS` / `MODELBEST_KEY`（LLM key，也可放 gitignored 文件）。对外暴露应在反向代理层加鉴权限流；服务拒绝本机/私网目标。

Docker 镜像构建需 Node 22+（Playwright noble 镜像锁 Node 22，`node:sqlite` 需 `NODE_OPTIONS=--experimental-sqlite`，Dockerfile 已配置）。CI（`.github/workflows/container.yml`）推送 `master` / `deploy/docker-api` 自动构建发布到 GHCR。

## 基准

`benchmark/cases.json` 维护**验证过的真值语料**（80 例，`vX` 前缀匹配）：
- `expectedVersion`：期望版本（前缀匹配，如 `v24` 匹配 `v24.18.1`）；空串 = 期望提取不到
- `registryKey`：可选结构化源（如 `winget:7zip.7zip` / `brew:node`）
- `expectChangelog`：期望能提取到更新日志

输出每例判定 + 置信度 + 📦(注册表)/🖥️(浏览器) 来源标记 + 汇总准确率，以及 **LLM 兜底判定段**（咨询多少例、答对/答错/无答案各多少，逐例列出）。磁盘缓存 `.bench-cache/` 让改模型重跑不用重新抓页。

## 已知边界（诚实记录）

- **依赖/组件版本压过产品**：页面出现 Chromium/Electron/其他库的更高版本时，rank 可能选错；margin 盲区（自信选错）不会触发 LLM。LLM 兜底也非万无一失（windsurf 曾被 "Chromium: 138.0.7204" 带偏，已通过提示词上下文窗口修正）。
- 深 JS 渲染站、SPA 站版本常藏在接口/运行时态里 → 由 L2 网络拦截解决；个别站（如 Chrome release-notes 镜像）即使渲染也难提取。
- changelog 页若版本号只在 JS 接口/下载文件名里（如 notion），需 L2 浏览器 + 下载文件名提取。
- 非 GitHub/无 RSS 的长尾站日志提取仍是弱环节（浏览器渲染慢、Trafilatura 依赖 Python）。

## License

[GNU General Public License v3.0](LICENSE) — 自由软件，允许再分发与修改，但衍生作品必须同样以 GPL 发布。

Copyright (C) 2026 kisrea-team
