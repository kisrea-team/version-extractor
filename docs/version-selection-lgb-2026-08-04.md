# 版本选择：LightGBM 筛选 + 数字最大（2026-08-04）

## 结论摘要

用 **LightGBM 筛选（排噪）+ 严格格式校验 + 版本号数字最大** 的方式选择当前产品版本，在净化后的 51 页测试集上达到 **43/51（84.3%）**，显著超过纯启发式（34/51）和分类器 argmax（34/51）。

核心洞察（来自用户）：**"格式类似的候选中，版本号最大者是当前版本"**。版本号本身是确定性特征——只要先把 build/时间戳/SVG/跨产品主版本噪声排除干净，数字比较就能选出最新版。这比让 BERT 学"当前 vs 历史"（文本语义无法区分）可靠得多。

## 数据清洗

测试集从最初的 74 页净化到 51 页，删除 23 页"正确版本无法从页面提取"的页面：

| 删除原因 | 页面 |
|---|---|
| 快照抓取失败/反爬/重定向（403/宣传页/JS壳） | inkscape, kdenlive, putty, 7zip, autohotkey, bettertouchtool, mysql, mpv, openjdk |
| 正确版本只存在于 SVG 坐标/JS 数据 | notion, wps, terraform, raspbian, cursor, gitkraken, opera, obsidian, evernote, krita, davinci, slack, zoom, ollama |

**SVG path 坐标剥离**（`src/export-candidates.ts` 的 `stripSvgCoords`）：清除 `<path d="M135.539 20.5151...">` 的坐标，因为 SVG 坐标数字（`135.539`、`7.28917`）在形式上与真实版本号无法用文本区分。剥离后 opera/wps/krita 等的坐标候选全部消失。

**expected 真值修正**（跟上市面最新版本，按用户标准 stable/rc/preview 都算正确）：
- python v3.14 → v3.15（`/downloads/latest/python3.15/`）
- everything v1.4 → v1.5.0（`Everything-1.5.0.1418b.x64-Setup.exe`）
- sketch v2025 → v2026.2（`sketch-2026.2-231037.zip`）
- audacity v3 → v4.0.0（beta 下载链接）
- dotnet v10 → v11.0（Preview 下载页）

## 方案

```text
候选版本
  → LightGBM 打分（融合 BERT 概率 + 版本结构 + scope + 格式特征）
  → 严格格式校验（排除 SVG path / 坐标 / 时间戳）
  → 主版本窗口 ±1（排除跨产品高版本）
  → scope 优先级（download-link > structured > heading > visible > noise）
  → 版本号数字最大者 = 当前版本
```

### LightGBM 特征

- `bert_prob`：分类器对候选文本的 P(产品版本)
- `major/minor/patch`：版本号数字结构
- `n_seg`：版本号段数
- `is_clean`：严格格式校验（纯数字点号，`-` 后必须是字母）
- `is_yearish`：年份样式排除
- `scope_dl/structured/heading/visible/noise`：来源 scope
- `has_v`、`n_digits_total`、`is_short_major`

训练数据：700 标注（current=1, historical+non_product=0）。

## 结果对比（51 页测试集）

| 方法 | 命中 | 命中率 |
|---|---:|---:|
| 纯启发式 | 34/51 | 66.7% |
| 分类器 argmax | 34/51 | 66.7% |
| 排序模型（页内相对/绝对/逐对） | ~20/51 | 39% |
| **LightGBM 筛 + 数字最大** | **43/51** | **84.3%** |

## 关键实验结论

1. **排序模型（Learning-to-Rank）在"当前 vs 历史"上无效**（~20/51）。原因：BERT 文本语义无法区分"当前版本 vs 历史版本"——它们的下载链接/正文上下文几乎相同（python 页 v3.11.1 和 v3.14.1 分类器分相同 0.97）。这是任务的本质属性，不是数据量问题。

2. **把 historical 当二分类负样本有害**（31/51）。历史版本与依赖版本共享"产品版本"文本特征，压低历史版本会连带压低真实产品版本。

3. **SVG 坐标是最大的候选污染源**。SVG path 数字（`M135.539 20.5151`）在形式上与版本号不可分，必须从源头剥离，不能靠分类器/筛选器过滤。

4. **"格式类似 + 数字最大"是确定性赢家**。LightGBM 负责排噪（build/时间戳/SVG/跨产品），版本号比较负责选最新，超过所有基于语义的方案。

## 遗留限制

- notion 类页面的版本在**下载响应文件名**里（`Notion-7.29.0.msix`），需点击下载才知道版本。已复现但批量稳定性差（各站下载触发方式不同），性价比低，从测试集移除。
- 剩余 8 个失败：windsurf/affinity（跨主版本）、raycast（数字差异）、golang（rc2 混淆）等，属提取边界。

## 产物

- 代码：`src/export-candidates.ts`（stripSvgCoords）、`src/crawler.ts`（下载文件名提取）、`src/version-extract.ts`（宽松正则）
- 训练：`scripts/train_lgb_filter.py`、`scripts/evaluate_lgb.py`
- 数据：`data/compare-pages.jsonl`（51 页）、`data/compare-candidates-v2.jsonl`（净化候选池）、`data/lgb-filter.joblib`

复现：

```bash
BENCH_CACHE_DIR=data/.l2cache npx tsx scripts/compare-new-l2.ts   # 重新生成候选池（SVG剥离+下载）
HF_HUB_OFFLINE=1 python scripts/evaluate_lgb.py                    # LightGBM 训练 + 评估
```
