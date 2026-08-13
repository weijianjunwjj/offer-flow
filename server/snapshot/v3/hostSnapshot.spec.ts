import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import {
  HostSnapshotRegistry,
  type SnapshotComponent,
} from '@weijianjunwjj/nova-wing/host-snapshot';
import { createNovaWingFacade, type NovaWingFacade } from '@weijianjunwjj/nova-wing/core';
import {
  NOVAWING_AUTHORITATIVE_TABLE_NAMES,
  createInjectedSqliteNovaWingStore,
} from '@weijianjunwjj/nova-wing/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db';
import { LATEST_SCHEMA_VERSION } from '../../migrations';
import { initSchema } from '../../schema';
import { createNovaWingRuntime } from '../../novawing/infrastructure';
import { AnalysisService } from '../../radar/analysis/analysisService';
import { deterministicSuccessProvider } from '../../radar/analysis/analysisProviderFakes';
import { seedActiveResumeAndProfile } from '../../radar/analysis/analysisInputFixture';
import { seedReviewFixture, type ReviewFixtureResult } from '../../radar/reviewFixture';
import { exportSnapshotToDirectory } from '../../sync/exportSnapshot';
import {
  SNAPSHOT_V2_COVERAGE,
  describeSnapshotV2Coverage,
} from '../../sync/types';
import {
  HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION,
  exportHostSnapshotV3,
  hostSnapshotRegistry,
  readAndVerifyHostSnapshotV3,
  verifyHostSnapshotV3Directory,
} from './hostSnapshot';
import {
  NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
  bootstrapNovaWingOffline,
} from './bootstrap';
import {
  HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
  restoreHostSnapshotV3ToCandidate,
} from './restoreCandidate';
import { DEFAULT_RESTORE_ARTIFACT_IO, type RestoreArtifactIo } from './restoreArtifacts';
import {
  HOST_SNAPSHOT_V3_DATA_FILE,
  HOST_SNAPSHOT_V3_MANIFEST_FILE,
} from './types';
import {
  OFFERFLOW_HOST_SNAPSHOT_V3_TABLES,
  OFFERFLOW_SCHEMA_V8_TABLE_REGISTRY,
} from './offerFlowComponent';
import { runHostSnapshotV3Cli } from '../../../scripts/hostSnapshotV3';

const cleanupDirectories: string[] = [];

afterEach(() => {
  while (cleanupDirectories.length > 0) {
    fs.rmSync(cleanupDirectories.pop()!, { recursive: true, force: true });
  }
});

interface Fixture {
  tempDirectory: string;
  databasePath: string;
  snapshotDirectory: string;
  pendingProposalId: string;
  radar?: ReviewFixtureResult;
}

function createTempDirectory(tag: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `offerflow-host-v3-${tag}-`));
  cleanupDirectories.push(directory);
  return directory;
}

function withNovaWingFacade<T>(
  databasePath: string,
  prefix: string,
  operation: (facade: NovaWingFacade) => T,
): T {
  const connection = new DatabaseSync(databasePath);
  const store = createInjectedSqliteNovaWingStore({ connection, migrationMode: 'validate' });
  let sequence = 0;
  try {
    return operation(createNovaWingFacade(store, {
      generateId: () => `${prefix}-${(sequence += 1)}`,
      clock: () => `2026-08-05T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    }));
  } finally {
    store.close();
    connection.close();
  }
}

function seedNovaWing(databasePath: string): string {
  return withNovaWingFacade(databasePath, 'source-nw', (facade) => {
    const approved = facade.createPendingProposal({
      action: 'set',
      memoryKey: 'global.snapshot_contract',
      category: 'principle',
      assertionType: 'user_decision',
      scope: 'global',
      proposedStatement: 'Use Host Snapshot V3',
      rationale: 'Preserve both authoritative components',
      evidenceSummary: 'Temporary integration fixture',
      sourceType: 'host',
      sourceSystem: 'offerflow-test',
    });
    facade.approveProposal({ proposalId: approved.id });
    return facade.createPendingProposal({
      action: 'set',
      memoryKey: 'career.restore_followup',
      category: 'priority',
      assertionType: 'user_decision',
      scope: 'career',
      proposedStatement: 'Continue after candidate restore',
      rationale: 'Prove revision continuity',
      evidenceSummary: 'Temporary integration fixture',
      sourceType: 'host',
      sourceSystem: 'offerflow-test',
    }).id;
  });
}

function createFixture(tag: string, includeRadar = false): Fixture {
  const tempDirectory = createTempDirectory(tag);
  const databasePath = path.join(tempDirectory, 'source.sqlite3');
  const db = openDb(databasePath);
  initSchema(db, { targetVersion: LATEST_SCHEMA_VERSION });
  let radar: ReviewFixtureResult | undefined;
  if (includeRadar) {
    let sequence = 0;
    radar = seedReviewFixture(db, {
      now: () => 1_700_000_000 + sequence,
      createId: () => `restore-seed-${(sequence += 1)}`,
    });
    seedActiveResumeAndProfile(db, 1_700_000_000);
  } else {
    db.prepare('INSERT INTO profiles (id, data_json, updated_at) VALUES (?, ?, ?)')
      .run('profile-v3', JSON.stringify({ displayName: 'Snapshot Fixture' }), 1_700_000_000);
  }
  db.prepare(`INSERT INTO import_logs (
    id, source, profile_count, job_count, ignored_key_count, warning_count, created_at, data_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'import-log-v3',
      'localstorage-json',
      1,
      2,
      3,
      1,
      1_700_000_001,
      JSON.stringify({ warnings: [{ key: 'legacy-job', reason: '字段无法解析' }] }),
    );
  db.close();
  bootstrapNovaWingOffline({
    databasePath,
    confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
  });
  const pendingProposalId = seedNovaWing(databasePath);
  return {
    tempDirectory,
    databasePath,
    snapshotDirectory: path.join(tempDirectory, 'host-v3'),
    pendingProposalId,
    radar,
  };
}

function exportFixture(fixture: Fixture): ReturnType<typeof exportHostSnapshotV3> {
  return exportHostSnapshotV3({
    databasePath: fixture.databasePath,
    outputDirectory: fixture.snapshotDirectory,
    workingDirectory: fixture.tempDirectory,
    workspaceDirectory: process.cwd(),
    confirmation: HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION,
    now: () => '2026-08-05T01:02:03.000Z',
  });
}

function mutateJson(filePath: string, mutate: (value: any) => void): void {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  mutate(value);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fakeComponent(
  component: string,
  owner: 'host' | 'novawing',
  tables: readonly string[],
): SnapshotComponent {
  return {
    component,
    owner,
    format: `${component}.snapshot.v3`,
    snapshotVersion: 3,
    authoritativeTables: tables,
    verifyBeforeExport(): never { throw new Error('unused'); },
    verifyAfterRestore(): never { throw new Error('unused'); },
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function snapshotRows(
  fixture: Fixture,
  componentName: 'offerflow' | 'novawing',
  tableName: string,
): Array<Record<string, unknown>> {
  const verified = readAndVerifyHostSnapshotV3(fixture.snapshotDirectory);
  const component = verified.data.components.find((candidate) => candidate.component === componentName);
  const table = component?.tables.find((candidate) => candidate.name === tableName);
  if (table === undefined) throw new Error(`snapshot table missing: ${componentName}/${tableName}`);
  return table.rows;
}

describe('Host Snapshot V3 registry 与 manifest', () => {
  it('审计 schema v12 全部 42 张表并明确选择 41 张 V3 表', () => {
    const fixture = createFixture('registry-audit');
    const db = new Database(fixture.databasePath, { readonly: true });
    const actual = (db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'nw_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    db.close();
    expect(OFFERFLOW_SCHEMA_V8_TABLE_REGISTRY).toHaveLength(42);
    expect(OFFERFLOW_SCHEMA_V8_TABLE_REGISTRY.map((entry) => entry.name)).toEqual(actual);
    expect(new Set(OFFERFLOW_SCHEMA_V8_TABLE_REGISTRY.map((entry) => entry.name)).size).toBe(42);
    expect(OFFERFLOW_HOST_SNAPSHOT_V3_TABLES).toHaveLength(41);
    expect(OFFERFLOW_SCHEMA_V8_TABLE_REGISTRY.filter((entry) => !entry.includedInHostSnapshotV3).map((entry) => entry.name))
      .toEqual(['schema_migrations']);
    expect(OFFERFLOW_SCHEMA_V8_TABLE_REGISTRY.every((entry) => entry.reason.trim() !== '')).toBe(true);
  });

  it('公共 registry 接受正常双组件并拒绝重复组件、重复表和跨 owner 越权', () => {
    expect(hostSnapshotRegistry().list().map((component) => component.component).sort())
      .toEqual(['novawing', 'offerflow']);

    const duplicateComponent = new HostSnapshotRegistry();
    duplicateComponent.register(fakeComponent('offerflow-a', 'host', ['profiles']));
    expect(() => duplicateComponent.register(fakeComponent('offerflow-a', 'host', ['jobs']))).toThrow();

    const duplicateTable = new HostSnapshotRegistry();
    expect(() => duplicateTable.register(fakeComponent('offerflow-a', 'host', ['profiles', 'profiles']))).toThrow();

    const hostClaimsNovaWing = new HostSnapshotRegistry();
    expect(() => hostClaimsNovaWing.register(fakeComponent('offerflow-a', 'host', ['nw_meta']))).toThrow();

    const novaWingClaimsHost = new HostSnapshotRegistry();
    expect(() => novaWingClaimsHost.register(fakeComponent('novawing', 'novawing', ['profiles']))).toThrow();
  });

  it('导出并验证双组件、host identity、行数与完整 digest', () => {
    const fixture = createFixture('manifest');
    const report = exportFixture(fixture);
    const verified = readAndVerifyHostSnapshotV3(fixture.snapshotDirectory);
    expect(report).toMatchObject({ status: 'exported', snapshotVersion: 3, componentCount: 2, tableCount: 44 });
    expect(verified.manifest).toMatchObject({
      format: 'host.snapshot.v3',
      snapshotVersion: 3,
      createdAt: '2026-08-05T01:02:03.000Z',
      host: expect.objectContaining({ name: 'offerflow' }),
    });
    expect(verified.manifest.components.map((component) => component.component).sort())
      .toEqual(['novawing', 'offerflow']);
    expect(verifyHostSnapshotV3Directory(fixture.snapshotDirectory).hostManifestDigest)
      .toBe(report.hostManifestDigest);
  });

  it.each([
    ['未知版本', (manifest: any) => { manifest.snapshotVersion = 99; }],
    ['缺失组件', (manifest: any) => { manifest.components.pop(); }],
    ['未知组件', (manifest: any) => { manifest.components[0].component = 'unknown'; }],
    ['行数篡改', (manifest: any) => { manifest.components[0].tables[0].rowCount += 1; }],
    ['schema 篡改', (manifest: any) => { manifest.components[0].schemaVersion += 1; }],
  ])('拒绝 %s', (_label, mutation) => {
    const fixture = createFixture('manifest-reject');
    exportFixture(fixture);
    mutateJson(path.join(fixture.snapshotDirectory, HOST_SNAPSHOT_V3_MANIFEST_FILE), mutation);
    expect(() => verifyHostSnapshotV3Directory(fixture.snapshotDirectory)).toThrow();
  });

  it('拒绝内容 digest 变化与 snapshot 行内容篡改', () => {
    const fixture = createFixture('data-tamper');
    exportFixture(fixture);
    mutateJson(path.join(fixture.snapshotDirectory, HOST_SNAPSHOT_V3_DATA_FILE), (data) => {
      const profiles = data.components[0].tables.find((table: any) => table.name === 'profiles');
      profiles.rows[0].data_json = JSON.stringify({ displayName: 'Tampered' });
    });
    expect(() => verifyHostSnapshotV3Directory(fixture.snapshotDirectory)).toThrow();
  });
});

describe('Host Snapshot V3 导出与 V2 隔离', () => {
  it('使用独立命名空间，V2 与 V3 不互相覆盖，并明确 V2 不含 NovaWing', () => {
    const fixture = createFixture('v2-v3');
    exportSnapshotToDirectory(fixture.databasePath, fixture.tempDirectory, 'temporary-device');
    const v2Snapshot = path.join(fixture.tempDirectory, 'offerflow.snapshot.json');
    const v2Manifest = path.join(fixture.tempDirectory, 'offerflow.manifest.json');
    const before = [sha256File(v2Snapshot), sha256File(v2Manifest)];
    exportFixture(fixture);
    expect([sha256File(v2Snapshot), sha256File(v2Manifest)]).toEqual(before);
    expect(fs.existsSync(path.join(fixture.snapshotDirectory, HOST_SNAPSHOT_V3_DATA_FILE))).toBe(true);
    expect(SNAPSHOT_V2_COVERAGE).toEqual({
      scope: 'offerflow-core-v2', novaWingIncluded: false, completeHostBackup: false,
    });
    expect(describeSnapshotV2Coverage({ novaWingFeatureEnabled: true, novaWingDataPresent: false }).warning)
      .toContain('不包含 NovaWing');
    expect(describeSnapshotV2Coverage({ novaWingFeatureEnabled: false, novaWingDataPresent: true }).warning)
      .toContain('不能作为完整 Host 备份');
  });

  it.each(['failAfterDataWrite', 'failBeforePublish'] as const)('中途失败 %s 不发布半份输出', (hook) => {
    const fixture = createFixture(`atomic-${hook}`);
    expect(() => exportHostSnapshotV3({
      databasePath: fixture.databasePath,
      outputDirectory: fixture.snapshotDirectory,
      workingDirectory: fixture.tempDirectory,
      workspaceDirectory: process.cwd(),
      confirmation: HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION,
      hooks: { [hook]: true },
    })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_EXPORT_FAILED' }));
    expect(fs.existsSync(fixture.snapshotDirectory)).toBe(false);
    expect(fs.readdirSync(fixture.tempDirectory).some((name) => name.startsWith('.host-snapshot-v3-stage-'))).toBe(false);
  });

  it('活动写事务使 point-in-time 导出硬拒绝', () => {
    const fixture = createFixture('write-conflict');
    const writer = new Database(fixture.databasePath);
    writer.exec('BEGIN IMMEDIATE');
    try {
      expect(() => exportFixture(fixture)).toThrowError(expect.objectContaining({
        code: 'HOST_SNAPSHOT_V3_OFFLINE_LOCK_REQUIRED',
      }));
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
    expect(fs.existsSync(fixture.snapshotDirectory)).toBe(false);
  });

  describe('红队 point-in-time 同步点', () => {
    it('BEGIN IMMEDIATE 获锁前提交的跨组件写入被两组件同时捕获', () => {
      const fixture = createFixture('pit-before-lock');
      const writer = new Database(fixture.databasePath);
      writer.transaction(() => {
        writer.prepare('UPDATE profiles SET data_json = ? WHERE id = ?')
          .run(JSON.stringify({ displayName: 'Before Lock' }), 'profile-v3');
        writer.prepare('UPDATE nw_proposals SET rationale = ? WHERE id = ?')
          .run('before-lock', fixture.pendingProposalId);
      })();
      writer.close();

      exportFixture(fixture);
      expect(snapshotRows(fixture, 'offerflow', 'profiles')).toContainEqual(expect.objectContaining({
        id: 'profile-v3', data_json: JSON.stringify({ displayName: 'Before Lock' }),
      }));
      expect(snapshotRows(fixture, 'novawing', 'nw_proposals')).toContainEqual(expect.objectContaining({
        id: fixture.pendingProposalId, rationale: 'before-lock',
      }));
    });

    it.each([
      ['OfferFlow→NovaWing', ['offerflow', 'novawing'] as const],
      ['NovaWing→OfferFlow', ['novawing', 'offerflow'] as const],
    ])('获锁后其它写连接 busy，且 %s 读取顺序得到同一旧状态', (_label, readOrder) => {
      const fixture = createFixture(`pit-order-${readOrder[0]}`);
      let blocked = false;
      exportHostSnapshotV3({
        databasePath: fixture.databasePath,
        outputDirectory: fixture.snapshotDirectory,
        workingDirectory: fixture.tempDirectory,
        workspaceDirectory: process.cwd(),
        confirmation: HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION,
        hooks: {
          componentDataReadOrder: readOrder,
          afterConsistencyLock() {
            const contender = new Database(fixture.databasePath, { timeout: 25 });
            try {
              contender.pragma('busy_timeout = 25');
              expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow();
              blocked = true;
            } finally {
              contender.close();
            }
          },
        },
      });
      expect(blocked).toBe(true);

      const writer = new Database(fixture.databasePath);
      writer.transaction(() => {
        writer.prepare('UPDATE profiles SET data_json = ? WHERE id = ?')
          .run(JSON.stringify({ displayName: 'After Lock' }), 'profile-v3');
        writer.prepare('UPDATE nw_proposals SET rationale = ? WHERE id = ?')
          .run('after-lock', fixture.pendingProposalId);
      })();
      writer.close();

      expect(snapshotRows(fixture, 'offerflow', 'profiles')).toContainEqual(expect.objectContaining({
        id: 'profile-v3', data_json: JSON.stringify({ displayName: 'Snapshot Fixture' }),
      }));
      expect(snapshotRows(fixture, 'novawing', 'nw_proposals')).toContainEqual(expect.objectContaining({
        id: fixture.pendingProposalId, rationale: 'Prove revision continuity',
      }));
      const inspect = new Database(fixture.databasePath, { readonly: true });
      expect(String(inspect.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('delete');
      expect(inspect.prepare('SELECT data_json FROM profiles WHERE id = ?').get('profile-v3'))
        .toEqual({ data_json: JSON.stringify({ displayName: 'After Lock' }) });
      expect(inspect.prepare('SELECT rationale FROM nw_proposals WHERE id = ?').get(fixture.pendingProposalId))
        .toEqual({ rationale: 'after-lock' });
      inspect.close();
    });

    it('锁前已建立的 NovaWing 长读事务与锁后专用读事务可并存且状态稳定', () => {
      const fixture = createFixture('pit-long-reader');
      const longReader = new DatabaseSync(fixture.databasePath, { timeout: 25 });
      longReader.exec('PRAGMA query_only = ON');
      longReader.exec('BEGIN');
      expect(longReader.prepare('SELECT rationale FROM nw_proposals WHERE id = ?').get(fixture.pendingProposalId))
        .toEqual({ rationale: 'Prove revision continuity' });
      try {
        exportFixture(fixture);
      } finally {
        longReader.exec('ROLLBACK');
        longReader.close();
      }
      expect(snapshotRows(fixture, 'offerflow', 'profiles')).toHaveLength(1);
      expect(snapshotRows(fixture, 'novawing', 'nw_proposals')).toHaveLength(2);
    });

    it('组件读取中途异常释放双连接和锁、不发布输出并保持 DELETE journal', () => {
      const fixture = createFixture('pit-mid-read-failure');
      expect(() => exportHostSnapshotV3({
        databasePath: fixture.databasePath,
        outputDirectory: fixture.snapshotDirectory,
        workingDirectory: fixture.tempDirectory,
        workspaceDirectory: process.cwd(),
        confirmation: HOST_SNAPSHOT_V3_EXPORT_CONFIRMATION,
        hooks: { failAfterFirstComponentRead: true },
      })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_EXPORT_FAILED' }));
      expect(fs.existsSync(fixture.snapshotDirectory)).toBe(false);

      const writer = new Database(fixture.databasePath, { timeout: 25 });
      expect(() => writer.prepare('UPDATE profiles SET updated_at = updated_at + 1 WHERE id = ?').run('profile-v3'))
        .not.toThrow();
      expect(String(writer.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('delete');
      writer.close();
    });
  });

  it('凭证、环境变量和绝对路径命中安全门后停止导出', () => {
    const fixture = createFixture('sensitive');
    const db = openDb(fixture.databasePath);
    db.prepare('UPDATE profiles SET data_json = ? WHERE id = ?')
      .run(JSON.stringify({ token: 'ghp_not_allowed_fixture' }), 'profile-v3');
    db.close();
    expect(() => exportFixture(fixture)).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_SENSITIVE_DATA',
    }));
    expect(fs.existsSync(fixture.snapshotDirectory)).toBe(false);
  });
});

describe('离线 NovaWing bootstrap', () => {
  it('全新 v8 库只通过公共 migration 创建 schema，重复执行稳定且保留数据', () => {
    const tempDirectory = createTempDirectory('bootstrap-new');
    const databasePath = path.join(tempDirectory, 'bootstrap.sqlite3');
    const db = openDb(databasePath);
    initSchema(db, { targetVersion: LATEST_SCHEMA_VERSION });
    db.close();
    const first = bootstrapNovaWingOffline({
      databasePath, confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
    });
    const pending = seedNovaWing(databasePath);
    const second = bootstrapNovaWingOffline({
      databasePath, confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
    });
    const planned = bootstrapNovaWingOffline({
      databasePath, confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION, dryRun: true,
    });
    expect(first.status).toBe('bootstrapped');
    expect(second.status).toBe('already-compatible');
    expect(planned.status).toBe('planned');
    const connection = new DatabaseSync(databasePath);
    const actual = (connection.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'nw_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(actual).toEqual([...NOVAWING_AUTHORITATIVE_TABLE_NAMES].sort());
    expect(connection.prepare('SELECT COUNT(*) AS count FROM nw_proposals WHERE id = ?').get(pending))
      .toEqual({ count: 1 });
    connection.close();
  });

  it('拒绝缺少确认、空路径和不兼容的部分 nw_ schema', () => {
    const tempDirectory = createTempDirectory('bootstrap-reject');
    const databasePath = path.join(tempDirectory, 'partial.sqlite3');
    const db = openDb(databasePath);
    initSchema(db, { targetVersion: LATEST_SCHEMA_VERSION });
    db.exec('CREATE TABLE nw_partial (id TEXT PRIMARY KEY)');
    db.close();
    expect(() => bootstrapNovaWingOffline({
      databasePath,
      confirmation: 'wrong' as typeof NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
    })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_CONFIRMATION_REQUIRED' }));
    expect(() => bootstrapNovaWingOffline({
      databasePath: '', confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
    })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_PATH_ABSOLUTE_REQUIRED' }));
    expect(() => bootstrapNovaWingOffline({
      databasePath, confirmation: NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION,
    })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_SCHEMA_MISMATCH' }));
  });

  it('正常 runtime 仍为 validate-only，不会自动 apply 缺失 schema', () => {
    const tempDirectory = createTempDirectory('runtime-validate-only');
    const databasePath = path.join(tempDirectory, 'runtime.sqlite3');
    const db = openDb(databasePath);
    initSchema(db, { targetVersion: LATEST_SCHEMA_VERSION });
    db.close();
    expect(() => createNovaWingRuntime({ databasePath })).toThrowError(expect.objectContaining({
      code: 'NOVA_WING_RUNTIME_INITIALIZATION_FAILED',
    }));
    const inspect = new Database(databasePath);
    expect(inspect.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name LIKE 'nw_%'").get())
      .toEqual({ count: 0 });
    inspect.close();
  });
});

describe('Host Snapshot V3 restore candidate', () => {
  it.each(['-journal', '-wal', '-shm'] as const)(
    'dry-run 对调用方预置 %s fail-closed、零修改且不创建 candidate/report',
    (suffix) => {
      const fixture = createFixture(`restore-sidecar-collision-${suffix.slice(1)}`);
      exportFixture(fixture);
      const candidatePath = path.join(fixture.tempDirectory, 'collision.sqlite3');
      const sidecarPath = `${candidatePath}${suffix}`;
      fs.writeFileSync(sidecarPath, `caller-owned-${suffix}`, { flag: 'wx' });
      const before = sha256File(sidecarPath);

      expect(() => restoreHostSnapshotV3ToCandidate({
        snapshotDirectory: fixture.snapshotDirectory,
        candidateDatabasePath: candidatePath,
        workingDirectory: fixture.tempDirectory,
        workspaceDirectory: process.cwd(),
        confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
        dryRun: true,
      })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_ARTIFACT_COLLISION' }));
      expect(sha256File(sidecarPath)).toBe(before);
      expect(fs.existsSync(candidatePath)).toBe(false);
      expect(fs.existsSync(`${candidatePath}.host-snapshot-v3-report.json`)).toBe(false);
    },
  );

  it('成功恢复不删除或覆盖调用方旧固定 rename-probe', () => {
    const fixture = createFixture('restore-legacy-probe-preserved');
    exportFixture(fixture);
    const candidatePath = path.join(fixture.tempDirectory, 'legacy-probe.sqlite3');
    const legacyProbePath = `${candidatePath}.rename-probe`;
    fs.writeFileSync(legacyProbePath, 'caller-owned-legacy-probe', { flag: 'wx' });
    const before = sha256File(legacyProbePath);

    const report = restoreHostSnapshotV3ToCandidate({
      snapshotDirectory: fixture.snapshotDirectory,
      candidateDatabasePath: candidatePath,
      workingDirectory: fixture.tempDirectory,
      workspaceDirectory: process.cwd(),
      confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
    });

    expect(report.status).toBe('candidate-ready');
    expect(sha256File(legacyProbePath)).toBe(before);
  });

  it('主恢复失败且 cleanup 失败时同时保留原始错误类别与脱敏清理状态', () => {
    const fixture = createFixture('restore-primary-and-cleanup-failure');
    exportFixture(fixture);
    const candidatePath = path.join(fixture.tempDirectory, 'cleanup-failure.sqlite3');
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      unlink() {
        const error = new Error(`${candidatePath} SQLITE_BUSY raw`) as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      },
      wait() { /* deterministic test: no wall-clock sleep */ },
    };

    try {
      restoreHostSnapshotV3ToCandidate({
        snapshotDirectory: fixture.snapshotDirectory,
        candidateDatabasePath: candidatePath,
        workingDirectory: fixture.tempDirectory,
        workspaceDirectory: process.cwd(),
        confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
        hooks: { failAfterSchemaBootstrap: true, artifactIo: io },
      });
      throw new Error('expected restore failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'HOST_SNAPSHOT_V3_CLEANUP_FAILED',
        primaryCode: 'HOST_SNAPSHOT_V3_RESTORE_FAILED',
        cleanupStatus: 'failed',
        resultState: 'none',
      });
      expect(JSON.stringify(error)).not.toContain(candidatePath);
      expect(JSON.stringify(error)).not.toContain('SQLITE_BUSY');
    }
  });

  it('恢复中途失败时 SQLite 连接已关闭，随后才清理 owned candidate', () => {
    const fixture = createFixture('restore-close-before-cleanup');
    exportFixture(fixture);
    const candidatePath = path.join(fixture.tempDirectory, 'closed-before-cleanup.sqlite3');
    let closeProved = false;
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      unlink(filePath) {
        if (path.basename(filePath) === path.basename(candidatePath)) {
          const moved = `${filePath}.close-proof`;
          fs.renameSync(filePath, moved);
          fs.renameSync(moved, filePath);
          closeProved = true;
        }
        DEFAULT_RESTORE_ARTIFACT_IO.unlink(filePath);
      },
    };

    expect(() => restoreHostSnapshotV3ToCandidate({
      snapshotDirectory: fixture.snapshotDirectory,
      candidateDatabasePath: candidatePath,
      workingDirectory: fixture.tempDirectory,
      workspaceDirectory: process.cwd(),
      confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
      hooks: { failAfterOfferFlowRestore: true, artifactIo: io },
    })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_RESTORE_FAILED' }));
    expect(closeProved).toBe(true);
    expect(fs.existsSync(candidatePath)).toBe(false);
  });

  it('恢复与报告发布成功但 report 临时清理失败时保留 candidate/report 并拒绝完全成功', () => {
    const fixture = createFixture('restore-success-cleanup-failure');
    exportFixture(fixture);
    const candidatePath = path.join(fixture.tempDirectory, 'retained.sqlite3');
    const reportPath = `${candidatePath}.host-snapshot-v3-report.json`;
    const runId = 'abcdefabcdefabcdefabcdefabcdefab';
    const reportTemporaryName = `.offerflow-host-v3-${runId}.report.tmp`;
    const io: RestoreArtifactIo = {
      ...DEFAULT_RESTORE_ARTIFACT_IO,
      unlink(filePath) {
        if (path.basename(filePath) === reportTemporaryName) {
          const error = new Error('temporary report busy') as NodeJS.ErrnoException;
          error.code = 'EBUSY';
          throw error;
        }
        DEFAULT_RESTORE_ARTIFACT_IO.unlink(filePath);
      },
      wait() { /* deterministic test: no wall-clock sleep */ },
    };

    expect(() => restoreHostSnapshotV3ToCandidate({
      snapshotDirectory: fixture.snapshotDirectory,
      candidateDatabasePath: candidatePath,
      workingDirectory: fixture.tempDirectory,
      workspaceDirectory: process.cwd(),
      confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
      hooks: { artifactIo: io, runId },
    })).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_CLEANUP_FAILED',
      cleanupStatus: 'failed',
      resultState: 'candidate-and-report-retained',
    }));
    expect(fs.existsSync(candidatePath)).toBe(true);
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toMatchObject({
      status: 'candidate-ready', integrity: 'ok', renameProbe: 'passed',
    });
  });

  it('双组件恢复后可继续 Radar 分析和批准 proposal，revision 不倒退且原库不变', () => {
    const fixture = createFixture('restore-success', true);
    const sourceHash = sha256File(fixture.databasePath);
    const exported = exportFixture(fixture);
    const candidatePath = path.join(fixture.tempDirectory, 'candidate.sqlite3');
    const report = restoreHostSnapshotV3ToCandidate({
      snapshotDirectory: fixture.snapshotDirectory,
      candidateDatabasePath: candidatePath,
      workingDirectory: fixture.tempDirectory,
      workspaceDirectory: process.cwd(),
      confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
    });
    expect(report).toMatchObject({
      status: 'candidate-ready', integrity: 'ok', foreignKeyViolationCount: 0,
      renameProbe: 'passed', novaWingCoreRevision: 1,
      hostManifestDigest: exported.hostManifestDigest,
    });
    expect(sha256File(fixture.databasePath)).toBe(sourceHash);
    const reportText = fs.readFileSync(`${candidatePath}.host-snapshot-v3-report.json`, 'utf8');
    expect(reportText).not.toContain(fixture.tempDirectory);
    expect(reportText).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)\b/u);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      expect(fs.existsSync(`${candidatePath}${suffix}`)).toBe(false);
    }

    const candidateDb = openDb(candidatePath);
    expect(candidateDb.prepare('SELECT data_json FROM import_logs WHERE id = ?').get('import-log-v3'))
      .toEqual({ data_json: JSON.stringify({ warnings: [{ key: 'legacy-job', reason: '字段无法解析' }] }) });
    expect(candidateDb.prepare('SELECT COUNT(*) AS count FROM radar_rule_assessments').get())
      .toEqual({ count: 6 });
    const runtime = createNovaWingRuntime({ databasePath: candidatePath });
    const analysis = new AnalysisService({
      db: candidateDb,
      provider: deterministicSuccessProvider(),
      novaWingAnalysisContextEnabled: true,
      novaWingHostAdapter: runtime.adapter,
    });
    const task = analysis.createTask(fixture.radar!.evidenceVersionId);
    expect(task.created).toBe(true);
    expect(task.task.inputSnapshot).toMatchObject({
      contractVersion: 2,
      novaWingContext: { coreRevision: 1 },
      ruleProjection: { assessments: expect.arrayContaining([
        expect.objectContaining({ ruleKey: 'salary_floor' }),
      ]) },
    });
    runtime.close();
    candidateDb.close();

    withNovaWingFacade(candidatePath, 'candidate-nw', (facade) => {
      facade.approveProposal({ proposalId: fixture.pendingProposalId });
    });
    const changedRuntime = createNovaWingRuntime({ databasePath: candidatePath });
    expect(changedRuntime.adapter.readLatestMainline({ scopes: ['global', 'career'] }).coreRevision).toBe(2);
    changedRuntime.close();

    const renamed = `${candidatePath}.closed`;
    fs.renameSync(candidatePath, renamed);
    fs.renameSync(renamed, candidatePath);
    expect(sha256File(fixture.databasePath)).toBe(sourceHash);
  });

  it('dry-run 只生成计划且 CLI 提供 help、拒绝未知参数', () => {
    const fixture = createFixture('restore-plan');
    exportFixture(fixture);
    const candidatePath = path.join(fixture.tempDirectory, 'planned.sqlite3');
    const plan = restoreHostSnapshotV3ToCandidate({
      snapshotDirectory: fixture.snapshotDirectory,
      candidateDatabasePath: candidatePath,
      workingDirectory: fixture.tempDirectory,
      workspaceDirectory: process.cwd(),
      confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
      dryRun: true,
    });
    expect(plan).toMatchObject({ status: 'planned', integrity: 'not-run', renameProbe: 'not-run' });
    expect(fs.existsSync(candidatePath)).toBe(false);
    expect(runHostSnapshotV3Cli(['--help'])).toEqual(expect.objectContaining({ usage: expect.stringContaining('restore-candidate') }));
    expect(runHostSnapshotV3Cli(['verify', '--help'])).toEqual(expect.objectContaining({ usage: expect.stringContaining('verify') }));
    expect(() => runHostSnapshotV3Cli([
      'verify', '--snapshot', fixture.snapshotDirectory, '--unknown', 'x',
    ])).toThrowError(expect.objectContaining({
      code: 'HOST_SNAPSHOT_V3_CLI_ARGUMENT_INVALID',
      message: 'CLI 参数格式非法（位置 3）',
    }));
  });

  it.each([
    'failAfterSchemaBootstrap',
    'failAfterOfferFlowRestore',
    'failAfterNovaWingRestore',
    'failBeforeVerification',
  ] as const)('%s 时整体失败并清理候选库', (hook) => {
    const fixture = createFixture(`restore-${hook}`);
    exportFixture(fixture);
    const candidatePath = path.join(fixture.tempDirectory, 'failed.sqlite3');
    expect(() => restoreHostSnapshotV3ToCandidate({
      snapshotDirectory: fixture.snapshotDirectory,
      candidateDatabasePath: candidatePath,
      workingDirectory: fixture.tempDirectory,
      workspaceDirectory: process.cwd(),
      confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
      hooks: { [hook]: true },
    })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_RESTORE_FAILED' }));
    expect(fs.existsSync(candidatePath)).toBe(false);
    expect(fs.existsSync(`${candidatePath}.host-snapshot-v3-report.json`)).toBe(false);
  });

  it('OfferFlow 或 NovaWing 组件恢复后被篡改会触发组件校验并清理', () => {
    for (const component of ['offerflow', 'novawing'] as const) {
      const fixture = createFixture(`restore-component-${component}`);
      exportFixture(fixture);
      const candidatePath = path.join(fixture.tempDirectory, `${component}.sqlite3`);
      expect(() => restoreHostSnapshotV3ToCandidate({
        snapshotDirectory: fixture.snapshotDirectory,
        candidateDatabasePath: candidatePath,
        workingDirectory: fixture.tempDirectory,
        workspaceDirectory: process.cwd(),
        confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
        hooks: {
          mutateCandidateBeforeVerification(target) {
            const db = new Database(target);
            try {
              if (component === 'offerflow') {
                db.prepare('UPDATE profiles SET updated_at = updated_at + 1').run();
              } else {
                db.prepare("UPDATE nw_mainline_entries SET statement = statement || ' changed'").run();
              }
            } finally {
              db.close();
            }
          },
        },
      })).toThrow();
      expect(fs.existsSync(candidatePath)).toBe(false);
    }
  });

  it('外键违规在组件校验前被拒绝，digest/Host 篡改不会创建候选库', () => {
    const fixture = createFixture('restore-fk', true);
    exportFixture(fixture);
    const candidatePath = path.join(fixture.tempDirectory, 'fk.sqlite3');
    expect(() => restoreHostSnapshotV3ToCandidate({
      snapshotDirectory: fixture.snapshotDirectory,
      candidateDatabasePath: candidatePath,
      workingDirectory: fixture.tempDirectory,
      workspaceDirectory: process.cwd(),
      confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
      hooks: {
        mutateCandidateBeforeVerification(target) {
          const db = new Database(target);
          db.pragma('foreign_keys = OFF');
          db.prepare('DELETE FROM radar_candidates WHERE id = ?').run(fixture.radar!.materialCandidateId);
          db.close();
        },
      },
    })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_RESTORE_FAILED' }));
    expect(fs.existsSync(candidatePath)).toBe(false);

    mutateJson(path.join(fixture.snapshotDirectory, HOST_SNAPSHOT_V3_MANIFEST_FILE), (manifest) => {
      manifest.manifestDigest = '0'.repeat(64);
    });
    expect(() => restoreHostSnapshotV3ToCandidate({
      snapshotDirectory: fixture.snapshotDirectory,
      candidateDatabasePath: candidatePath,
      workingDirectory: fixture.tempDirectory,
      workspaceDirectory: process.cwd(),
      confirmation: HOST_SNAPSHOT_V3_RESTORE_CONFIRMATION,
    })).toThrowError(expect.objectContaining({ code: 'HOST_SNAPSHOT_V3_INVALID' }));
    expect(fs.existsSync(candidatePath)).toBe(false);
  });
});
