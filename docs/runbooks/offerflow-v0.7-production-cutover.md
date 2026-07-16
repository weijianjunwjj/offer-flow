# OfferFlow v0.7 生产切换操作手册（G6-B）

- 日期：2026-07-16
- 状态：**G6-B 尚未开始，必须由用户再次明确授权后才能执行。**
- 原则：逐步、可中止、可回滚。**任何步骤失败都不得自动继续**，立即转入回滚（`offerflow-v0.7-production-rollback.md`）。

## 前置

- G6-A 迁移演练、正式版本晋升演练、回滚演练全部通过；最终验收矩阵中 `productionRequired` 项此时才允许推进。
- 已验收的 G4/G5 晋升来源为 G5 沙箱 v6（`tmp/g5-sandbox/offerflow-v6.sqlite3`）。

## 步骤（每步须记录结果；失败即停止并回滚）

1. **用户授权确认**：用户明确书面授权执行 G6-B 生产切换。
2. **代码检查**：确认在正确 commit/branch，工作区干净（仅允许既有 `.claude/launch.json` 本地改动）。
3. **停止正式服务**：确保无进程持有 `data/offerflow.sqlite3` 句柄。
4. **真实库只读基线**：记录 path/schema(应为 v4)/size/mtime/SHA-256/`integrity_check`/`foreign_key_check`/G1~G3 关键表行数。
5. **一致性备份与备份验证**：生成升级前 v4 备份，记录其 SHA-256，并只读校验备份 `integrity_check=ok`、行数与基线一致（此备份即回滚锚点）。
6. **源 fingerprint 门禁**：确认真实库 SHA-256 与第 4 步基线一致（期间未被修改）；确认晋升来源沙箱 v6 存在且含 active G4/G5，其晋升包 attestation 的 `bundleHash`/`payloadCanonicalHash` 与 G6-A 记录一致。
7. **显式 v4→v6 升级**：仅在获授权后，对真实库执行受控 v4→v5→v6（不自动、须显式命令）。
8. **升级后只读验证**：schema=6、`integrity_check=ok`、`foreign_key_check=0`、G1~G3 行数与内容 hash 与基线一致、G4/G5 新表为空。
9. **导入 G4/G5 晋升包**：事务性导入（失败零写入）。
10. **导入后验证**：G4 active version、G5 active StrategyWindow/StrategyVersion 可读；`generationMode`/`decisionDiff` 保留；G5 引用的 G4 version 正确；hash/版本/行数符合 attestation；Job/Application/FeedbackEvent 行数不变。
11. **开启正式 G4/G5 入口**：在真实服务入口显式启用 marketPosition/strategyWindow capability。
12. **全链路烟测**：G1~G5 只读健康检查；AI 仅在明确点击时调用（可选，最多一次）。
13. **失败停止点**：第 7~12 任一失败，停止并转入回滚（恢复第 5 步备份），不得继续。
14. **恢复升级前备份**：见回滚手册。
15. **Snapshot 裁决执行**：按 `offerflow-v0.7-snapshot-release-decision.md` 用户裁决结果执行（推荐方案 B：以一致性备份为恢复机制并禁用旧 Snapshot 对 schema>2 的发布）。
16. **用户最终确认**：用户在真实环境确认 G4/G5 行为正确、数据无误。
17. **发布授权（分开）**：push、merge main、Tag、Release 各自需要用户单独授权，不得因切换成功自动执行。

## 停止点汇总

- 未获用户授权 → 不执行任何写操作。
- 备份/基线 hash 不一致 → 停止。
- 升级后校验失败 → 回滚。
- 晋升导入失败 → 事务回滚（零写入）→ 停止。
- 烟测异常 → 回滚。
