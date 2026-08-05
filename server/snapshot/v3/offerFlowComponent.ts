import type Database from 'better-sqlite3';
import {
  createComponentSnapshotManifest,
  digestSnapshotValue,
  validateComponentSnapshotManifest,
  type ComponentSnapshotManifest,
  type JsonPrimitive,
  type JsonValue,
  type SnapshotComponent,
} from '@weijianjunwjj/nova-wing/host-snapshot';
import { getDatabaseSchemaVersion, LATEST_SCHEMA_VERSION } from '../../migrations';
import { getPrimaryKeyColumns, getTableColumns, quoteIdent } from '../../sync/tables';
import { hostSnapshotError } from './errors';
import {
  OFFERFLOW_COMPONENT_FORMAT,
  OFFERFLOW_COMPONENT_NAME,
  OFFERFLOW_SNAPSHOT_VERSION,
  type SnapshotComponentData,
  type SnapshotTableData,
} from './types';

export type OfferFlowTableClassification =
  | 'authoritative-business'
  | 'recomputable-derived'
  | 'cache'
  | 'runtime-task-state'
  | 'migration-meta'
  | 'temporary-audit';

export interface OfferFlowTableRegistryEntry {
  name: string;
  migrationVersion: number;
  migrationName: string;
  classification: OfferFlowTableClassification;
  primaryModules: readonly string[];
  foreignKeys: readonly string[];
  includedInHostSnapshotV3: boolean;
  reason: string;
}

const V1 = '001_v0_6_baseline';
const V2 = '002_v0_7_job_memory_schema';
const V3 = '003_v0_7_capability_baseline_schema';
const V4 = '004_v0_7_history_funnel_schema';
const V5 = '005_v0_7_market_position_schema';
const V6 = '006_v0_7_strategy_window_schema';
const V7 = '007_v0_8_radar_domain_schema';
const V8 = '008_v0_8_radar_candidate_relations_schema';

export const OFFERFLOW_SCHEMA_V8_TABLE_REGISTRY: readonly OfferFlowTableRegistryEntry[] = [
  { name: 'analysis_tasks', migrationVersion: 7, migrationName: V7, classification: 'runtime-task-state', primaryModules: ['server/radar/analysisTaskRepository', 'server/radar/analysis'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '持久化任务状态同时保存不可替代的 input snapshot 与分析 input_hash 关联，恢复后仍需可靠重试和 revision 审计。' },
  { name: 'app_meta', migrationVersion: 1, migrationName: V1, classification: 'migration-meta', primaryModules: ['server/migrations', 'server/job-memory/resumeVersionRepository', 'server/sync'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '除 schema_version 外还保存 active_resume_version_id 等权威当前指针；V3 固定同 schema 恢复并完整校验。' },
  { name: 'applications', migrationVersion: 2, migrationName: V2, classification: 'authoritative-business', primaryModules: ['server/job-memory', 'server/radar/promotion'], foreignKeys: ['jobs', 'resume_versions', 'applications'], includedInHostSnapshotV3: true, reason: '正式求职记忆权威数据。' },
  { name: 'candidate_evidence', migrationVersion: 3, migrationName: V3, classification: 'authoritative-business', primaryModules: ['server/capability-baseline'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '人工/AI 经审核的能力证据及裁决不可重新生成。' },
  { name: 'capability_baseline_meta', migrationVersion: 3, migrationName: V3, classification: 'authoritative-business', primaryModules: ['server/capability-baseline'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '能力基线 active version 权威指针。' },
  { name: 'capability_baseline_proposals', migrationVersion: 3, migrationName: V3, classification: 'authoritative-business', primaryModules: ['server/capability-baseline'], foreignKeys: [], includedInHostSnapshotV3: true, reason: 'Human-in-the-loop 提案与裁决历史。' },
  { name: 'capability_baseline_versions', migrationVersion: 3, migrationName: V3, classification: 'authoritative-business', primaryModules: ['server/capability-baseline'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '正式能力基线不可变版本。' },
  { name: 'capability_command_receipts', migrationVersion: 3, migrationName: V3, classification: 'temporary-audit', primaryModules: ['server/capability-baseline/repository'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '命令幂等权威回执；丢失会允许重复高影响命令。' },
  { name: 'feedback_events', migrationVersion: 2, migrationName: V2, classification: 'authoritative-business', primaryModules: ['server/job-memory', 'server/radar/promotion'], foreignKeys: ['applications', 'feedback_events'], includedInHostSnapshotV3: true, reason: '正式求职反馈事实流水。' },
  { name: 'historical_baseline_drafts', migrationVersion: 4, migrationName: V4, classification: 'temporary-audit', primaryModules: ['server/history-import'], foreignKeys: ['historical_import_sessions', 'resume_versions', 'historical_baseline_drafts', 'jobs', 'applications'], includedInHostSnapshotV3: true, reason: '包含尚未确认或已确认的人工补录草稿及正式对象追踪，无法安全重算。' },
  { name: 'historical_event_drafts', migrationVersion: 4, migrationName: V4, classification: 'temporary-audit', primaryModules: ['server/history-import'], foreignKeys: ['historical_baseline_drafts', 'feedback_events'], includedInHostSnapshotV3: true, reason: '人工补录事件草稿与确认结果追踪。' },
  { name: 'historical_import_receipts', migrationVersion: 4, migrationName: V4, classification: 'temporary-audit', primaryModules: ['server/history-import/receiptRepository'], foreignKeys: ['historical_import_sessions'], includedInHostSnapshotV3: true, reason: '历史补录幂等回执。' },
  { name: 'historical_import_sessions', migrationVersion: 4, migrationName: V4, classification: 'temporary-audit', primaryModules: ['server/history-import'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '承载未完成人工补录会话且为草稿 FK 根。' },
  { name: 'import_logs', migrationVersion: 1, migrationName: V1, classification: 'temporary-audit', primaryModules: ['server/importLocalStorage', 'server/job-memory/upgrade', 'server/sync'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '保存不可复现的导入摘要、警告与升级审计，并被 Job Memory 校验、恢复审计和哈希链读取；当前不存在确定性重建入口。' },
  { name: 'job_match_analysis_records', migrationVersion: 7, migrationName: V7, classification: 'authoritative-business', primaryModules: ['server/radar/analysis'], foreignKeys: ['radar_candidates', 'radar_candidate_versions', 'resume_versions', 'job_match_analysis_records'], includedInHostSnapshotV3: true, reason: '不可重现的模型结果与服务端 Envelope 历史。' },
  { name: 'jobs', migrationVersion: 1, migrationName: V1, classification: 'authoritative-business', primaryModules: ['server/repositories/jobRepository', 'server/job-memory', 'server/radar/promotion'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '正式岗位记忆权威数据。' },
  { name: 'market_position_meta', migrationVersion: 5, migrationName: V5, classification: 'authoritative-business', primaryModules: ['server/market-position'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '市场位置 active version 权威指针。' },
  { name: 'market_position_proposals', migrationVersion: 5, migrationName: V5, classification: 'authoritative-business', primaryModules: ['server/market-position'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '市场位置提案与人工裁决历史。' },
  { name: 'market_position_receipts', migrationVersion: 5, migrationName: V5, classification: 'temporary-audit', primaryModules: ['server/market-position/repository'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '市场位置命令幂等权威回执。' },
  { name: 'market_position_versions', migrationVersion: 5, migrationName: V5, classification: 'authoritative-business', primaryModules: ['server/market-position'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '正式市场位置不可变版本。' },
  { name: 'profiles', migrationVersion: 1, migrationName: V1, classification: 'authoritative-business', primaryModules: ['server/repositories/profileRepository', 'server/sync'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '正式用户画像权威数据。' },
  { name: 'radar_actions', migrationVersion: 7, migrationName: V7, classification: 'authoritative-business', primaryModules: ['server/radar/action'], foreignKeys: ['radar_candidates', 'radar_candidate_versions', 'radar_actions'], includedInHostSnapshotV3: true, reason: 'Human-in-the-loop append-only 动作事实与撤销链。' },
  { name: 'radar_candidate_relations', migrationVersion: 8, migrationName: V8, classification: 'authoritative-business', primaryModules: ['server/radar/candidateRelationRepository', 'server/radar/reviewService'], foreignKeys: ['radar_candidates', 'radar_actions', 'radar_candidate_relations'], includedInHostSnapshotV3: true, reason: '重复候选人工裁决与演进历史。' },
  { name: 'radar_candidate_sources', migrationVersion: 7, migrationName: V7, classification: 'authoritative-business', primaryModules: ['server/radar/candidateRepository'], foreignKeys: ['radar_candidates', 'radar_source_records'], includedInHostSnapshotV3: true, reason: '候选与来源的权威关联。' },
  { name: 'radar_candidate_versions', migrationVersion: 7, migrationName: V7, classification: 'authoritative-business', primaryModules: ['server/radar/candidateRepository', 'server/radar/reviewService'], foreignKeys: ['radar_candidates', 'radar_candidate_versions'], includedInHostSnapshotV3: true, reason: '不可变标准化岗位事实版本。' },
  { name: 'radar_candidates', migrationVersion: 7, migrationName: V7, classification: 'authoritative-business', primaryModules: ['server/radar/candidateRepository', 'server/radar/reviewService'], foreignKeys: ['radar_source_records', 'radar_candidate_versions', 'radar_candidates'], includedInHostSnapshotV3: true, reason: 'Radar 候选生命周期权威数据。' },
  { name: 'radar_capture_sessions', migrationVersion: 7, migrationName: V7, classification: 'temporary-audit', primaryModules: ['server/radar/captureRepository', 'server/radar/routes'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '虽为短期技术对象，但保存未完成用户预览且是不可变 capture snapshot 的可选 FK 来源。' },
  { name: 'radar_capture_snapshots', migrationVersion: 7, migrationName: V7, classification: 'authoritative-business', primaryModules: ['server/radar/captureRepository', 'server/radar/commitService'], foreignKeys: ['radar_capture_sessions'], includedInHostSnapshotV3: true, reason: '不可变原始来源事实。' },
  { name: 'radar_promotions', migrationVersion: 7, migrationName: V7, classification: 'authoritative-business', primaryModules: ['server/radar/promotion'], foreignKeys: ['radar_candidates', 'radar_candidate_versions', 'jobs', 'applications', 'feedback_events', 'radar_actions'], includedInHostSnapshotV3: true, reason: 'Radar 到正式记忆的权威晋升追踪。' },
  { name: 'radar_recommendation_batches', migrationVersion: 7, migrationName: V7, classification: 'recomputable-derived', primaryModules: ['server/radar/recommendationBatchRepository', 'server/radar/recommendation'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '算法可再次运行，但历史批次/诊断与晋升追踪不可保证逐字节重现，作为审计结果保留。' },
  { name: 'radar_rule_assessments', migrationVersion: 7, migrationName: V7, classification: 'authoritative-business', primaryModules: ['server/radar/ruleAssessmentRepository', 'server/radar/reviewService', 'server/radar/analysis/inputSnapshot', 'server/radar/recommendation'], foreignKeys: ['radar_candidates', 'radar_candidate_versions'], includedInHostSnapshotV3: true, reason: '保存不可变规则结果与证据，且是人工覆盖、Analysis stale 与 Recommendation 硬约束的事实源；当前只有结果写入接口，不存在真实重算入口。' },
  { name: 'radar_source_records', migrationVersion: 7, migrationName: V7, classification: 'authoritative-business', primaryModules: ['server/radar/sourceRecordRepository', 'server/radar/commitService'], foreignKeys: ['radar_capture_snapshots'], includedInHostSnapshotV3: true, reason: '来源身份与最后不可变快照指针。' },
  { name: 'resume_versions', migrationVersion: 2, migrationName: V2, classification: 'authoritative-business', primaryModules: ['server/job-memory/resumeVersionRepository'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '正式简历不可变版本。' },
  { name: 'schema_migrations', migrationVersion: 0, migrationName: 'migration-runner-metadata', classification: 'migration-meta', primaryModules: ['server/migrations'], foreignKeys: [], includedInHostSnapshotV3: false, reason: '候选库由当前受信 migration bootstrap 确定性重建；不得从数据快照覆盖 migration 事实。' },
  { name: 'strategy_meta', migrationVersion: 6, migrationName: V6, classification: 'authoritative-business', primaryModules: ['server/strategy-window'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '策略 active version 权威指针。' },
  { name: 'strategy_proposals', migrationVersion: 6, migrationName: V6, classification: 'authoritative-business', primaryModules: ['server/strategy-window'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '策略提案与人工裁决历史。' },
  { name: 'strategy_receipts', migrationVersion: 6, migrationName: V6, classification: 'temporary-audit', primaryModules: ['server/strategy-window/repository'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '策略命令幂等权威回执。' },
  { name: 'strategy_versions', migrationVersion: 6, migrationName: V6, classification: 'authoritative-business', primaryModules: ['server/strategy-window'], foreignKeys: [], includedInHostSnapshotV3: true, reason: '正式策略不可变版本。' },
] as const;

export const OFFERFLOW_HOST_SNAPSHOT_V3_TABLES = OFFERFLOW_SCHEMA_V8_TABLE_REGISTRY
  .filter((entry) => entry.includedInHostSnapshotV3)
  .map((entry) => entry.name);

function asPrimitive(value: unknown): JsonPrimitive {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) return value;
  throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 仅接受可验证的 SQLite 标量');
}

function readTable(db: Database.Database, name: string): SnapshotTableData {
  const columns = getTableColumns(db, name);
  if (columns.length === 0) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', 'OfferFlow Snapshot 表结构不完整');
  }
  const primaryKey = getPrimaryKeyColumns(db, name);
  if (primaryKey.length === 0) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', 'OfferFlow Snapshot 权威表缺少主键');
  }
  const rows = db.prepare(
    `SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(name)} ORDER BY ${primaryKey.map(quoteIdent).join(', ')}`,
  ).all() as Array<Record<string, unknown>>;
  return {
    name,
    primaryKey,
    columns,
    rows: rows.map((row) => Object.fromEntries(
      columns.map((column) => [column, asPrimitive(row[column])]),
    )),
  };
}

export function readOfferFlowComponentData(db: Database.Database): SnapshotComponentData {
  if (getDatabaseSchemaVersion(db) !== LATEST_SCHEMA_VERSION) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', 'Host Snapshot V3 只接受 OfferFlow schema v8');
  }
  return {
    component: OFFERFLOW_COMPONENT_NAME,
    tables: OFFERFLOW_HOST_SNAPSHOT_V3_TABLES.map((table) => readTable(db, table)),
  };
}

export function createOfferFlowComponentManifestFromData(
  data: SnapshotComponentData,
): ComponentSnapshotManifest {
  if (data.component !== OFFERFLOW_COMPONENT_NAME) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'OfferFlow component 名称不匹配');
  }
  if (
    data.tables.length !== OFFERFLOW_HOST_SNAPSHOT_V3_TABLES.length
    || data.tables.some((table, index) => table.name !== OFFERFLOW_HOST_SNAPSHOT_V3_TABLES[index])
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'OfferFlow component 权威表集合不匹配');
  }
  return createComponentSnapshotManifest({
    component: OFFERFLOW_COMPONENT_NAME,
    format: OFFERFLOW_COMPONENT_FORMAT,
    snapshotVersion: OFFERFLOW_SNAPSHOT_VERSION,
    schemaVersion: LATEST_SCHEMA_VERSION,
    metadata: {
      databaseSchemaVersion: LATEST_SCHEMA_VERSION,
      authoritativeTableCount: OFFERFLOW_HOST_SNAPSHOT_V3_TABLES.length,
    },
    tables: data.tables.map((table) => ({
      name: table.name,
      rowCount: table.rows.length,
      contentDigest: digestSnapshotValue({
        columns: table.columns,
        primaryKey: table.primaryKey,
        rows: table.rows,
      } as JsonValue),
    })),
  });
}

function databaseFromContext(context: unknown): Database.Database {
  if (
    context === null
    || typeof context !== 'object'
    || !('prepare' in context)
    || !('pragma' in context)
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'OfferFlow component context 无效');
  }
  return context as Database.Database;
}

export function createOfferFlowSnapshotComponent(): SnapshotComponent {
  return {
    component: OFFERFLOW_COMPONENT_NAME,
    owner: 'host',
    format: OFFERFLOW_COMPONENT_FORMAT,
    snapshotVersion: OFFERFLOW_SNAPSHOT_VERSION,
    authoritativeTables: OFFERFLOW_HOST_SNAPSHOT_V3_TABLES,
    verifyBeforeExport(context: unknown): ComponentSnapshotManifest {
      return createOfferFlowComponentManifestFromData(readOfferFlowComponentData(databaseFromContext(context)));
    },
    verifyAfterRestore(context: unknown, manifest: ComponentSnapshotManifest): void {
      const expected = validateComponentSnapshotManifest(manifest);
      const actual = createOfferFlowComponentManifestFromData(
        readOfferFlowComponentData(databaseFromContext(context)),
      );
      if (expected.manifestDigest !== actual.manifestDigest) {
        throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'OfferFlow component 恢复后摘要不一致');
      }
    },
  };
}
