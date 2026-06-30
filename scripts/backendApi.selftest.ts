import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../server/index';
import type { JobSeekerProfile } from '../src/storage';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-api-'));
const dbPath = path.join(tempDir, 'offerflow.sqlite3');
const app = buildServer(dbPath);

async function request<T>(base: string, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${route}`, init);
  if (!response.ok) {
    throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });

  const health = await request<{ ok: true }>(base, '/health');
  assert.equal(health.ok, true);

  const meta = await request<{ path: string }>(base, '/meta/db-path');
  assert.equal(meta.path, dbPath);

  const emptyProfile = await request<JobSeekerProfile | null>(base, '/profile');
  assert.equal(emptyProfile, null);

  const profile: JobSeekerProfile = {
    resumeText: 'resume',
    projectExperience: 'project',
    targetCity: '苏州',
    targetRole: '前端',
    expectedSalary: '20K',
    acceptOutsourcing: false,
    acceptOvertime: true,
    jobSearchFocus: 'growth',
    weaknessNote: 'none',
  };
  await request<JobSeekerProfile>(base, '/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  assert.deepEqual(await request<JobSeekerProfile>(base, '/profile'), profile);

  await request<{ ok: true }>(base, '/profile', { method: 'DELETE' });
  assert.equal(await request<JobSeekerProfile | null>(base, '/profile'), null);

  const created = await request<Record<string, unknown>>(base, '/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: 'A 公司',
      role: '前端工程师',
      city: '上海',
      salaryRange: '20-30K',
      jdText: 'Vue TypeScript',
    }),
  });
  assert.equal(typeof created.id, 'string');
  assert.equal(created.company, 'A 公司');

  const list = await request<Array<Record<string, unknown>>>(base, '/jobs');
  assert.equal(list.length, 1);

  const id = String(created.id);
  const got = await request<Record<string, unknown>>(base, `/jobs/${id}`);
  assert.equal(got.role, '前端工程师');

  const patched = await request<Record<string, unknown>>(base, `/jobs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city: '杭州', matchScore: '88%' }),
  });
  assert.equal(patched.city, '杭州');
  assert.equal(patched.company, 'A 公司');

  const put = await request<Record<string, unknown>>(base, `/jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: 'B 公司', role: '资深前端' }),
  });
  assert.equal(put.company, 'B 公司');
  assert.equal(put.role, '资深前端');

  await request<{ ok: true }>(base, `/jobs/${id}`, { method: 'DELETE' });
  await request<{ ok: true }>(base, `/jobs/${id}`, { method: 'DELETE' });
  assert.equal((await request<unknown[]>(base, '/jobs')).length, 0);

  console.log('backendApi.selftest: passed');
} finally {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
