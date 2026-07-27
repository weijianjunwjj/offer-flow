# V8-5 岗位建议批次 · 人工验收证据（已验收）

**状态：ACCEPTED / ACTIVATION PENDING**
**验收日期：2026-07-27**

本轮由受控推荐验收沙箱（`npm run recommendation:review`，schema v8、非生产、会话级临时库）
操作采集，用户复核已完成，验收结论为 ACCEPTED。

## 最终验收口径

- V8-5 = ACCEPTED / ACTIVATION PENDING
- RC-08（0～8 条推荐）= Done
- schema v8 = IMPLEMENTED IN CODE / NOT ACTIVATED IN PRODUCTION
- 生产 schema = v7；Radar / Analysis / Recommendations 正式入口 = DISABLED
- 生产 v8 激活仍需独立授权（BR-1），本轮未执行

## 验收范围

沙箱前端 flag：`radar=on` / `recommendations=on` / `analysis=off`
（同时证明推荐面板独立于 V8-4 前端门禁）。

三个场景均已人工走通：

- **正常推荐**：疑似重复关系生成 2 条建议，`apply_now` 排序先于 `stretch`，
  每条含结论类型、置信度、理由、证据引用与适用条件；
- **0 条建议**：`needs_recheck` 关系两侧均无 current 成功分析，
  展示 `emptyReason = no_current_successful_analysis`，不凑数；
- **blocked**：wide scope 预建批次展示 8 条建议 + 2 条硬约束命中
  （`hard_constraint_hit`）的被排除候选，逐条给出确定性阻断原因。

## 工程证据

- `recommendation:e2e` 5/5 通过（生成/幂等/切换与 0 条/加载最新 + blocked/零写入）；
- `review-e2e` 11/11 通过（V8-3 评审工作台无回归）；
- 全量 vitest 1254 通过；vue-tsc 与 build 通过；
- 零写入断言：`jobs` / `applications` / `feedback_events` 计数不变，
  候选版本、规则评估、分析记录表签名不变，`integrity_check` 与 `foreign_key_check` 通过。

## 附带的 UI 结构修复（V8-5.5）

验收过程中发现推荐入口埋在长页面底部，已在验收前修复并复验：

- 推荐面板上移至候选对比区顶部、先于候选详情；未选关系时提示「请先选择一组岗位」；
- 决策工作台主内容宽度提升至 1520px，顶部两列限高 + 内部滚动；
- 状态 Tag 中文化，内部 ID / 版本号 / 证据默认弱化或折叠。

## 尚未开始

- **V8-6（RadarPromotion 正式晋升、30 条评测、发布验收）未开始。**
- 生产 migration、备份恢复演练与正式开关切换均未授权、未执行。
