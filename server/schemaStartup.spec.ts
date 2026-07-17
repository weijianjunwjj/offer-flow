import { describe, expect, it } from 'vitest';
import { planSchemaStartup, schemaRefusalMessage } from './schemaStartup';

const base = { requiredVersion: 3, latestVersion: 3, productionVersion: 2 } as const;

describe('planSchemaStartup · 真实库禁止启动自动迁移', () => {
  it('真实库(allowAutoMigrate=false) v2、要求 v3 → 拒绝 too_old，不迁移', () => {
    expect(planSchemaStartup({ ...base, currentVersion: 2, allowAutoMigrate: false }))
      .toEqual({ kind: 'refuse', reason: 'too_old' });
  });

  it('真实库 v3、要求 v3 → ok', () => {
    expect(planSchemaStartup({ ...base, currentVersion: 3, allowAutoMigrate: false }))
      .toEqual({ kind: 'ok' });
  });

  it('真实库未初始化(v0) → 拒绝 uninitialized，不自动建库', () => {
    expect(planSchemaStartup({ ...base, currentVersion: 0, allowAutoMigrate: false }))
      .toEqual({ kind: 'refuse', reason: 'uninitialized' });
  });

  it('真实库 schema 高于应用最新 → 拒绝 too_new', () => {
    expect(planSchemaStartup({ ...base, currentVersion: 4, allowAutoMigrate: false }))
      .toEqual({ kind: 'refuse', reason: 'too_new' });
  });

  it('v1 遗留库始终拒绝 legacy_v1（无论是否允许自动迁移）', () => {
    expect(planSchemaStartup({ ...base, currentVersion: 1, allowAutoMigrate: false }))
      .toEqual({ kind: 'refuse', reason: 'legacy_v1' });
    expect(planSchemaStartup({ ...base, currentVersion: 1, allowAutoMigrate: true }))
      .toEqual({ kind: 'refuse', reason: 'legacy_v1' });
  });
});

describe('planSchemaStartup · 临时/注入库允许自动初始化', () => {
  it('注入库 v0 → 迁移到所需版本', () => {
    expect(planSchemaStartup({ ...base, currentVersion: 0, allowAutoMigrate: true }))
      .toEqual({ kind: 'migrate', targetVersion: 3 });
  });

  it('注入库 v2、要求 v3 → 迁移到 v3', () => {
    expect(planSchemaStartup({ ...base, currentVersion: 2, allowAutoMigrate: true }))
      .toEqual({ kind: 'migrate', targetVersion: 3 });
  });

  it('注入库 v2、要求 v2（能力基线关闭）→ ok，不迁移', () => {
    expect(planSchemaStartup({ ...base, requiredVersion: 2, currentVersion: 2, allowAutoMigrate: true }))
      .toEqual({ kind: 'ok' });
  });
});

describe('schemaRefusalMessage', () => {
  it('too_old 指向显式升级命令，legacy_v1 保留 B7-B 文案', () => {
    expect(schemaRefusalMessage('too_old', 2, 3, 3)).toContain('db:upgrade-real');
    expect(schemaRefusalMessage('legacy_v1', 1, 2, 3)).toMatch(/requires schema version 2.*B7-B/s);
  });
});
