# OfferFlow v0.8 · V8-4 可靠单岗位分析实施证据

> **文档版本：** 1.0
> **对应设计：** `docs/technical/offerflow-v0.8-v8-4-reliable-single-analysis-design.md`
> **对应 Traceability：** RC-07（可解释单岗位分析）、RC-12（可靠任务，单岗位部分）
> **波次：** V8-4
> **状态：** `MANUAL ACCEPTED`（2026-07-27）
> **基线：** 分支 `feat/v0.8-v8-4`，HEAD `d10736d`（回归基线）→ `a16ee85`（人工验收沙箱工具提交）；生产 schema v7，Radar 与 Analysis 正式入口 `DISABLED`；生产迁移与正式开关仍未授权
> **回归日期：** 2026-07-25（集成 worktree 一次完整回归）
> **验收日期：** 2026-07-27（人工验收沙箱 `npm run analysis:review`，114 文件 / 1191 测试 + 6 E2E 全绿，API JSON 正常，fake Provider `delayed_success` → `succeeded` 一次走通）

---

## 0. 结论（BLUF）

V8-4 可靠单岗位分析的**代码与自动化测试已实现并全绿**，覆盖设计文档的输入契约、Provider 与结构修复、执行器与有效性判断、服务编排、HTTP API、前端面板与门禁、刷新恢复，以及六个浏览器 E2E 场景。

本波次**尚未获得人工视觉/交互验收签字**，**未授权生产迁移或正式开关**。生产 schema 保持 v7，Radar 与 Analysis 正式入口保持 `DISABLED`。V8-5（RC-08 的 0～8 条推荐）与 V8-6（RadarPromotion 晋升）均**未开始**。

---

## 1. 实现提交链（真实 commit hash）

线性链，父提交 `fba6231`（文档：明确取消任务为终态）之后：

| 层 | commit | 主题 |
|----|--------|------|
| 可解释输入/输出契约 | `e75ad7b` | 功能：建立可解释岗位分析输入与输出契约 |
| 固定 Snapshot 组装 | `c2b01c2` | 功能：实现岗位分析固定输入组装 |
| Provider 与结构修复 | `4ade326` | 功能：实现岗位分析提供方与结构修复 |
| 执行器与 stale/有效性 | `e71eee9` | 功能：实现可靠岗位分析执行与有效性判断 |
| AnalysisService 编排 | `03bc27d` | 功能：实现单岗位分析服务编排 |
| HTTP API | `4bad61b` | 功能：接出单岗位分析任务接口 |
| 前端 AnalysisPanel 与门禁 | `8334603` | 功能：接出单岗位分析前端面板与门禁 |
| 刷新恢复 | `5982c9f` | 修复：支持岗位分析任务刷新恢复 |
| normal E2E | `c568930` | 测试：补齐岗位分析正常流程端到端回归 |
| repair/retry/cancel/late-result E2E | `ccbc0cc` | 测试：补齐岗位分析失败重试与取消端到端回归 |
| stale E2E | `d10736d` | 测试：补齐岗位分析过期状态端到端回归 |

> normal / repair / retry / cancel / late-result / stale 六个浏览器 E2E 场景分布于三条测试提交
> （`c568930` normal + 刷新恢复；`ccbc0cc` repair + retry + cancel + late-result；`d10736d` stale）。

---

## 2. 已验证能力

以下能力均由上述提交的自动化测试（单元/集成 + 浏览器 E2E）覆盖，本轮回归全绿：

- **deterministic createTask**：固定输入命中确定性主键 `analysis-task:v1:<inputHash>`，重复调用复用同一 task，绝不重复创建。
- **固定 Snapshot**：任务冻结 `JobMatchAnalysisInputSnapshotV1`，执行与重试均从冻结快照解析，绝不重跑 snapshot builder。
- **transport retry 与 task retry 分离**：传输层重试（provider 内）与人工 task retry（failed→queued，attemptCount 递增）互不混淆。
- **最多一次结构 repair**：malformed 输出触发至多一次结构修复；不泄漏内部修复细节；成功仅落一条记录。
- **原子 AnalysisRecord 写入**：成功时原子写入单条记录，`record.input_hash` UNIQUE 双层幂等。
- **cancellation 与 late-result suppression**：running→cancel→cancelled；迟到结果被丢弃，绝不写记录、绝不翻成功。
- **restart recovery**：进程恢复时遗留 running→failed(PROCESS_RESTART_INTERRUPTED)，queued 交回执行队列。
- **retry 复用原 Snapshot**：retry 复用原 inputSnapshot（attemptCount 1→2），不重建快照。
- **current / stale 查询投影**：有效性由记录冻结版本与当前 active 版本 + policy 常量比较派生；本波次 stale E2E 经真实推进 active JobMatchProfile 版本触发 `job_match_profile_changed`，旧记录呈现「历史参考」且不新建任务、不调 Provider。
- **七个 Analysis HTTP 接口**：createTask / runTask / getTask / retryTask / cancelTask / getAnalysis / listCandidateAnalyses，复用 Radar 采集桥安全网关（loopback + Host + Origin + capture-client 头）。
- **disabled-by-default 前端 Flag**：`RadarAnalysisPanel.vue` 受能力门禁控制，正式入口默认关闭。
- **刷新恢复**：凭 sessionStorage 按 candidateVersionId 分键的 taskId 指针恢复任务态，不重复 create、不再次 run。
- **Job / Application / FeedbackEvent 零污染**：E2E 断言三表计数与候选版本/规则评估签名不变、integrity_check=ok、foreign_key_check=0。

---

## 3. 本轮真实质量数字

2026-07-25 在独立集成 worktree（`feat/v0.8-v8-4` @ `d10736d`）一次完整回归的真实结果：

| 门禁 | 命令 | 结果 |
|------|------|------|
| 类型检查（Vue） | `npx vue-tsc --noEmit` | 通过（0 错误） |
| 类型检查（根 tsconfig） | `npx tsc --noEmit -p tsconfig.json` | 通过（0 错误） |
| 类型检查（扩展 tsconfig） | `npx tsc --noEmit -p browser-extension/tsconfig.json` | 通过（0 错误） |
| 单元/集成测试 | `npx vitest run` | **114 文件 / 1191 测试全部通过** |
| 生产构建 | `npm run build` | 成功（仅 chunk>500kB 的既有告警） |
| 迁移自检 | `npx tsx scripts/migrations.selftest.ts` | `migrations.selftest: passed` |
| 评审工作台 E2E | `npm run review:e2e` | **11 项全部通过** |
| 单岗位分析 E2E | `npm run analysis:e2e` | **6 项全部通过** |
| 空白差异检查 | `git diff --check` | 干净 |
| 临时资源 | os.tmpdir 残留 `offerflow-analysis-e2e-*` | 无 |
| 生产库 | `data/offerflow.sqlite3` | 未创建、未访问 |

---

## 4. 状态与边界（严格）

- **V8-4：** `IMPLEMENTATION COMPLETE / MANUAL ACCEPTANCE PENDING`
- **RC-07（可解释单岗位分析）：** `Partial`
- **RC-12（可靠任务，单岗位部分）：** `Partial`
- **生产 schema：** `v7`（未推进 `PRODUCTION_SCHEMA_VERSION`，保持 2）
- **Radar 正式入口：** `DISABLED`
- **Analysis 正式入口：** `DISABLED`

明确未完成/未授权事项：

- **V8-5 的 0～8 条推荐（RC-08 及其 0–8 条建议）尚未开始。**
- **V8-6 promotion（RadarPromotion 晋升）尚未开始。**
- **人工视觉与交互验收尚未签字。**
- **生产迁移与正式开关未授权**（不激活生产 Radar/Analysis、不升级生产数据库）。

本文档仅记录实施与自动化回归证据，不构成人工验收结论，也不授权任何生产变更。
