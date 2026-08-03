# 数据集与 MarkupLM 路线

> 这是为将来训练 MarkupLM（DOM 结构感知模型）而沉淀的数据资产。
> 当前数据量小（~250 例），只够做小模型/基线研究；随 LogUp 运营数据增长而持续扩充。

## 数据是什么

统一数据集 `data/dataset.json`：从各批次语料合并去重而来，每个用例含：

```json
{
  "id": "sha1(url前12位)",
  "name": "软件名",
  "url": "版本源 URL",
  "batch": "来源批次（logup-cases / logup-cases-holdout / logup-cases-batch3 / cases）",
  "versionRegex": "DB 的 version_regex（站点自己的精确方法）",
  "expectedVersion": "期望版本（人工核实的真值，或取正则活标注）",
  "currentDbVersion": "DB 快照版本（可能过时，仅参考）",
  "registryKey": "注册表 key（winget/brew，如有）",
  "label": "正则在当前页现抓值 R —— 唯一真值的活标注",
  "labelSource": "regex-live",
  "htmlFile": "data/html/<id>.html —— 原始 HTML 快照（训练输入）",
  "fetchedAt": "抓取时间"
}
```

原始 HTML 快照在 `data/html/`（gitignored，可由 `scripts/export-dataset.ts` 重新生成）。

## 标签(label)的严谨性

- **唯一真值原则**：label = `version_regex` 在当前页现抓值 R。这是站点自己的方法在当前页的**活提取**，比 DB 快照可靠。
- **已知局限（诚实记录）**：
  - 正则也可能过时（页面结构变了，匹配到旧元素）—— 此时 label 可能错，需人工复核
  - DB 的 `currentDbVersion` 是快照，**一定不能当 label**（已经过时）
  - 构建号/SaaS 用例的"正确版本"有歧义（Wireshark v4.6 vs 构建 v14.44）—— 这类标注需人工定
- **过滤规则**：label 若为纯哈希 / 纯字母 / 超长 / 纯日期 → 标记 `labelSource: null`，不用于训练

## 如何扩充（随运营数据增长）

```bash
# 重新从 LogUp 库拉新批次语料
npx tsx scripts/build-logup-corpus.ts --count 55 --out benchmark/logup-cases-batchN.json

# 修正 label + 导出统一数据集
npx tsx scripts/correct-logup-corpus.ts
npx tsx scripts/export-dataset.ts

# 跑回归评估（防退化）
npx tsx scripts/eval-holdout.ts --file benchmark/logup-cases-batchN.json
```

每次新增一个批次，`export-dataset.ts` 会自动合并去重并抓取 HTML 快照。

## MarkupLM 路线

**问题**：区分"语义版本 vs 构建号/库版本"，本质是 DOM 结构语义问题：
> "页面里哪个元素的版本是产品版本"

**MarkupLM 契合点**：它把**文本 + DOM 树结构**一起建模，能从数据学到
"下载按钮旁 + 标题里 + 出现多次 = 产品版本"这类结构语义 —— 正是我手写
"上下文多样性"信号想表达的东西，但它是从数据学的。

**训练准备（当前阶段）**：
- ✅ 已备：URL + 活标注 label + HTML 快照
- 待备：候选版本标注（页面每个版本样字符串 → 是否产品版本的正/负样本），
  可从 label 反推：label 匹配的候选 = 正样本，其他候选 = 负样本
- 量级：当前 ~250 例，小模型（候选排序器）勉强够；MarkupLM 微调需
  攒到 1k+ 例

**触发条件（不急于投入）**：
1. 数据量到 1k+ 活标注
2. 且"语义消歧"确实是剩余失败的主要来源
3. 且 LLM/devchrome 兜底成本成为负担

在此之前，保持：注册表 + 启发式（确定性，零成本）+ LLM 兜底长尾。

## 数据集统计（诚实）

| 批次 | 文件 | 例数 | 构成 |
|------|------|------|------|
| 通用 | benchmark/cases.json | 83 | 手工语料（含 registryKey） |
| 第一批 | logup-cases.json | 55 | 非GitHub 优先（SPA/AppStore 难例） |
| 第二批 | logup-cases-holdout.json | 55 | 非GitHub 回归集 |
| 第三批 | logup-cases-batch3.json | 50 | 新非GitHub（SaaS 构建号多） |
| **合计（去重后）** | data/dataset.json | ~243 | 详见 manifest |

评估基准（诚实，非 GitHub）：
- strict（管道==正则现抓）：约 42-77%，随批次难度波动
- honest（含正则过时、管道拿到更新版）：约 65-91%
- 波动主因：SaaS 构建号体系占比
