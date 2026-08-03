# version-extractor 候选级人工标注数据集 — 最终报告（150 页）

- 目标：按 `docs/candidate-annotation-guidelines.md`（pr-feat-tier 分支）补充候选版本标注数据
- 范围：150 个非 GitHub、非 App Store 官网项目页面，候选级标注
- 校验：`python scripts/validate_all_batches.py` → **0 errors**
- 统一导出：`data/dataset-annotated-150.json`

## 总量

| 指标 | 值 |
|---|---:|
| 页面数 | 150 |
| 原始 HTML 快照 | 150 |
| 渲染后 HTML 快照 | 24 |
| 候选标注 | 235 |
| 批次 | 8（batch-001 ~ batch-008） |

## 标签分布

| label | 数量 | 说明 |
|---|---:|---:|
| current_product | 78 | 当前/最新/页面唯一明确的产品版本 |
| historical_product | 52 | 产品历史版本 |
| non_product | 44 | 非产品版本（噪声） |
| ambiguous | 61 | 证据不足，未使用 PG18 快照强行标注 |

## 噪声类型分布

sdk:8, os:10, asset:2, build:8, svg:2, dependency:11, date:1, api:3

## 来源类型覆盖

- 下载页/产品页：Sublime Text、Total Commander、HeidiSQL、WinRAR、DaisyDisk、xScope、Shottr 等
- 发布说明/更新日志：Typora、Wireshark、Fantastical、Things、Kaleidoscope、OmniFocus、PopClip 等
- 纯文本变更记录：OpenSSL、Bandizip、Everything、7-Zip、IrfanView
- XML/RSS/JSON 更新源：Rectangle Pro、Krita、Draw Things、Postman、Obsidian Mobile、坚果云
- 中文官网：Flomo、Snipaste、钉钉、Quicker、PixPin、可灵AI、MarsCode、滴答清单、Qwen Chat、超级右键
- SaaS changelog/营销页：Notion、Cursor、Windsurf、Lovable、Reclaim.ai、Calendly 等
- 结构化元数据：Dash、WinToUSB、Flotato、Shottr（JSON-LD softwareVersion）
- 混合噪声页：GitKraken、Sketch、OrbStack、Trae、Hailuo、Insomnia、DaVinci Resolve、Warp

## 审查要点

1. **PG18 快照不作为真值**：仅作候选发现；发现多处过时快照并按页面证据修正
   - GitKraken 12.2.1（快照 11.10.0）、BetterTouchTool 6.692（快照 6.284）、IrfanView 4.75（快照 4.73）、Zotero 9.0.6（快照 8.0.4）、RunJS 4.1.0（快照 1.0.0）、Krita 5.3.3（快照 5.2.16）、Fork 2.69（快照 2.17.1）、IntelliJ 2026.2（快照 2025.3）、Ableton 12.4.3（快照 12.3.6）、Postman 12.22.0（快照 12.2.2）、Zoom 7.1.6（快照 6.7.7）、iStat Menus 7.3（快照 7.2）、Timing 2026.4.1（快照 1.0.0）等
2. **非产品版本正确分离**：SDK（Segment 4.16.1、RudderStack 3.2.0、React 18.2.0）、依赖（jQuery、Bootstrap、Electron 43.1.1、Moment.js 2.30.1）、OS 最低版本（macOS 10.13+）、构建号（Kaleidoscope 10509、TablePlus 752、iStat 2273）、SVG/资源坐标、日期、AI 模型名（Kling Image 3.0、NovelAI V4.5）
3. **ambiguous 保留证据不足样本**：61 条（26%），不编造版本；如 Slack、Cursor、Windsurf、OrbStack 等 SPA 页面原始 HTML 无版本证据
4. **不可达页面记录失败不猜测**：Kafka 重定向壳、Cinema 4D 403、Enpass/Sora/VirtualBox/Adobe/Arc 超时，均记录后替换为其他官网页面
5. **每条标注含**：pageId/url/pageStatus/version/label/noiseType/temporalStatus/subject/evidenceTypes/evidenceQuote/confidence/note/annotator/reviewStatus/fetchedAt/htmlFile/renderedHtmlFile/snapshotSha256

## 目录结构

```text
data/annotation-batches/
├── batch-001/ ~ batch-008/
│   ├── REPORT.md
│   ├── html/           原始 HTTP HTML（150）
│   ├── rendered/       Playwright 渲染 DOM（24）
│   └── manifests/
│       ├── sources.json       页面+抓取元数据+快照哈希
│       └── annotations.json   候选级标注
data/dataset-annotated-150.json  统一导出（pages+annotations）
scripts/validate_all_batches.py  全量校验脚本
```

## 说明

- 未提交 PR、未推送远程、未修改生产数据库（按用户要求等待授权）
- 训练/测试集站点隔离、holdout 划分尚未进行（可后续按 URL 域名划分）
