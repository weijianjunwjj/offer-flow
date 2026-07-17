import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { initSchema } from '../schema';
import { ProfileRepository } from '../repositories/profileRepository';
import type { JobSeekerProfile } from '../../src/storage';
import { makeJobMatchProfileDraftFixture } from '../../src/domain/job-match-profile/testFixtures';
import type { JobMatchProfileAiProvider } from './aiProvider';

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

/** fake Provider：延迟完成，并监听传入 signal，用于验证正常请求不会被误 abort */
function delayedFakeProvider(delayMs: number): JobMatchProfileAiProvider & { aborted: boolean } {
  const state = { aborted: false };
  return {
    isConfigured: () => true,
    modelName: () => 'fake-delayed-model',
    async generate(_snapshot, signal) {
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          state.aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve({
            rawText: JSON.stringify(makeJobMatchProfileDraftFixture()),
            model: 'fake-delayed-model',
          });
        }, delayMs);
      });
    },
    get aborted() { return state.aborted; },
  };
}

function buildHarness(aiProvider: JobMatchProfileAiProvider): { app: FastifyInstance; db: SqliteDatabase } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-jmp-routes-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 2 });
  new ProfileRepository(db).save(baseProfile());
  const app = buildServer({ db, jobMatchProfile: { aiProvider } });
  cleanups.push(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

describe('岗位匹配画像路由 · 真实 Fastify 路由注册', () => {
  it('注入延迟完成的 fake AI Provider：正常请求完成不会触发 signal abort，且不返回超时 503', async () => {
    const provider = delayedFakeProvider(30);
    const { app } = buildHarness(provider);

    const response = await app.inject({
      method: 'POST',
      url: '/job-match-profile/proposals/generate',
      payload: { idempotencyKey: 'route-gen-1', expectedProfileStateVersion: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(provider.aborted).toBe(false);
    const body = response.json() as { state: { proposals: Array<{ generatedBy: string }> } };
    expect(body.state.proposals.some((p) => p.generatedBy === 'ai')).toBe(true);

    await app.close();
  });

  it('GET /job-match-profile 返回空状态', async () => {
    const provider = delayedFakeProvider(5);
    const { app } = buildHarness(provider);

    const response = await app.inject({ method: 'GET', url: '/job-match-profile' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { activeVersion: unknown };
    expect(body.activeVersion).toBeNull();

    await app.close();
  });
});
