# RC-11 岗位晋升反向追踪 · 人工验收证据（已验收）

**状态：RC-11 MANUALLY ACCEPTED / DONE / ACTIVATION PENDING**
**验收日期：2026-07-28**
**验收范围：晋升双向可追溯性（正向来源链 + 三类正式对象反查）只读界面**

本轮由受控追踪验收沙箱（`npm run trace:review`，schema v8、非生产、会话级临时库）
操作核对，用户复核已完成，验收结论为 ACCEPTED。

## 最终验收口径

- RC-11（RadarPromotion 反向追踪）= **Done**（RC-09 晋升功能层此前已人工验收通过，2026-07-27）
- schema v8 = IMPLEMENTED IN CODE / NOT ACTIVATED IN PRODUCTION
- 生产 schema = v7；Radar / Analysis / Recommendations / Promotion / Action 正式入口 = DISABLED
- 生产 v8 激活仍需独立授权（BR-1），本轮未执行
- **本文件不得被引用为 V8-6 整体完成或 v0.8 产品验收的依据**：
  - V8-6 仍为 `PARTIAL`：30 条评测、v8 migration/backup/recovery、截图与产品验收三项未开始，RC-12 未启动；
  - v0.8 产品验收 = **HELD（暂缓）**，等待后续 UX 收口波次与 V8-6 剩余交付。

## 验收范围

沙箱前端 flag：`radar=on` / `recommendations=on`（追踪面板随晋升面板渲染）。已预建覆盖各追踪场景的晋升 fixture。

以下场景均已人工走通：

- **正向来源链（UI）**：点建议「晋升」→ 预览 → 确认后，晋升面板下方自动展示
  候选版本（快照锚点）/ 触发原因 / 推荐批次 / 正向正式对象；
- **三类正式对象反查（UI 统一只读查询区）**：Job / Application / FeedbackEvent 均可反查到引用它的晋升；
- **link 模式**：同一 Job 被多份晋升引用时全部列出并提示「一对象对应多份晋升」；
- **触发四态如实呈现**：未记录 / 已解析 / 已撤销（标注「已撤销，但正式事实链路保留」）；
  `action_missing`（因 `trigger_action_id` FK `ON DELETE RESTRICT` 无法自然构造）由服务/组件单测覆盖；
- **推荐批次成员推断**：显式标注「按候选版本成员关系推断（非确定因果）」并展示 `wasSelected`；
- **无来源明确不可追溯**：无引用晋升的正式对象反查显示「不可追溯」，绝不编造；
- **刷新后追踪保持**：刷新页面重走幂等晋升，来源链展示同一份晋升记录（后端持久化，非仅前端态）；
- **纯只读**：追踪面板不含删除 / 修改 / 自动修复任何入口。

## 工程证据

- `trace:e2e` 13/13 通过，连跑两次稳定（浏览器 4：正向 UI 链 / 三类反查 + link / 无来源 / 刷新保持；
  真实 API 与直读库 9：正向来源链、三类反查、link 多晋升、未记录触发、批次成员推断且
  `wasSelected` 与库 `selected_candidate_version_ids_json` 实测一致、撤销 RadarAction 后追踪照常且
  正式对象仍完整可溯、无来源 `traceable=false` / 晋升不存在 404、追踪只读五表零写入、
  `integrity_check` 与 `foreign_key_check`）；
- `promotion:e2e` 11/11 通过（V8-6 晋升写入闭环无回归，晋升面板内嵌追踪面板未破坏原流程）；
- 全量 vitest 1434 通过（136 文件），新增追踪面板组件单测 16 例；vue-tsc 与 build 通过；
- 关键不变量断言：
  - **追踪纯只读**——连续调用正向/反查/无来源/404 各端点后，Job/Application/FeedbackEvent/Promotion/Action
    五表计数逐字节不变；
  - **撤销不破坏追踪**——撤销触发 RadarAction 后，来源链仍解析该动作并标注 `reverted=true`，
    正式对象仍完整追溯到原晋升（正式事实链路与 Radar 决策态解耦）；
  - **忠实透传不臆测**——批次仅按候选版本成员关系推断且显式标注非确定因果；无引用即 `no_promotion`；
  - `integrity_check` 与 `foreign_key_check` 通过。

## 关键提交

- `fe86dd4`（功能：实现岗位晋升反向追踪界面）
- `f64ed6b`（测试：补齐岗位晋升追踪端到端回归）
- `0ab55ae`（工具：增加 RC-11 人工验收沙箱）

## 尚未开始 / 明确边界

- V8-6 剩余交付未开始：30 条晋升评测、v8 migration/backup/recovery 演练、截图与**产品验收**；RC-12 发布闭环未启动；
- v0.8 产品验收**暂缓**，等待后续 UX 收口波次；
- 生产 migration、备份恢复演练与正式开关切换均未授权、未执行；
- link 模式仍无 UI 晋升入口（仅经 API 构造 fixture 验证反查），与 RC-09 边界一致；
- `trace:review` 停机路径与既往验收脚本一致：Git Bash 的 SIGTERM 送不到 Windows 原生进程，
  实测需 `taskkill /F`；teardown 代码照搬已验证的 V8-5/V8-6/RC-10 脚本；
- RC-11 Done 不改变 V8-6 整体 `PARTIAL` 状态，也不构成 v0.8 产品验收。
