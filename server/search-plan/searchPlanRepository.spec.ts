import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { DAILY_SEARCH_PLAN_SCHEMA_VERSION, runMigrations } from '../migrations';
import { SearchPlanRepository } from './searchPlanRepository';
import type { DailySearchPlan, DailySearchPlanVersion } from './types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-search-plan-'));
let databaseSequence = 0;

function withRepo(run: (repo: SearchPlanRepository, db: Database.Database) => void): void {
  databaseSequence += 1;
  const dbPath = path.join(tempDir, `scenario-${databaseSequence}.sqlite3`);
  const db = openDb(dbPath);
  try {
    runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_SCHEMA_VERSION });
    run(new SearchPlanRepository(db), db);
  } finally {
    db.close();
  }
}

function makePlan(overrides: Partial<DailySearchPlan> = {}): DailySearchPlan {
  return {
    id: 'plan-1',
    name: '每日前端岗位',
    status: 'active',
    activeVersionId: null,
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
    ...overrides,
  };
}

function makeVersion(overrides: Partial<DailySearchPlanVersion> = {}): DailySearchPlanVersion {
  return {
    id: 'version-1',
    searchPlanId: 'plan-1',
    version: 1,
    cities: [{ name: '苏州', priority: 1 }, { name: '无锡', priority: 2 }],
    roleDirections: ['前端开发', '全栈开发'],
    baseKeywords: ['React', 'TypeScript'],
    expandedKeywords: [],
    hardConstraints: [],
    sourceConfigs: [
      { providerKey: 'tavily', searchDepth: 'basic', country: 'china', enabled: true },
    ],
    schedule: { dailyAt: '09:00' },
    scanBudget: { maxQueriesPerRun: 30 },
    analysisBudget: { maxAnalysesPerRun: 5 },
    briefPolicy: {},
    explorationPolicy: {},
    notificationPolicy: {
      highPriorityEnabled: true,
      dailyBriefEnabled: true,
      failureNoticeEnabled: true,
    },
    latestCatchUpTime: '09:00',
    createdAt: 100,
    activatedAt: null,
    supersedesVersionId: null,
    ...overrides,
  };
}

describe('SearchPlanRepository（T021）', () => {
  it('insertPlan + getPlan 往返保留字段', () => {
    withRepo((repo) => {
      repo.insertPlan(makePlan());
      const plan = repo.getPlan('plan-1');
      assert.ok(plan !== null);
      assert.equal(plan.id, 'plan-1');
      assert.equal(plan.name, '每日前端岗位');
      assert.equal(plan.status, 'active');
      assert.equal(plan.activeVersionId, null);
      assert.equal(plan.createdAt, 100);
    });
  });

  it('listPlans 返回全部计划', () => {
    withRepo((repo) => {
      repo.insertPlan(makePlan({ id: 'plan-a', name: 'A', createdAt: 100, updatedAt: 100 }));
      repo.insertPlan(makePlan({ id: 'plan-b', name: 'B', createdAt: 200, updatedAt: 200 }));
      const plans = repo.listPlans();
      assert.equal(plans.length, 2);
      assert.deepEqual(plans.map((p) => p.id).sort(), ['plan-a', 'plan-b']);
    });
  });

  it('updatePlan 更新 name / status / activeVersionId', () => {
    withRepo((repo) => {
      repo.insertPlan(makePlan());
      repo.updatePlan('plan-1', { name: '改名', status: 'paused' });
      const plan = repo.getPlan('plan-1');
      assert.ok(plan !== null);
      assert.equal(plan.name, '改名');
      assert.equal(plan.status, 'paused');
      assert.ok(plan.updatedAt >= 100, 'updatedAt 应前移');
    });
  });

  it('insertVersion + getVersion 往返保留 JSON 字段', () => {
    withRepo((repo) => {
      repo.insertPlan(makePlan());
      repo.insertVersion(makeVersion());
      const version = repo.getVersion('version-1');
      assert.ok(version !== null);
      assert.equal(version.searchPlanId, 'plan-1');
      assert.equal(version.version, 1);
      assert.deepEqual(version.cities, [{ name: '苏州', priority: 1 }, { name: '无锡', priority: 2 }]);
      assert.deepEqual(version.roleDirections, ['前端开发', '全栈开发']);
      assert.deepEqual(version.baseKeywords, ['React', 'TypeScript']);
      assert.deepEqual(version.sourceConfigs, [
        { providerKey: 'tavily', searchDepth: 'basic', country: 'china', enabled: true },
      ]);
      assert.deepEqual(version.schedule, { dailyAt: '09:00' });
      assert.equal(version.latestCatchUpTime, '09:00');
    });
  });

  it('同一 (search_plan_id, version) 不可重复插入（UNIQUE 约束）', () => {
    withRepo((repo) => {
      repo.insertPlan(makePlan());
      repo.insertVersion(makeVersion({ id: 'version-1' }));
      assert.throws(() => {
        repo.insertVersion(makeVersion({ id: 'version-1-dup' }));
      }, /UNIQUE constraint failed/);
    });
  });

  it('版本外键：search_plan_id 指向不存在的计划被拒绝', () => {
    withRepo((repo, db) => {
      // foreign_keys 已在 openDb 中开启，验证 FK 生效。
      assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1);
      assert.throws(() => {
        repo.insertVersion(makeVersion({ searchPlanId: 'missing-plan' }));
      }, /FOREIGN KEY constraint failed/);
    });
  });

  it('listVersionsByPlan 按 version 降序返回', () => {
    withRepo((repo) => {
      repo.insertPlan(makePlan());
      repo.insertVersion(makeVersion({ id: 'v1', version: 1 }));
      repo.insertVersion(makeVersion({ id: 'v3', version: 3 }));
      repo.insertVersion(makeVersion({ id: 'v2', version: 2 }));
      const versions = repo.listVersionsByPlan('plan-1');
      assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
    });
  });

  it('setActiveVersion 更新 plan.active_version_id 并记录 activated_at', () => {
    withRepo((repo) => {
      repo.insertPlan(makePlan());
      repo.insertVersion(makeVersion({ id: 'v1', version: 1 }));
      repo.insertVersion(makeVersion({ id: 'v2', version: 2 }));
      repo.setActiveVersion('plan-1', 'v2');
      const plan = repo.getPlan('plan-1');
      assert.equal(plan?.activeVersionId, 'v2');
      const active = repo.getActiveVersion('plan-1');
      assert.ok(active !== null);
      assert.equal(active.id, 'v2');
      assert.ok(active.activatedAt !== null, 'activatedAt 应被记录');
    });
  });

  it('未激活时 getActiveVersion 返回 null', () => {
    withRepo((repo) => {
      repo.insertPlan(makePlan());
      repo.insertVersion(makeVersion());
      assert.equal(repo.getActiveVersion('plan-1'), null);
    });
  });

  it('不可变版本：Repository 不提供 UPDATE 版本入口（无 updateVersion 方法）', () => {
    withRepo((repo) => {
      repo.insertPlan(makePlan());
      repo.insertVersion(makeVersion());
      // 只读断言：getVersion 返回的对象被上游修改不应影响库内数据。
      const version = repo.getVersion('version-1');
      assert.ok(version !== null);
      version.roleDirections.push('篡改');
      const again = repo.getVersion('version-1');
      assert.ok(again !== null);
      assert.deepEqual(again.roleDirections, ['前端开发', '全栈开发']);
    });
  });
});
