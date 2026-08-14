import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION, runMigrations } from '../migrations';
import { SearchPlanRepository } from './searchPlanRepository';
import { SkipRepository } from './skipRepository';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-skip-repo-'));
let seq = 0;

function withRepo(run: (db: Database.Database, repo: SkipRepository, planRepo: SearchPlanRepository) => void): void {
  seq += 1;
  const db = openDb(path.join(tempDir, `scenario-${seq}.sqlite3`));
  runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION });
  const planRepo = new SearchPlanRepository(db);
  planRepo.insertPlan({
    id: 'plan-1', name: 'p', status: 'active', activeVersionId: null,
    createdAt: 1, updatedAt: 1, deletedAt: null,
  });
  planRepo.insertVersion({
    id: 'version-1', searchPlanId: 'plan-1', version: 1,
    cities: [], roleDirections: [], baseKeywords: [], expandedKeywords: [], hardConstraints: [],
    sourceConfigs: [], schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
    scanBudget: {}, analysisBudget: {}, briefPolicy: {}, explorationPolicy: {},
    notificationPolicy: {}, latestCatchUpTime: '12:00',
    createdAt: 1, activatedAt: 1, supersedesVersionId: null,
  });
  run(db, new SkipRepository(db), planRepo);
  db.close();
}

describe('SkipRepository（T032 Skip Today 持久化）', () => {
  it('skip 后 isSkipped=true；未 skip 前 isSkipped=false', () => {
    withRepo((_db, repo) => {
      expect(repo.isSkipped('version-1', '2026-08-14')).toBe(false);
      repo.skip('version-1', '2026-08-14', 'user_skipped_today', 1000);
      expect(repo.isSkipped('version-1', '2026-08-14')).toBe(true);
    });
  });

  it('幂等：同 PlanVersion 同自然日重复 skip 只保留一行', () => {
    withRepo((_db, repo) => {
      repo.skip('version-1', '2026-08-14', 'user_skipped_today', 1000);
      repo.skip('version-1', '2026-08-14', 'user_skipped_today', 2000);
      expect(repo.listByVersion('version-1')).toHaveLength(1);
      expect(repo.listByVersion('version-1')[0]?.scheduledDay).toBe('2026-08-14');
      expect(repo.listByVersion('version-1')[0]?.createdAt).toBe(1000);
    });
  });

  it('不同自然日各自独立（下一日不继承 skip）', () => {
    withRepo((_db, repo) => {
      repo.skip('version-1', '2026-08-14', 'user_skipped_today', 1000);
      expect(repo.isSkipped('version-1', '2026-08-14')).toBe(true);
      expect(repo.isSkipped('version-1', '2026-08-15')).toBe(false);
    });
  });

  it('不同 PlanVersion 互不影响', () => {
    withRepo((_db, repo, planRepo) => {
      planRepo.insertVersion({
        id: 'version-2', searchPlanId: 'plan-1', version: 2,
        cities: [], roleDirections: [], baseKeywords: [], expandedKeywords: [], hardConstraints: [],
        sourceConfigs: [], schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
        scanBudget: {}, analysisBudget: {}, briefPolicy: {}, explorationPolicy: {},
        notificationPolicy: {}, latestCatchUpTime: '12:00',
        createdAt: 1, activatedAt: null, supersedesVersionId: null,
      });
      repo.skip('version-1', '2026-08-14', 'user_skipped_today', 1000);
      expect(repo.isSkipped('version-1', '2026-08-14')).toBe(true);
      expect(repo.isSkipped('version-2', '2026-08-14')).toBe(false);
    });
  });
});
