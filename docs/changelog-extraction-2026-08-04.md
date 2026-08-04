# Changelog 提取：版本锚定 + Trafilatura 清洗（2026-08-04）

## 结论摘要

更新日志提取从基线 **0/6** 提升到 **6/6 全部干净正文**（python/blender/obsidian/nginx/postgresql/gimp），额外 10 个新 URL 验证 **9/10 成功**（GitHub、纯文本、博客、SPA、文档站、App Store 全覆盖）。

核心设计：**不猜 changelog 结构**，用「版本锚定 + 整页 Trafilatura 清洗」：

```text
已知版本号（版本提取器结果）
  → 确认页面是日志页（有版本锚点）
  → Trafilatura 整页提取正文（结构无关的文本密度算法）
  → 干净 Markdown
```

## 为什么不用"猜结构"

早期尝试 `detectChangelogType` 正则分类（纯文本/标题/列表/博客/JS渲染）——**失败**：
- nginx `Changes with nginx 1.31.3` 正则没匹配到，误判
- gimp 博客结构没匹配
- postgresql 列表页被误判成纯文本

结论：changelog 结构差异是**无界的**，正则猜不准。正确做法是**不猜**——版本号是确定的锚，Trafilatura 是结构无关的正文提取器。

## 架构

```
extractFromUrl(URL)
  ├─ L3 官方端点 / L0 注册表 → 版本
  ├─ L1 启发式提取版本号
  ├─ L2 浏览器渲染（SPA 兜底）
  └─ extractChangelog（版本锚定 + Trafilatura）
      ├─ 规则层：纯文本（nginx）/ 列表跟随（postgresql）/ 博客跟随（python）
      ├─ 质量门控 goodEnough（长度 >300 + 无 HTML 残片 + 无版权/面包屑）
      └─ 不足时 → Playwright 渲染整页 → Trafilatura 清洗
```

### 关键设计

1. **版本锚定，不猜结构**：用已知版本号（或"最新版数字最大"）定位，正文交给 Trafilatura 整页提取，不纠结容器边界。

2. **分层降级**：
   - 规则层优先（纯文本/标题式/列表跟随），已验证干净
   - 内容脏（<300 字符/含残片/版权）→ 降级浏览器
   - 静态抓取失败（反爬/SPA）→ 浏览器渲染
   - Trafilatura 失败 → turndown

3. **质量门控 goodEnough**：
   ```ts
   content.length > 300
   && 无 </li><ul> 等 HTML 残片
   && 无 Creative Commons / Canonical URL / [Prev][Up] 面包屑
   ```

4. **版权/法律链接排除**：`findLatestVersionLinkWithVersion` 排除 creativecommons/license/privacy 链接，避免 gimp 把 CC `4.0` 当最新版。

5. **Trafilatura UTF-8 修复**：Windows 控制台默认 GBK，输出非 GBK 字符崩溃 → 脚本 `sys.stdout.reconfigure(encoding='utf-8')`。

## 验证结果

### 原始 6 例（从 0/6 → 6/6）

| 页面 | 版本 | 长度 | 内容 |
|---|---|---|---|
| python | v3.15.0 | 691 | ✅ 干净正文 |
| blender | v2.9 | 365 | ✅ |
| obsidian | v1.13 | 9174 | ✅ JS 渲染 |
| nginx | v1.31.3 | 2359 | ✅ 纯文本 |
| postgresql | v18.4 | 2758 | ✅ 列表跟随 |
| gimp | v3.2.4 | 10583 | ✅ 博客 |

### 新 URL 验证（9/10）

| 页面 | 结果 |
|---|---|
| vscode/next.js/nodejs (GitHub) | ✅ |
| firefox / libreoffice / wordpress | ✅ |
| rust blog / kubernetes / gimp | ✅ |
| docker (docs.docker.com) | ✅ 浏览器渲染 |

### 单入口端到端（ccswitch）

```text
extractFromUrl('https://www.ccswitch.io/zh/changelog/')
  → 版本: v3.19.1 (json-ld)
  → 日志: v3.19.1, 18066 字符
```

## 产物

- `src/changelog.ts`：规则层 + 质量门控 + 版权过滤 + 列表/博客跟随
- `src/changelog-ai.ts`：浏览器渲染 + Trafilatura 整页提取
- `src/pipeline.ts`：changelog 走完整兜底（含浏览器）
- `scripts/trafilatura_clean.py`：Python Trafilatura 清洗入口（UTF-8 修复）

## 复现

```bash
# 需要 trafilatura
python -m pip install trafilatura

# 单 URL 版本 + 日志
npx tsx -e "import('./src/pipeline.ts').then(async m => { const o = await m.extractFromUrl('https://www.python.org/news/', {}); console.log(o.version.version, o.changelog?.version, o.changelog?.content?.length); await m.closeBrowser(); })"

# 完整评估
npx tsx scripts/eval-changelog.ts
```
