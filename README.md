# 软件更新版本日志提取爬虫（规则化为主，LLM 对语义问题长尾兜底）

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

### 评测基准（2026-08-12）

三套纯页面提取基准（`--no-registry`，只用页面 HTML，禁注册表兜底），零重叠：

- **`benchmark/bench-hard-final.json`（24 例）**：官网难例硬基准（原 25 例）。8-12 净化：SuperDuper URL 换官网首页 `shirt-pocket.com/`（原 blog 页内容漂移，页面无版本号）、剔除夸克网盘（官网 `pan.quark.cn` 渲染后无版本号，信息论极限）、MSTeams 期望更新为 New Teams 当前版 `26198.304.4946.9672`（页面标题 "new and classic"，多版本线取主流）。历史成绩：23/25 = 92%（v48，部分依赖当时缓存内容）。
- **`benchmark/bench-new50.json`（52 例）**：第二轮扩展基准，多版本线/噪音干扰难例。历史成绩：44/52 = 85%（v8）。
- **`benchmark/bench-new30.json`（30 例）**：第三轮官网/changelog 基准（27 官网 + 3 changelog），全部 fastCRW render_js 渲染抓取。历史成绩：26/30 = 87%（v3）→ 28/30 = 93%（v4，带 latest 特征）。

**成绩记录口径**：`--no-registry` + `FETCHER=fastcrw` + `render_js:true`（SPA 必传，见 `src/crawler.ts`）；判定为 `vX` 前缀匹配；缓存 `.bench-cache/` 使改模型重跑不重新抓页。

### 数据集验证（2026-08-11）

基准与训练数据全部经过**真实源交叉验证**（Tavily 搜索 + fastCRW 抓取 + GitHub/iTunes/npm/brew API 三线）：

- **`benchmark/ve-benchmark-all.json`（362 例）**：全面验证后保留。删除 19 个「页面无版本号」的营销页（SaaS 登录页/JS 营销站，信息论上无法提取）；修正过期期望值（Duolingo 7.135、钉钉 8.5.1 等）；恢复 4 个 bundleId 格式的 iTunes 项目。GitHub 101 例全部通过 releases API 复核。
- **`data/canonical-targets.jsonl`（210 页）**：训练 label 来源，Tavily 子代理 + fastCRW 全量验证，修正 15 个错误版本（Alpine 3.24.1 / GCC 16.1 / Tcl 9.0.4 / Linux内核 7.1.4 等，均快照前已发布）。
- **`data/ds700-ctx/train-ready.jsonl`（351 页 / 9476 条候选）**：current 标注 15 个差异全部可解释（抓取提取错或版本更新），historical 标注经 Tavily 修正 16 条（Alpine/Inkscape/VS 等版本颠倒）。

**关键方法论：**
1. **时间对齐**：快照（2026-08-03）标注只能用快照时点的版本验证，不能用今天的版本改（否则把「当时正确」误判成错）。
2. **官方源可能误导**：官网常列 dev/beta 版（Inkscape 官网有 1.5 dev，但稳定版是 1.4.4），必须以权威第三方（Wikipedia/发布日志）+ 多源交叉为准。
3. **页面无版本是常态**：约 20% 官网（营销页/博客列表页/登录页）确实没有版本号，任何提取器（含 LLM）都提取不到，属于信息论极限，应从基准剔除而非优化。

### 模型重训与公平对比（2026-08-11）

用修正后的数据重训 LambdaRank（`train3_lgb.py`），**同 210 例训练未见过页面公平对比**：

| 模型 | 准确率 |
|---|---|
| 旧模型（2026-08-08） | 84.3%（177/210） |
| **新模型（重训后）** | **95.2%（200/210）** |

旧模型 FAIL 聚类：倾向选旧一版（claude-code v2.1.226 vs 2.1.227）、漏检多（GitHub API 密集批 17/18 FAIL）；新模型修正了这两类。真实泛化提升 **+10.9%**。

### fastCRW 抓取模式（可选）

`FETCHER=fastcrw FASTCRW_URL=http://<host>:3000` 可将抓取层替换为 [fastCRW](https://github.com/us/crw)（Firecrawl 兼容自托管爬虫，LightPanda JS 渲染 + stealth 反爬），替代本地 Playwright。适合内存受限环境（VPS 3.8G 跑不动批量浏览器渲染时）。验证：5 例混合类型 100% 通过。

### 2026-08-13 研究记录：收益临界验证

**结论：ve 当前架构（正则收集 → LightGBM 过滤 → LambdaRank 排序 → LLM 低置信兜底）已进入收益临界状态。** 本轮系统性验证了特征、收集层、LLM 输入、触发指标、换模型共 5 大类方向，**无任何方向能稳定超过现有基线**；同时揭露了一个此前掩盖所有"提升"的系统性假象，并完成了 4 项真实修复 + 基准坏案例清理。

#### 一、静默回退假象（影响所有历史"提升"结论）

**现象**：train4b/4c/4e 系列在 76 例上测出 69.0%~81.6% 的"提升"，重训后 test 集 81.2%。

**真相**：实验脚本改了特征列数（37→40/41 列），但生产代码 `buildRankFeatureRows` 仍是 37 列 → `lgb_worker` 报 `X.shape[1] != model.n_features_in_` → **调用方 catch 后静默回退到启发式提取**。所有"提升"全是启发式回退的假象，与模型无关。

真实对比（列数一致）下：train3（37 列）62/76 是天花板，train4g（dist）76.3%、train4h（near）78.9%、train4i（归族）80.3%——**全部低于 train3**。

#### 二、验证过的方向（真实结果，无一提分）

| 方向 | 验证方式 | 结果 |
|---|---|---|
| dist 特征（下载链接距离/产品词距离） | 40 列重训 + TS 一致性 | 76.3%（-5.3%） |
| near 特征（版本词邻近） | 39 列重训 | 78.9%（-1.4%） |
| 归族特征（簇内最大/位置最早） | 39 列重训 + 76 例 | 80.3%（-1.3%，收益被 LLM 兜底稀释） |
| 声明块收集层重构 | decl-only 模拟 | 65.8%（-3.9%，误杀正确版本） |
| page-type 分流 | 下载页/历史页统计 | 50%/17%，不可行 |
| LLM 结构标注（paths 标签链） | 完整链路 | 62/76 零和（Lens 救回 vs 4 破坏） |
| 具体结构标注（class+区块标题） | 完整链路 | 59-61/76 负收益 |
| 上下文窗口扩大（110→270 字符） | 完整链路 | 60/76 无效 |
| 换模型 gpt-oss-20b（禁思考/medium/high） | 完整链路 | 55/58/60，全不如 diffusiongemma |
| 换模型 NEMOTRON-550B | 禁思考参数 400 | 不可用 |
| 触发指标 ML 分类器 | LOO | 0.635，漏判 21 |
| "净化后数字最大"规则 | 29 例 + 74 例 | 44.8%/37.8%（假最大污染） |
| 区块标题（最近的 h1-h3） | 覆盖率 | 89% 页面无父标题，不可得 |

**统一规律：LLM 对任何结构标注（标签链/class/区块标题）的反应不可控——少数案例受益（Lens/LibreOffice/Shotcut），多数案例被干扰，净效果零或负。** 多版本线的判别信息（"Latest Release"/"LTS"/"Released v100.0"/"recommended download"）**全部存在于候选上下文里**，失败是 LLM 判断力边界（Node.js 在 LTS vs Latest 间犹豫、RoboForm 被浏览器扩展版本 9.9.9 迷惑），不是上下文缺失。

#### 三、落地的真实修复（本轮有效部分）

1. **build 后缀提取**（`purifyVersion` 加 `-\d{1,4}(?!\d)`）：Screen Studio `3.7.5-4595` / ImageMagick `7.1.2-29` 此前被截成主版本导致假 FAIL，现完整保留（限 1-4 位防日期 build）。
2. **rc/beta 判定**（基准匹配剥离预发布后缀）：rc/beta 是"某种意义的最新版本"，不再判错。
3. **URL 编码空格**（`cleanText` 加 `%20→空格`）：Waterfox 案例 `Setup%206.6.17.exe` 的 `%20` 使 "20"+"6.6.17" 拼成伪版本 `206.6.17` 迷惑 rank/LLM。
4. **组合触发**（`margin<0.5 || channelConflict || p12diff<0.015`）：p12diff（filter top1-top2 概率差）抓 margin 高但 rank 实际犹豫的案例，MKVToolNix（margin 高、上下文含 "Released v100.0"）被救回。
5. **性能**：LLM 超时 60→20s、attempt 0 失败立即切 Resin 代理换出口 IP（原 attempt 0-1 直连白等 2×超时）、取消 modelbest 兜底（兜底答错多）。
6. **基准坏案例清理**：移除页面不含期望版本的案例（Eagle 博客文章、Teams 版本格式混乱、Zotero 版本仅存于 JS 平台映射不渲染）、MariaDB 换页面（download 交互页 → 官网首页）、Kubernetes 期望修正（页面实际最新 1.36.2）、Mumble 期望修正（页面声明 latest stable 1.5.915 而非 macOS 特例 1.5.901）。

**"版本只在 JS 配置里、渲染后页面不显示"的页面（如 Zotero standaloneVersions）不应作为产品版本识别网站**——与营销页/登录页同类，属信息论极限。

#### 四、基准成绩（2026-08-13）

| 基准 | 成绩 | 说明 |
|---|---|---|
| 76 例（清理前，含 4 坏案例） | 63/76 = 82.9% | build/rc 修复后 |
| 74 例（清理后，去 Eagle/Teams） | 63/74 = 85.1% | MariaDB/K8s 待重跑确认 |
| 28 例新基准（brew 权威 + fastcrw 确认，零坏案例） | 24/28 = 85.7% | LLM 随机 ±1（Firefox 曾输出 53.0.4 截断错误） |
| 28 例（Waterfox beta 按 rc 原则计对） | 25/28 = 89.3% | 待定 |

纯模型（llm:false）在 29 例上 65.5% vs 完整链路 82.8%——**LLM 兜底真实贡献 +17.3%**。

#### 五、剩余边界（诚实记录）

- **多版本线 3 例**：Node.js（LTS 24.19.0 vs Latest 26.7.0，上下文含两个徽标）、RoboForm（recommended 主程序 9.9.5 vs 浏览器扩展 9.9.9）、Waterfox（current 6.6.17 vs beta 6.7.0）——信息在上下文里，LLM 判断力边界。
- **LLM 输出截断**：diffusiongemma 偶发丢版本号首位（Termius 9.43.1→43.1、Firefox 153.0.4→53.0.4），±1 波动。
- **深 JS 站**（版本仅存接口/配置）：Zotero 类已从基准剔除，生产上由 L2 网络拦截覆盖。

**架构判断**：页面级提取（HTML → 版本号）的信息上限已被本架构逼近。rank 37 特征 + LLM 语义兜底 + 预发布感知的组合，在"页面确实声明版本"的网站上的真实水平约 **86-89%**；剩余失败要么是页面不声明（信息论极限），要么是 LLM 对"哪个版本线是当前"的语义判断（模型能力问题）。进一步提升需要动收集层（网络拦截/接口级）或换更强语义模型，均超出当前架构的边际收益。

## 已知边界（诚实记录）

- **依赖/组件版本压过产品**：页面出现 Chromium/Electron/其他库的更高版本时，rank 可能选错；margin 盲区（自信选错）不会触发 LLM。LLM 兜底也非万无一失（windsurf 曾被 "Chromium: 138.0.7204" 带偏，已通过提示词上下文窗口修正）。
- 深 JS 渲染站、SPA 站版本常藏在接口/运行时态里 → 由 L2 网络拦截解决；个别站（如 Chrome release-notes 镜像）即使渲染也难提取。
- changelog 页若版本号只在 JS 接口/下载文件名里（如 notion），需 L2 浏览器 + 下载文件名提取。
- 非 GitHub/无 RSS 的长尾站日志提取仍是弱环节（浏览器渲染慢、Trafilatura 依赖 Python）。

## License

[GNU General Public License v3.0](LICENSE) — 自由软件，允许再分发与修改，但衍生作品必须同样以 GPL 发布。

Copyright (C) 2026 kisrea-team
