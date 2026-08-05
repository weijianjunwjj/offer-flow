import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { AnalysisTaskRepository } from '../analysisTaskRepository';
import { seedReviewFixture } from '../reviewFixture';
import { AnalysisService } from './analysisService';
import { deterministicSuccessProvider } from './analysisProviderFakes';
import { seedActiveResumeAndProfile } from './analysisInputFixture';
import { FakeNovaWingHostAdapter } from './fakeNovaWingHostAdapter.specHelper';

let tempDir: string;
let db: SqliteDatabase;
let clock: number;

function seed(): { versionId: string; candidateId: string } {
  let seq = 0;
  const fixture = seedReviewFixture(db, {
    now: () => 1_700_000_000 + seq,
    createId: () => `nw-seed-${(seq += 1)}`,
  });
  seedActiveResumeAndProfile(db, 1_700_000_000);
  return { versionId: fixture.evidenceVersionId, candidateId: fixture.materialCandidateId };
}

function fakeContext(revision = 7): FakeNovaWingHostAdapter {
  return new FakeNovaWingHostAdapter({
    coreRevision: revision,
    entries: [
      { scope: 'career', key: 'career.target', value: { role: 'backend', level: 2 } },
      { scope: 'global', key: 'global.summary', value: ['distributed', 'payments'] },
    ],
  });
}

function service(fake?: FakeNovaWingHostAdapter, enabled = false): AnalysisService {
  let record = 0;
  return new AnalysisService({
    db,
    provider: deterministicSuccessProvider(),
    now: () => (clock += 1),
    createRecordId: () => `nw-record-${(record += 1)}-${clock}`,
    novaWingAnalysisContextEnabled: enabled,
    novaWingHostAdapter: fake,
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-nova-wing-context-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 8 });
  clock = 1_800_000_000;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('NovaWing context in AnalysisService', () => {
  it('is default-off: adapter is not required/called and the original V1 snapshot remains unchanged', () => {
    const { versionId } = seed();
    const fake = fakeContext();
    const first = service(fake, false).createTask(versionId);
    const second = service(undefined, false).createTask(versionId);

    expect(fake.callCount).toBe(0);
    expect(second.created).toBe(false);
    expect(second.task.inputHash).toBe(first.task.inputHash);
    expect(first.task.inputSnapshot).toMatchObject({ contractVersion: 1 });
    expect(first.task.inputSnapshot).not.toHaveProperty('novaWingContext');
  });

  it('freezes a sorted V2 context, calls once, and includes revision/entries in the input hash', () => {
    const { versionId } = seed();
    const fake = fakeContext(7);
    const sut = service(fake, true);
    const first = sut.createTask(versionId);
    const snapshot = first.task.inputSnapshot as {
      contractVersion: number;
      novaWingContext: { coreRevision: number; scopes: string[]; entries: Array<{ scope: string; key: string }> };
    };
    expect(fake.calls).toEqual([{ scopes: ['global', 'career'] }]);
    expect(snapshot.contractVersion).toBe(2);
    expect(snapshot.novaWingContext).toMatchObject({ coreRevision: 7, scopes: ['global', 'career'] });
    expect(snapshot.novaWingContext.entries.map((entry) => `${entry.scope}:${entry.key}`)).toEqual([
      'global:global.summary',
      'career:career.target',
    ]);

    fake.setContext({
      coreRevision: 7,
      entries: [
        { scope: 'global', key: 'global.summary', value: ['distributed', 'payments'] },
        { scope: 'career', key: 'career.target', value: { level: 2, role: 'backend' } },
      ],
    });
    const semanticallySame = sut.createTask(versionId);
    expect(semanticallySame.task.inputHash).toBe(first.task.inputHash);
    expect(semanticallySame.created).toBe(false);

    fake.setRevision(8);
    const changed = sut.createTask(versionId);
    expect(changed.task.inputHash).not.toBe(first.task.inputHash);
    expect(changed.created).toBe(true);
  });

  it('round-trips the frozen revision through task persistence and derives current/stale with one read per list', async () => {
    const { versionId, candidateId } = seed();
    const fake = fakeContext(7);
    const sut = service(fake, true);
    const { task } = sut.createTask(versionId);
    await sut.runTask(task.id);

    const stored = new AnalysisTaskRepository(db).getById(task.id)!;
    expect((stored.inputSnapshot as { novaWingContext: { coreRevision: number } }).novaWingContext.coreRevision).toBe(7);

    fake.resetCalls();
    const current = sut.listCandidateAnalyses(candidateId);
    expect(fake.callCount).toBe(1);
    expect(current[0]).toMatchObject({
      novaWingCoreRevision: 7,
      validity: { status: 'current', staleReasons: [] },
    });

    fake.setRevision(8);
    fake.resetCalls();
    const stale = sut.listCandidateAnalyses(candidateId);
    expect(fake.callCount).toBe(1);
    expect(stale[0]?.validity).toEqual({
      status: 'stale',
      staleReasons: ['nova_wing_context_changed'],
    });

    fake.setUnavailable(new Error('C:\\private\\business.sqlite SQLITE_BUSY'));
    expect(() => sut.listCandidateAnalyses(candidateId)).toThrowError(expect.objectContaining({
      code: 'NOVA_WING_CONTEXT_UNAVAILABLE',
      message: 'NovaWing 分析上下文暂不可用',
    }));
  });

  it('treats a legacy V1 record as current while disabled and stale while enabled', async () => {
    const { versionId, candidateId } = seed();
    const legacy = service(undefined, false);
    const { task } = legacy.createTask(versionId);
    await legacy.runTask(task.id);
    expect(legacy.listCandidateAnalyses(candidateId)[0]?.validity.status).toBe('current');

    const fake = fakeContext(1);
    const enabled = service(fake, true);
    expect(enabled.listCandidateAnalyses(candidateId)[0]).toMatchObject({
      novaWingCoreRevision: null,
      validity: { status: 'stale', staleReasons: ['nova_wing_context_changed'] },
    });
  });
});
