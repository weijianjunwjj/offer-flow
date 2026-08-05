import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { createNovaWingFacade, type NovaWingFacade } from '@weijianjunwjj/nova-wing/core';
import { createInjectedSqliteNovaWingStore } from '@weijianjunwjj/nova-wing/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../index';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { AnalysisService } from '../radar/analysis/analysisService';
import { deterministicSuccessProvider } from '../radar/analysis/analysisProviderFakes';
import { seedActiveResumeAndProfile } from '../radar/analysis/analysisInputFixture';
import { FakeNovaWingHostAdapter } from '../radar/analysis/fakeNovaWingHostAdapter.specHelper';
import { seedReviewFixture } from '../radar/reviewFixture';
import { RecommendationBatchService } from '../radar/recommendation/recommendationBatchService';
import {
  applyNovaWingSchemaForTestOrDevelopment,
  createNovaWingRuntime,
  NOVA_WING_DEVELOPMENT_APPLY_CONFIRMATION,
} from './infrastructure';
import { loadNovaWingRuntime, type NovaWingRuntimeHandle } from './runtimeLoader';

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) fs.rmSync(target, { recursive: true, force: true });
  }
});

function createOfferFlowDatabase(tag: string): {
  db: SqliteDatabase;
  databasePath: string;
  tempDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `offerflow-novawing-${tag}-`));
  cleanupPaths.push(tempDir);
  const databasePath = path.join(tempDir, 'shared.sqlite3');
  const db = openDb(databasePath);
  initSchema(db, { targetVersion: 8 });
  return { db, databasePath, tempDir };
}

function applyNovaWingSchema(databasePath: string): void {
  applyNovaWingSchemaForTestOrDevelopment({
    databasePath,
    confirmation: NOVA_WING_DEVELOPMENT_APPLY_CONFIRMATION,
  });
}

function withNovaWingFacade<T>(databasePath: string, operation: (facade: NovaWingFacade) => T): T {
  const connection = new DatabaseSync(databasePath);
  const store = createInjectedSqliteNovaWingStore({
    connection,
    migrationMode: 'validate',
    busyTimeoutMs: 1_000,
    busyRetries: 1,
    busyRetryDelayMs: 10,
  });
  try {
    return operation(createNovaWingFacade(store, {
      generateId: (() => {
        let value = 0;
        return () => `integration-${(value += 1)}`;
      })(),
      clock: (() => {
        let value = 0;
        return () => `2026-08-05T00:00:0${(value += 1)}.000Z`;
      })(),
    }));
  } finally {
    store.close();
    connection.close();
  }
}

function seedInitialMainline(databasePath: string): string {
  return withNovaWingFacade(databasePath, (facade) => {
    const first = facade.createPendingProposal({
      action: 'set',
      memoryKey: 'global.runtime_contract',
      category: 'principle',
      assertionType: 'user_decision',
      scope: 'global',
      proposedStatement: 'Use immutable package versions',
      rationale: 'Stable host integration',
      evidenceSummary: 'Runtime integration test',
      sourceType: 'host',
      sourceSystem: 'offerflow-test',
    });
    facade.approveProposal({ proposalId: first.id });
    return facade.createPendingProposal({
      action: 'set',
      memoryKey: 'career.runtime_target',
      category: 'priority',
      assertionType: 'user_decision',
      scope: 'career',
      proposedStatement: 'Prioritize backend platform roles',
      rationale: 'Career direction',
      evidenceSummary: 'Runtime integration test',
      sourceType: 'host',
      sourceSystem: 'offerflow-test',
    }).id;
  });
}

function approvePending(databasePath: string, proposalId: string): void {
  withNovaWingFacade(databasePath, (facade) => {
    facade.approveProposal({ proposalId });
  });
}

async function holdExclusiveLock(databasePath: string, milliseconds: number): Promise<{
  done: Promise<unknown[]>;
  worker: Worker;
}> {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const db = new Database(workerData.databasePath);
    db.exec(
      'CREATE TABLE IF NOT EXISTS __novawing_busy_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);'
      + 'BEGIN EXCLUSIVE;'
      + 'INSERT INTO __novawing_busy_probe (id, value) VALUES (1, 1) '
      + 'ON CONFLICT(id) DO UPDATE SET value = value + 1;'
    );
    parentPort.postMessage('locked');
    setTimeout(() => {
      db.exec('ROLLBACK');
      db.close();
      parentPort.postMessage('released');
    }, workerData.milliseconds);
  `, { eval: true, workerData: { databasePath, milliseconds } });
  await new Promise<void>((resolve, reject) => {
    worker.once('message', (message) => {
      if (message === 'locked') resolve();
    });
    worker.once('error', reject);
  });
  return { worker, done: once(worker, 'exit') };
}

describe('NovaWing runtime infrastructure', () => {
  it('requires explicit development apply and validate never creates a missing schema', async () => {
    const { db, databasePath, tempDir } = createOfferFlowDatabase('schema-boundary');
    expect(() => applyNovaWingSchemaForTestOrDevelopment({
      databasePath,
      confirmation: 'wrong' as typeof NOVA_WING_DEVELOPMENT_APPLY_CONFIRMATION,
    })).toThrowError(expect.objectContaining({ code: 'NOVA_WING_RUNTIME_APPLY_NOT_CONFIRMED' }));
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => applyNovaWingSchemaForTestOrDevelopment({
        databasePath,
        confirmation: NOVA_WING_DEVELOPMENT_APPLY_CONFIRMATION,
      })).toThrowError(expect.objectContaining({ code: 'NOVA_WING_RUNTIME_APPLY_NOT_CONFIRMED' }));
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }

    await expect(loadNovaWingRuntime({ enabled: true, databasePath })).rejects.toMatchObject({
      code: 'NOVA_WING_RUNTIME_INITIALIZATION_FAILED',
      message: 'NovaWing runtime 初始化失败',
    });
    expect(db.prepare(
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'nw_%'",
    ).pluck().get()).toBe(0);
    db.close();
    const moved = path.join(tempDir, 'missing-schema-closed.sqlite3');
    fs.renameSync(databasePath, moved);
    expect(fs.existsSync(moved)).toBe(true);
  });

  it('reads real context over two drivers and proves V2 hash/stale/recommendation exclusion', async () => {
    const { db, databasePath, tempDir } = createOfferFlowDatabase('dual-driver');
    applyNovaWingSchema(databasePath);
    const pendingProposalId = seedInitialMainline(databasePath);
    const runtime = createNovaWingRuntime({ databasePath });

    let sequence = 0;
    const fixture = seedReviewFixture(db, {
      now: () => 1_700_000_000 + sequence,
      createId: () => `runtime-seed-${(sequence += 1)}`,
    });
    seedActiveResumeAndProfile(db, 1_700_000_000);
    const service = new AnalysisService({
      db,
      provider: deterministicSuccessProvider(),
      now: () => 1_800_000_000 + (sequence += 1),
      createRecordId: () => `runtime-record-${(sequence += 1)}`,
      novaWingAnalysisContextEnabled: true,
      novaWingHostAdapter: runtime.adapter,
    });
    const created = service.createTask(fixture.evidenceVersionId);
    const repeated = service.createTask(fixture.evidenceVersionId);
    expect(created.task.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repeated).toMatchObject({ created: false, task: { inputHash: created.task.inputHash } });
    expect(created.task.inputSnapshot).toMatchObject({
      contractVersion: 2,
      novaWingContext: {
        coreRevision: 1,
        scopes: ['global', 'career'],
        entries: [{
          scope: 'global',
          key: 'global.runtime_contract',
          value: {
            assertionType: 'user_decision',
            category: 'principle',
            rationale: 'Stable host integration',
            statement: 'Use immutable package versions',
          },
        }],
      },
    });
    await service.runTask(created.task.id);
    expect(service.listCandidateAnalyses(fixture.materialCandidateId)[0]?.validity).toEqual({
      status: 'current',
      staleReasons: [],
    });
    runtime.close();

    approvePending(databasePath, pendingProposalId);
    const changedRuntime = createNovaWingRuntime({ databasePath });
    const changedService = new AnalysisService({
      db,
      provider: deterministicSuccessProvider(),
      novaWingAnalysisContextEnabled: true,
      novaWingHostAdapter: changedRuntime.adapter,
    });
    expect(changedService.listCandidateAnalyses(fixture.materialCandidateId)[0]?.validity).toEqual({
      status: 'stale',
      staleReasons: ['nova_wing_context_changed'],
    });

    const recommendation = new RecommendationBatchService({
      db,
      novaWingAnalysisContextEnabled: true,
      novaWingHostAdapter: changedRuntime.adapter,
    }).createBatch([fixture.evidenceVersionId]);
    expect(recommendation.batch.selectedCandidateVersionIds).toEqual([]);
    expect((recommendation.batch.scope as {
      recommendationSet: { blocked: Array<{ reason: string }> };
    }).recommendationSet.blocked.map((item) => item.reason)).toEqual(['stale_analysis']);

    changedRuntime.close();
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
    db.close();
    const moved = path.join(tempDir, 'dual-driver-closed.sqlite3');
    fs.renameSync(databasePath, moved);
    expect(fs.existsSync(moved)).toBe(true);
  });

  it('uses finite busy waits: succeeds after release and redacts timeout failures', async () => {
    const { db, databasePath } = createOfferFlowDatabase('busy');
    applyNovaWingSchema(databasePath);
    seedInitialMainline(databasePath);
    const runtime = createNovaWingRuntime({
      databasePath,
      busyPolicy: {
        busyTimeoutMs: 1_000,
        readBusyRetries: 0,
        readBusyRetryDelayMs: 0,
      },
    });
    const released = await holdExclusiveLock(databasePath, 120);
    expect(runtime.adapter.readLatestMainline({ scopes: ['global', 'career'] }).coreRevision).toBe(1);
    await released.done;

    runtime.close();
    const timeoutRuntime = createNovaWingRuntime({
      databasePath,
      busyPolicy: {
        busyTimeoutMs: 40,
        readBusyRetries: 1,
        readBusyRetryDelayMs: 10,
      },
    });
    db.exec(`
      BEGIN EXCLUSIVE;
      UPDATE __novawing_busy_probe SET value = value + 1 WHERE id = 1;
    `);
    let busyError: unknown;
    try {
      timeoutRuntime.adapter.readLatestMainline({ scopes: ['global', 'career'] });
    } catch (error) {
      busyError = error;
    } finally {
      db.exec('ROLLBACK');
    }
    expect(busyError).toMatchObject({
      code: 'NOVA_WING_CONTEXT_UNAVAILABLE',
      message: 'NovaWing 分析上下文暂不可用',
    });
    expect((busyError as Error).message).not.toContain(databasePath);
    expect((busyError as Error).message).not.toMatch(/SQLITE|database is/iu);
    timeoutRuntime.close();
    db.close();
  });

  it('closes an owned runtime before the owned OfferFlow DB and keeps repeated close stable', async () => {
    const { db, databasePath, tempDir } = createOfferFlowDatabase('shutdown');
    db.close();
    applyNovaWingSchema(databasePath);
    const runtime = createNovaWingRuntime({ databasePath });
    const app = buildServer({
      dbPath: databasePath,
      radar: {
        enabled: true,
        analysisEnabled: true,
        novaWingAnalysisContextEnabled: true,
        novaWingRuntime: runtime,
      },
    });
    await app.close();
    runtime.close();
    expect(() => runtime.adapter.readLatestMainline({ scopes: ['global', 'career'] }))
      .toThrowError(expect.objectContaining({ code: 'NOVA_WING_CONTEXT_UNAVAILABLE' }));
    const moved = path.join(tempDir, 'shutdown-complete.sqlite3');
    fs.renameSync(databasePath, moved);
    expect(fs.existsSync(moved)).toBe(true);
  });

  it('does not inspect NovaWing schema while disabled and never closes an injected fake', async () => {
    const { db, databasePath } = createOfferFlowDatabase('fake-priority');
    const fake = new FakeNovaWingHostAdapter({ coreRevision: 0, entries: [] });
    let runtimeCloseCalls = 0;
    const unusedRuntime: NovaWingRuntimeHandle = {
      adapter: { readLatestMainline: () => ({ coreRevision: 99, entries: [] }) },
      close: () => { runtimeCloseCalls += 1; },
    };
    const app = buildServer({
      db,
      radar: {
        enabled: true,
        analysisEnabled: true,
        novaWingAnalysisContextEnabled: true,
        novaWingHostAdapter: fake,
        novaWingRuntime: unusedRuntime,
      },
    });
    await app.close();
    expect(runtimeCloseCalls).toBe(0);
    expect(fake.callCount).toBe(0);
    db.close();
    expect(fs.existsSync(databasePath)).toBe(true);
  });
});
