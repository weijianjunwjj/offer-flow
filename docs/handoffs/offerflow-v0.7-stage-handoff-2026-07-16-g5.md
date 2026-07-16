# OfferFlow v0.7 阶段交接（2026-07-16，G4 → G5）

## 1. G1–G4 签收事实（回顾）

- G1 全局岗位匹配画像 MVP：用户已于 2026-07-15 验收。
- G2 CandidateEvidence 与 CapabilityBaseline：用户已于 2026-07-15 验收。
- G3 历史补录与基础漏斗：用户已于 2026-07-15 正式验收（真实数据库已受控升级到 schema v4）。
- G4 MarketPositionProfile 与 EvidenceSufficiency（含 AI 生成提案）：用户已于 2026-07-16 在隔离沙箱（schema v5）验收。
- 详见 [`offerflow-v0.7-stage-handoff-2026-07-16-g4.md`](offerflow-v0.7-stage-handoff-2026-07-16-g4.md)。

## 2. 当前实施顺序

1. G1（已验收）
2. G2（已验收）
3. G3（已验收）
4. G4（已验收）
5. **G5 StrategyWindow 与正式策略 Proposal Review（本轮，工程实现完成，等待用户 sandbox 验收）**
6. G6 最终验收与发布

v0.7 仍禁止发布，App 版本继续保持 `0.6.2`。

## 3. G5 分支与起点

- 分支：`feat/v0.7.0-g5-strategy-window`（从 `feat/v0.7.0-g4-market-position` 的 HEAD `772cead` 切出）
- 范围冻结文档：[`offerflow-v0.7-g5-strategy-window.md`](../product/offerflow-v0.7-g5-strategy-window.md)

## 4. G5 产品与工程边界（摘要，完整规则见范围冻结文档）

- G5 把 G1（岗位匹配）、G2（能力基线）、G3（漏斗）、G4（市场位置与证据充分性）转化为受门禁约束、可审核、可版本化、可撤销的阶段性求职策略。**不自动决策、不自动投递、不预测 Offer 概率。**
- **StrategyWindow 完全由确定性规则生成**：读取 G4 active 市场位置版本的全局 `evidenceLevel` 与 7 类 `DecisionGate` 状态，映射为三档窗口——`insufficient → 证据收集窗口`、`directional → 受控实验窗口`、`supported → 有限优化窗口`；窗口的允许/仅观察/禁止动作、复盘触发、停止条件、allowed/blockedClaims 全部锁定在 `src/domain/strategy-window/strategyWindow.ts`。AI 不得修改窗口任何字段。
- **DecisionGate → 策略动作门禁**集中确定性实现：降薪试探、搬迁研究、减少投入随证据等级逐级解锁；`abandon_direction` 与 `relocation_decision` 永不 `decision_ready`；不存在“直接放弃方向/直接搬迁/辞职/自动投递”这类可执行动作类型。
- **AI 只在边界内生成叙述**：复用 G4 既有共享 LLM Provider，不新增 Provider/BYOK，仅用户点击时调用；服务端先确定性生成窗口与基础草稿，AI 只返回 headline/objective/summary/uncertainties 与既有行动的 title/rationale/成功失败信号，服务端合并后对整份草稿重新执行门禁校验（`validateStrategyDraft`）；结构化输出/禁止措辞/证据引用失败最多修复一次，二次失败返回稳定错误码、不保存半成品。
- **审核与版本**：提案→接受/修改后接受/拒绝/稍后处理→正式版本；接受前不改正式版本、不修改 Job/Application/FeedbackEvent、不执行任何行动；接受后创建且仅创建一个 immutable 版本并事务化切换 active、保留 generationMode 与 decisionDiff；相同 `inputHash` 复用既有提案（`reused`）；G1/G2/G4 版本变化、G3 漏斗指纹变化或窗口到期使旧提案 `stale`，stale/到期提案不可接受；“修改后接受”仍重新校验门禁，用户不能绕过。
- **Schema v6 仅限沙箱**：新增 `strategy_meta/strategy_proposals/strategy_versions/strategy_receipts` 四表（纯新增，不改 v2–v5）；真实数据库保持 schema v4，真实生产入口不开启 G4/G5（`server/index.ts` 底部未添加 marketPosition/strategyWindow capability）。`historyImport` 启动门禁已固定为 `HISTORY_IMPORT_SCHEMA_VERSION=4`，不再随 `LATEST_SCHEMA_VERSION` 上浮，保证真实 v4 库 `npm run dev` 行为不变。

## 5. 本轮改动清单

- 新增领域层 `src/domain/strategy-window/`（types/schemas/strategyWindow/actions/draft/defaults/clone/index/testFixtures）。
- 新增服务端 `server/strategy-window/`（errors/inputSnapshot/repository/aiProvider/aiMerge/service/routes）。
- 新增迁移 `server/migrations/strategyWindowSchemaV6.ts` 并在 `server/migrations.ts` 注册 version 6、新增 `STRATEGY_WINDOW_SCHEMA_VERSION=6`、`HISTORY_IMPORT_SCHEMA_VERSION=4`，`LATEST_SCHEMA_VERSION` 升至 6。
- `server/index.ts` 新增 `StrategyWindowCapability` 与路由接线。
- 前端：`src/pages/StrategyWindowPage.vue`、`src/api/strategyWindowApi.ts`、`src/domain/presentation/strategyWindowLabels.ts`、`src/router/index.ts`（`/strategy-window` 路由与关闭重定向）、`src/config/features.ts`（`g5SandboxEnabled`）、`src/App.vue`（导航“求职策略”+ G5 隔离横幅）。
- 沙箱：`scripts/g5SandboxPrepare.ts`、`scripts/devG5Sandbox.ts`、`package.json`（`g5:sandbox:prepare` / `dev:g5-sandbox`）、`.gitignore`（`tmp/g5-sandbox/`）。`.claude/launch.json` 仅本地新增 G5 配置，不纳入提交。
- 测试：域测试（`strategyWindow.spec.ts`/`actions.spec.ts`）、服务端 `service.spec.ts`、页面 `StrategyWindowPage.spec.ts`、`src/router/router.spec.ts` 追加 G5 用例、`scripts/migrations.selftest.ts` 追加 v5→v6 块。

## 6. 验证结果（本轮实际运行）

- `npm run typecheck`：通过。
- `npm run test`：69 文件 / 604 用例全部通过（含新增域/服务端/页面/路由测试，AI 测试均使用 Fake Provider，未调用真实模型）。
- `npm run build`：通过（chunk >500kB 为既有告警，未处理）。
- `npm run selftest`：全部通过。
- `npm run migration:selftest`：通过（含 v5→v6 升级、新表 CHECK/FK、幂等）。
- `npm run test:router`：2 用例通过。
- `git diff --check`：无空白错误（仅 CRLF 提示）。
- `npm run g5:sandbox:prepare`：schema v6、integrity=ok、foreign_key_check=0、G1–G4 行数一致、strategy_* 新表为空、`sourceUnchanged=true`、`realDbUnchanged=true`。
- 浏览器读侧验证（`npm run dev:g5-sandbox`，Fake/未触发真实模型）：导航“求职策略”可见、G5 隔离横幅显示、当前窗口为“证据收集窗口”（真实 G4 样本 insufficient）、三类边界清晰、“薪资区间试探”不出现在“现在可以做”、“当前不能做”含不得降薪/搬迁、控制台无异常、页面不暴露 inputHash 等内部字段。

## 7. 真实环境现状（未受本轮影响）

- 真实数据库 `data/offerflow.sqlite3` 全程保持 **schema v4**，验证前后 sha256 一致（`cdc214c8…`），未升级、未触碰。
- 真实生产入口未开启 G4/G5；G5 生产切换（真实库受控升级到 schema v6 并在生产开放）属后续独立任务，需用户另行拍板。
- Snapshot 契约仍为 Job Memory v2，只支持 schema 2；Snapshot 升级仍是独立基础设施任务，须由用户另行裁决。

## 8. 是否调用真实模型

- 全程**未调用真实 AI 模型**：所有自动化测试使用 Fake Provider；浏览器读侧验证未点击“AI 生成”。按范围约定，接入真实 Provider 的一次生成留待用户在 sandbox 验收时明确点击。

## 9. 未改变的结论

- v0.7 仍禁止发布、禁止合并 main、禁止升级版本、禁止创建 PR/Tag/Release。
- **G5 尚未经用户验收**，本轮只完成工程实现，不得被宣称为已验收。
- 未 push、未创建 PR/Tag/Release、未合并 main、未进入 G6。

## 10. 下一阶段

- 等待用户在 G5 隔离沙箱验收：`npm run g5:sandbox:prepare` → `npm run dev:g5-sandbox` → 打开 `http://127.0.0.1:5185/#/strategy-window` → AI 生成策略提案（首次真实调用一次模型）→ 审核并接受激活正式 V1 → 相同输入复用 → 拒绝/稍后处理 → 确认真实库哈希不变。
- 用户另行拍板 G4/G5 生产切换与 Snapshot 契约升级范围后，再进入 G6 最终验收与发布准备。
