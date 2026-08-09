# 交接文档 —— LogUp 版本提取引擎 + 数据集/BERT 铺路

> 最后更新：2026-08-03
> 交接人：Claude Code 会话（与用户长时间协作后）
> 目标：让新的 CLI/会话能无缝接手继续

---

## 1. 项目全貌（两个仓库）

| 仓库 | 本地路径 | 分支 | 状态 |
|------|---------|------|------|
| **LogUp**（主站） | `C:\workspace\logup` | `improve/comprehensive` | 18 提交待 PR，未推远端 |
| **version-extractor**（本次核心） | `C:\workspace\version-extractor` | `pr-feat-tier`（= PR #1 head） | 活跃开发中 |

- **LogUp**：Next.js 软件版本追踪站。已做：工业爬虫引擎、控制平面、微任务、AI Provider 管理、GH Actions 控制、安全加固。工作树干净，改动都在本地 `improve/comprehensive`，**待用户 review 后 PR 合入 dev**。
- **version-extractor**：独立的"软件更新数据提取模型"（版本号+日志），GPL-3.0，已推 `kisrea-team/version-extractor`。PR #1（`feat/three-tier-extractor`）实现三档提取器，**待 review**。本地分支 `pr-feat-tier` 又叠加了多轮修复。

**⚠️ 注意**：`version-extractor` 的本地 `pr-feat-tier` 分支有**尚未推远端**的提交（L2 采纳规则修复、JSON 提取、App Store 端点、日志基线、数据集导出等）。若要让 PR 包含这些，需要把这些提交 push 到 PR head。

---

## 2. version-extractor 架构

```
src/
├── registries.ts       包注册表（winget/brew/flathub）+ 官方端点（go/python/postgres/itunes/redis…）
├── version-extract.ts  版本号提取：候选评分 + 上下文多样性 + 置信度 + 交叉校验
├── changelog.ts        更新日志提取：GitHub release body / RSS / changelog 页
├── sources.ts          更新源识别
├── pipeline.ts         高层管道：注册表 → L3官方端点 → L1启发式 → L2浏览器渲染 → 日志
├── crawler.ts          抓取层：got-scraping(TLS/UA) + 磁盘缓存 + Playwright 渲染/网络拦截
└── types.ts            共享类型
```

**三档递进**（详见 `docs/three-tier-extractor.md`）：
- L1 浅层：HTML 启发式（候选评分 + 下载链接交叉验证 + 上下文多样性）
- L2 深度：Playwright 渲染 + XHR 网络拦截 + 运行时全局态 + 主 CTA 定位
- L3 版本体系守卫 + 结构化官方端点

**确定性优先原则**：注册表 > GitHub API > 官方 JSON 端点 > HTML 启发式 > 浏览器。AI 仅兜底长尾。

---

## 3. 语料与评估现状

### 语料（合并后统一数据集）

| 批次 | 文件 | 例数 | 说明 |
|------|------|------|------|
| 通用 | benchmark/cases.json | 83 | 手工语料（含 registryKey） |
| 第一批 | benchmark/logup-cases.json | 55 | LogUp 库非GitHub优先（SPA/AppStore 难例） |
| 第二批 | benchmark/logup-cases-holdout.json | 55 | 非GitHub 回归集 |
| 第三批 | benchmark/logup-cases-batch3.json | 50 | 新非GitHub（SaaS 构建号多） |
| **统一** | **data/dataset.json** | **236**（去重） | 含 label、registryKey、HTML 引用 |
| HTML 快照 | data/html/<id>.html | 215 个 | gitignored，可重生成 |

**数据生成脚本**：
- `scripts/build-logup-corpus.ts`：从 LogUp 库拉新批次（`--count N --out xxx`）
- `scripts/correct-logup-corpus.ts`：用"正则现抓 R"修正 expectedVersion（真值）
- `scripts/export-dataset.ts`：合并去重 + 抓 HTML + 生成 data/dataset.json
- `scripts/eval-holdout.ts`：回归评估（strict/honest 双指标，并行 8）

### 真实评估（非 GitHub，不跳过）

```
严格(strict): 42~77%   管道V == 正则现抓R
真实(honest): 65~91%   正则过时、管道拿到更新版也算对
波动主因：语料中 SaaS/构建号体系占比
```

**关键教训（防过拟合）**：数字随语料构成剧烈波动。每次改模型必须跑**全部三个批次**，尤其未调过的批次，防止"修好一批带坏另一批"。

---

## 4. 当前工作线 A：数据集固化 + 候选标注导出 + BERT 训练（优先）

### 已完成
- ✅ 统一数据集 `data/dataset.json`（236 例，130 例有活标注 label）
- ✅ HTML 快照 215 个（data/html/）
- ✅ 数据文档 `data/DATA.md`（含 MarkupLM 路线）

### 待做（按顺序）
1. **候选标注导出脚本**（`scripts/export-candidates.ts`）：从 label 反推训练样本
   - 每个页面收集所有"版本样"候选（版本号正则扫 HTML）
   - 正样本 = 匹配 label 的候选；负样本 = 其他候选
   - 输出：`(页面上下文前~64 token + 候选版本) → 0/1`，JSON Lines
   - 236 例 ≈ 1k~4k 条样本
2. **BERT 训练脚本**（如 `scripts/train-bert.py`）
   - 用 transformers 微调 bert-base-chinese（页面含中文）分类头
   - 训练/验证切分，防过拟合
   - **先跑启发式基线对比**：BERT 没超过基线不上
3. **接入管道**：训练好的分类器替换/增强 `version-extract.ts` 的候选评分

### 技术要点
- 样本输入格式建议：`[CLS] 候选版本: 1.2.3 [SEP] 页面上下文: <前后各64字符> [SEP]`
- 数据量：现在 130 有label ≈ 够训小分类器；攒到 ~500+ 项目 / 上万样本更稳
- **不要用 DB 的 latest_version 当 label**（过时）；用正则现抓 R

---

## 5. 工作线 B：版本日志提取（已搁置，基线 40%）

- `scripts/eval-changelog.ts`：三类路径基线
- 基线：GitHub release body 3/3 ✅、RSS 1/1 ✅、**changelog 页 0/6 ❌**
- 已做部分修复：纯文本（nginx）、列表页跟随版本链接（`findLatestVersionLink`）
- **未验证修复效果**（切换到 BERT 线前被打断）。修复代码在 `src/changelog.ts`，需重跑 eval-changelog 确认
- changelog 页剩余难点：JS 渲染（obsidian）、列表页跟随链接的鲁棒性

---

## 6. 关键认知/坑（务必知道）

1. **真值唯一性**：正确版本是唯一的。DB 快照会过时、正则也会过时（页面结构变）。当前"最可靠活真值" = 正则在当前页现抓 R。但 R 也不完美（PyCharm 例证明）。
2. **构建号 vs 语义版本**：构建号（4200/11083/v14.44）和语义版本（1.2.3）都像版本。解法是**结构化源（注册表）**，不是更好的 HTML 解析。7-Zip/WinRAR/Everything 配 registryKey 后确定性正确。
3. **SaaS 无意义版本**：Asana v271、Todoist v11083 —— 用户不关心，该选品过滤，不追踪。
4. **上下文多样性**是最强启发式信号：语义版本跨多个上下文出现，构建号只在一处。已加入 `version-extract.ts` 评分。
5. **过拟合风险**：别针对单个 case 调规则；用三个批次的 holdout 当刹车。
6. **日志提取（changelog 页）是最弱环节**，GitHub/RSS 已可用（覆盖开源项目）。

---

## 7. 环境与凭据（敏感，注意）

- 数据库：VPS `104.168.43.209:5432`（PostgreSQL，用户 postgres）—— **服务不稳定，需时连时断，连接要加 timeout**
- 备用库：Supabase `spb-xkgmy3thgcr046ne.supabase.opentrust.net`（687 项目，246 有 regex）
- 密码/Token：**在对话中泄露过，建议用户轮换**。GitHub token 曾用于 API + 推送
- .env.local / .env 文件：LogUp 的 `.env.local` 已配置（VPS 库 + admin 凭据）

---

## 8. 下一步建议（交接后优先做）

1. **先把 version-extractor 的 pr-feat-tier 未推送提交 push 到 PR**（固化成果）
2. **写候选标注导出脚本**（`scripts/export-candidates.ts`），导出 BERT 训练样本
3. 跑一次 BERT 微调 + 对比启发式基线
4. 顺手重跑 `eval-changelog.ts` 确认日志修复是否生效（已写的代码）
5. LogUp 侧：review 后把 `improve/comprehensive` PR 合入 dev
