# OfferFlow v0.7 求职记忆恢复手册

## 1. 适用范围

本手册覆盖 OfferFlow v0.7.0 求职记忆升级的发布前恢复与灾难恢复。默认生产形态是 schema v2；schema v1 只允许在显式兼容或整体回退场景使用。

恢复操作遵守同一边界：

```text
先停止写入并确认故障阶段
→ 验证备份、数据库与 Snapshot
→ 只在隔离目录演练
→ 获得人工授权
→ 执行对应恢复
→ 只读复核
→ 再恢复业务写入
```

禁止把旧 Snapshot、旧数据库或不完整 apply-result 直接覆盖到正在运行的生产路径。任何恢复都不能自动创建 Application、ResumeVersion、FeedbackEvent，也不能自动投递或发送消息。

## 2. 恢复前固定检查

1. 停止 App，确认没有写连接、sync lock 或遗留端口。
2. 记录当前分支、Git Commit、数据库 schema、apply-result 阶段和 Snapshot schema。
3. 使用 manifest 校验 Backup ID、文件大小、SHA-256、integrity、foreign key 和表聚合。
4. 确认备份目录被 Git ignore，文件不是符号链接，且没有被覆盖。
5. 先把目标备份恢复到系统临时目录演练；禁止第一次验证就操作正式路径。
6. 恢复演练和正式复核均不得调用真实 LLM、OCR 或外部业务服务。

常用只读 Gate：

```bash
npm.cmd run job-memory-v2:verify-real
npm.cmd run snapshot:check
npm.cmd run v0.7:b8-audit
```

`job-memory-v2:verify-real` 和 `snapshot:check` 只负责复核，不执行 backfill 或恢复。全新 clone 缺少正式 Snapshot 时，consistency 必须明确失败并提示初始化或从备份恢复，不能把“文件不存在”当成通过。

## 3. 场景 A：apply 事务开始前失败

识别特征：

- 数据库仍为 schema v1。
- v2 三张表不存在。
- 没有 Application、FeedbackEvent 或 migration audit。
- 常见原因包括 checkpoint ID 冲突、Backup ID/哈希/授权 token 不一致、错误分支、dirty working tree 或源指纹变化。

处理：

1. 不恢复数据库，因为事务尚未开始。
2. 修复前置条件；不要删除、覆盖或复用冲突 checkpoint。
3. 重新运行 B7-A 只读检查和 dry-run。
4. 重新向用户展示 Backup ID、源短指纹、备份短哈希和预期聚合，并取得新的明确授权。
5. 授权通过后再运行正式 apply。

禁止留下“升级中”的假标记，也不要手工创建 v2 表。

## 4. 场景 B：apply transaction 内失败

识别特征：

- 失败发生在 schema migration、backfill、Projection 校验、Job hash 校验或提交前完整性校验。
- SQLite 独占事务应自动回滚。

处理：

1. 验证 schema 仍为 v1。
2. 验证 v2 表、Application、FeedbackEvent 和 migration audit 均不存在。
3. 验证源业务指纹与授权前一致。
4. 保留失败报告，修复阻塞原因后重新执行完整 preflight。

不要手工补表、补事件或修改 migration audit；任何半迁移状态都应视为恢复失败。

## 5. 场景 C：数据库 v2 成功，Snapshot 发布失败

识别特征：

- `databaseCommitted=true`。
- 数据库 schema 为 2，backfill 和 migration audit 已提交。
- `snapshotPublished=false`、`resolved=false`。
- 正式 Snapshot 仍是发布前的完整 pair，或发布失败后已原子回滚到旧 pair。

处理：

1. 禁止用 v1 数据库或 v1 Snapshot 覆盖已升级数据库。
2. 只读验证升级库：schema、migration、integrity、FK、Backup ID、apply Commit、源指纹、Application/Event/audit 聚合。
3. 使用受控 `resume-snapshot-real`，从当前已升级数据库重新生成 Snapshot v2。
4. 验证 Snapshot consistency 和 roundtrip。
5. 创建并校验 post-upgrade v2 备份，将其绑定最终成功 apply-result。
6. 最终状态必须唯一：`databaseCommitted=true`、`snapshotPublished=true`、`resolved=true`。
7. 第二次 resume 只能返回 `already-resolved`，不得重复 backfill、重复发布或新增 audit。

## 6. 场景 D：升级后数据库损坏

处理：

1. 立即停止 App，保留损坏库和 sidecar，不在原文件上修补。
2. 使用 post-upgrade v2 备份恢复到全新目录。
3. 校验备份 manifest、数据库 integrity/FK、schema v2 和 7 张同步表聚合。
4. 恢复同一备份中的 Snapshot v2 pair，执行 consistency 和 roundtrip。
5. 启动默认 v2 Server，执行只读 `/jobs/summaries`、`/jobs/:id/bundle` 和 `/resume-versions` smoke。
6. 端口释放、只读指纹不变并获得人工确认后，才允许替换正式路径。

默认不回退 v1。只有产品明确决定整体降级时，才进入场景 E。

## 7. 场景 E：必须整体回退 v1

整体回退需要单独人工授权，且必须同时回退数据和运行代码：

1. 使用批准的 schema v1 灾难恢复备份，不使用临时 checkpoint 替代授权基线。
2. 将数据库和 Snapshot v1 恢复到隔离目录并完成只读 API smoke。
3. 代码切换到显式 v1 兼容配置：后端 capability=false，前端 flag=false。
4. 确认 Server 不自动迁移、不执行 backfill、不注册 v2 routes。
5. 获得整体降级授权后才替换正式路径。

不能只换成 v1 数据库而继续运行默认 v2 代码；默认 v2 Server 会明确拒绝未升级的 schema v1 数据库。

## 8. 恢复后验收

- 数据库 schema 与运行代码一致。
- `integrity_check=ok`，foreign key violation 为 0。
- migration 连续，表聚合符合授权记录。
- Snapshot schema 与数据库一致，所有同步表差异为 0。
- 只读 API 返回共享 Schema 可解析响应。
- 数据库、Snapshot 和备份在复核前后指纹不变。
- 临时目录、临时数据库、发布 staging 和端口全部清理。
- Human-in-the-loop、legacy write guard 和 Projection 单事实源继续生效。

## 9. 明确禁止

- 在真实库重新执行 backfill。
- 用备份覆盖真实库后再补写缺失记录。
- 手工修改 Application、FeedbackEvent、Job 或 migration audit。
- 用 v1 Snapshot 覆盖 schema v2 数据库。
- 删除批准备份、checkpoint、post-upgrade 备份或正式 Snapshot。
- 在恢复脚本中调用 LLM、OCR、Boss/猎聘、自动投递或自动消息发送。
- 把完整哈希、绝对路径、真实 Job ID 或业务记录写入报告。
