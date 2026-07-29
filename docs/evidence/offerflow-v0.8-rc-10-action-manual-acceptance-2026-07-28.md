# RC-10 岗位雷达动作 · 人工验收证据（已验收）

**状态：RC-10 MANUALLY ACCEPTED / DONE / ACTIVATION PENDING**
**验收日期：2026-07-28**
**验收范围：RadarAction 四族动作 + 撤销 + append-only 历史投影**

本轮由受控动作验收沙箱（`npm run action:review`，schema v8、非生产、会话级临时库）
操作采集，用户复核已完成，验收结论为 ACCEPTED。

## 最终验收口径

- RC-10（RadarAction）= Done
- schema v8 = IMPLEMENTED IN CODE / NOT ACTIVATED IN PRODUCTION
- 生产 schema = v7；Radar / Analysis / Recommendations / Promotion / Action 正式入口 = DISABLED
- 生产 v8 激活仍需独立授权（BR-1），本轮未执行
- 本文件**不得**被引用为 V8-6 整体完成的依据：V8-6 仍为 Partial（RC-11 = Partial、RC-12 未启动）

## 验收范围

沙箱前端 flag：`radar=on` / `recommendations=on` / `analysis=off`（动作栏随评审工作台渲染）。

五类场景均已人工走通：

- **四族一键切换**：收藏 / 忽略 / 标记优先 / 已投待反馈，置位后显示生效态与「撤销」入口；
- **刷新后状态恢复**：置位后刷新页面并重新打开关系，生效态由服务端事件流恢复；
- **撤销后状态恢复**：撤销后回到未生效、set 按钮重现；
- **忽略影响推荐资格**：忽略某侧候选后建议区旧结果立即清空，重新生成时该候选进入
  「被排除的候选（`ignored_unchanged`）」，撤销忽略后重新生成即恢复资格；
- **收藏 / 标记优先不误排除**：置位后重新生成建议仍包含该候选、无被排除项。

## 工程证据

- `action:e2e` 10/10 通过，连跑两次稳定（浏览器 5 + 真实 API/直读库 5）；
- `recommendation:e2e` 5/5 通过（V8-5 推荐批次无回归）；
- 全量 vitest 1409 通过（133 文件）；vue-tsc 与 build 通过；
- 不变量断言：
  - 历史 append-only——apply→revert 追加两条可追踪事件，旧 set 事件回填 `reverted` 而非改写；
  - 幂等——重复 apply 同族 `changed=false` 且不新增历史；
  - `no_response`（已投待反馈）不产生 Application / 拒绝 FeedbackEvent / 负向 CandidateEvidence；
  - 已晋升候选执行并撤销全部四族动作后，Job/Application/FeedbackEvent/Promotion 四表逐字节不变
    （`formalSig` 联合签名 + 计数比对）；
  - `integrity_check` 与 `foreign_key_check` 通过。

## 关键提交

- `d750c82`（接出岗位雷达动作与处理界面）
- `0cf8725`（测试：补齐岗位雷达动作端到端回归）
- `8715162`（工具：增加 RC-10 人工验收沙箱）

## 尚未开始 / 明确边界

- 生产 migration、备份恢复演练与正式开关切换均未授权、未执行；
- `action:review` 停机路径与既往验收脚本一致：Git Bash 的 SIGTERM 送不到 Windows 原生进程，
  实测需 `taskkill /F`；teardown 代码照搬已验证的 V8-5/V8-6 脚本；
- RC-10 Done 不改变 V8-6 整体 Partial 状态。
