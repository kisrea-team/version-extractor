# 软件更新数据提取模型（规则化，不依赖 LLM）

从软件官网 / 包注册表 / GitHub 确定性提取「最新版本号 + 更新日志」。全部规则化实现，AI 仅对残余长尾兜底。

## 架构：确定性优先，多源递进

```
① 包注册表（winget / Homebrew / Flathub）   ← 版本是命名字段，命中即确定性
② GitHub API（release / tag）                ← 权威
③ 官方 RSS / JSON 更新清单（latest.json 等）
④ HTML 启发式 + Playwright 渲染              ← 兜底
```

**关键转变**：不靠解析 HTML 猜"哪个数字是版本"，而是优先查**包注册表**（winget/brew/flathub 就是为追踪每个软件最新版而存在的）。主流软件注册表命中率极高，确定性、零成本、零 AI。

**版本选择**（`LightGBM` 筛选 + 版本号比较）：候选版本经 `LightGBM` 判定"是否产品版本"（融合版本结构/scope/格式特征），再用「格式类似 + 版本号数字最大」选出当前版本——**跨站通用，不猜页面结构**。

**更新日志**（版本锚定 + Trafilatura）：用已知版本号定位，`Trafilatura` 整页提取正文转 Markdown。覆盖 GitHub release body、RSS、纯文本（nginx CHANGES）、列表跟随（postgresql）、博客（python/gimp）、JS 渲染（obsidian）。**不猜 changelog 结构**，结构差异交给结构无关的正文提取。

三档递进提取器设计见 [`docs/three-tier-extractor.md`](docs/three-tier-extractor.md)。
版本选择分析见 [`docs/version-selection-lgb-2026-08-04.md`](docs/version-selection-lgb-2026-08-04.md)。
Changelog 提取见 [`docs/changelog-extraction-2026-08-04.md`](docs/changelog-extraction-2026-08-04.md)。

## 模块

```
src/
├── registries.ts       包注册表：winget manifest / brew / flathub
├── version-extract.ts  版本号提取：候选评分 + 下载链接交叉验证 + 置信度
├── changelog.ts        更新日志提取：GitHub / RSS / 纯文本 / 列表跟随 / 质量门控
├── changelog-ai.ts     更新日志浏览器兜底：Playwright 渲染 + Trafilatura 清洗
├── sources.ts          更新源识别
├── pipeline.ts         高层管道：注册表 → HTML → 浏览器渲染 → 日志
├── crawler.ts          抓取层：UA 轮换 + TLS 指纹 + 重试 + 磁盘缓存 + Playwright 渲染
└── types.ts            共享类型
```

## 核心思想

1. **真实版本号会反复出现** —— 标题、meta、下载链接、正文多处；垃圾版本（JS 资产/构建号）只出现一次、不在下载链接里。
2. **版本选择靠确定性规律** —— "格式类似的候选中版本号最大者是当前版本"；LightGBM 负责排除 build/SVG/时间戳噪声。
3. **日志提取不猜结构** —— 版本锚定 + Trafilatura 整页正文提取，覆盖 changelog 各种组织方式。
4. **每次提取都带置信度** —— 只有「高置信」可免 AI 直接写入；中/低置信升级 AI 复核。
5. **注册表/结构化源优先** —— 主流软件根本不走 HTML 猜测。

## 使用

```bash
npm install
npx playwright install chromium      # 首次（JS 渲染兜底）
python -m pip install trafilatura     # changelog 正文清洗

# 单 URL：获取版本号 + 最新日志
npx tsx scripts/probe.ts <url>       # 或 npm run probe -- <url>

# 基准测试（并行 + 磁盘缓存）
npm run bench

# changelog 提取评估
npx tsx scripts/eval-changelog.ts
```

单入口 `extractFromUrl(url)` 一次返回 `{ version, changelog }`：
```ts
import { extractFromUrl } from './src/pipeline';
const out = await extractFromUrl('https://www.python.org/news/', { token: '' });
out.version    // { version: 'v3.15.0', source, confidence }
out.changelog  // { version: 'v3.15.0', content: '...', date }
```

## HTTP API / Docker 部署

项目提供一个常驻 HTTP API，发送网址后可选择只返回版本号、只返回日志，或同时返回两者。服务会复用 Playwright 浏览器实例，减少重复启动开销。

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
{
  "url": "https://www.python.org/downloads/",
  "fields": ["version", "changelog"]
}
```

`fields` 可选值为 `version` 和 `changelog`；不传时默认返回两者。只获取版本号时：

```bash
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.python.org/downloads/","fields":["version"]}'
```

返回示例：

```json
{
  "url": "https://www.python.org/downloads/",
  "elapsedMs": 1200,
  "version": {
    "version": "v3.14.6",
    "source": "official-endpoint",
    "confidence": "high"
  },
  "changelog": null
}
```

`GET /health` 返回服务状态。环境变量：`PORT`（默认 `3000`）、`MAX_CONCURRENT`（默认 `2`）、`EXTRACT_TIMEOUT_MS`（默认 `90000`）、`GITHUB_TOKEN`（可选）。对外暴露服务时应在反向代理层增加鉴权和限流；服务本身会拒绝明显的本机/私网目标地址。


`benchmark/cases.json` 维护**经过验证的真值语料**（这是衡量可靠性的关键）：
- `expectedVersion`：期望版本（前缀匹配，如 `v24` 匹配 `v24.18.1`）；空串 = 期望提取不到
- `registryKey`：可选结构化源（如 `winget:7zip.7zip` / `brew:node`）
- `expectChangelog`：期望能提取到更新日志

输出每例判定 + 置信度 + 📦(注册表)/🖥️(浏览器) 来源标记 + 汇总准确率。磁盘缓存 `.bench-cache/` 让改模型重跑不用重新抓页。

## 更新日志提取现状

changelog 页从基线 0/6 提升到 6/6 全部干净正文，额外新 URL 验证 9/10 成功。覆盖结构：

| 结构 | 代表 | 方案 |
|---|---|---|
| GitHub Releases | next.js/vscode/nodejs | API release body |
| RSS | rectangle updates.xml | feed 解析 |
| 纯文本 | nginx CHANGES | 版本行切块 |
| 列表跟随 | postgresql | 最新版本链接 → 详情页 |
| 博客 | python/gimp/wordpress | 跟随文章 → 详情页正文 |
| JS 渲染 | obsidian | Playwright 渲染 + Trafilatura |

## 已知边界（诚实记录）

- 启发式能可靠判断「哪些是真实版本」，但**含大量 URL 的页面**上「哪个是最新」可能失准（CDN 资产版本干扰）。
- 深 JS 渲染站、SPA 站版本常藏在接口/运行时态里 → 由 L2 网络拦截解决。
- changelog 页若版本号只在 JS 接口/下载文件名里（如 notion），需 L2 浏览器 + 下载文件名提取。
- 非 GitHub/无 RSS 的长尾站日志提取仍是弱环节（浏览器渲染慢、Trafilatura 依赖 Python）。

## License

[GNU General Public License v3.0](LICENSE) — 自由软件,允许再分发与修改,但衍生作品必须同样以 GPL 发布。

Copyright (C) 2026 kisrea-team
