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

三档递进提取器设计见 [`docs/three-tier-extractor.md`](docs/three-tier-extractor.md)。

## 模块

```
src/
├── registries.ts       包注册表：winget manifest / brew / flathub
├── version-extract.ts  版本号提取：候选评分 + 下载链接交叉验证 + 置信度
├── changelog.ts        更新日志提取：GitHub release body / RSS / changelog 页
├── sources.ts          更新源识别
├── pipeline.ts         高层管道：注册表 → HTML → 浏览器渲染 → 日志
├── crawler.ts          抓取层：UA 轮换 + TLS 指纹 + 重试 + 磁盘缓存 + Playwright 渲染
└── types.ts            共享类型
```

## 核心思想

1. **真实版本号会反复出现** —— 标题、meta、下载链接、正文多处；垃圾版本（JS 资产/构建号）只出现一次、不在下载链接里。
2. **每次提取都带置信度** —— 只有「高置信」可免 AI 直接写入；中/低置信升级 AI 复核。
3. **交叉校验** —— 提取版本必须比数据库当前版本「更大」才算更新，倒退/相等判定疑似错误。
4. **注册表/结构化源优先** —— 主流软件根本不走 HTML 猜测。

## 使用

```bash
npm install
npx playwright install chromium   # 首次（JS 渲染兜底）

# 基准测试（58 例，并行 + 磁盘缓存）
npm run bench

# 单源探查（看来源/版本/置信/候选/日志）
npm run probe -- <url>
```

## 基准测试

`benchmark/cases.json` 维护**经过验证的真值语料**（这是衡量可靠性的关键）：
- `expectedVersion`：期望版本（前缀匹配，如 `v24` 匹配 `v24.18.1`）；空串 = 期望提取不到
- `registryKey`：可选结构化源（如 `winget:7zip.7zip` / `brew:node`）
- `expectChangelog`：期望能提取到更新日志

输出每例判定 + 置信度 + 📦(注册表)/🖥️(浏览器) 来源标记 + 汇总准确率。磁盘缓存 `.bench-cache/` 让改模型重跑不用重新抓页。

## 准确率现状与目标

| 配置 | 预估 | 状态 |
|------|------|------|
| 现状（L1 启发式 + 部分注册表，58 例） | 45% | ✅ 实测 |
| + 注册表全量补 key | ~70% | 待补 |
| + L2 网络拦截/全局态 | ~80% | P1 规划 |
| + L3 版本体系守卫 | ~85% | P3 规划 |
| 残余长尾 | ~12% 需 AI/人工 | 兜底 |

详见 [docs/three-tier-extractor.md](docs/three-tier-extractor.md)。

## 已知边界（诚实记录）

- 启发式能可靠判断「哪些是真实版本」，但**含大量 URL 的页面**上「哪个是最新」可能失准（CDN 资产版本干扰）。
- 深 JS 渲染站、SPA 站版本常藏在接口/运行时态里 → 由 L2 网络拦截解决。
- golang 等 1.x 非递增体系 → 由 L3 版本体系守卫 + 结构化源解决。

## License

[GNU General Public License v3.0](LICENSE) — 自由软件,允许再分发与修改,但衍生作品必须同样以 GPL 发布。

Copyright (C) 2026 kisrea-team
