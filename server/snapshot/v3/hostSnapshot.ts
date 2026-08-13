import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import {
  HostSnapshotRegistry,
  createNovaWingSnapshotComponent,
  createRegisteredHostSnapshotManifest,
  validateRegisteredHostSnapshotManifest,
  type ComponentSnapshotManifest,
  type HostSnapshotIdentity,
  type HostSnapshotV3Manifest,
} from '@weijianjunwjj/nova-wing/host-snapshot';
import {
  NOVAWING_AUTHORITATIVE_TABLES,
  validateNovaWingSnapshotManifest,
  verifyNovaWingBeforeSnapshotExport,
} from '@weijianjunwjj/nova-wing/sqlite';
import { getDatabaseSchemaVersion, LATEST_SCHEMA_VERSION, RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION } from '../../migrations';
import { readAppVersion } from '../../sync/appVersion';
import { atomicWriteJson } from '../../sync/hash';
import { HostSnapshotV3Error, hostSnapshotError } from './errors';
import {
  assertNoPathConflict,
  assertSnapshotMemberRegularFile,
  isPathStrictlyInside,
  readSnapshotMemberUtf8,
  validateExistingInputDirectory,
  validateExistingInputFile,
  validateNewOutputDirectory,
} from './pathSafety';
import {
  assertComponentData,
  assertSnapshotDataSafety,
  readNovaWingComponentData,
  verifyNovaWingDataInMemory,
} from './data';
import {
  createOfferFlowComponentManifestFromData,
  createOfferFlowSnapshotComponent,
  readOfferFlowComponentData,
} from './offerFlowComponent';
import {
  HOST_SNAPSHOT_V3_DATA_FILE,
  HOST_SNAPSHOT_V3_MANIFEST_FILE,
  OFFERFLOW_COMPONENT_NAME,
  OFFERFLOW_HOST_DATA_FORMAT,
  OFFERFLOW_SNAPSHOT_VERSION,
  type HostSnapshotV3Data,
  type HostSnapshotV3ExportReport,
  type HostSnapshotV3VerifyReport,
  type SnapshotComponentData,
  type VerifiedHostSnapshotV3,
} from './types';

export const HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION =
  'EXPORT_HOST_SNAPSHOT_V3_OFFLINE' as const;

export interface HostSnapshotV3ExportOptions {
  databasePath: string;
  outputDirectory: string;
  workingDirectory: string;
  workspaceDirectory: string;
  confirmation: typeof HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION;
  dryRun?: boolean;
  now?: () => string;
  hooks?: {
    failAfterDataWrite?: boolean;
    failBeforePublish?: boolean;
    /** Red-team synchronization point: invoked while BEGIN IMMEDIATE is held, before NovaWing opens. */
    afterConsistencyLock?: () => void;
    /** Red-team only: prove the lock makes component data read order irrelevant. */
    componentDataReadOrder?: readonly ['offerflow' | 'novawing', 'offerflow' | 'novawing'];
    /** Red-team only: force an exception inside the consistency boundary after one component read. */
    failAfterFirstComponentRead?: boolean;
  };
}

interface ResolvedExportPaths {
  databasePath: string;
  outputDirectory: string;
  workingDirectory: string;
  workspaceDirectory: string;
}

function createRegistry(): HostSnapshotRegistry {
  const registry = new HostSnapshotRegistry();
  registry.register(createOfferFlowSnapshotComponent());
  registry.register(createNovaWingSnapshotComponent());
  return registry;
}

function resolveExportPaths(options: HostSnapshotV3ExportOptions): ResolvedExportPaths {
  const database = validateExistingInputFile(options.databasePath);
  const output = validateNewOutputDirectory(options.outputDirectory);
  const working = validateExistingInputDirectory(options.workingDirectory);
  const workspace = validateExistingInputDirectory(options.workspaceDirectory);
  if (!fs.existsSync(path.join(workspace.path, '.git'))) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_TYPE_MISMATCH', 'workspace 必须是 Git 工作区');
  }
  assertNoPathConflict(workspace, working, { rejectOverlap: true });
  if (!isPathStrictlyInside(working, output)) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_PATH_CONFLICT', '输出必须严格位于显式 working directory 内');
  }
  assertNoPathConflict(database, output, { rejectOverlap: true });
  return {
    databasePath: database.path,
    outputDirectory: output.path,
    workingDirectory: working.path,
    workspaceDirectory: workspace.path,
  };
}

function assertDeleteJournalBetter(db: Database.Database): void {
  if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'delete') {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', 'Host Snapshot V3 要求 journal_mode=DELETE');
  }
}

function assertDeleteJournalNode(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
  if (typeof row?.journal_mode !== 'string' || row.journal_mode.toLowerCase() !== 'delete') {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', 'Host Snapshot V3 要求 journal_mode=DELETE');
  }
}

function novaWingManifestFromComponent(component: ComponentSnapshotManifest): ReturnType<typeof validateNovaWingSnapshotManifest> {
  return validateNovaWingSnapshotManifest({
    format: component.format,
    snapshotVersion: component.snapshotVersion,
    schemaVersion: component.schemaVersion,
    currentCoreRevision: component.metadata.currentCoreRevision,
    // Host component manifests are canonically sorted by table name, while the
    // NovaWing snapshot contract requires its published registry order.
    tables: NOVAWING_AUTHORITATIVE_TABLES.map((descriptor) => {
      const table = component.tables.find((candidate) => candidate.name === descriptor.name);
      if (table === undefined) {
        throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'NovaWing component 缺少权威表');
      }
      return table;
    }),
  });
}

function componentByName(
  components: readonly ComponentSnapshotManifest[],
  name: string,
): ComponentSnapshotManifest {
  const component = components.find((candidate) => candidate.component === name);
  if (component === undefined) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 缺少必需组件');
  }
  return component;
}

function buildSnapshotInConsistencyBoundary(
  databasePath: string,
  createdAt: string,
  hooks: HostSnapshotV3ExportOptions['hooks'],
): { data: HostSnapshotV3Data; manifest: HostSnapshotV3Manifest } {
  const offerFlow = new Database(databasePath, { fileMustExist: true, timeout: 100 });
  let locked = false;
  let novaWing: DatabaseSync | undefined;
  let stage = 'offerflow-open';
  try {
    stage = 'offerflow-journal';
    assertDeleteJournalBetter(offerFlow);
    const version = getDatabaseSchemaVersion(offerFlow);
    if (version < RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION) {
      throw hostSnapshotError(
        'HOST_SNAPSHOT_V3_SCHEMA_MISMATCH',
        `Host Snapshot V3 要求 OfferFlow schema >= v${RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION}，实际 v${version}`,
      );
    }
    try {
      stage = 'consistency-lock';
      offerFlow.pragma('busy_timeout = 100');
      offerFlow.exec('BEGIN IMMEDIATE');
      locked = true;
    } catch {
      throw hostSnapshotError(
        'HOST_SNAPSHOT_V3_OFFLINE_LOCK_REQUIRED',
        'Host Snapshot V3 需要服务离线且无活动写操作',
      );
    }
    stage = 'consistency-hook';
    hooks?.afterConsistencyLock?.();
    stage = 'novawing-open';
    novaWing = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 100,
    });
    novaWing.exec('PRAGMA query_only = ON');
    assertDeleteJournalNode(novaWing);
    const registry = createRegistry();
    const contexts = new Map<string, unknown>([
      [OFFERFLOW_COMPONENT_NAME, offerFlow],
      ['novawing', novaWing],
    ]);
    const host: HostSnapshotIdentity = {
      name: 'offerflow',
      appVersion: readAppVersion(),
      schemaVersion: LATEST_SCHEMA_VERSION,
    };
    stage = 'component-manifest';
    const manifest = createRegisteredHostSnapshotManifest({ registry, contexts, createdAt, host });
    stage = 'component-data';
    const readOrder = hooks?.componentDataReadOrder ?? ['offerflow', 'novawing'];
    if (new Set(readOrder).size !== 2) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 component 读取顺序无效');
    }
    const componentData = new Map<string, SnapshotComponentData>();
    for (const [index, component] of readOrder.entries()) {
      componentData.set(
        component,
        component === OFFERFLOW_COMPONENT_NAME
          ? readOfferFlowComponentData(offerFlow)
          : readNovaWingComponentData(novaWing),
      );
      if (index === 0 && hooks?.failAfterFirstComponentRead) {
        throw new Error('TEST_FAIL_AFTER_FIRST_COMPONENT_READ');
      }
    }
    const components = [
      componentData.get(OFFERFLOW_COMPONENT_NAME)!,
      componentData.get('novawing')!,
    ];
    stage = 'component-safety';
    assertSnapshotDataSafety(components);
    stage = 'offerflow-digest';
    const offerFlowManifest = componentByName(manifest.components, OFFERFLOW_COMPONENT_NAME);
    if (createOfferFlowComponentManifestFromData(components[0]!).manifestDigest !== offerFlowManifest.manifestDigest) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'OfferFlow component 导出摘要不一致');
    }
    stage = 'novawing-manifest';
    const novaManifest = novaWingManifestFromComponent(componentByName(manifest.components, 'novawing'));
    stage = 'novawing-live-verify';
    verifyNovaWingBeforeSnapshotExport(novaWing);
    stage = 'novawing-data-verify';
    verifyNovaWingDataInMemory(components[1]!, novaManifest);
    return {
      data: {
        format: OFFERFLOW_HOST_DATA_FORMAT,
        snapshotVersion: OFFERFLOW_SNAPSHOT_VERSION,
        createdAt,
        host,
        components,
        hostManifestDigest: manifest.manifestDigest,
      },
      manifest,
    };
  } catch (error) {
    if (error instanceof HostSnapshotV3Error) throw error;
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_EXPORT_FAILED',
      `Host Snapshot V3 一致性边界在 ${stage} 阶段失败`,
    );
  } finally {
    try { novaWing?.close(); } finally {
      if (locked) {
        try { offerFlow.exec('ROLLBACK'); } catch { /* Connection close still releases the lock. */ }
      }
      offerFlow.close();
    }
  }
}

function parseHostData(value: unknown): HostSnapshotV3Data {
  if (value === null || typeof value !== 'object') {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 data 无效');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.format !== OFFERFLOW_HOST_DATA_FORMAT
    || candidate.snapshotVersion !== OFFERFLOW_SNAPSHOT_VERSION
    || typeof candidate.createdAt !== 'string'
    || candidate.host === null
    || typeof candidate.host !== 'object'
    || !Array.isArray(candidate.components)
    || typeof candidate.hostManifestDigest !== 'string'
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 data 版本或结构无效');
  }
  const host = candidate.host as Record<string, unknown>;
  if (
    typeof host.name !== 'string'
    || typeof host.appVersion !== 'string'
    || !Number.isSafeInteger(host.schemaVersion)
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 identity 无效');
  }
  const components = candidate.components.map(assertComponentData);
  if (
    components.length !== 2
    || components[0]?.component !== OFFERFLOW_COMPONENT_NAME
    || components[1]?.component !== 'novawing'
  ) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 必须且只能包含 OfferFlow 与 NovaWing');
  }
  return {
    format: OFFERFLOW_HOST_DATA_FORMAT,
    snapshotVersion: OFFERFLOW_SNAPSHOT_VERSION,
    createdAt: candidate.createdAt,
    host: { name: host.name, appVersion: host.appVersion, schemaVersion: Number(host.schemaVersion) },
    components,
    hostManifestDigest: candidate.hostManifestDigest,
  };
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 文件无法解析');
  }
}

export function readAndVerifyHostSnapshotV3(snapshotDirectoryRaw: string): VerifiedHostSnapshotV3 {
  const snapshotDirectory = validateExistingInputDirectory(snapshotDirectoryRaw);
  // Validate both physical members before either is parsed. Each read then opens a
  // descriptor and rechecks identity before and after reading to narrow replacement races.
  assertSnapshotMemberRegularFile(snapshotDirectory, HOST_SNAPSHOT_V3_DATA_FILE);
  assertSnapshotMemberRegularFile(snapshotDirectory, HOST_SNAPSHOT_V3_MANIFEST_FILE);
  try {
    const data = parseHostData(parseJson(readSnapshotMemberUtf8(snapshotDirectory, HOST_SNAPSHOT_V3_DATA_FILE)));
    const registry = createRegistry();
    const manifest = validateRegisteredHostSnapshotManifest(
      parseJson(readSnapshotMemberUtf8(snapshotDirectory, HOST_SNAPSHOT_V3_MANIFEST_FILE)),
      registry,
    );
    if (
      data.hostManifestDigest !== manifest.manifestDigest
      || data.createdAt !== manifest.createdAt
      || JSON.stringify(data.host) !== JSON.stringify(manifest.host)
    ) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 data/manifest 不一致');
    }
    assertSnapshotDataSafety(data.components);
    const offerFlowData = data.components[0]!;
    if (
      createOfferFlowComponentManifestFromData(offerFlowData).manifestDigest
      !== componentByName(manifest.components, OFFERFLOW_COMPONENT_NAME).manifestDigest
    ) {
      throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'OfferFlow component 数据摘要不一致');
    }
    const novaWingData = data.components[1]!;
    verifyNovaWingDataInMemory(
      novaWingData,
      novaWingManifestFromComponent(componentByName(manifest.components, 'novawing')),
    );
    return { data, manifest };
  } catch (error) {
    if (error instanceof HostSnapshotV3Error) throw error;
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 校验失败');
  }
}

export function verifyHostSnapshotV3Directory(snapshotDirectory: string): HostSnapshotV3VerifyReport {
  const verified = readAndVerifyHostSnapshotV3(snapshotDirectory);
  return {
    status: 'verified',
    snapshotVersion: 3,
    componentCount: verified.manifest.components.length,
    tableCount: verified.manifest.components.reduce((sum, component) => sum + component.tables.length, 0),
    hostManifestDigest: verified.manifest.manifestDigest,
  };
}

export function exportHostSnapshotV3(options: HostSnapshotV3ExportOptions): HostSnapshotV3ExportReport {
  if (options.confirmation !== HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_CONFIRMATION_REQUIRED', 'Host Snapshot V3 导出缺少显式离线确认');
  }
  const paths = resolveExportPaths(options);
  try {
    const snapshot = buildSnapshotInConsistencyBoundary(
      paths.databasePath,
      (options.now ?? (() => new Date().toISOString()))(),
      options.hooks,
    );
    const report: HostSnapshotV3ExportReport = {
      status: options.dryRun ? 'planned' : 'exported',
      snapshotVersion: 3,
      databaseSchemaVersion: snapshot.manifest.host.schemaVersion,
      componentCount: snapshot.manifest.components.length,
      tableCount: snapshot.manifest.components.reduce((sum, component) => sum + component.tables.length, 0),
      hostManifestDigest: snapshot.manifest.manifestDigest,
      componentDigests: Object.fromEntries(
        snapshot.manifest.components.map((component) => [component.component, component.manifestDigest]),
      ),
    };
    if (options.dryRun) return report;

    const outputParent = path.dirname(paths.outputDirectory);
    const stagingDirectory = fs.mkdtempSync(path.join(outputParent, '.host-snapshot-v3-stage-'));
    try {
      atomicWriteJson(path.join(stagingDirectory, HOST_SNAPSHOT_V3_DATA_FILE), snapshot.data);
      if (options.hooks?.failAfterDataWrite) throw new Error('TEST_FAIL_AFTER_DATA_WRITE');
      atomicWriteJson(path.join(stagingDirectory, HOST_SNAPSHOT_V3_MANIFEST_FILE), snapshot.manifest);
      readAndVerifyHostSnapshotV3(stagingDirectory);
      if (options.hooks?.failBeforePublish) throw new Error('TEST_FAIL_BEFORE_PUBLISH');
      fs.renameSync(stagingDirectory, paths.outputDirectory);
    } finally {
      if (fs.existsSync(stagingDirectory)) fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
    return report;
  } catch (error) {
    if (error instanceof HostSnapshotV3Error) throw error;
    throw hostSnapshotError('HOST_SNAPSHOT_V3_EXPORT_FAILED', 'Host Snapshot V3 导出失败');
  }
}

export function novaWingComponentManifest(
  manifest: HostSnapshotV3Manifest,
): ReturnType<typeof validateNovaWingSnapshotManifest> {
  return novaWingManifestFromComponent(componentByName(manifest.components, 'novawing'));
}

export function componentDataByName(
  components: readonly SnapshotComponentData[],
  name: string,
): SnapshotComponentData {
  const component = components.find((candidate) => candidate.component === name);
  if (component === undefined) {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_INVALID', 'Host Snapshot V3 缺少必需组件数据');
  }
  return component;
}

export function hostSnapshotRegistry(): HostSnapshotRegistry {
  return createRegistry();
}
