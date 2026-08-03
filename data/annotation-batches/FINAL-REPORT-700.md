# version-extractor 候选级人工标注数据集 — 最终报告（700 页）

- 目标：按 `docs/candidate-annotation-guidelines.md`（pr-feat-tier 分支）补充候选版本标注数据至累计 700 页
- 完成：**743 个唯一页面**（原始 150 页 + 新增 593 个唯一 URL，超过 550 新增目标）
- 校验：`python scripts/validate_700.py` → **errors 0**
- 统一导出：`data/dataset-annotated-700.json`（pages 743 / annotations 902）

## 累计统计

| 指标 | 值 |
|---|---:|
| 唯一页面数 | 743 |
| 原始 HTML 快照（status 200） | 778 条记录（含跨批次复核记录） |
| 候选标注 | 902 |
| `current_product` | 225 |
| `historical_product` | 117 |
| `non_product` | 63 |
| `ambiguous` | 497 |
| 批次 | batch-001 ~ batch-050 |

## 批次结构

- batch-001 ~ batch-008：原始 150 页（前一轮完成）
- batch-009 ~ batch-050：本轮新增，每批独立 `sources.json` / `annotations.json` / `html/`
- 每批均有 REPORT.md 或可审计的 manifest；快照 SHA-256 全部校验通过

## 数据来源分布

- **PG18 项目官网**（update_source_url / links）：约 40%
- **Grok 搜索发现的官方页面**（中文厂商、独立开发者、国际开源）：约 20%
- **已知官方域名批量扩展**（语言官网、发行版、媒体工具、安全工具、数据库、监控、浏览器、桌面环境等）：约 40%

## 关键审查成果

1. **页面证据优先于 PG18 快照**：如 LibreOffice 26.2.5、GDB 17.2、GnuPG 2.5.21、Vim 9.2、Wireshark 4.6.7、HandBrake 1.11.2、Ardour 9.7 等，均按当前页面实际内容标注。
2. **non_product 噪声 63 条**：Gpg4win 5.1.0（依赖套件）、最低系统版本、SVG 坐标、JS/CSS 资源版本、jQuery/Bootstrap 依赖、Cloudflare beacon 版本等。
3. **497 条 ambiguous 如实保留**：大量 SPA/营销页（Next.js、React、Vue、Svelte、Angular、Ghost、Kubernetes 等）无静态版本字段，未用数据库值强行填充。
4. **失败页面留档**：Cloudflare/验证码/超时/404 页面（约 80 条记录）保存失败状态，不猜测、不采纳。
5. **跨批次去重**：部分早期批次存在重复 URL 复核记录，已在唯一计数中剔除，不重复计入 700。

## 复现命令

```bash
cd /root/version-extractor
python scripts/export_700.py        # 生成 dataset-annotated-700.json
python scripts/validate_700.py      # 全量校验（快照哈希+字段完整性）
```

## 说明

- 未修改生产数据库，未推送远程仓库，未创建 PR。
- 训练/holdout 站点隔离划分尚未执行（下一步可选）。
- 提取器评估尚未运行（下一步可选，结果不会反向修改真值）。
