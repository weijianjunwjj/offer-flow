import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { sha256RequestHash } from '../job-memory/requestHash';
import {
  exportPromotionBundle,
  importPromotionBundle,
  PromotionError,
  type PromotionAttestation,
  type PromotionBundle,
} from './bundle';

const HASH = 'a'.repeat(64);
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) { try { cleanups.pop()?.(); } catch { /* best-effort temp cleanup (Windows handle latency) */ } } });

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-promo-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'db.sqlite3');
}

interface SeedOpts {
  mpActive?: boolean;
  swActive?: boolean;
  mpProposalStatus?: string;
  swProposalStatus?: string;
  swRefMpVersionId?: string; // 让 G5 引用错误的 G4 version
  extraPendingSw?: boolean;
}

function seedV6Source(db: SqliteDatabase, opts: SeedOpts = {}): void {
  initSchema(db, { targetVersion: 6 });
  const mpVerId = 'mpv-1';
  const mpPropId = 'mpp-1';
  const swVerId = 'swv-1';
  const swPropId = 'swp-1';
  const now = 1000;

  const mpVersion = { id: mpVerId, version: 1, status: 'active', proposalId: mpPropId, createdAt: now, activatedAt: now, global: { headline: 'mp' }, inputSnapshot: { inputHash: HASH } };
  const mpProposal = { id: mpPropId, status: opts.mpProposalStatus ?? 'accepted', generatedBy: 'ai', payload: {}, createdAt: now, inputSnapshot: { inputHash: HASH } };
  db.prepare("INSERT INTO market_position_meta (id,state_version,active_version_id,updated_at) VALUES ('default',?,?,?)").run(2, opts.mpActive === false ? null : mpVerId, now);
  db.prepare('INSERT INTO market_position_proposals (id,status,generated_by,input_fingerprint,data_json,created_at) VALUES (?,?,?,?,?,?)').run(mpProposal.id, mpProposal.status, mpProposal.generatedBy, HASH, JSON.stringify(mpProposal), now);
  db.prepare('INSERT INTO market_position_versions (id,version,status,proposal_id,data_json,created_at,activated_at) VALUES (?,?,?,?,?,?,?)').run(mpVersion.id, 1, opts.mpActive === false ? 'archived' : 'active', mpPropId, JSON.stringify(opts.mpActive === false ? { ...mpVersion, status: 'archived' } : mpVersion), now, now);

  const refMp = opts.swRefMpVersionId ?? mpVerId;
  const swVersion = {
    id: swVerId, version: 1, status: 'active', proposalId: swPropId, createdAt: now, activatedAt: now,
    window: { id: 'sw-window-1', dataCutoffAt: now, sourceVersionIds: { jobMatchProfileVersionId: 'jmp-1', capabilityBaselineVersionId: 'cb-1', marketPositionVersionId: refMp } },
    inputSnapshot: { marketPositionVersionId: refMp, acceptedEvidenceIds: [], inputHash: HASH },
    generationMode: 'ai', decisionDiff: [],
  };
  const swProposal = { id: swPropId, status: opts.swProposalStatus ?? 'accepted', generatedBy: 'ai', payload: {}, createdAt: now, inputSnapshot: { inputHash: HASH } };
  db.prepare("INSERT INTO strategy_meta (id,state_version,active_version_id,updated_at) VALUES ('default',?,?,?)").run(2, opts.swActive === false ? null : swVerId, now);
  db.prepare('INSERT INTO strategy_proposals (id,status,generated_by,input_fingerprint,data_json,created_at) VALUES (?,?,?,?,?,?)').run(swProposal.id, swProposal.status, swProposal.generatedBy, HASH, JSON.stringify(swProposal), now);
  db.prepare('INSERT INTO strategy_versions (id,version,status,proposal_id,data_json,created_at,activated_at) VALUES (?,?,?,?,?,?,?)').run(swVersion.id, 1, opts.swActive === false ? 'archived' : 'active', swPropId, JSON.stringify(opts.swActive === false ? { ...swVersion, status: 'archived' } : swVersion), now, now);

  if (opts.extraPendingSw) {
    const pending = { id: 'swp-2', status: 'proposed', generatedBy: 'ai', inputSnapshot: { inputHash: HASH } };
    db.prepare('INSERT INTO strategy_proposals (id,status,generated_by,input_fingerprint,data_json,created_at) VALUES (?,?,?,?,?,?)').run(pending.id, 'proposed', 'ai', HASH, JSON.stringify(pending), now + 1);
  }
}

function exportFrom(db: SqliteDatabase): { bundle: PromotionBundle; attestation: PromotionAttestation } {
  return exportPromotionBundle(db, { sourceDatabasePath: '/tmp/src.sqlite3', sourceDatabaseHash: HASH, now: () => 5000 });
}

function track(db: SqliteDatabase): SqliteDatabase {
  cleanups.push(() => { try { db.close(); } catch { /* already closed */ } });
  return db;
}

function makeSource(opts: SeedOpts = {}): SqliteDatabase {
  const p = tempDbPath();
  const db = openDb(p);
  seedV6Source(db, opts);
  return track(db);
}

function makeEmptyV6Target(): SqliteDatabase {
  const db = openDb(tempDbPath());
  initSchema(db, { targetVersion: 6 });
  return track(db);
}

describe('exportPromotionBundle', () => {
  it('导出仅含 active accepted 链路，bundle/payload hash 稳定', () => {
    const a = exportFrom(makeSource());
    const b = exportFrom(makeSource());
    expect(a.bundle.marketPosition.activeVersionId).toBe('mpv-1');
    expect(a.bundle.strategy.activeVersionId).toBe('swv-1');
    expect(a.bundle.strategy.activeWindowId).toBe('sw-window-1');
    expect(a.attestation.bundleHash).toBe(b.attestation.bundleHash);
    expect(a.attestation.payloadCanonicalHash).toBe(b.attestation.payloadCanonicalHash);
  });

  it('缺少 active G4 版本时停止', () => {
    expect(() => exportFrom(makeSource({ mpActive: false }))).toThrow(PromotionError);
  });

  it('缺少 active G5 版本时停止', () => {
    expect(() => exportFrom(makeSource({ swActive: false }))).toThrow(PromotionError);
  });

  it('G5 引用错误的 G4 version 时停止', () => {
    expect(() => exportFrom(makeSource({ swRefMpVersionId: 'wrong-mp' }))).toThrow(/G4/);
  });

  it('来源提案非 accepted（如 proposed）时停止', () => {
    expect(() => exportFrom(makeSource({ swProposalStatus: 'proposed' }))).toThrow(PromotionError);
  });

  it('晋升包不包含 pending/其它提案与命令回执', () => {
    const { bundle } = exportFrom(makeSource({ extraPendingSw: true }));
    expect(bundle.strategy.sourceProposal.id).toBe('swp-1');
    expect((bundle.strategy.sourceProposal as any).status).toBe('accepted');
    expect(JSON.stringify(bundle)).not.toContain('swp-2');
    expect(JSON.stringify(bundle)).not.toContain('receipt');
  });

  it('导出不修改来源数据库（hash 前后一致）', () => {
    const p = tempDbPath();
    const db = openDb(p);
    seedV6Source(db);
    db.close();
    const before = fs.readFileSync(p);
    const ro = new Database(p, { readonly: true });
    exportPromotionBundle(ro, { sourceDatabasePath: p, sourceDatabaseHash: HASH });
    ro.close();
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });
});

describe('importPromotionBundle', () => {
  it('空 v6 目标正常导入', () => {
    const { bundle, attestation } = exportFrom(makeSource());
    const target = makeEmptyV6Target();
    const result = importPromotionBundle(target, bundle, attestation);
    expect(result.applied).toBe(true);
    expect(target.prepare("SELECT active_version_id FROM market_position_meta WHERE id='default'").get()).toMatchObject({ active_version_id: 'mpv-1' });
    expect(target.prepare("SELECT active_version_id FROM strategy_meta WHERE id='default'").get()).toMatchObject({ active_version_id: 'swv-1' });
  });

  it('重复导入相同 bundle 返回 alreadyApplied，不重复写入', () => {
    const { bundle, attestation } = exportFrom(makeSource());
    const target = makeEmptyV6Target();
    importPromotionBundle(target, bundle, attestation);
    const again = importPromotionBundle(target, bundle, attestation);
    expect(again.alreadyApplied).toBe(true);
    expect(Number((target.prepare('SELECT COUNT(*) c FROM strategy_versions').get() as any).c)).toBe(1);
  });

  it('相同 id 不同 payload 时停止', () => {
    const { bundle, attestation } = exportFrom(makeSource());
    const target = makeEmptyV6Target();
    importPromotionBundle(target, bundle, attestation);
    // 目标已有 active，但换一个 payload 不同的 bundle（改 windowId）→ TARGET_HAS_ACTIVE
    const tampered = structuredClone(bundle);
    (tampered.strategy.version as any).window.id = 'sw-window-CHANGED';
    tampered.payloadCanonicalHash = sha256RequestHash({ mpVersion: tampered.marketPosition.version, mpProposal: tampered.marketPosition.sourceProposal, swVersion: tampered.strategy.version, swProposal: tampered.strategy.sourceProposal });
    const att2 = structuredClone(attestation);
    att2.payloadCanonicalHash = tampered.payloadCanonicalHash;
    att2.bundleHash = sha256RequestHash(tampered);
    expect(() => importPromotionBundle(target, tampered, att2)).toThrow(PromotionError);
  });

  it('目标已有另一 active 版本时停止', () => {
    const { bundle, attestation } = exportFrom(makeSource());
    const target = makeEmptyV6Target();
    // 先塞入一个不同的 active MP 版本
    target.prepare("INSERT INTO market_position_meta (id,state_version,active_version_id,updated_at) VALUES ('default',1,'other-mp',1)").run();
    target.prepare("INSERT INTO market_position_versions (id,version,status,proposal_id,data_json,created_at,activated_at) VALUES ('other-mp',1,'active','p',?,1,1)").run(JSON.stringify({ id: 'other-mp' }));
    expect(() => importPromotionBundle(target, bundle, attestation)).toThrow(/active/);
  });

  it('payload hash 被篡改时拒绝，事务零写入', () => {
    const { bundle, attestation } = exportFrom(makeSource());
    const target = makeEmptyV6Target();
    const bad = structuredClone(bundle);
    (bad.marketPosition.version as any).tampered = true; // 改内容但不改 hash
    expect(() => importPromotionBundle(target, bad, attestation)).toThrow(/hash/);
    expect(Number((target.prepare('SELECT COUNT(*) c FROM market_position_versions').get() as any).c)).toBe(0);
    expect(Number((target.prepare('SELECT COUNT(*) c FROM strategy_versions').get() as any).c)).toBe(0);
  });

  it('未知字段的 bundle 被拒绝', () => {
    const { bundle, attestation } = exportFrom(makeSource());
    const target = makeEmptyV6Target();
    const bad = { ...structuredClone(bundle), unexpected: 1 } as any;
    expect(() => importPromotionBundle(target, bad, attestation)).toThrow(/未知字段/);
  });
});
