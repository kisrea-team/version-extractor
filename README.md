# 软件更新数据提取模型（规则化，不依赖 LLM）

从软件官网/GitHub 提取「最新版本号 + 更新日志」，全部确定性规则化实现，AI 仅作兜底。

## 架构

```
UpdateExtractor
├── src/sources.ts         更新源识别：GitHub releases/tags / RSS / changelog 页
├── src/version-extract.ts 版本号提取：候选评分 + 下载链接交叉验证 + 置信度
└── src/changelog.ts       更新日志提取：GitHub release body / RSS 条目 / changelog 页区块
```

## 核心思想

1. **真实版本号会反复出现** —— 标题、meta、下载链接、正文多处；垃圾版本（JS 资产/构建号）只出现一次、不在下载链接里。
2. **每次提取都带置信度** —— 只有「高置信」才可免 AI 直接写入；中/低置信必须升级 AI 复核。
3. **交叉校验** —— 提取版本必须比数据库当前版本「更大」才算更新；倒退/相等一律判定疑似错误。
4. **日志三来源分级** —— GitHub API(高) > RSS(高) > changelog 页区块(中)。

## 使用

```bash
npm install

# 基准测试（内置语料）
npm run bench

# 用自定义验证语料
npm run bench:cases

# 单 URL 探查（看来源/版本/置信/日志）
npm run probe -- <url>
```

## 基准测试

`benchmark/cases.json` 维护「经过人工验证的真值」—— 这是衡量可靠性的关键：
- `expectedVersion`：期望版本（前缀匹配，如 `v24` 匹配 `v24.18.1`）；空串 = 期望提取不到
- `expectChangelog`：期望能提取到更新日志内容
- `currentDbVersion`：交叉校验决策测试

输出每例判定（PASS / 误报 / 漏 / 错）+ 置信度 + 汇总准确率。

## 已知边界（诚实记录）

- 启发式能可靠判断「哪些是真实版本」，但**含大量 URL 的页面**上「哪个是最新」仍可能失准
  （CDN 资产/JS 版本数值更大时会干扰）。交叉校验 + 置信度门控 + AI 兜底是安全网。
- 落地路径：`get-version` 生成并建议 `version_regex` → 采纳后项目走精确正则路径，
  之后更新全确定性。

## License

MIT
