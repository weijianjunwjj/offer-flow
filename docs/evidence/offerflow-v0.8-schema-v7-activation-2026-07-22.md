# OfferFlow v0.8 生产数据库 schema v7 受控激活证据

> 日期：2026-07-22
> 结果：PASS
> V8-2：CLOSED / FROZEN
> Radar 正式入口：DISABLED

## 1. 授权与代码锁定

- 用户明确授权真实生产数据库 schema v7 受控激活。
- 激活前 HEAD：`9b3a972`；V8-1 migration checkpoint：`043dca7`。
- `043dca7..HEAD` 的 migration、升级入口和 migration selftest 无差异。
- package version 保持 `0.7.0`。
- 激活前 tracked diff、staged 区和未知未跟踪文件均为空。
- 未执行 push、merge、Tag、Release 或 PR。

## 2. 停写与升级前基线

- 停止了唯一在运行的 OfferFlow Radar 沙箱进程树；它使用系统临时沙箱库，不是生产库。
- 停写后 OfferFlow server、Vite、migration、自测和浏览器扩展提交端口均无监听。
- 生产库使用仓库默认相对路径 `data/offerflow.sqlite3`；未设置数据库路径或 Radar feature flag 覆盖。
- schema version：6；`schema_migrations` 为 1～6；Radar 表不存在。
- 文件 SHA-256：`18121c2e4a5a99a3727c0def3f006afc2278f57c9863f8a6be838c1efb9f0983`。
- 文件大小：1,085,440 字节；mtime UTC：`2026-07-16T15:50:02.920Z`。
- `PRAGMA integrity_check=ok`；`PRAGMA foreign_key_check` 结果 0 条。
- 既有表共 25 张：`app_meta`、`applications`、`candidate_evidence`、`capability_baseline_meta`、`capability_baseline_proposals`、`capability_baseline_versions`、`capability_command_receipts`、`feedback_events`、`historical_baseline_drafts`、`historical_event_drafts`、`historical_import_receipts`、`historical_import_sessions`、`import_logs`、`jobs`、`market_position_meta`、`market_position_proposals`、`market_position_receipts`、`market_position_versions`、`profiles`、`resume_versions`、`schema_migrations`、`strategy_meta`、`strategy_proposals`、`strategy_receipts`、`strategy_versions`。
- 关键行数：jobs=15、applications=9、feedback_events=11、resume_versions=1、profiles=1、candidate_evidence=9、market_position_versions=2、strategy_versions=2、capability_baseline_versions=1；`job_match_analysis_records` 在 v6 不存在。

## 3. 原始备份与恢复验证

- 原始备份位于 Git 忽略目录 `backups/migration-v0.8/schema-v7-activation-20260722T055835953Z/original/`，未覆盖任何旧备份。
- 原始备份 SHA-256、大小和 mtime 与生产源库完全一致。
- 从原始备份复制出独立恢复验证副本；以 `readonly + query_only` 打开成功。
- 恢复副本的 schema、全部 25 张表、全部表行数、完整性和外键结果与生产基线完全一致。
- 原始备份创建后未在其上运行 migration。

## 4. v6→v7 生产副本 dry-run

- 从原始备份另行复制 dry-run 库，使用与真实升级相同的已提交 `db:upgrade-real` 入口执行。
- schema 6→7；`schema_migrations` 仅新增 `007_v0_8_radar_domain_schema`。
- 表数 25→37；只新增预期的 12 张 Radar 表。
- 新增 12 个显式 Radar 索引，无重复索引签名、无临时表或意外表。
- 所有既有表行数不变；12 张 Radar 表初始行数全部为 0。
- dry-run 后 SHA-256：`38d9601a15af6f25e5e0faeebbc329dd2ffd8a54b4e9adb4994741a8e607f857`；大小 1,273,856 字节。
- `integrity_check=ok`；外键违规 0。
- 第二次执行返回 `noop`，没有重复创建结构或数据。
- v7 故障注入探针在创建完整 v7 结构后主动抛错；事务回滚后仍为 schema v6、零 Radar 表、migration 记录仍为 1～6，证明不留下半完成状态。

## 5. 真实生产升级

- 在停写状态下使用与 dry-run 完全相同的已提交入口和锁定源指纹执行。
- 工具在升级前再次创建备份并验证其 SHA-256 与锁定源一致。
- schema 6→7；migration 7 名称正确；37 张表全部存在。
- 全部既有业务表行数与升级前一致；12 张 Radar 表全部为 0。
- `integrity_check=ok`；外键违规 0。
- 升级后 SHA-256：`d1c114b93a8931d31f30839b091d60ef91c78356a4d761270e2e209af92926ff`。
- 升级后大小：1,273,856 字节；mtime UTC：`2026-07-22T06:00:28.888Z`。
- 未发布 Snapshot，未创建 Job、Application、FeedbackEvent、Candidate、Snapshot 或演示数据。

## 6. Radar 关闭状态下启动冒烟

- 使用正常 `npm run dev` 服务代码路径启动，真实数据库路径保持默认；同步目录被隔离到本次 Git 忽略的维护目录，防止历史 Snapshot 导入造成非本次授权写入。
- `/health`、`/profile`、`/jobs`、`/resume-versions`、`/job-match-profile`、`/market-position`、`/strategy/current` 均返回 200。
- Jobs、Profile、Job Match Profile、Market Position、Strategy 五个现有页面均成功渲染。
- 冒烟期间未出现 POST、PUT、PATCH 或 DELETE 请求，也没有前端未处理异常。
- Radar 后端路由未注册并返回通用 404；前端 `/radar/import` 重定向到 `jobs?feature=radar-import-disabled`，Preview 页面未渲染。
- 未执行真实浏览器采集、Preview 提交或 Candidate/CandidateVersion 创建。
- 停服后数据库 SHA-256、大小、mtime 和全部行数与升级完成时一致；Radar 表仍全部为 0；完整性和外键再次通过。

## 7. 最终裁决

- RC-01=Done；RC-02=Done；RC-03=Done；RC-04=Done。
- V8-2=`CLOSED / FROZEN`。
- 生产 schema=v7。
- Radar 正式入口=`DISABLED`。
- 未触发恢复；迁移前原始备份与独立恢复副本继续保留在 Git 忽略目录。
- V8-3=`APPROVED / DESIGN ALLOWED / IMPLEMENTATION NOT STARTED`；本次未实施任何 V8-3 或 v0.9 代码。
