# V8-6 岗位晋升 · 功能人工验收证据（阶段性）

**状态：PROMOTION FEATURE MANUALLY ACCEPTED / V8-6 PARTIAL / ACTIVATION PENDING**
**验收日期：2026-07-27**
**验收范围：仅 RadarPromotion 功能层，不含 V8-6 整体验收**

本轮由受控晋升验收沙箱（`npm run promotion:review`，schema v8、非生产、会话级临时库）
操作采集，用户复核已完成，结论为**岗位晋升功能人工验收通过**。

## 验收口径（严格限定）

- **岗位晋升功能 = 人工验收通过**
- **RC-11（正式晋升）= Partial**，非 Done
- **V8-6 整体 = Partial**，非 Done；RC-12 未启动
- schema v8 = IMPLEMENTED IN CODE / NOT ACTIVATED IN PRODUCTION
- Radar / Analysis / Recommendations / Promotion 正式入口 = DISABLED
- 生产 v8 激活仍需独立授权（BR-1），本轮未执行

本文件**不得**被引用为 RC-11 完成或 V8-6 完成的依据。

## 已完成并有证据的部分

| 能力 | 证据 |
|---|---|
| 预览零写入 | `promotion:e2e` 直读库断言：预览前后 `jobs` / `applications` / `feedback_events` / `radar_promotions` 四表计数逐一相等 |
| 确认写入正确 | 四类对象各 +1；UI 展示的四个 ID 与库内该行晋升记录逐字段比对一致 |
| 幂等重放 | 二次确认返回 200 且 `created=false`，复用同一晋升与同一批正式对象，零新增写入 |
| `no_response` 禁止晋升 | 预览与执行双端 409 `PROMOTION_TRIGGER_NOT_ALLOWED`，且四表零变化 |
| 深度钳制 | `user_priority` 请求 feedback 实际降为 job_only，`clampReasons` 含 `trigger_forbids_application`，确认后只建 Job |
| 原子失败零残留 | 注入撞主键的 `createId`，日志出现 `UNIQUE constraint failed: radar_promotions.id`，四表与失败前完全一致 |
| 端到端剧本 | `promotion:e2e` 11/11，连跑两次均通过；`integrity_check` 与 `foreign_key_check` 通过 |

工程门禁：`vue-tsc` 干净、全量 vitest 1353 通过（127 文件）、`build` 成功。

关键提交：`7a464b6`（领域）、`14373cb`（服务）、`e54e13c`（预览与确认）、
`5d48d30`（E2E 回归）、`de53dc5`（人工验收沙箱）。

## 明确缺口（本轮未覆盖）

| 缺口 | 说明 |
|---|---|
| 反向追踪 | 追溯矩阵 RC-11 验收物之一，无任何证据；未实现从正式对象反查候选版本的用户可见路径 |
| 撤销不删除正式事实 | RC-11 不通过条件之一（`release-contract.md:83`）。依赖 RC-10 RadarAction，该项未实现，**无法验证** |
| link 模式无 UI 入口 | 服务仅在请求显式带 `jobId` 时 link，前端未提供岗位选择器；link 仅经 API 验证，计划展示由组件测试覆盖 |
| 30 条评测 | `docs/evaluation/offerflow-v0.8-evaluation-plan.md:26` 要求真实岗位集 ≥30 条覆盖 19 类 + 13 项发布指标；仓库内无数据集、无标注、无跑批报告 |
| v8 migration / backup / recovery | 仅有 v7 激活证据（2026-07-22）；v8 演练零证据 |
| 截图与产品验收 | 无 V8-6 截图与产品验收文档 |
| `promotion:review` 停机路径 | Ctrl+C teardown 未验证（Git Bash 的 SIGTERM 送不到 Windows 原生进程，实测需 `taskkill /F`）；teardown 代码照搬已验证的 V8-5 脚本 |

## PRODUCTION_SCHEMA_VERSION = 2 的实际语义（只读查证，未修改）

该常量**不表示生产库处于 v2**。实测生产库 `data/offerflow.sqlite3`：
`schema_migrations` 为 1～7（至 `007_v0_8_radar_domain_schema`）、`app_meta.schema_version = '7'`、
10 张 radar 表齐备（含 `radar_promotions`，0 行）。

其真实含义有两处：

1. **Job Memory v2 生产底座下限**（`server/migrations.ts:28` 注释）：快照、恢复与生产验证机器以 v2 为准。
   `LATEST_SCHEMA_VERSION = 8` 与之有意区分，v3～v8 均为纯新增表，不改 v2 生产语义。
2. **启动门禁的默认所需版本**（`server/index.ts:157`）：未开启任何 Radar/能力 flag 时，
   要求版本回落到 2；真实生产库禁止启动时自动迁移。

因此「schema v8 代码完成、生产仍 v7」成立；但由此推论「生产无晋升表」是**错的**——
`radar_promotions` 在 v7 就已落地，v8 增量仅为 `008_v0_8_radar_candidate_relations_schema`。

### 由此查出的一处阻塞（未修改，留待授权后处理）

v0.7 时代的生产校验 `verifyCurrentProductionDatabase` 断言生产库**恰好**包含前 2 条 migration
且 `app_meta.schema_version === '2'`。只读实测该函数对当前生产库抛错：

```text
当前生产数据库 schema 应为 2，实际为 7
```

`createCurrentBaselineBackup`（`server/job-memory/production/baselineBackup.ts:182`）在备份前调用同一校验，
故 **v0.7 备份工具当前无法对生产库运行**。这是 v8 migration/backup/recovery 项的前置阻塞，
不是单纯「未开始」。**本轮按要求未改动该常量或校验逻辑。**

## 尚未开始

- RC-09（误区证据门）、RC-10（RadarAction）未开始；
- RC-12（可靠任务与发布验收）未启动；
- 生产 migration、备份恢复演练与正式开关切换均未授权、未执行。
