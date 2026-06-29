# OfferFlow v0.4 T2 Storage Adapter Design

## 1. 背景

T1 已验证 Tauri + SQLite 最小技术闭环：Tauri 可启动，应用本地数据目录可解析，SQLite 文件可创建，`app_meta.schema_version=1` 可写入并读回。

T2 只做存储适配层设计，不替换现有业务存储，不迁移 `localStorage`，不修改页面 UI。

目标是让后续 T3 / T4 / T5 能在清晰边界内推进 SQLite schema、备份、迁移和 adapter 实现，避免页面直接感知 Tauri 或 SQL。

## 2. 当前 `src/storage/` 现状

当前存储层由以下文件组成：

1. `types.ts`：定义持久化数据形状，包括 `JobSeekerProfile`、`JobRecord`、`JobReport`、`CompanyInput`、`CompanyAssessment`、`OpportunityAnalysis`、`CommunicationStatus` 和 v0.3 跟进事实字段。
2. `driver.ts`：定义同步键值接口 `StorageDriver`，当前实现有 `BrowserStorageDriver` 和 `MemoryStorageDriver`。
3. `configStore.ts`：`ConfigStore`，负责单条全局 profile 的 `getProfile` / `saveProfile` / `clearProfile`。
4. `jobStore.ts`：`JobStore`，负责 job 的 `createJob` / `getJob` / `listJobs` / `updateJob` / `deleteJob`。
5. `keys.ts`：定义 `offerflow:` namespace、profile key、job key、旧 namespace 兼容规则。
6. `defaults.ts`：读取旧 job 时补齐 v0.2 / v0.3 默认字段，并将旧 `contactStatus` 映射到 `communicationStatus`。
7. `migration.ts`：把旧 `offerpilot:` namespace 复制到当前 `offerflow:` namespace，不删除旧数据。
8. `index.ts`：公开 storage 类型和 `createStores` / `createBrowserStores` / `createMemoryStores`。

当前页面通过 `src/app/stores.ts` 的 `useStores()` 间接拿到 stores：

```txt
Vue Pages
  ↓
useStores()
  ↓
ConfigStore / JobStore
  ↓
StorageDriver
  ↓
Browser localStorage
```

当前关键行为：

1. `ConfigStore` 保存一条全局 profile，覆盖式写入。
2. `JobStore` 一条 job 一个 key，不使用总表大对象。
3. `listJobs()` 通过扫描 storage keys 找到 `offerflow:job:*`，读取完整 JSON，按 `updatedAt` 倒序排序。
4. `getJob()` 和 `listJobs()` 读取 job 时都会调用 `withJobRecordDefaults()` 补齐旧数据默认值。
5. `getProfile()` 遇到坏 JSON 会抛错。
6. `listJobs()` 遇到坏 job JSON 会跳过该条并 `console.warn`，不让一条坏数据拖垮列表。
7. `updateJob()` 保留 `id` 和 `createdAt`，并把 `updatedAt` 改为当前时间。
8. v0.3 派生决策字段不持久化；只持久化用户手动维护的跟进事实。

## 3. v0.4 存储适配层目标

T2 的目标是设计未来切换路径：

1. 页面不直接调用 Tauri command。
2. 页面不直接写 SQL。
3. Tauri command 不泄漏到 Vue 页面。
4. localStorage 和 SQLite 对页面暴露同一类 repository 能力。
5. 保留现有 `JobRecord` / `JobSeekerProfile` 业务模型含义。
6. 保留旧数据兼容规则：namespace 兼容、默认值补齐、坏数据处理。
7. 为 SQLite 的“核心索引字段独立列 + 完整对象 `data_json`”策略预留一致写入路径。
8. 为后续迁移、备份、校验、回滚留出边界，不在页面里散落迁移逻辑。

T2 不改变当前运行路径。当前页面仍使用现有 localStorage store。

## 4. 分层架构

推荐分层：

```txt
Vue Pages
  ↓
App Stores / Composables
  ↓
Storage Port
  ↓
LocalStorage Adapter / SQLite Adapter
  ↓
Browser localStorage / Tauri SQLite Commands
```

职责划分：

1. Vue Pages：只处理 UI 状态、表单输入、用户动作和展示，不关心数据来自 localStorage 还是 SQLite。
2. App Stores / Composables：负责把页面动作转为 repository 调用，承接 loading / error / refresh 状态。
3. Storage Port：定义 profile 和 job 的业务读写接口，是页面和存储实现之间的稳定契约。
4. LocalStorage Adapter：复用现有 `ConfigStore` / `JobStore` 行为，作为迁移前默认实现和回退实现。
5. SQLite Adapter：通过 Tauri command 访问 SQLite，不直接出现在页面层。
6. Tauri SQLite Commands：负责 app data 路径、SQLite 连接、事务、schema、备份、迁移和错误返回。

## 5. 推荐接口草案

由于 Tauri command 是异步边界，v0.4 的正式 storage port 建议使用 `Promise`。LocalStorage adapter 可以用 `Promise.resolve(...)` 包装现有同步 store。

```ts
export interface StoragePort {
  profile: ProfileRepository;
  jobs: JobRepository;
  meta: StorageMetaRepository;
}

export interface StorageMetaRepository {
  getSchemaVersion(): Promise<string | null>;
  getMigrationStatus(): Promise<MigrationStatus>;
}

export type MigrationStatus =
  | 'not_started'
  | 'backup_created'
  | 'migrating'
  | 'migrated'
  | 'failed';
```

T2 不新增实际 TypeScript 文件；上面只是文档草案。

## 6. Profile 读写接口

```ts
export interface ProfileRepository {
  getProfile(): Promise<JobSeekerProfile | null>;
  saveProfile(profile: JobSeekerProfile): Promise<JobSeekerProfile>;
  clearProfile(): Promise<void>;
}
```

行为要求：

1. `getProfile()` 没有数据时返回 `null`。
2. `saveProfile()` 覆盖式保存全局唯一 profile。
3. `clearProfile()` 只清理当前 adapter 的 profile；迁移阶段不得删除旧 localStorage 数据。
4. SQLite adapter 写入 profile 时，`profiles.data_json` 保存完整 `JobSeekerProfile`。
5. 如果后续 profile 需要独立索引列，只能从 `JobSeekerProfile` 统一派生，不允许页面传第二套列数据。

## 7. Job CRUD 接口

```ts
export interface JobRepository {
  createJob(input?: JobCreateInput): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  listJobs(query?: JobListQuery): Promise<JobRecord[]>;
  updateJob(
    id: string,
    patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>>,
  ): Promise<JobRecord>;
  deleteJob(id: string): Promise<boolean>;
}

export interface JobListQuery {
  city?: string;
  companySizeTier?: CompanySizeTier;
  communicationStatus?: CommunicationStatus;
  minOpportunityScore?: number;
  decisionView?: 'all' | 'to_greet' | 'followup' | 'cut_loss' | 'waiting_reply';
  orderBy?: 'updatedAt' | 'opportunityScore' | 'matchScore';
  orderDirection?: 'asc' | 'desc';
}
```

行为要求：

1. `createJob()` 继续只接收 `JobCreateInput`，由 repository 填充默认值。
2. `getJob()` 返回完整 `JobRecord`，读取旧数据时仍要补默认值。
3. `listJobs()` 默认按 `updatedAt desc`，与当前 `JobStore` 行为一致。
4. `updateJob()` 必须保留 `id` / `createdAt`，并统一刷新 `updatedAt`。
5. `deleteJob()` 返回是否存在过该记录。
6. v0.3 派生决策字段仍不持久化，列表决策视图应继续由 `deriveDecision(job, allJobs)` 派生，不写入 SQLite。

`JobListQuery.decisionView` 只作为后续页面 / app store 的便利参数草案；SQLite adapter 不应把派生决策结果落库。

## 8. `listJobs` 排序 / 筛选字段来源

当前 localStorage 实现：

1. 扫描 `offerflow:job:*`。
2. 读取完整 JSON。
3. `withJobRecordDefaults()` 补齐字段。
4. 内存中按 `updatedAt` 倒序排序。

未来 SQLite 实现建议：

| 用途 | SQLite 独立列 | 来源 |
|---|---|---|
| 主键 | `id` | `JobRecord.id` |
| 列表标题 | `company` / `role` | `JobRecord.company` / `JobRecord.role` |
| 基础筛选 | `city` | `JobRecord.city` |
| 沟通筛选 | `communication_status` | `JobRecord.communicationStatus` |
| 更新时间排序 | `updated_at` | `JobRecord.updatedAt` |
| 创建时间 | `created_at` | `JobRecord.createdAt` |
| 机会分排序 / 筛选 | `opportunity_score` | `JobRecord.opportunityAnalysis?.opportunityScore ?? null` |
| 匹配分排序 | `match_score` | `JobRecord.matchScore` 转为可排序数字，无法转换时为 `null` |
| 公司规模筛选 | `company_size_tier` | `companyInput.sizeTier` 优先，必要时兼容 `companyAssessment.sizeTier` |
| 高价值信号 | `high_value_signal` | `JobRecord.highValueSignal ? 1 : 0` |

完整对象仍保存在 `data_json`。返回 `JobRecord` 时以 `data_json` 为完整事实来源，再执行默认值补齐。独立列只服务列表、筛选、排序和迁移校验。

## 9. 错误处理策略

统一错误策略：

1. repository 层返回稳定业务错误，不把底层 `localStorage`、SQLite、Tauri 原始异常直接暴露给页面。
2. `getProfile()` 遇到坏 JSON：保持当前行为，抛出清晰错误。
3. `listJobs()` 遇到单条坏数据：保持当前行为，跳过坏记录并记录 warning / migration log，不让整页崩溃。
4. `getJob(id)` 遇到该 job 坏数据：抛出含 `id` 的清晰错误。
5. `updateJob(id)` 找不到记录：抛出含 `id` 的清晰错误。
6. SQLite 写入失败必须在 Tauri command 内回滚事务。
7. 迁移失败不得标记 `migration_status=migrated`，不得删除旧 localStorage 数据。

建议后续定义：

```ts
export type StorageErrorCode =
  | 'not_found'
  | 'corrupted_data'
  | 'write_failed'
  | 'read_failed'
  | 'migration_failed'
  | 'backup_failed';
```

T2 不实现该类型，仅记录设计方向。

## 10. JSON data 与 SQLite 独立列一致性策略

SQLite 写入必须遵守一个原则：

```txt
独立列永远由完整 JobRecord / JobSeekerProfile 派生，不允许页面或调用方单独传列值。
```

推荐写入流程：

```txt
输入 JobRecord
  ↓
withJobRecordDefaults / normalize
  ↓
deriveJobIndexColumns(record)
  ↓
同一事务内写入 jobs 独立列 + data_json
  ↓
读回或返回同一个 normalized record
```

建议后续 SQLite adapter 内部维护纯函数：

```ts
interface JobIndexColumns {
  id: string;
  company: string;
  role: string;
  city: string;
  communicationStatus: CommunicationStatus;
  createdAt: number;
  updatedAt: number;
  opportunityScore: number | null;
  matchScore: number | null;
  companySizeTier: CompanySizeTier;
  highValueSignal: boolean;
}

function deriveJobIndexColumns(record: JobRecord): JobIndexColumns;
```

一致性要求：

1. `data_json` 是完整对象兜底，不允许只靠独立列重建 `JobRecord`。
2. 独立列和 `data_json` 必须在同一 SQLite transaction 中写入。
3. 任何更新 job 的路径都必须经过同一个 adapter 方法，避免列和 JSON 分叉。
4. 迁移校验要比较 job 数量、关键字段和 `data_json` 中的完整对象。
5. 如果发现独立列和 `data_json` 不一致，优先信任 `data_json` 并记录修复任务，不在页面层临时修补。

## 11. 为什么页面不能直接调用 Tauri

页面直接调用 Tauri command 会带来以下问题：

1. 页面会绑定桌面运行时，Web 端 `npm.cmd run build` 的可维护性下降。
2. localStorage 回退、迁移前只读兜底、测试用内存 adapter 会变困难。
3. Tauri command 名称、参数、错误格式会扩散到多个 Vue 组件。
4. 页面会同时承担 UI、业务状态、存储协议和错误翻译，难以审查是否越界。
5. 后续如果调整 SQLite command 或备选本地服务方案，页面需要大面积改动。

因此页面只能依赖 app store / composable 暴露的业务方法；Tauri 只允许出现在 SQLite adapter 或更底层 command client 中。

## 12. LocalStorage Adapter 与 SQLite Adapter 分工

LocalStorage Adapter：

1. 复用当前 `ConfigStore` / `JobStore` 行为。
2. 作为 v0.4 切换前默认数据源。
3. 作为迁移失败后的只读兜底来源。
4. 继续承担旧 namespace 复制和默认值补齐行为，直到正式迁移逻辑接管。

SQLite Adapter：

1. 通过 Tauri command 访问 SQLite。
2. 负责 schema version、事务、索引列、`data_json`、migration status。
3. 负责把 SQLite row 转成完整 `JobRecord` / `JobSeekerProfile`。
4. 不直接出现在 Vue 页面。
5. 不在 T2 实现；T3 起再落地。

Adapter 选择建议：

```txt
未迁移 / 迁移失败：LocalStorage Adapter
迁移成功且校验通过：SQLite Adapter
手动恢复 / 调试：允许显式只读查看 localStorage 备份
```

## 13. 与 v0.3 跟进事实字段的兼容

SQLite adapter 必须完整保留以下 v0.3 字段：

1. `communicationStatus`
2. `lastGreetedAt`
3. `followupCount`
4. `lastFollowupAt`
5. `lastCommunicationNote`
6. `highValueSignal`
7. `strategyOverride`
8. `draftMessageText`

其中：

1. `communicationStatus`、`followupCount`、`highValueSignal` 建议同步为独立列，服务列表筛选和排序。
2. 其他跟进事实字段可只保存在 `data_json`，除非后续有明确列表筛选需求。
3. `strategy`、`nextAction`、`stopLoss`、`scenario`、`companyWarning` 仍是派生结果，不进入 SQLite 持久化字段。

## 14. T3 / T4 / T5 后续拆分建议

T3：SQLite schema 与基础 repository 实现

1. 定义 SQLite schema。
2. 建立 `app_meta`、`profiles`、`jobs`、`migration_logs`、`backup_logs`。
3. 实现 Tauri command 的最小 profile / job 读写。
4. 实现 `deriveJobIndexColumns()`。
5. 不接页面，不迁移 localStorage。

T4：localStorage JSON 备份与导出设计 / 实现

1. 读取当前 `offerflow:*` 和旧 `offerpilot:*` 数据。
2. 生成迁移前 JSON 备份。
3. 写入 `backup_logs`。
4. 提供手动导出 JSON 备份入口。
5. 不执行正式迁移。

T5：localStorage -> SQLite 迁移命令与校验

1. 执行备份。
2. 创建 schema。
3. 逐条迁移 profile / jobs。
4. 校验数量和关键字段。
5. 写入 `migration_logs`。
6. 标记 `migration_status=migrated`。
7. 只标记旧 localStorage 已迁移，不删除旧数据。

T6：页面接入前的 adapter 切换验证

1. 用 selftest 覆盖 LocalStorage Adapter 与 SQLite Adapter 同一接口行为。
2. 验证迁移成功和失败路径。
3. 验证坏数据处理。
4. 确认是否允许进入页面接入。

## 15. T2 红线

本阶段只设计，不做以下事项：

1. 不修改现有页面。
2. 不修改现有 `src/storage/` 运行逻辑。
3. 不替换 localStorage。
4. 不写正式 SQLite Store。
5. 不写 localStorage -> SQLite 迁移。
6. 不写备份恢复逻辑。
7. 不删除旧数据。
8. 不改 `JobRecord` 字段含义。
9. 不做云同步、AI API、账号、多端或 Boss 自动化。

