/**
 * v0.9 Phase 5A — Evidence Upgrade Persistence 真实双连接 smoke。
 *
 * 目的：不再只做顺序模拟，用同一临时 SQLite 文件 + 两个独立 connection，
 * 复用真实 EvidenceUpgradeService，验证：
 *   - 跨连接幂等 / 单 child 不变量（Case A / Case B）
 *   - 真实 SQLite 锁竞争行为（BEGIN IMMEDIATE → SQLITE_BUSY fallback）
 *
 * 结论边界（见 Final Report）：
 *   better-sqlite3 为单连接同步执行，单进程内无法真正并行两个 connection 的写；
 *   跨连接顺序调用 + BEGIN IMMEDIATE 已证明单 child 不变量；真实多进程场景由
 *   SQLite RESERVED 锁串行化（后到者 busy-wait 至前一个提交后 re-check 命中 child），
 *   超时则 SQLITE_BUSY。本 app 当前为 single-process / single-connection 部署。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { EvidenceUpgradeService } from './EvidenceUpgradeService';
import type { EvidenceUpgradeInput } from './types';
import type { ExtractedContent } from '../../content-acquisition/types';
import { SearchEvidenceIngestionService } from '../searchEvidence/SearchEvidenceIngestionService';
import type { SearchEvidenceItem } from '../searchEvidence/searchEvidenceTypes';
import { RadarCandidateRepository } from '../candidateRepository';
import { DAILY_JOB_HUNTER_SCHEMA_VERSION, runMigrations } from '../../migrations';
import { openDb } from '../../db';

const FULL_TEXT_A = '负责Web前端开发，使用React与TypeScript。岗位职责包括页面开发、组件封装与性能优化，'
  + '以及配合后端完成接口联调。任职要求3年以上经验，本科及以上学历。';
const FULL_TEXT_B = '负责Web前端开发，使用Vue与Vite。岗位职责包括页面开发、组件封装与性能优化，'
  + '以及配合后端完成接口联调。任职要求3年以上经验，本科及以上学历。';

function makeSearchItem(overrides: Partial<SearchEvidenceItem> = {}): SearchEvidenceItem {
  return {
    provider: 'tavily',
    query: '苏州 前端工程师 招聘',
    providerRequestId: `req-${randomUUID().slice(0, 8)}`,
    title: '高级前端开发工程师',
    url: `https://jobs.zhiye.com/jobs/${randomUUID().slice(0, 8)}`,
    content: '负责Web前端开发，使用React。',
    domain: 'jobs.zhiye.com',
    providerScore: 0.85,
    publishedAt: '2026-08-01',
    searchedAt: Date.now(),
    providerMetadata: {},
    ...overrides,
  };
}

function makeContent(plainText: string): ExtractedContent {
  return {
    title: '高级前端开发工程师',
    plainText,
    canonicalUrl: 'https://jobs.zhiye.com/jobs/canonical',
    contentType: 'text/html',
  };
}

function makeInput(sourceVersionId: string, plainText: string): EvidenceUpgradeInput {
  return {
    sourceVersionId,
    content: makeContent(plainText),
    validation: { status: 'PASS', reasonCode: 'jd_complete' },
  };
}

describe('EvidenceUpgradeService multi-connection smoke', () => {
  let filePath: string;
  let dbA: Database.Database;
  let dbB: Database.Database;
  const now = Date.now();
  const createId = randomUUID;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `offerflow-5a-smoke-${randomUUID()}.sqlite3`);
    dbA = openDb(filePath);
    runMigrations(dbA, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    // 迁移完成后开第二连接，共享同一 schema 文件
    dbB = openDb(filePath);
  });

  afterEach(() => {
    try { dbA.close(); } catch { /* noop */ }
    try { dbB.close(); } catch { /* noop */ }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(filePath + suffix); } catch { /* noop */ }
    }
  });

  function ingestSource(): { versionId: string; candidateId: string } {
    const ingester = new SearchEvidenceIngestionService(dbA, { now: () => now, createId });
    const outcome = ingester.ingest(makeSearchItem(), 'SEARCH_EVIDENCE');
    return { versionId: outcome.candidateVersionId!, candidateId: outcome.candidateId! };
  }

  function evidenceUpgradeChildren(db: Database.Database, candidateId: string) {
    return new RadarCandidateRepository(db)
      .listVersionsByCandidate(candidateId)
      .filter((v) => v.originType === 'evidence_upgrade');
  }

  it('Case A：同 source + 同 content，跨两连接 → 一个 UPGRADED + 一个 ALREADY_UPGRADED，child count === 1', () => {
    const { versionId, candidateId } = ingestSource();
    const serviceA = new EvidenceUpgradeService(dbA, { now: () => now, createId });
    const serviceB = new EvidenceUpgradeService(dbB, { now: () => now, createId });

    const first = serviceA.upgrade(makeInput(versionId, FULL_TEXT_A));
    expect(first.status).toBe('UPGRADED');

    // B 连接读到 A 已提交的 child，返回 ALREADY（不是 stale）
    const second = serviceB.upgrade(makeInput(versionId, FULL_TEXT_A));
    expect(second.status).toBe('ALREADY_UPGRADED');
    expect(evidenceUpgradeChildren(dbB, candidateId)).toHaveLength(1);
  });

  it('Case B：同 source + 不同 content，跨两连接 → 一个 UPGRADED + 一个 BLOCKED，child count === 1', () => {
    const { versionId, candidateId } = ingestSource();
    const serviceA = new EvidenceUpgradeService(dbA, { now: () => now, createId });
    const serviceB = new EvidenceUpgradeService(dbB, { now: () => now, createId });

    const first = serviceA.upgrade(makeInput(versionId, FULL_TEXT_A));
    expect(first.status).toBe('UPGRADED');

    const second = serviceB.upgrade(makeInput(versionId, FULL_TEXT_B));
    expect(second).toEqual({ status: 'BLOCKED', reasonCode: 'source_already_upgraded_content_changed' });

    // 硬不变量：绝无第二个不同 hash 的 child
    const children = evidenceUpgradeChildren(dbB, candidateId);
    expect(children).toHaveLength(1);
  });

  it('真实锁行为：A 持 RESERVED 写锁时，B 的 BEGIN IMMEDIATE 在 busy_timeout 后抛 SQLITE_BUSY', () => {
    // 缩短 B 的 busy_timeout，避免测试挂起；真实默认值为 5000ms（better-sqlite3 默认）
    dbB.pragma('busy_timeout = 50');

    dbA.prepare('BEGIN IMMEDIATE').run(); // A 持有 RESERVED 写锁

    let caught: unknown = null;
    try {
      dbB.prepare('BEGIN IMMEDIATE').run();
    } catch (error) {
      caught = error;
    } finally {
      dbA.prepare('ROLLBACK').run();
      dbB.pragma('busy_timeout = 5000');
    }

    expect(caught).not.toBeNull();
    expect((caught as { code?: string }).code).toBe('SQLITE_BUSY');
  });

  it('跨连接后数据可见：B 连接能读到 A 写入的 candidate/version', () => {
    const { versionId, candidateId } = ingestSource();
    const repoB = new RadarCandidateRepository(dbB);
    expect(repoB.getCandidate(candidateId)).not.toBeNull();
    expect(repoB.getVersion(versionId)).not.toBeNull();
  });
});
