import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { initSchema } from '../schema';
import { getDatabaseSchemaVersion } from '../migrations';
import { ProfileRepository } from '../repositories/profileRepository';
import type { JobSeekerProfile } from '../../src/storage';
import {
  makeCandidateEvidenceContentFixture,
  makeCapabilityBaselineDraftFixture,
} from '../../src/domain/capability-baseline/testFixtures';
import type { CapabilityBaselineAiProvider } from './aiProvider';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function baseProfile(): JobSeekerProfile {
  return {
    resumeText: 'Vue / TypeScript / Node.js',
    projectExperience: '复杂 B 端与 AI 应用工程',
    targetCity: '苏州',
    targetRole: 'AI 应用前端工程师',
    expectedSalary: '25-35K',
    acceptOutsourcing: false,
    acceptOvertime: true,
    jobSearchFocus: 'growth',
    weaknessNote: '大型 AI 生产证明不足',
  };
}

function delayedFakeProvider(delayMs: number): CapabilityBaselineAiProvider & { aborted: boolean } {
  const state = { aborted: false };
  const run = <T>(value: T): Promise<T> => new Promise((resolve) => {
    setTimeout(() => resolve(value), delayMs);
  });
  return {
    isConfigured: () => true,
    modelName: () => 'fake-delayed-model',
    async generateEvidence(_snapshot, signal) {
      return new Promise((resolve, reject) => {
        const onAbort = (): void => { state.aborted = true; reject(new DOMException('aborted', 'AbortError')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve({ rawText: JSON.stringify([makeCandidateEvidenceContentFixture({ sourceId: 'ai-1' })]), model: 'fake-delayed-model' });
        }, delayMs);
      });
    },
    async generateBaseline() {
      return run({ rawText: JSON.stringify(makeCapabilityBaselineDraftFixture()), model: 'fake-delayed-model' });
    },
    get aborted() { return state.aborted; },
  };
}

function buildHarness(aiProvider: CapabilityBaselineAiProvider): { app: FastifyInstance; db: SqliteDatabase } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-cb-routes-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 2 });
  new ProfileRepository(db).save(baseProfile());
  const app = buildServer({ db, capabilityBaseline: { enabled: true, serviceDeps: { aiProvider } } });
  cleanups.push(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

describe('能力基线路由 · 真实 Fastify 注册', () => {
  it('buildServer 将 v2 库自动升级到 v3 并挂载能力基线路由', async () => {
    const { app, db } = buildHarness(delayedFakeProvider(5));
    expect(getDatabaseSchemaVersion(db)).toBe(3);
    const response = await app.inject({ method: 'GET', url: '/capability-baseline' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { activeVersion: unknown; state: { stateVersion: number } };
    expect(body.activeVersion).toBeNull();
    expect(body.state.stateVersion).toBe(0);
    await app.close();
  });

  it('手工录入证据经真实路由写入并返回', async () => {
    const { app } = buildHarness(delayedFakeProvider(5));
    const response = await app.inject({
      method: 'POST',
      url: '/capability-baseline/evidence/manual',
      payload: {
        idempotencyKey: 'route-ev-1',
        expectedStateVersion: 0,
        content: makeCandidateEvidenceContentFixture(),
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { state: { evidence: Array<{ generatedBy: string }> } };
    expect(body.state.evidence).toHaveLength(1);
    expect(body.state.evidence[0]!.generatedBy).toBe('manual');
    await app.close();
  });

  it('注入延迟完成的 fake AI Provider：正常请求完成不会触发 signal abort，不返回超时', async () => {
    const provider = delayedFakeProvider(30);
    const { app } = buildHarness(provider);
    const response = await app.inject({
      method: 'POST',
      url: '/capability-baseline/evidence/generate',
      payload: { idempotencyKey: 'route-gen-1', expectedStateVersion: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect(provider.aborted).toBe(false);
    const body = response.json() as { state: { evidence: Array<{ generatedBy: string }> } };
    expect(body.state.evidence.some((e) => e.generatedBy === 'ai')).toBe(true);
    await app.close();
  });

  it('未知证据决策返回稳定 404', async () => {
    const { app } = buildHarness(delayedFakeProvider(5));
    const response = await app.inject({
      method: 'POST',
      url: '/capability-baseline/evidence/does-not-exist/accept',
      payload: { idempotencyKey: 'route-404', expectedStateVersion: 0 },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { code: string }).code).toBe('EVIDENCE_NOT_FOUND');
    await app.close();
  });
});
