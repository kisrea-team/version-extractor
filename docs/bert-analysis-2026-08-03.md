# BERT 版本候选分类分析（2026-08-03）

## 结论摘要

当前 BERT 不应替代纯启发式版本提取器。使用未参与训练的新页面材料对比后，纯启发式在页面级最终版本选择上明显更好；BERT 更适合作为候选过滤器或辅助排序器，最终结果仍应保留下载链接、版本列表、上下文多样性和明确噪声过滤规则。

## 训练数据与模型

本轮模型使用：

- 文本向量模型：`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
- 分类器：冻结 embedding + `LogisticRegression(class_weight="balanced")`
- 训练切分：按 URL 切分，避免同一页面候选泄漏到训练集和测试集
- 清洗数据：`data/candidates-clean.jsonl`
- 正样本：203 条
- 明确负样本：5,854 条
- `unknown`：10,449 条，未进入监督训练
- 训练候选来自 108 个 URL
- 测试集指标：准确率 0.986，F1 0.988，精确率 0.977，召回率 1.000
- 剩余测试误判：1 条，为 Kling 页面价格 `¥0.1` 被判成版本候选

训练指标较高，但不能代表跨网站泛化能力。训练数据中的正样本数量和网站类型仍然偏少。

## 新页面对比

评估材料来自 `data/dataset.json` 中满足以下条件的页面：

- 没有 `label`，因此没有进入训练数据；
- 有 `expectedVersion`，可以作为页面级真值；
- 有本地 HTML 快照；
- 共 74 个页面。

这 74 个页面是未参与训练的新页面材料。候选池额外包含 `v1`、`v26` 这类 MAJOR-only 主版本号，以覆盖 Firefox、Node.js 等页面。

### 页面级结果

| 方法 | 命中数 | 命中率 |
|---|---:|---:|
| 纯启发式 | 35 / 74 | 47.3% |
| 新 BERT | 25 / 74 | 33.8% |

有 17 个页面没有把 `expectedVersion` 提取进 BERT 候选池，因此再好的分类器也无法选中真值。只看真值已经进入候选池的 57 个页面：

| 方法 | 命中数 | 命中率 |
|---|---:|---:|
| 纯启发式 | 34 / 57 | 59.6% |
| 新 BERT | 25 / 57 | 43.9% |

两者关系：

- 两者都正确：21 个
- 只有纯启发式正确：14 个
- 只有 BERT 正确：4 个
- 两者都错误：35 个

BERT 单独正确的页面包括 Audacity、Everything、QGIS、Flomo。纯启发式单独正确的页面包括 Node.js、Nginx、VS Code、Prometheus、Bitwarden 等。

## 为什么训练集高分但新页面较差

1. **正样本数量和网站多样性不足**

   当前只有 203 条正样本、约 108 个训练 URL。模型见过的页面类型不足以覆盖大量官网首页、下载页、changelog、SPA 和结构化接口。

2. **输入特征过于文本化**

   当前主要输入是“候选版本 + 文本上下文”。`title`、`download-link`、`structured`、`noise` 等 scope 虽然被拼入文本，但没有作为稳定的结构化数值特征输入。

3. **训练和新测试的候选分布不完全一致**

   训练导出主要使用小版本和完整语义版本；新页面对比额外开启了 MAJOR-only 候选，例如 `v26`、`v153`。这类候选在训练中覆盖不足。

4. **BERT 被要求强行从所有候选中选一个**

   当所有候选概率都不高时，当前评估仍取最高概率候选，容易选中旧版本、依赖版本或构建号。纯启发式则有下载链接权重、上下文多样性、版本列表和最大版本保护。

## unknown 样本的意义

`unknown` 不是负样本，而是无法从现有锚点确定真值的未标注样本。典型来源包括：

- changelog 中的合法历史版本；
- release 页面中的多个合法版本；
- npm、VS Code、iTunes 等结构化接口中的版本；
- 无法确认属于主产品还是插件/依赖的候选。

不能把全部 `unknown` 直接标成 0，否则会把真实的历史版本、合法版本列表和结构化产品版本制造成假负样本，模型会学到错误的页面来源偏见。

正确用途：

- 从 BERT 概率接近 0.5 的样本中优先人工标注；
- 将明确的 `build/sdk/api/OS/SVG/CSS/依赖` 样本转为负样本；
- 将下载链接、产品标题和版本语义同时支持的样本转为正样本；
- 将历史版本单独用于排序训练，而不是直接作为“当前版本”二分类正样本；
- 真正证据不足的样本继续保留为 `ambiguous`。

建议标注类别：

```text
product-current       当前产品版本
product-historical    合法的历史版本或版本列表项
non-product            构建号、SDK、API、OS、依赖、CSS、SVG 等
ambiguous              证据不足
```

## 推荐架构

```text
L3 官方接口
  ↓
L2 浏览器渲染
  ↓
L1 纯启发式生成候选
  ↓
BERT 判断候选是否像产品版本
  ↓
启发式分数 + BERT 概率联合排序
  ↓
版本列表、最大版本和明确噪声规则保护
```

BERT 应作为候选过滤器或重排序器，不应独立决定最终版本。建议加入显式特征：

- `scope_title`
- `scope_heading`
- `scope_download_link`
- `scope_structured`
- `scope_visible`
- `scope_noise`
- `in_download_url`
- `in_page_url`
- `context_count`
- `has_v_prefix`
- `has_build_keyword`
- `has_sdk_keyword`
- `candidate_count`

## Todo

### 高优先级

- [ ] 统一训练和评估的候选规则，训练数据也覆盖 MAJOR-only 版本。
- [ ] 从 74 个新页面中优先标注启发式/BERT 分歧样本。
- [ ] 从 10,449 个 `unknown` 中抽取概率接近 0.5 的主动学习样本。
- [ ] 为训练输入增加 scope、下载链接、上下文数量等结构化特征。
- [ ] 解决 17 个页面的候选召回问题，先确保真值进入候选池。

### 中优先级

- [ ] 将训练集扩展到至少 300--500 个不同网站。
- [ ] 正样本扩展到 1,000 条以上，每个正样本配 3--10 个难负样本。
- [ ] 单独建立历史版本/版本列表排序评估，不把它们与当前版本二分类混在一起。
- [ ] 对 BERT、纯启发式和混合排序器使用固定的页面级 holdout 回归集。
- [ ] 重新安装 CUDA 版 PyTorch 后，用 GPU 重跑同一份对比；CUDA 不是指标逻辑的一部分，只影响运行速度。

### 暂不做

- [ ] 暂不把 BERT 合并进生产 pipeline，先完成标注和跨页面回归。
- [ ] 暂不把全部 `unknown` 自动转为负样本。
- [ ] 暂不以训练集 0.986 准确率作为模型可上线依据。

## 本地实验产物

以下文件保留在本地用于复核，不作为本次 Git 提交内容：

- `data/candidates-clean.jsonl`：训练候选和三值标签
- `data/classifier-clean.joblib`：新分类器
- `data/compare-pages.jsonl`：74 个新页面的纯启发式结果
- `data/compare-candidates.jsonl`：新页面候选池及 BERT 输入
- `data/compare-report.jsonl`：逐页面对比结果
- `data/compare-run-cpu.log`：CPU 运行日志

复现实验命令：

```bash
npx tsx scripts/compare-new.ts
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python -u scripts/compare_classifier.py
```
