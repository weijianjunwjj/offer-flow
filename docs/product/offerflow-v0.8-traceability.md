# OfferFlow v0.8 PRD—Implementation Traceability

> **矩阵版本：** 1.0  
> **对应 PRD：** v2.1  
> **v0.8 总体状态：`ENGINEERING COMPLETE / RELEASE CANDIDATE`（v0.8.0-rc1，2026-07-29）——非 GA。** 判定依据：RC-01～RC-08、RC-10、RC-11 = Done；V8-4 / V8-5 / V8-6 功能开发完成；V8-UX 收口（三阶段主线 + 信息噪声降噪）实现完成，**仅剩「人工无说明 smoke」一项待补**；RC-09 Not Started、RC-12 `Partial / Blocked`。发布判定条件仍被阻塞、不由工程侧解除：**① 30 条真实评测——数据与人工标注阻塞。**（原「② 生产 v8 migration / backup / recovery——授权阻塞 BR-1」已于 2026-07-29 完成：生产库 v7→v8 受控迁移 + baseline backup + 克隆演练 + 只读启动 smoke 全通过，证据 `docs/evidence/offerflow-v0.8-production-schema-v8-activation-2026-07-29.md`；**此项非产品版本口径变更，产品仍 v0.8.0-rc1**。）因此本版本**只能声明 Release Candidate，不得声明 GA / 正式发布 / 版本完成**；GA 仍需 RC-09 完成、30 条评测通过、核心页面真实截图与产品文案人工验收、用户明确批准发布（见 Release Contract §4）。生产库 schema 已为 v8，但 Radar / Analysis 正式入口仍 DISABLED、未启用任何生产开关。
> **状态：** V8-2 `CLOSED / FROZEN`；V8-3 `ACCEPTED / ACTIVATION PENDING`（RC-05 / RC-06 = Done，2026-07-23 验收）；V8-5 `MANUAL ACCEPTED`（2026-07-27）（RC-08 = Done，人工验收沙箱 `npm run recommendation:review` 2026-07-27 通过签字，证据见 `docs/evidence/offerflow-v0.8-v8-5-manual-acceptance-2026-07-27.md`）；V8-4 `MANUAL ACCEPTED`（2026-07-27）（RC-07、RC-12 可靠单岗位分析部分 = 人工验收通过，代码与自动化回归 2026-07-25 全绿，实施证据见 `docs/technical/offerflow-v0.8-v8-4-implementation-evidence.md`；人工验收沙箱 `npm run analysis:review` 2026-07-27 验收通过、已签字），生产 schema 已于 2026-07-29 迁移到 v8、但 Radar 与 Analysis 正式入口仍保持关闭、正式开关仍未启用。采集桥、预览、确认写入闭环、自动化测试、最终真实 BOSS 批量 Preview 与生产 schema v7 受控激活均已完成；Radar 正式入口保持关闭。2026-07-22 最终范围收缩为扩展当前页采集、BOSS 单条/批量、通用可见文本降级、预览纠错/取消/确认、幂等重放与终态；手工 JD 文本、“链接 + 文本”和 JSON 对象/数组输入均从产品入口、前端 API 包装、写入 DTO 和验收中删除，仅保留数据库枚举、历史数据读取与 Preview/Snapshot 反序列化兼容；扩展继续使用 JSON HTTP body 的 browser/boss/generic 协议。RC-01～RC-04 均为 Done。RC-10（RadarAction）= `Done`：人工验收沙箱 `npm run action:review` 2026-07-28 通过签字，`action:e2e` 10/10 连跑两次稳定、`recommendation:e2e` 5/5 无回归、vitest 1409 全绿，证据见 `docs/evidence/offerflow-v0.8-rc-10-action-manual-acceptance-2026-07-28.md`。RC-11（RadarPromotion 反向追踪）= `Done`：人工验收沙箱 `npm run trace:review` 2026-07-28 通过签字，`trace:e2e` 13/13 连跑两次稳定、`promotion:e2e` 11/11 无回归、vitest 1434 全绿，证据见 `docs/evidence/offerflow-v0.8-rc-11-trace-manual-acceptance-2026-07-28.md`。V8-6 功能开发完成（RadarPromotion 功能层、反向追踪、端到端剧本三项完成；RC-11 于 2026-07-28 转 Done）；发布闭环侧仍 `PARTIAL / BLOCKED`：**30 条真实评测（数据与人工标注阻塞）、核心页面真实截图与产品验收两项未完成**（原「生产 v8 migration/backup/recovery」已于 2026-07-29 完成，证据 `docs/evidence/offerflow-v0.8-production-schema-v8-activation-2026-07-29.md`，且不改变产品版本口径），RC-12 保持 Partial/Blocked、RC-09 未启动；证据见 `docs/evidence/offerflow-v0.8-v8-6-promotion-partial-acceptance-2026-07-27.md`。V8-UX 收口波次（三阶段主线步骤条 / 行动卡 / 三问引导 + 工作台信息噪声降噪）= **实现完成**（commit `633eb0d`、`eb43f1a`；纯展示层，未改行为/契约/数据库；vitest 1456、5 组 radar E2E、build、typecheck 全绿），**仅剩「人工无说明 smoke」（不看技术码、仅凭中文文案走通三阶段主线）一项待补**。**v0.8 产品验收 = `HELD / 暂缓`**：待 30 条评测、核心页面真实截图与产品文案人工验收完成后另行组织（生产 v8 受控迁移已于 2026-07-29 完成，不单独构成产品验收条件）。本条**不得**解读为 V8-6 整体发布完成或 v0.8 产品验收通过、更**不得**解读为 GA（RC-11 Done、V8-UX 实现完成均不改变发布闭环 Partial/Blocked 状态）。

---

## 1. 用户结果追踪

| ID | 用户结果 | PRD | Technical Design | Evaluation | 波次 | 实施状态 | 验收证据 |
|---|---|---|---|---|---|---|---|
| RC-01 | BOSS 当前页采集 | 6.1 P0-01 / US-01 | 6.1 / 11.1 | 2.2 / 9 | V8-2 | Done（真实单条与批量链路、最终 2 项 Preview、来源身份、字段与 JD 不串位均已验证；停在 Preview 未确认写入） | 用户截图 `artifacts/v0.8-v8-2/2026-07-22-boss-batch-preview.png`（Git 忽略）及同目录只读 audit JSON；session `686a0ef7…` |
| RC-02 | 通用可见文本降级 | 6.1 P0-02 / US-01 | 6.2 | 2.2 / 4 | V8-2 | Done（真实 MV3 popup + 注入抽取通过；受控动态 loopback mock 打开 Preview；服务端集成测试独立证明 Preview 前零正式写入） | `test-results/extension-e2e/*generic*/generic-fallback-{preview.png,result.json}`、同目录 `trace.zip`；`server/radar/routes.spec.ts` |
| RC-03 | 采集入口收敛与统一预览 | 6.1 P0-03 / US-02 | 4.1 / 6.3 | 2.3 / 9 | V8-2 | Done（只保留扩展会话预览；无手工 JD textarea/按钮/状态/handler/帮助文案/前端 API 包装；JSON 专用 route 为 404；共享写入 DTO 拒绝全部 legacy 输入值） | UI 删除契约、路由 404/422、引用审计、generic fallback 回归 |
| RC-04 | 不可变 Snapshot/Version | 4.3–4.5 / P0-04/05 | 3 / 4.2 / 4.5 | 5.1 | V8-1/2 | Done（实现、写入闭环、真实采集、最终 Preview 零写入及生产 schema v7 受控激活全部通过） | 见下方 RC-04 分项证据与生产激活记录 |
| RC-05 | 重复与变化 | P0-06 / US-03 | 5 | 5.1 | V8-3 | Done（代码实现完成、自动化回归通过、人工验收 ACCEPTED；沙箱/演练 schema≥v8，生产仍 v7。MA-01/MA-02 静态截图受内层滚动容器裁切，能力已由真实浏览器验证 + Review Playwright E2E + 组件/API 测试 + 审计数据共同证明，采用证据例外完成验收；生产 v8 激活仍需独立授权。证据 `docs/evidence/offerflow-v0.8-v8-3-manual-acceptance-pending.md`、`docs/evidence/offerflow-v0.8-v8-3-review-workbench-2026-07-23.md`） | fixture、Diff 截图、hash 结果 |
| RC-06 | 透明规则 | P0-07 / US-04 | 4.7 | 3 / 4 | V8-3 | Done（代码实现完成、自动化回归通过、人工验收 ACCEPTED；沙箱/演练 schema≥v8，生产仍 v7。MA-03/MA-04 静态证据完整；采用证据例外完成验收；生产 v8 激活仍需独立授权。证据 `docs/evidence/offerflow-v0.8-v8-3-manual-acceptance-pending.md`、`docs/evidence/offerflow-v0.8-v8-3-review-workbench-2026-07-23.md`） | 命中原文、覆盖动作截图 |
| RC-07 | 可解释单岗位分析 | P0-08 / US-05 | 4.9 / 7 / 8 | 4 / 5.2 | V8-4 | Done — V8-4 `MANUAL ACCEPTED`（2026-07-27）（输入/输出契约、Provider 与结构修复、执行器、服务编排、七个 HTTP 接口、前端面板与门禁、刷新恢复均已实现；单元/集成 + 六个浏览器 E2E 全绿；人工验收沙箱 `npm run analysis:review` 2026-07-27 通过签字；生产入口 DISABLED、schema 仍 v7、生产迁移未授权） | Payload、Envelope、证据引用；实施证据 `docs/technical/offerflow-v0.8-v8-4-implementation-evidence.md` |
| RC-08 | 0～8 条推荐 | P0-09 / US-06 | 4.10 / 13.3 | 7 | V8-5 | Done — V8-5 `MANUAL ACCEPTED`（2026-07-27）（推荐契约、确定性收敛、投影、服务编排、HTTP 接口与前端面板均已实现；0～8 条上限、允许 0 条、不凑数、硬约束/抑制阻断原因齐备；`recommendation:e2e` 5/5、`review-e2e` 11/11、vitest 1254 全绿；人工验收沙箱 `npm run recommendation:review` 2026-07-27 通过签字；生产入口 DISABLED、schema 仍 v7、生产迁移未授权） | 正常批次与空推荐截图；验收证据 `docs/evidence/offerflow-v0.8-v8-5-manual-acceptance-2026-07-27.md` |
| RC-09 | 误区或证据不足 | 4.8 / 11.3 / US-07 | 9 | 5.4 / 7 | V8-5 | Not Started | formed/insufficient 两类样本 |
| RC-10 | RadarAction | P0-10 / US-08 | 4.11 / 12 | 5.5 | V8-5 | Done — 人工验收通过（2026-07-28）。四族动作（收藏/忽略/标记优先/已投待反馈）+ 撤销 + append-only 历史投影全部实现；`action:e2e` 10/10（连跑两次稳定）：动作栏置位/刷新恢复/撤销恢复、忽略使旧推荐立即失效并重新生成时被排除（`ignored_unchanged`）、撤销后恢复资格、收藏/优先不误排除、历史 append-only 可追踪、幂等（重复 apply `changed=false`）、`no_response`（已投待反馈）不产生 Application/拒绝反馈/负向证据、已晋升候选执行并撤销全部动作后正式四表逐字节不变、`integrity_check`/`foreign_key_check` 通过；`recommendation:e2e` 5/5 无回归；vitest 1409、vue-tsc、build 全绿；人工验收沙箱 `npm run action:review` 2026-07-28 通过签字。生产入口 DISABLED、schema 仍 v7、生产迁移未授权 | 动作流水、撤销、投影；验收证据 `docs/evidence/offerflow-v0.8-rc-10-action-manual-acceptance-2026-07-28.md` |
| RC-11 | RadarPromotion | P0-11 / US-09 | 4.12 / 13.4 | 8 | V8-6 | Done — 人工验收通过（2026-07-28）。晋升功能层（2026-07-27 已验收）+ 双向可追溯性只读界面全部实现。已完成并有证据：预览零写入、确认写入 Job/Application/FeedbackEvent/Promotion 各一条且 UI 与库逐字段一致、幂等重放、`no_response` 双端 409 零残留、深度钳制、原子失败整体回滚；**反向追踪：** 正向来源链（候选版本/触发原因/推荐批次/正向对象）、三类正式对象反查、link 多晋升、触发四态、批次成员推断（显式标注非确定因果 + `wasSelected`）、无来源明确不可追溯、刷新后追踪保持、追踪只读五表零写入、**撤销 RadarAction 不破坏追踪且正式事实链路保留**（RC-10 Done 后已可验证）；`trace:e2e` 13/13 连跑两次稳定、`promotion:e2e` 11/11 无回归、vitest 1434、vue-tsc、build 全绿；人工验收沙箱 `npm run trace:review` 2026-07-28 通过签字。**边界：** link 模式仍无 UI 晋升入口（仅 API 验证反查）。生产入口 DISABLED、schema 仍 v7、生产迁移未授权 | 晋升预览、幂等、反向追踪；验收证据 `docs/evidence/offerflow-v0.8-rc-11-trace-manual-acceptance-2026-07-28.md` |
| RC-12 | 可靠任务与发布闭环 | P0-12 / US-10 / 12.2 | 4.8 / 10 | 6 / 9 | V8-4/6 | Partial / Blocked（保持）— V8-4 单岗位可靠分析任务已实现并人工验收通过（2026-07-27）（确定性 createTask、固定 Snapshot、状态机、最多一次结构修复、原子写入、cancel/迟到结果抑制、进程恢复、retry 复用快照、current/stale 投影，自动化全绿）；**发布闭环三项被阻塞、不由工程侧解除：① 30 条真实评测——数据与人工标注阻塞；② 生产 v8 migration/backup/recovery——授权阻塞（BR-1）；③ 核心页面真实截图与产品文案人工验收未完成。** | 故障日志、migration、恢复、截图；实施证据 `docs/technical/offerflow-v0.8-v8-4-implementation-evidence.md` |

### 1.1 RC-04 分项证据（区分实现层次，不得合并为单一完成结论）

| 分项 | 状态 | 证据 |
|---|---|---|
| Schema / migration 实现 | Done | `server/migrations/radarDomainSchemaV7.ts`（12 表、FK/CHECK 约束、12 个显式索引）；`server/migrations.ts` 注册 v7；`RADAR_DOMAIN_SCHEMA_VERSION=7`，`PRODUCTION_SCHEMA_VERSION` 仍为 2，不影响生产默认路径 |
| 生产 schema v7 受控激活 | Done（2026-07-22） | 停写后锁定真实库 v6 指纹；原始备份与独立恢复副本 hash、schema、全部既有表行数一致；生产副本 dry-run 仅新增 migration 7、12 张 Radar 表和 12 个显式索引，重复执行为 noop，故障注入完整回滚；真实库使用同一已提交 migration 入口升级到 v7，既有表行数不变、Radar 表全为 0、`integrity_check=ok`、FK 异常 0；Radar 关闭状态下旧 API/页面启动冒烟通过，停服后库 hash/行数未变化。见 `docs/evidence/offerflow-v0.8-schema-v7-activation-2026-07-22.md`。 |
| 域模型 / Repository 实现 | Done | `src/domain/radar/`、`server/radar/`；`radar.spec.ts` 覆盖循环 FK 三步事务、Repository 不暴露 update/updateVersion |
| 自动化测试 | Done | `scripts/migrations.selftest.ts` v7 升级/幂等/约束测试块；`server/radar/radar.spec.ts`；全量 `vitest run` |
| 生产数据库副本迁移演练 | Done（本次执行） | 对生产库只读副本执行：一致性备份 → 复制为演练库 → 正式 `initSchema` 入口从 v6 升到 v7 → 12 张雷达表/10 个索引存在且为空 → 全部 v0.7 业务表行数与内容 hash 保持不变（仅 `schema_migrations` 按预期新增 1 行、`app_meta.schema_version` 按预期由 6 更新为 7）→ `integrity_check=ok`、`foreign_key_check` 无异常 → 再次运行 migration 确认幂等 → 循环 FK 三步事务与 `marked_applied_pending` Action 数据冒烟通过，未产生正式 Application → 生产库文件 hash 全程不变。演练全部在系统临时目录中进行，未提交、未保留任何数据库文件 |
| 备份与恢复验证 | Done（本次执行） | 对迁移前一致性副本（非生产库本身）执行项目现有正式备份机制 `backupDatabase()`（`VACUUM INTO` + `doctorDatabase` 校验），恢复到独立临时位置后验证 schema version、`integrity_check=ok`、`foreign_key_check` 无异常，核心 v0.7 表行数与 hash 与备份源一致；备份/恢复均使用临时 `OFFERFLOW_BACKUP_DIR`/`OFFERFLOW_SYNC_DIR`，未写入真实 `backups/`、`sync/` 目录，事后已清理 |
| V8-2 采集→预览→确认写入闭环（代码/自动化测试） | Done（本次实施） | `server/radar/routes.ts`/`service.ts`/`dtoSchemas.ts`/`normalize.ts`（扩展共享会话创建、逐条加项、纠错、取消、幂等提交，事务内写入 `CaptureSnapshot`/`SourceRecord`/`Candidate`/`CandidateVersion`/`CandidateSource`）；`server/radar/schemaGate.spec.ts` 与 `server/radar/routes.spec.ts` 覆盖 Radar 关闭/v6 拒绝/v7 可用、Origin/Host/header、校验、未确认不落库、取消、完整提交、幂等、纠错新版本、404/422、8 条上限、过期和 capability 失效；前端只展示扩展创建的会话预览，不提供任何手工 JD 输入。扩展保留 JSON HTTP body、`visibleText`、Capture Item 和 browser/boss/generic 消息协议；历史枚举与 Preview/Snapshot 读取兼容保留，但 legacy create/add 写入值和 JSON 专用处理器均已删除。 |
| V8-2 commit 终态与幂等契约 | Done（本次实施） | Technical Design §4.1「commit 必须幂等」「committed session 不得再次生成重复快照」落地：首次 commit 进入 committed 终态并把请求指纹+outcomes 存入既有 `raw_input_json`（不改 schema）；完全相同的重复 commit 重放首次结果（相同 Candidate/Version ID、零新增行），内容不同的重复 commit 拒绝（`COMMIT_CONFLICT`），cancel/expired 后写操作全部拒绝，错误体不回显 sessionId；`server/radar/routes.spec.ts` 新增 4 项契约测试，`server/radar` 共 50 项通过 |
| V8-2 临时 v7 沙箱 | Done（本次执行） | 新增 `scripts/devRadarSandbox.ts` + `npm run dev:radar-sandbox` + `.claude/launch.json`：系统临时目录全新空库自动迁移到 schema v7（非真实生产库），后端 Radar 显式开启并监听 loopback，Vite 反代 Radar API；预览、纠错、确认、幂等重放、取消和过期均可在隔离库验证，`jobs/applications/feedback_events` 保持 0。已取消输入方式的历史沙箱结果不再作为当前 RC-03 验收。 |
| V8-2 扩展采集注入阻塞缺陷修复 | Done（本次实施） | 真实 Chrome/BOSS 验收发现阻塞缺陷：popup 用 `executeScript({ func: runPageExtraction })` 注入，但该函数依赖注入后不存在的模块闭包（`selectAndExtract`），页面上下文抛 `ReferenceError` → `result:null` → popup 读 `captureMethod` 崩溃「Cannot read properties of null」，列表页/详情页均复现。修复：改为 `executeScript({ files:['src/content/injectedCapture.js'] })` 注入预构建自包含脚本（esbuild 打包全部 extractor，已核实产物为 IIFE 且内联 `selectAndExtract`/`zhipin.com`，无外部闭包引用）+ 只引用页面全局的 `func` 读取结果全局；采集函数返回判别联合 `PageCaptureExecutionResult`（`ok:true{capture}` \| `ok:false{code,message}`），popup 先判 `ok` 再取 `captureMethod`，空数组/缺失/`null`/异常一律归一化为可读错误不再 TypeError；列表页/详情页选择器全失效均降级通用可见文本，字段缺失保持 null 不编造。新增 `browser-extension/src/content/{captureResult,captureFlow,injectedCapture}.ts` 与两份 spec（§五 1-12 全覆盖），扩展单测由 8 增至 26；`tsc -p browser-extension` / `build:extension`（两产物）/ `vitest run`（711 项）/ `git diff --check` 全绿；manifest 未改（仍 `activeTab`+`scripting`，无常驻 content script、无 cookies/history/`<all_urls>`） |
| V8-2 BOSS 抽取精度修复（字段串位 / 城市地址混淆 / JD 噪声） | Done（本次实施） | 真实采集验收反馈：company 写成岗位名、role 未识别、city 抓成整段地址、JD 混入导航噪声。根因：旧选择器命中错误节点 + 无 city/district/address 拆分 + 整页 innerText 当 JD。修复（仅扩展层，未改 DB/DTO/schema/后端领域）：① 支持两种布局（独立 `job_detail` 详情页、列表页左列表+右详情面板）各用独立选择器组；② role/company 分别定向并交叉校验（company==role 或形似岗位名则改走标题解析），杜绝串位；③ 受控解析 `parseCityAddress` 把「苏州吴中区苏州国际科技园」拆为 city=苏州/district=吴中区/address=完整，city 只存城市；④ 确定性 fallback：定向 DOM→受控 title/address 解析→unknown，不从整页文本猜测；⑤ 每个核心字段带 `source`/`confidence`/`qualityIssues`，低置信字段发送为 null 交由人工确认；⑥ JD 只取职位描述卡片，排除导航/推荐/聊天/页脚。新增 `extractors/{cityAddress,bossTitle}.ts`、重写 `bossExtractor.ts`/`selectExtractor.ts`、两份脱敏最小 fixture（`fixtures/boss-job-detail.html`、`boss-list-panel.html`）、重写 `extractors.spec.ts` 覆盖 §七.1-11（两布局回归、role/company 不串位、title 分组、城市/区县/地址拆分、薪资 11-16、JD 无导航、选择器失效不交叉填充、generic 不猜测）。扩展单测增至 40；`tsc -p browser-extension` / `build:extension`（`injectedCapture.js` 仍为自包含 IIFE，内联 `parseCityAddress`，无 import）/ `vitest run`（725 项）/ `git diff --check` 全绿 |
| V8-2 真实独立详情页采集（用户已确认） | Done（用户真实操作） | 用户在真实 BOSS 独立 job_detail 详情页采集成功并确认写入：company=赞同科技、role=web前端（苏州、银行项目）、city=苏州、salary=11-16K、JD 无明显导航噪声、预览可编辑、commit 成功并创建 Candidate |
| V8-2 session capability 地址栏清理（§三） | Done（本次实施） | 新增 `src/pages/radar/sessionCapability.ts`（纯函数：query 读取+UUID 校验→sessionStorage 持久化→`stripSessionIdFromHash` 清地址栏→刷新恢复→committed/cancelled/expired/invalid 清除→仅暴露截断标识），接入 `RadarImportPage.vue`（不用 localStorage、不打印完整 ID）。单测 `sessionCapability.spec.ts` 覆盖 9 项；浏览器预览工具实测：加载后 hash=`#/radar/import`（完整 sessionId 已从地址栏移除）、sessionStorage 可恢复、刷新后仍显示预览条目、commit 后 sessionStorage 清空且刷新不再恢复、页面只显示「会话 ea3c6b66…」不含完整 ID |
| V8-2 完整抽取元数据进入 raw snapshot（§四） | Done（本次实施） | 审计裁决：此前**未保存**（`materializeItem` 的 rawSnapshot 仅含 captureMethod/visibleText）。修复（不改 schema、不改结构化八字段 DTO、不扩大 normalized 契约）：新增自由形式 `extractionMetadata` 从扩展经 `addItem` 落入 `raw_snapshot_json`；扩展 `selectExtractor` 产出含 district/address + 每字段 source/confidence/qualityIssues 的元数据，经 captureResult/captureFlow/popup/radarCaptureClient 透传，服务端 `AddCaptureItemRequestSchema`+`RadarPreviewItemSchema` 增加 `extractionMetadata` 并在 `materializeItem` 写入 rawSnapshot。临时 v7 DB 实测 `raw_snapshot_json.extractionMetadata.district=吴中区`、`fields.city.{source:boss_dom,confidence:medium,qualityIssues:[…]}`；`normalized_json` 不含 address、district 仍为 null（未写入 city、未扩大契约）。新增 routes.spec 数据库断言 + 扩展元数据断言 |
| V8-2 精确去重自动验证（§五） | Done（本次执行） | 临时 v7 沙箱经真实 HTTP 两次提交同一 BOSS 岗位（同规范化 URL）：第一次 `created`（candidate e0f341ce），第二次 `unchanged` 且 candidateId 相同、零新增 Candidate/Version；仅按稳定来源/规范化 URL/内容 hash 判定，无模糊相似度/语义合并/Diff。全库计数 candidates=3、versions=3、jobs=applications=feedback_events=0（正式记忆零污染） |
| V8-2 列表页批量选卡 + 串行右侧详情采集（代码/自动化测试） | Done（代码、自动化与用户真实 Chrome） | 正式列表页路径改为「用户手动批量选卡 + 扩展串行点击切换右侧详情 + 一个批量 preview session」，取代「自动猜测 selected 卡片」（后者降级为诊断探针）。新增纯逻辑：`browser-extension/src/extractors/semanticCard.ts`（composedPath→语义卡片根、逻辑去重同 id/canonical/父子包含、选择集合 ≤8）、`bossExtractor.captureKnownJobFromRightPanel`（已知身份右侧采集：href 一致或 role+可读薪资交叉校验，identity 不成立 fail-closed，PUA 薪资回退卡片薪资，`3–5年` 不作薪资，company=展示名 source=selected_card、companyLegalName=null）、`content/batchQueue.ts`（串行状态机，队列只持稳定快照、单 in-flight）、`content/batchRunner.ts`（编排：按 id 重定位→首项已匹配免点击→原生点击→MutationObserver 稳定→采集→单项失败续跑）、`content/batchPayload.ts`（提交项：含全部所选项，failed→commitBlocked+诊断摘要，captured/needs_correction→JD 正文）。注入 UI `content/batchCapture.ts`（Shadow DOM 浮层、原生 checkbox 默认切换 + `change` 更新队列、事件只阻止冒泡、暂停/继续/取消、Esc 清理）；`background/background.ts`（SW 仅 createSession+逐项 addItem+开预览，单项 add 失败独立记录不重试整批，返回 submitted/failedToSubmit）；`popup` 分流（job_detail 单采/列表页批量/其他通用）；`RadarImportPage.vue` 批量汇总 + captured 默认勾选、needs_correction 不默认勾选、failed 阻塞。manifest 新增 background service worker（无新增敏感权限）。新增测试：`semanticCard.spec`/`batchQueue.spec`/`batchRunner.spec`/`batchPayload.spec`/`knownJob.spec`/`commitGate.spec`。自动门全绿；最终真实 Chrome 2 项批量 Preview、来源身份、JD 不串位与 Preview 零写入证据见本表最终证据行和 Runbook §7。未自动滚动/翻页/投递，未写正式记忆。 |
| V8-2 Batch Runner 真实浏览器自动验收跑道与交互修复 | Done（Playwright 确定性扩展 E2E）；真实 BOSS 卡片识别仍待诊断 JSON | 新增 `browser-extension/e2e/`：MV3 persistent context、固定专用 profile、自动 build、bundled Chromium、service worker/extensionId 获取、真实 action popup CDP 操作、确定性 BOSS 双栏页、截图/video/trace 与 DOM audit。8 个 E2E 覆盖 popup 成功关闭/失败保留、104px 安全位置、拖动/折叠/resize 约束、原生 checkbox checked 与 0→1→2 计数、点击不切换右栏、清空、取消/Esc、首屏/延迟新增/虚拟重建 reconciliation、hidden/DOM clone 去重、选择阶段零 OfferFlow API，以及诊断面板/复制脱敏 JSON/零 host 完整原因/重扫轮次/退出清理。`batchCapture.ts` 增加仅在批量模式存在的受限真实页诊断：每轮容器/candidate/semantic root/accept/host/lifecycle 计数，12 类拒绝原因、最多 12 个脱敏样本、最多 12 轮计数历史、30KB 上限；只保留 URL pathname，不含 query/securityId/token/Cookie/JD/HTML/聊天。**本轮未修改 CARD_SELECTOR、semantic root selector、字段 selector 或 acceptance 规则**；当前规则审计结果为 job_detail href+role 硬要求，semantic root 还要求 salary/company/experience/education 任一信号，salary 不是单独硬条件，acceptance 另行要求 company。用户真实 smoke 已确认 popup 自动关闭和浮层可见，但真实卡片 host 视觉为 0；须由新诊断 JSON 判定唯一分叉后再最小修复，不得用 fixture 推断。未点击「开始采集」，未调用 Capture API，未写数据库；未改 server DTO/API/schema/migration/Radar 领域模型。 |
| V8-2 真实 BOSS 零 host 诊断定向修复 | Done（代码与 Playwright 8/8）；待用户一次真实复验 | 用户返回的真实诊断 JSON：container=`.job-list-container`、raw/unique=171、semantic roots=31、accepted/mounted/connected=0；拒绝严格集中为 `missing_job_detail_href=109`、`invalid_external_record_id=23`、`missing_company=39`，host mount/remove/hidden/detached 均为 0。样本证明两项同源过严约束：① semantic root 提前停在 `.job-info`，公司位于卡片 shell 外层或不可读，而 `SelectedCard.companyDisplayName` 契约本为 nullable；② 真实 externalRecordId 含 `-`/`_`，旧 `[A-Za-z0-9]+` 正则拒绝。最小修复：批量挂载优先使用既有 `candidateShell` 作为完整卡片根；稳定 job id + role 即可进入选择，company 缺失留给 preview 人工确认；job id 仅扩展为单路径段 `[A-Za-z0-9_-]+`，仍拒绝 query/斜杠等字符。新增真实形状 fixture（`.job-info` 与 company sibling、无可读薪资、含 `-`/`_` id）及单测。未扩大 CARD_SELECTOR，未新增公司 selector，未自动滚动/采集；未改 server/DTO/API/schema/migration/数据库。 |
| V8-2 批量预览公司/薪资字段回退 | Done（代码与自动化测试）；真实 PUA 薪资仍取决于页面是否提供可访问明文 | 第二份真实诊断确认卡片识别已恢复：accepted/mounted/connected=42/42/42、mount/remove/hidden/detached 均无失败；但 12 个样本的 `detectedCompany`/`detectedSalary` 全为 null，真实 preview 中公司及薪资上下限为空。审计发现批量采集此前即使右侧 job id 身份成立，也硬编码只取左卡 company。修复为：左卡公司不可读时，在身份一致的右侧详情内复用既有 `extractCompany` 受控优先级；不读整页、不猜公司。薪资继续遵守反风控边界：卡片 textContent 为 PUA 时，新增只读 `aria-label`/`title`/`data-salary`/`data-v-salary` 明文回退，且仍须匹配带单位薪资；页面没有可访问明文时保持 null 并由 preview 人工确认，不解码反爬字体。新增 `knownJob.spec`/`semanticCard.spec` 回归。未改 server/DTO/API/schema/migration/数据库。 |
| V8-2 真实字段节点诊断补强 | Done（Playwright 8/8）；等待用户字段级 JSON | 第三份真实诊断仍显示 card scanning 正常（accepted/mounted/connected=30/30/30，selection=8），说明问题不在 reconciliation；preview 为 6 captured/2 blocked，blocked 原因为右侧当前岗位详情头部未定位，同时 company/salary 继续为空。现有诊断仅有最终 null，无法证明真实字段 class/属性/PUA 来源。诊断 JSON 新增 `fieldProbe.selectedCard/rightPanel`：只记录候选节点 tag/class、≤40 字受控文本、pathname、aria/title/data-salary/data-v-salary/ka、前 30 个 Unicode code point、font-family，以及不含文本的 class 清单；过滤 recruiter/chat/im/avatar，继续受 30KB 总上限约束，不记录 HTML/query/JD/Cookie/Token/招聘者。未改 selector 或 runner 判定，等待真实字段证据后再最小修复。 |
| V8-2 真实公司节点定向修复与 PUA 薪资裁决 | Done（代码与定向测试）；待真实预览确认公司 | 字段级 JSON 给出唯一结构证据：左卡公司是 `a.boss-info[href*="/gongsi/"]`，文本为公司展示名且 `ka=company_logo_click_*`；同卡 `span.boss-name` 是招聘者姓名，必须排除。`readCardInfo` 新增仅受 `/gongsi/` 链接约束的 `a.boss-info` selector，并新增真实 footer 形状回归，证明读取“智身科技”且不读取 boss-name。薪资证据同样明确：`.job-salary` 文本为 `U+E033/U+E031/...` PUA，font-family=`kanzhun-mix, kanzhun-Regular`，aria/title/data-salary/data-v-salary 均为空；按安全边界不逆向字体、不猜码点数字，继续 unknown + preview 人工纠正。未改 server/DTO/API/schema/migration/数据库。 |
| V8-2 公司字段真实预览复验 | Done（用户真实 BOSS 操作） | 用户重新加载扩展后在真实 `/web/geek/jobs` 选择 6 条并生成 preview：汇总为 captured=6、blocked=0；诊断 accepted/mounted/connected=15/15/15、selection=6，host lifecycle 全无失败。公司字段已成功进入预览（包括上海凌瓴信息科技、上海游幕网络科技、兴业数金、华林证券、豆糖网络等）；页面仅以“某中型互联网公司”匿名展示的条目保持 unknown，不将匿名描述伪装为正式公司名。薪资页面视觉为 18-28K/25-35K/20-30K 等，但 DOM 仍只有 `kanzhun` PUA 码点且无可访问明文；按既定“不绕过风控”边界不实现字体映射，薪资继续人工确认。 |
| V8-2 真实 BOSS 薪资 PUA 受限解码 | Done（代码与定向测试）；待用户重新加载扩展后真实复验 | 用户明确要求修复薪资空值，并提供同页截图与字段诊断：可见 `18-28K` 对应 `U+E032 U+E039 - U+E033 U+E039`，可见 `13-18K` 对应 `U+E032 U+E034 - U+E032 U+E039`，结合 `20-40K` 等样本确认当前 `kanzhun-mix` / `kanzhun-Regular` 的 `U+E031..U+E03A` 连续映射为 `0..9`。扩展新增受限 decoder：仅薪资 class、computed kanzhun 字体、已确认码位范围、合法带单位且正数有序区间同时成立才解码；范围外 PUA/错误字体/非法区间立即 unknown，不下载或逆向字体、不 OCR。解码来源从卡片贯穿稳定队列到右侧采集；预览填入上下限，但 confidence=medium、qualityIssues 明示 PUA、status=`needs_correction`，因此不默认纳入确认。新增卡片/右侧/负向边界/队列传递测试。未改 server DTO/API/schema/migration/Radar 领域模型或数据库。 |
| V8-2 猎头机构与截断公司展示名回退 | Done（代码与自动化测试）；待真实第二组复验 | 用户真实截图证明第二组不是第一组的完整公司主页结构：`合肥市蜀山区元卓... · hr` 被完整公司校验按截断值拒绝；`高策华途 · 猎头顾问`、`TTR上海臻猎 · 猎头顾问` 位于右侧 `.job-boss-info .boss-info-attr`，属于招聘者所属机构而非已确认用人公司。最小修复：仅在岗位身份已校验后读取该结构，只剥离末尾白名单招聘角色；机构名或左卡截断展示名以 medium、qualityIssues、`needs_correction` 进入预览，不默认确认且不伪装成工商全称。相邻 `.name`/`.boss-name` 招聘者姓名继续禁止读取；诊断 fieldProbe 同步排除招聘者姓名、script/style 和大段非薪资文本。新增真实形状 extractor/payload/E2E 隐私回归。未改 server DTO/API/schema/migration、数据库或正式记忆。 |
| V8-2 学历要求与招聘者活跃度快照 | Done（代码与自动化测试）；待用户真实页复验 | 学历沿用既有 `educationRequirement` 结构化字段，不改 DTO/schema：抽取按具体限定优先，保留“统招本科/全日制本科/本科及以上/大专”等标签原文，并在预览页增加可编辑字段。招聘者活跃度只从当前岗位右侧 `.job-boss-info` 内受控活跃时间节点读取，作为 `extractionMetadata.activityStatus` 随 raw snapshot 保存并在预览中只读展示；不进入 recognizedFields/normalized CandidateVersion，不因活跃状态变化产生岗位新版本。招聘者姓名、自由文本、超长文本均不读取。新增 extractor、batch payload、metadata reader 与预览组件测试。未改 server DTO/API/schema/migration、数据库或正式记忆。 |
| V8-2 活跃度真实节点兼容 | Done（真实诊断定向修复 + 自动化测试）；待用户重载扩展复验 | 用户真实诊断证明当前页状态 class 为 `.boss-online-tag`、页面原文为“在线”，旧 selector 未命中。最小修复为在已确认当前岗位的 `.job-boss-info` 内接受 class 表明 online/active/status 的状态节点，并原样保留不超过 30 字的短文本，不再使用活跃文案枚举；仍明确排除 `.name`/`.boss-name`/`.boss-info-attr`、招聘者节点及隐藏节点，不读取整个招聘者区域。未改 server DTO/API/schema/migration、数据库或正式记忆。 |
| V8-2 活跃状态嵌套结构回归修复 | Done（第二份真实诊断定向修复 + 自动化测试）；待用户重载扩展复验 | 第二次真实复验仍全空。诊断显示 `.boss-online-tag` 与 `.name` 同属招聘者行；根因是隐私过滤使用 `closest('.job-boss-info .name')`，把嵌套在姓名行内的合法状态 tag 一并拒绝。修复为只拒绝命中节点本身是姓名/机构属性的情况；状态 tag 即使嵌套于 `.name` 仍只读取自身 `textContent`，不读取姓名祖先。新增真实嵌套 DOM 回归并断言结果为“在线”且不含招聘者姓名。未改 server DTO/API/schema/migration、数据库或正式记忆。 |
| V8-2 可自动化沙箱验收（§六） | Done（本次执行） | 扩展产物与注入路径一致；沙箱 schema v7、DB 在系统临时目录、后端 Radar + 前端 flag 开启；扩展 Capture Item 的 preview/correction/commit/idempotent replay/cancel/expiry 复用同一链路；浏览器预览验证地址栏 sessionId 即时移除、刷新恢复、committed 后刷新不恢复；临时 DB 脱敏计数与截断 ID 已核对。生产激活结果另见本表“生产 schema v7 受控激活”。 |
| V8-2 普通页 generic fallback 自动证据 | Done（2026-07-22） | Playwright 使用真实 MV3 action popup 和真实注入抽取打开非 BOSS fixture；fixture 同时含标题、正文、导航、hidden/inline hidden/CSS hidden/style/script 噪声。结果为 `generic_visible_text`，sourceUrl/title 正确、可见正文存在、隐藏/style/script 噪声缺失、`recognizedFields=null`；扩展 HTTP 与 Preview 使用动态隔离 loopback 受控 mock，服务端零正式写入由 API 集成测试独立验证。截图、trace、结构化 JSON 保存在被 Git 忽略的 `test-results/extension-e2e/*generic*/`，不纳入 checkpoint。 |
| V8-2 OfferFlow 未启动自动证据 | Done（2026-07-22） | Playwright 临时扩展副本改写为动态分配后立即释放的未监听 loopback 端口；popup 保持打开并提示“OfferFlow 未启动…启动后重试”，未打开 Preview、未产生 session/add item、无残留注入 UI、page/popup 未处理异常均为 0。截图、trace、结构化 JSON 保存在 `test-results/extension-e2e/*OfferFlo*/`，未停止或访问用户真实 OfferFlow。 |
| V8-2 最终真实 BOSS 批量 Preview 与只读数据库核验 | Done（2026-07-22，用户普通 Chrome） | 最新 session `686a0ef7…` 为 `browser/preview`、2 items、`committedAt=null`；两项 item index 0/1 是 background 按 `selectionOrder` 排序后的持久化顺序（metadata 未重复保存显式 `selectionOrder`）；岗位分别为“厨芯科技/全栈侧重前端/15-25K/3-5年/本科”和“苏州安辰拓海科技/全栈无侧重/15-20K/5-10年/大专”，均苏州、在线；两项 externalRecordId、right-panel ID、canonical/source URL 一致，`identityMatch=true`、`commitBlocked=false`；JD 指纹分别为“微信小程序/前端”和“AI 数字人/后端”，无串位。SQLite 以 `readonly + query_only` 核验：目标 Snapshot=0，从 Preview 创建时刻起 Source/Candidate/Version/Link/Job/Application/FeedbackEvent 新增均为 0，`integrity_check=ok`、FK 异常 0。截图和 audit JSON 归档在 Git 忽略的 `artifacts/v0.8-v8-2/`。 |

RC-04 作为整体用户结果标记 **Done**：V8-1/V8-2 的实现、自动测试、迁移/恢复演练、真实 BOSS 写入、最终 Preview 零写入证据和真实生产 schema v7 受控激活均已完成。Radar 正式入口仍关闭，升级本身没有创建任何 Radar 数据。

### 1.2 schema v7 生产激活时点（V8-1 结单前审计）

已审计 `initSchema` 实际调用链、`PRODUCTION_SCHEMA_VERSION`/`LATEST_SCHEMA_VERSION` 分工与真实生产库
状态。`PRODUCTION_SCHEMA_VERSION` 保持 2 不变，真实库启动仍不会自动迁移；2026-07-22 经用户单独明确授权，
通过 `db:upgrade-real -- --confirm` 将真实库从 v6 显式升级到 v7。升级后 Radar 前后端正式入口仍为 disabled，
12 张 Radar 表为空。详细流程见 `docs/runbooks/offerflow-v0.8-migration-recovery.md` 第 1.1 节和激活证据记录。

### 1.3 V8-3 设计状态（标准化 / 去重 / 变化识别）

- **状态：** `ACCEPTED / ACTIVATION PENDING`（代码实现完成、自动化回归通过、人工验收 ACCEPTED；沙箱/演练 schema≥v8）— schema v8 = IMPLEMENTED IN CODE / NOT ACTIVATED IN PRODUCTION；生产 schema 仍 v7、Radar 正式入口仍 `DISABLED`。RC-05、RC-06 均为 `Done`。**验收采用证据例外：** MA-01/MA-02 静态截图受内层滚动容器裁切，相关能力已由真实浏览器验证、Review Playwright E2E、组件测试、API 测试与审计数据共同证明；MA-03/MA-04 静态证据完整；不再补拍截图，此例外不影响最终验收结论。**生产 v8 激活仍需独立授权（BR-1），本轮未执行。**
- **范围：** 覆盖 RC-05（重复与变化）、RC-06（透明规则）的实现，含字段标准化、exact/疑似重复、no-change fingerprint（`radar-candidate-version:v1`）、material change、规则证据契约、用户覆盖审计，以及 V8-3 人工评审工作台（只读评审 + 人工裁决 + 规则覆盖，`/radar/review`）。
- **设计文档：** `docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md`。
- **实施证据：** `docs/evidence/offerflow-v0.8-v8-3-review-workbench-2026-07-23.md`（含 943 tests / tsc / vue-tsc / extension:typecheck、真实浏览器 E2E、v7 沙箱回归、生产库保护核验）。
- **schema 边界（2026-07 产品裁决，纠正上一版矛盾）：** schema v7 足够支撑标准化、exact identity、no-change、material-change、Snapshot 保留与基础规则证据；**完整 V8-3 需要最小化 schema v8**（持久化疑似重复候选对、`confirmed_distinct`、防重复提示、重审状态、duplicate 裁决 action_type），schema v8 为 **V8-3 正式实施前置条件**，不再视为非阻断未来优化。本轮**只设计 v8，不编写 migration、不改生产库、不改 `PRODUCTION_SCHEMA_VERSION`**。
- **已裁决（原 B1/B2/B3）：** B1 疑似重复用候选关系专用表 `radar_candidate_relations`（不塞入 `radar_candidate_sources`）；B2 `confirmed_distinct` 为 P0 硬需求（持久化、防反复提示、仅新实质证据可复审）；B3 responsibilities/requirements/skillTags 顺序调整不构成实质变化（fingerprint 按规范化集合比较，Snapshot 保留原始顺序）。补充裁决：`unknown→确定值`建版本；`确定值→unknown`默认视为采集质量退化，仅留 Snapshot、不建退化版本。
- **schema v8：** 迁移 `008_v0_8_radar_candidate_relations_schema` 已编写并在沙箱/演练/注入测试库使用；**生产库已于 2026-07-29 经用户授权受控迁移到 v8**（BR-1 迁移部分已完成，证据 `docs/evidence/offerflow-v0.8-production-schema-v8-activation-2026-07-29.md`）。评审路由在 `schema≥v8` 时注册，生产库现为 v8。**但 Radar 正式入口仍 DISABLED、未启用任何生产开关，产品版本仍 v0.8.0-rc1；V8-3 在生产的实际启用另需正式开关授权，本轮未启用。**
- **仍待裁决：** BR-1 生产 schema v8 迁移**已于 2026-07-29 完成**（剩余仅正式开关启用授权）；BR-2 §9 规则证据缺口字段的证据严格性档位（当前实现区分 structured/legacy_scalar/corrupt 三态呈现）。
- **边界：** 未改动 V8-2（CLOSED/FROZEN）、RC-01～RC-04 或 Radar 正式入口（仍 DISABLED）；`PRODUCTION_SCHEMA_VERSION` 常量保持 2（生产库实际 schema 已为 v8）。V8-3 实现仅在 `schema≥v8` 环境可用，生产库现已满足此条件但正式开关未启用。

### 1.4 V8-4 设计状态（可靠单岗位分析）

- **状态：** `MANUAL ACCEPTED`（2026-07-27）（技术设计冻结、契约明确；业务代码/测试/页面/API 已实现，2026-07-25 集成 worktree 一次完整回归全绿；实施证据见 `docs/technical/offerflow-v0.8-v8-4-implementation-evidence.md`；**人工验收沙箱 `npm run analysis:review` 2026-07-27 通过签字**；**生产迁移与正式开关仍未授权**）。生产 schema 仍 v7、Radar 与 Analysis 正式入口均 `DISABLED`。
- **范围：** 覆盖 RC-07（可解释单岗位分析）与 RC-12（可靠任务，单岗位部分）的设计裁决：`JobMatchAnalysisInputSnapshotV1` 输入快照、LLM Payload/Envelope 分离与证据目录、确定性任务 ID `analysis-task:v1:<inputHash>` + record.input_hash UNIQUE 双层幂等、状态机、attempt 语义、`JobMatchAnalysisPayloadV1` Structured Output、Provider 与一次结构修复、cancel/迟到结果、原子成功写入、进程恢复、stale 投影、API/DTO、能力门禁、`RadarAnalysisPanel.vue`、测试矩阵与文件实施计划。
- **设计文档：** `docs/technical/offerflow-v0.8-v8-4-reliable-single-analysis-design.md`。
- **无需 migration：** `analysis_tasks` 与 `job_match_analysis_records` 已由 schema v7 建表并含所需全部列；本设计不新增 migration、不改生产库、不推进 `PRODUCTION_SCHEMA_VERSION`（保持 2）。
- **边界：** 未改动 V8-2/V8-3 既有结论、RC-01～RC-06、生产 schema v7 状态或 Radar 正式入口；不接新 Provider、不做 BYOK、不绑定 SSE、不承诺断点续跑；AI Payload 不含内部 ID；不使用 legacy `/api/llm/analyze-job` 作为正式契约。
- **未决（不阻塞设计冻结）：** Resume/Profile 投影字段对齐既有领域投影、初始 promptVersion/analysisPolicyVersion/providerPolicyVersion 常量值、userOverride 是否并入 ruleProjectionHash——均在实施首个 PR 固定。

### 1.5 V8-UX 收口波次状态（表达层主线收口）

- **状态：** `IMPLEMENTED`（2026-07-29）——纯展示层收口，未改行为层。**仅剩「人工无说明 smoke」一项待补。**
- **范围：** 把 v0.7 后逐波堆叠的核心页面收口为一条三阶段用户主线（① 收集整理 → ② 审核处理 → ③ 晋升跟踪），并降低岗位雷达工作台信息噪声。方案见 `docs/product/offerflow-v0.8-ux-consolidation-plan.md`。
- **已交付（commit `633eb0d` + `eb43f1a`）：** 新增纯展示组件 `RadarStageStepper.vue`（三阶段步骤条）、`RadarNextActionCard.vue`（单一主 CTA 行动卡）、`RadarGuideBar.vue`（每页「这是做什么/现在做什么/完成后去哪」三问）；`RadarImportPage` / `RadarReviewPage` 挂载步骤条 + 三问 + 动作后下一步引导；`App.vue` 导航新增「岗位雷达」入口（受既有 `radarEnabled` 门禁，默认关，未改门禁语义）；技术码（`status`/`decisionType`/`reasonCode`/`outcome`/候选与版本/晋升/推荐批次 ID、hash）默认折叠进 `<details class="tech-details">`，默认呈现中文标签。
- **护栏落实：** 未改路由/路由名、组件 props/emit/内部状态机；全部 `data-testid` 保留在原节点；折叠只包裹或换可见文案、不改断言目标文本值（E2E 经 `toContainText`/`.text()` 读 textContent，折叠后仍通过）。未改 `src/domain/**`、`src/api/**`、`src/storage/**`、Repository、migration、判决引擎、features 门禁默认值；未新增依赖、未动 AI/SSE/任务机制、未触碰 BOSS 自动化/BYOK/正式记忆边界。
- **自动化验证（2026-07-29 全绿）：** `vue-tsc --noEmit` 通过；`vitest run` 1456/1456；`vite build` 通过；`review:e2e` 11/11、`recommendation:e2e` 5/5、`promotion:e2e` 11/11、`action:e2e` 10/10、`trace:e2e` 13/13；`migration:selftest` passed；`db:doctor` `ok`、`integrity=ok`、FK 违例 0。
- **待补（不由自动化解除）：** 「人工无说明 smoke」——不看任何技术码、仅凭中文文案与三阶段主线走通「采集 → 评审 → 晋升跟踪」并截图，对照方案 §3 / §4.3。**此项完成前 V8-UX 不得标注为「验收通过」。**
- **已知遗留（不阻断本波，交后续处理）：** `App.vue` 品牌行仍显示 `v0.7.0`（方案 §4.5 建议改为当前版本，本波未改，避免在文档收口中改动展示文案）；导航「岗位雷达」入口在生产 `radarEnabled=false` 时仍隐藏（符合门禁语义）。
- **边界：** 未改动 RC-01～RC-12 的功能结论或验收状态；V8-UX 是表达层收口，不计入任何 RC 的「通过/不通过」判定，也不改变 v0.8 发布闭环的 Partial/Blocked 状态。

### 1.6 NovaWing 宿主契约与真实只读 Runtime Adapter（2026-08-05）

- **状态：** `IMPLEMENTED / DEFAULT OFF / REAL RUNTIME`。OfferFlow 以正式 GitHub Packages 来源精确安装 `@weijianjunwjj/nova-wing@0.1.0`；项目 `.npmrc` 仅保存 scope registry 映射，lockfile 固定官方 `resolved` 与 `integrity`。生产代码只使用 `core` / `sqlite` / `host-snapshot` 公共出口，不导入 `testing` 或内部 `dist` 路径；Host Snapshot V3 离线生命周期见 §1.7。
- **唯一运行架构：** `AnalysisService → OfferFlow NovaWingHostAdapter → NovaWing Runtime Adapter → NovaWingFacade → SqliteNovaWingStore → nw_*`。OfferFlow 与 NovaWing 指向同一 SQLite 文件，但分别拥有 `better-sqlite3` 与 `node:sqlite DatabaseSync` 独立连接；连接、Store、Facade 不暴露到业务层，OfferFlow 生产代码不执行 `nw_*` SQL，也不在 OfferFlow transaction 回调内调用 NovaWing。
- **Feature / migration / locking：** `OFFERFLOW_NOVA_WING_ANALYSIS_CONTEXT` 关闭时在动态加载基础设施前返回，不创建连接、不检查 `nw_*` schema，V1/hash/stale/Recommendation 语义不变；开启时 production runtime 固定 `migrationMode: 'validate'`，schema 缺失或初始化失败稳定拒绝启动。`apply` 仅开放给非 production 且携带显式确认常量的测试/开发初始化，不进入 OfferFlow migration 或 schema version。两连接保持 `journal_mode=DELETE`；NovaWing 使用 5000ms busy timeout、有限 Store/host 重试，超时统一脱敏为宿主错误。
- **快照、hash、stale 与推荐：** 开启时从真实 Facade 读取 `global` / `career`，仅投影 `scope/key/assertionType/category/rationale/statement` 与 `coreRevision`，冻结为 V2 并纳入 canonical hash；Context 仍受确定性排序、32 KiB、重复键、scope/revision、JSON 与敏感内容校验。revision 改变后旧分析确定性得到 `nova_wing_context_changed`，RecommendationBatch 按既有 `stale_analysis` 排除且不复制 entries。
- **DI、错误与生命周期：** 显式 Fake Adapter 始终优先，既不加载真实 infrastructure，也不由 OfferFlow 关闭。真实 runtime 初始化中途失败会关闭已创建资源；Fastify 排空请求后在同一 `onClose` 链中先关闭 NovaWing runtime，再关闭 OfferFlow owned DB；close 可重复调用。稳定错误保留 `NOVA_WING_ADAPTER_REQUIRED`、`NOVA_WING_CONTEXT_UNAVAILABLE`、`NOVA_WING_CONTEXT_INVALID`、`NOVA_WING_CONTEXT_TOO_LARGE`，新增 `NOVA_WING_RUNTIME_INITIALIZATION_FAILED` / `NOVA_WING_RUNTIME_APPLY_NOT_CONFIRMED`，均不回显 SQLite 原文、路径、`nw_*` 表名、堆栈或 Context 正文。
- **验证：** 新增 package/runtime/双驱动/锁/生命周期边界 16/16；既有 NovaWing Context、Radar contracts/inputSnapshot/service/validity 与 Recommendation 定向回归 118/118；cc-auto 隔离回归 690 passed / 7 skipped；项目全量 2240 passed / 7 skipped；`migration:selftest`、`vue-tsc --noEmit` 与 production build 通过。临时磁盘库证明显式 apply → production validate、真实 V2/hash、revision stale、推荐排除、缺 schema 拒绝、busy 释放/超时和双连接关闭后文件可重命名；静态检查证明精确版本/官方 lock、公共出口、深导入拒绝及无生产 `nw_*` SQL。
- **边界：** 未修改 UI、审批流程、Prompt 正文、旧 `/api/llm/analyze-job`、cc-auto、OfferFlow schema/migration、NovaWing 仓库或 Snapshot V2；未连接真实业务数据库、未执行真实 Provider 网络或 production migration，未 commit、push、merge、rebase、tag、release 或 publish。

### 1.7 Host Snapshot V3 与离线 NovaWing bootstrap/恢复候选库（2026-08-05）

- **状态：** `IMPLEMENTED / OFFLINE ONLY / CANDIDATE ONLY`。新增稳定 `offerflow` + 正式包 `novawing` 双组件 Host Snapshot V3；schema v8 的 38 张 OfferFlow 表均完成分类，35 张纳入、`schema_migrations` / `import_logs` / `radar_rule_assessments` 按明确理由排除。完整审计见 `docs/technical/offerflow-host-snapshot-v3-table-classification.md`。
- **一致性与原子性：** 导出要求服务和业务连接离线；专用双驱动连接在同一 SQLite 文件上，以 OfferFlow `BEGIN IMMEDIATE` 阻止外部写入并形成 point-in-time 边界。数据/manifest 在 staging 目录写入并完整回读验证后才以目录 rename 发布；失败不留半份输出，V3 使用独立文件名，不覆盖 V2。
- **V2 兼容：** V2 七表行为和 loader 保持；新输出显式标记 `offerflow-core-v2`、`novaWingIncluded=false`、`completeHostBackup=false`。feature 开启或存在 NovaWing 数据时明确警告 V2 不是完整 Host 备份；V3 不接受 V2，也不制造空 NovaWing component。
- **bootstrap / restore：** `novawing:bootstrap` 只接受显式路径、离线确认、schema v8 和 DELETE journal，只调用正式包公共 migration apply，正常 Runtime 仍 validate-only。恢复只创建全新候选库，顺序为两套 schema bootstrap → 两组件数据 → integrity/FK → 组件/Host 校验 → 正常 Runtime 双连接读取 → 关闭/rename 探针；失败删除候选和报告。
- **安全与边界：** 快照命中凭证、provider key、环境变量或绝对路径时停止，不静默删改权威数据；CLI/报告/稳定错误不输出路径、SQL、SQLite 原文或正文。未实现或执行正式数据库替换，未接触真实数据库，未修改 feature 默认值、UI、Prompt、Provider、审批或 cc-auto。
- **验证：** Host Snapshot V3 定向 25/25；V2 + NovaWing 双驱动 + Radar/Recommendation + cc-auto 定向 989 passed / 7 skipped；项目全量单 worker 2265 passed / 7 skipped；`migration:selftest`、TypeScript typecheck、production build、architecture check（0 error）与 `git diff --check` 通过。并发全量曾两次在未修改的 cc-auto 测试目录触发 Windows 临时文件 rename `EPERM`，对应 spec 隔离 39/39、全量单 worker 均通过。

---

## 2. 红队问题追踪

| ID | 问题 | 最终裁决 | 落地位置 | 状态 |
|---|---|---|---|---|
| RT-01 | 缺少不可变 RadarCandidateVersion | 新增独立版本实体 | TD 4.5 | Resolved in Docs |
| RT-02 | radar_application_marks 影子 Application | 完全删除，改 Action | TD 4.11 | Resolved in Docs |
| RT-03 | Candidate 状态混合 | 仅 active/merged/archived | PRD 4.4 / TD 4.4 | Resolved in Docs |
| RT-04 | AI 返回内部 ID | Envelope/Payload 分离 | PRD 4.10 / TD 4.9 | Resolved in Docs |
| RT-05 | 输入准备度缺失 | 必需/可选/降级规则 | PRD 5 / TD 7 | Resolved in Docs |
| RT-06 | stale 缺失 | 确定性派生 reasons | PRD 4.11 / TD 8 | Resolved in Docs |
| RT-07 | 浏览器适配过载 | BOSS + 通用降级；猎聘 P1 | PRD 6 | Resolved in Docs |
| RT-08 | 误区必出矛盾 | 诊断结果必出，误区有证据门 | PRD 4.8 / 11 | Resolved in Docs |
| RT-09 | 断点续跑伪承诺 | 记录恢复 + 固定输入重试 | PRD 9.7 / TD 10 | Resolved in Docs |
| RT-10 | 文档混杂 | 拆分七份文档 | PRD 0.2 | Resolved in Docs |
| RT-11 | 非目标城市未定义 | 全局画像、cityCode=null | PRD 5.2 | Resolved in Docs |
| RT-12 | 非必要输入面扩大 | 仅保留扩展当前页采集；删除手工 JD 文本、组合链接与对象/数组导入入口 | PRD P0-03 / TD 6.3 | Resolved in Docs/Code |

---

## 3. 明确删除或后移

| 项目 | 决定 | 目标版本/位置 |
|---|---|---|
| “链接 + 文本”输入 | 删除 | V8-2 不提供入口；历史枚举仅兼容读取 |
| JSON 单对象/小数组输入 | 删除 | V8-2 不提供入口或处理器；历史 DTO/序列化仅兼容读取 |
| 手工 JD 文本输入 | 删除 | V8-2 页面、前端 API 包装和验收均不提供；`visibleText` 仅属于扩展 Capture Item 与历史兼容 |
| 猎聘专用字段适配 | 后移 | P1 |
| `/radar/imports` | 删除 | 不实现 |
| `radar_import_batches` | 删除 | 不实现 |
| `radar_application_marks` | 删除 | 不实现 |
| Candidate ignored/promoted 状态 | 删除 | Action/Promotion 派生 |
| AI 内部 ID 输出 | 删除 | 服务端 Envelope |
| 真正断点续跑承诺 | 删除 | 固定输入重试 |
| DeepSeek SSE 产品绑定 | 删除 | 技术实现自行选择 |
| 完整 SourceConfig/SourceRun | 后移 | v0.9 |
| 自动反馈画像进化 | 后移 | v0.9 |
| 低能量自动预筛 / 服务端批量 prefilter | 后移 | v0.9（不作为 V8-2 Done 条件）|
| 历史身份批量预检 / 自动滚动 / 全自动巡航（AutoCruiseRun）| 后移 | v0.9；不属于本次 V8-2 收口，也不在本次 checkpoint 中实现或提交 |
| list_panel「自动猜测当前 selected 卡片」 | 降级 | 仅作单项失败诊断探针，不作为 V8-2 正式能力；列表页正式路径改为「手动批量选卡 + 串行右侧详情采集」|

---

## 4. 用户可见截图清单

- [x] BOSS 扩展采集成功
- [x] 通用可见文本降级预览
- [x] 页面不存在手工 JD 文本/链接组合/JSON 输入
- [ ] CandidateVersion 历史与 Diff
- [ ] 数据质量与未知字段
- [ ] 透明规则命中原文
- [ ] 用户规则覆盖与撤销
- [ ] 单岗位分析四档建议
- [ ] stale 分析提示
- [ ] 0～8 条推荐
- [ ] 空推荐
- [ ] 正式误区诊断
- [ ] 证据不足诊断
- [ ] 收藏/忽略/重点/已投递
- [ ] 无回复不创建 Application
- [ ] 晋升预览与正式关联
- [ ] 任务失败、重试和刷新恢复

---

## 5. 发布授权追踪

| 动作 | 当前授权 |
|---|---|
| 冻结 PRD v2.1 | 未授权 |
| 开始 V8-1 实施 | 未授权 |
| 合并 main | 未授权 |
| 推送 main | 未授权 |
| Tag | 未授权 |
| Release | 未授权 |
