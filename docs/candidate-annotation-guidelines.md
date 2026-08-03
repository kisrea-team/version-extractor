# 候选版本人工标注规范

**版本：** 1.0
**用途：** 为版本候选分类器补充高质量监督数据
**适用对象：** 执行候选标注任务的 AI 或人工标注员

## 1. 标注目标

页面中经常同时出现多种数字：产品版本、历史版本、构建号、依赖包版本、SDK/API 版本、系统最低版本、CSS/SVG 坐标和日期。本任务不是判断“哪个数字最大”，而是判断每个候选数字在页面中的**产品归属、版本类别和时间状态**。

模型最终需要学会两件事：

1. 这个候选是不是目标产品的版本；
2. 如果是多个产品版本中的一个，它是不是当前/最新产品版本。

标注时必须优先提供页面证据，让模型学习“标题、下载链接、版本字段、正文和噪声上下文”的区别。

## 2. 标注输入

每条候选通常包含：

```json
{
  "url": "https://example.com/download",
  "version": "v1.2.3",
  "text": "候选: v1.2.3 [SEP] 上下文: [download-link] ...",
  "scopes": ["download-link", "heading"],
  "labelReason": "ambiguous-semantic-candidate"
}
```

字段含义：

- `url`：候选来自哪个页面。
- `version`：需要判断的候选版本号。
- `text`：候选版本和提取到的上下文。
- `scopes`：上下文来源：`title`、`meta`、`heading`、`visible`、`download-link`、`structured`、`noise`。
- `labelReason`：程序当前的预标注原因，不是真值。不能只看这个字段决定标签。

如果平台提供 HTML 快照，必须同时查看候选附近的原文、链接目标和字段名。只凭候选数字本身不能可靠标注。

## 3. 主标签

主标签必须四选一，互相排斥：

| 标签 | 含义 | 是否进入二分类正样本 |
|---|---|---:|
| `current_product` | 目标产品当前、最新、稳定或页面唯一明确的产品版本 | 是 |
| `historical_product` | 目标产品真实的历史版本、旧版本或版本列表项，但不能确认是当前版本 | 否，默认用于排序 |
| `non_product` | 不是目标产品版本 | 否，作为明确负样本 |
| `ambiguous` | 证据不足、冲突或无法确定 | 否，保留做主动学习 |

### 3.1 `current_product`

标为 `current_product` 的必要条件：候选明确属于页面目标产品，并且有至少一项当前性证据：

- 标题、主标题或正文明确写 `latest`、`current`、`stable`、`new release`、`最新版本` 等；
- 下载按钮、安装包链接或官方版本字段明确指向该候选；
- 页面只有一个明确的产品版本，且没有相互冲突的版本候选；
- 结构化字段明确是目标产品的 `version`、`latestVersion`、`releaseVersion` 等，而不是依赖或构建字段。

`v1.2.3` 这种格式本身不能证明它是当前产品版本。

### 3.2 `historical_product`

标为 `historical_product` 的情况：

- changelog/release history 中的旧版本；
- 版本列表中确实属于目标产品，但页面没有说明它是当前版本；
- 旧下载项、旧安装包、旧发行记录；
- 页面正文明确说 `previous`、`older`、`archive`、`历史版本`。

不要把历史产品版本标成 `non_product`。它是真实产品版本，只是不适合作为“当前版本”的二分类正样本。

如果一个版本列表按时间顺序排列，且页面明确标出最新项，可以将最新项标为 `current_product`，其他项标为 `historical_product`。不能只按版本号最大判断最新项。

### 3.3 `non_product`

候选明确不属于目标产品版本时标为 `non_product`，并填写一个 `noiseType`：

| `noiseType` | 典型证据 |
|---|---|
| `build` | `buildNumber`、`build_number`、内部构建号、commit/revision、SaaS 部署编号 |
| `sdk` | SDK、开发工具包、最低 SDK、编译 SDK |
| `api` | API、协议、schema、接口版本 |
| `os` | `minimumOsVersion`、系统要求、Windows/macOS/iOS/Android 版本 |
| `dependency` | npm 包、插件、扩展、库、组件或依赖 manifest 的版本 |
| `css` | CSS 属性、字号、行高、间距、类名中的数字 |
| `svg` | SVG `viewBox`、`path`、坐标、`width`、`height`、`points` |
| `asset` | JS/CSS/map 文件名、chunk、webpack、图片/资源 URL |
| `date` | 日期、发布时间日期、年份或时间戳 |
| `other_noise` | 价格、数量、尺寸、统计值、订单号等其他非版本数字 |

只有有证据时才标 `non_product`。不要因为版本号很大、没有 `v` 前缀或看起来“不像软件版本”就单独判负。

### 3.4 `ambiguous`

遇到以下情况标为 `ambiguous`：

- 页面无法加载、上下文被截断或候选来源不明；
- 同一候选可能属于主产品，也可能属于插件/依赖；
- 可见文本、下载链接和结构化字段互相冲突；
- 多个产品共用页面，无法确认候选属于哪个产品；
- 只能根据数字大小、出现次数、域名或经验猜测；
- 页面只显示构建号，但没有证据证明它是产品公开版本；
- 标注员与页面证据无法达成高/中置信判断。

`ambiguous` 是合格结果，不要为了提高完成数量强行选择其他标签。

## 4. 辅助字段

建议每条标注包含以下字段：

```json
{
  "pageId": "页面或快照 ID",
  "url": "https://example.com/download",
  "version": "v1.2.3",
  "pageStatus": "product-page",
  "label": "current_product",
  "noiseType": null,
  "temporalStatus": "current",
  "subject": "target-product",
  "evidenceTypes": ["heading", "download-link"],
  "evidenceQuote": "Download Example 1.2.3",
  "confidence": "high",
  "note": "页面唯一下载版本，链接目标包含该版本",
  "annotator": "annotator-01",
  "reviewStatus": "single-pass"
}
```

字段规则：

- `pageStatus`：`product-page`、`release-history`、`changelog-rss`、`structured-endpoint`、`mixed`、`unusable`。
- `temporalStatus`：`current`、`historical`、`not-applicable`、`unclear`。
- `subject`：`target-product`、`dependency`、`plugin`、`system`、`unknown`。
- `evidenceTypes`：只能填写实际观察到的来源：`title`、`meta`、`heading`、`visible`、`download-link`、`structured`、`url`、`noise`。
- `evidenceQuote`：复制页面中的短原文，通常不超过 200 个字符；不要只写“看起来像版本”。
- `confidence`：`high`、`medium`、`low`。低置信度通常应使用 `ambiguous`。
- `annotator`：标注者名称或 AI 模型标识。
- `reviewStatus`：`single-pass`、`rule-checked` 或 `needs-review`。

### 4.1 证据优先级

通常按以下顺序参考，但证据冲突时必须记录冲突：

1. 官方下载链接或安装包链接；
2. 页面标题、主标题和明确的当前/最新语义；
3. 官方结构化 `version`/`latestVersion` 字段；
4. 正文版本说明；
5. 普通 URL 文本；
6. 出现次数、数字大小和格式外观。

第 6 类只能作为辅助线索，不能单独决定标签。

## 5. 页面级与候选级流程

对每个页面执行：

1. 判断页面类型和目标产品是谁。
2. 列出页面中所有待标候选，不只看程序当前选中的一个。
3. 对每个候选确认它的直接上下文、来源 scope、链接目标和字段名。
4. 先判产品归属，再判当前/历史状态，最后填写证据和置信度。
5. 页面中目标产品、插件、依赖和系统版本混在一起时，逐候选分别标注。
6. 页面无法判断时标 `ambiguous`，并填写阻碍判断的原因。

不要整页统一标正或统一标负。一个页面可以同时有 `current_product`、`historical_product` 和 `non_product`。

## 6. 必须覆盖的高价值难例

这些样本优先级最高，因为它们直接对应当前模型错误：

### A. 产品版本 vs 构建号

如果页面同时出现 `Version 4.6` 和 `Build 14.44`：

- `4.6`：通常是产品版本，依据页面语义标 `current_product` 或 `historical_product`；
- `14.44`：若明确是 build，标 `non_product/build`；
- 如果页面没有说明两者关系，相关候选可标 `ambiguous`。

### B. 版本列表和 changelog

- 明确标为 latest/current 的项：`current_product`；
- 其他真实发行项：`historical_product`；
- 日期、作者编号和 commit：`non_product/date` 或 `non_product/build`；
- 不要因为不等于数据库当前版本就标负。

### C. 结构化接口

先确认字段属于谁：

- 目标产品的 `version`、`latestVersion`：可标产品版本；
- `minimumOsVersion`、`sdkVersion`、`buildNumber`：`non_product` 对应子类；
- 包注册表或插件市场中的版本：如果目标是包/插件本身，可标 `current_product`；如果目标是主产品，通常是 `dependency` 或 `ambiguous`。

### D. 下载链接和多个平台

同一产品的 Windows、macOS、Linux 安装包都可能携带同一产品版本。不要把平台名称、架构、文件大小或发布日期当成版本。多个不同版本的安装包要依据页面的 latest/旧版语义区分当前和历史。

### E. SVG/CSS/JS 噪声

出现于 SVG path、`viewBox`、坐标、CSS `font-size`/`line-height`、JS chunk、map 文件或资源 URL 中的数字，标 `non_product`，不要受附近产品标题影响。

### F. SaaS 和内部版本体系

SaaS 页面可能只展示部署号、发布日期或内部 revision。没有证据表明它是用户可见产品版本时标 `non_product/build`；如果同时有公开产品版本和内部号，分别标注。

### G. 产品与插件/依赖混杂

候选属于插件、扩展、主题、SDK 或 npm 包时，不要因为它出现在官方产品域名下就标为目标产品版本。填写 `subject`，必要时使用 `dependency` 或 `ambiguous`。

## 7. 禁止的标注方式

以下理由不能单独形成标签：

- “数字最大，所以是当前版本”；
- “有三个上下文，所以一定是真的”；
- “URL 是官方网站，所以所有版本都是产品版本”；
- “没有 `v` 前缀，所以一定不是版本”；
- “数据库当前版本是 X，所以页面其他版本都错”；
- “程序预标成 unknown/negative，所以直接照抄”；
- 通过页面之外的搜索结果替换当前快照证据。

## 8. 标注优先级

不要随机平均标注全部候选。按以下顺序获取对模型最有价值的数据：

1. 纯启发式和 BERT 最终选择不一致的页面；
2. BERT 概率接近 0.5 的候选；
3. BERT 高概率但上下文明确是 build、SDK、依赖、SVG/CSS 的候选；
4. 纯启发式选错、但正确版本已存在候选池的页面；
5. 17 个正确版本没有进入候选池的页面，补充页面级/候选召回信息；
6. changelog、release、下载页中尚未确认的多版本候选；
7. 其他 unknown 样本。

每个页面尽量覆盖一个正例和多个 hard negative，不要只收集简单的 `v1.2.3` 正例。

## 9. AI 标注质量控制

- AI 每条标注必须输出证据引用、证据类型、置信度和简短理由；没有证据时使用 `ambiguous`。
- 标注完成后运行规则自检：主标签互斥、`non_product` 必须有 `noiseType`、`current_product` 必须有当前性证据、`evidenceQuote` 非空且来自上下文。
- 对 `ambiguous`、证据冲突页面、产品/依赖混合页面和高影响难例自动设置 `reviewStatus: needs-review`，不要强行转换为训练标签。
- 普通样本使用 `reviewStatus: rule-checked`；人工只需抽查规则自检失败、低置信度和模型训练后的高影响误判。
- 按主标签、噪声子类和页面类型统计分布；若某类样本异常集中，先检查标注规则和输入上下文。
- 同一产品、域名、模板族和近重复页面必须在同一个训练/验证/holdout 分组，防止数据泄漏。

## 10. 训练数据转换

人工标签到训练任务的转换：

```text
current_product    -> 二分类正样本 1
non_product        -> 二分类负样本 0
historical_product -> 默认不进入二分类；作为页内排序候选
ambiguous          -> 不进入监督训练；进入主动学习/评估池
```

排序任务可以在同一页面构造：

```text
current_product > historical_product > non_product
```

但只有页面证据明确支持该顺序时才构造排序对。不要跨页面比较版本号，也不要把不同产品的版本号组成训练对。

训练/验证/测试必须按产品或页面组切分，而不是随机按候选行切分。每轮训练都要报告：页面数、产品数、各主标签数量、各噪声子类数量、unknown/ambiguous 数量、正负比例和跨页面 holdout 结果。

## 11. 交付格式

推荐使用 UTF-8 JSONL，一行一个候选。可复制以下模板：

```json
{"pageId":"page-id","url":"https://example.com/download","version":"v1.2.3","pageStatus":"product-page","label":"current_product","noiseType":null,"temporalStatus":"current","subject":"target-product","evidenceTypes":["heading","download-link"],"evidenceQuote":"Download Example 1.2.3","confidence":"high","note":"页面唯一公开下载版本","annotator":"annotator-01","reviewStatus":"single-pass"}
```

`non_product` 示例：

```json
{"pageId":"page-id","url":"https://example.com","version":"v11083","pageStatus":"mixed","label":"non_product","noiseType":"build","temporalStatus":"not-applicable","subject":"target-product","evidenceTypes":["structured","noise"],"evidenceQuote":"buildNumber: 11083","confidence":"high","note":"字段明确是构建号","annotator":"annotator-01","reviewStatus":"single-pass"}
```

`historical_product` 示例：

```json
{"pageId":"page-id","url":"https://example.com/releases","version":"v1.1.0","pageStatus":"release-history","label":"historical_product","noiseType":null,"temporalStatus":"historical","subject":"target-product","evidenceTypes":["visible","download-link"],"evidenceQuote":"Previous release 1.1.0","confidence":"high","note":"目标产品真实旧版本","annotator":"annotator-01","reviewStatus":"single-pass"}
```

## 12. 开始前的小批试标

正式标注前先抽取 50--100 条，必须覆盖四类主标签、每个主要噪声子类、版本列表、结构化字段、下载链接和歧义样本。先用 AI 完成单轮标注，再运行规则自检：

- 自检发现标签定义问题：修订规范后重新标注；
- 自检发现页面证据缺失：补充 HTML/context 展示并标为 `ambiguous`；
- 自检发现 current 与 historical 混淆：增加页面时间语义示例；
- 自检发现 build 与产品版本混淆：增加字段名和链接目标示例；
- 只对低置信度、冲突和高影响误判样本安排人工抽查，不要求全量人工复核。

小批试标通过后再扩大规模。目标不是尽快标完，而是获得能改善跨页面泛化的正例、hard negative 和结构化证据。
