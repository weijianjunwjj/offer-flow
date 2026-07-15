/**
 * 服务启动时的 schema 决策（纯函数，便于单测）。
 *
 * 核心边界：真实生产库禁止在启动时自动迁移（allowAutoMigrate=false）；
 * 仅临时 / 注入 / 内存库允许自动初始化到所需版本（allowAutoMigrate=true）。
 */
export interface SchemaStartupInput {
  currentVersion: number;
  requiredVersion: number;
  latestVersion: number;
  productionVersion: number;
  allowAutoMigrate: boolean;
}

export type SchemaStartupPlan =
  | { kind: 'ok' }
  | { kind: 'migrate'; targetVersion: number }
  | { kind: 'refuse'; reason: 'legacy_v1' | 'uninitialized' | 'too_old' | 'too_new' };

export function planSchemaStartup(input: SchemaStartupInput): SchemaStartupPlan {
  const { currentVersion, requiredVersion, latestVersion, productionVersion, allowAutoMigrate } = input;
  // v1 遗留库始终拒绝，交由授权的 B7-B 升级工具处理。
  if (currentVersion === 1) return { kind: 'refuse', reason: 'legacy_v1' };
  if (allowAutoMigrate) {
    if (currentVersion === 0) return { kind: 'migrate', targetVersion: requiredVersion };
    if (currentVersion >= productionVersion && currentVersion < requiredVersion) {
      return { kind: 'migrate', targetVersion: requiredVersion };
    }
  }
  if (currentVersion === 0) return { kind: 'refuse', reason: 'uninitialized' };
  if (currentVersion < requiredVersion) return { kind: 'refuse', reason: 'too_old' };
  if (currentVersion > latestVersion) return { kind: 'refuse', reason: 'too_new' };
  return { kind: 'ok' };
}

export function schemaRefusalMessage(
  reason: Exclude<SchemaStartupPlan, { kind: 'ok' } | { kind: 'migrate'; targetVersion: number }>['reason'],
  currentVersion: number,
  requiredVersion: number,
  latestVersion: number,
): string {
  switch (reason) {
    case 'legacy_v1':
      return 'Job Memory v2 capability requires schema version 2; current version is 1. '
        + 'Legacy schema v1 must use the authorized B7-B upgrade tool.';
    case 'uninitialized':
      return '真实数据库尚未初始化；本轮禁止服务启动时自动迁移真实库。'
        + '请先运行显式命令：npm run db:upgrade-real -- --confirm（会先备份、升级到最新 schema 并在升级后校验，不发布 Snapshot）。';
    case 'too_old':
      return `真实数据库 schema 版本为 ${currentVersion}，低于应用所需的 ${requiredVersion}；`
        + '本轮禁止服务启动时自动迁移真实库。请先运行显式升级命令：'
        + 'npm run db:upgrade-real -- --confirm（会先备份、升级并在升级后校验，不发布 Snapshot）。';
    case 'too_new':
      return `真实数据库 schema 版本为 ${currentVersion}，高于本应用支持的最新版本 ${latestVersion}；`
        + '请先升级应用代码再启动，避免旧代码读取更新的数据库。';
    default:
      return '真实数据库 schema 状态异常，拒绝启动。';
  }
}
