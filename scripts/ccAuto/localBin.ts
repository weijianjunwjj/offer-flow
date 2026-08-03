/**
 * 机器侧验证命令的启动辅助：把「本地依赖包的 JS bin」解析成绝对路径，
 * 交给当前 Node 进程（process.execPath）直接执行，不依赖 PATH、不使用 shell、不调用 .cmd shim。
 *
 * 背景：Windows 下 `spawnSync('pnpm', ...)` / `execFileSync('pnpm', ...)` 依赖 PATH 与 cmd shim，
 * 某些子进程环境（如经 claude 拉起的隔离进程）PATH 中没有可直接执行的 pnpm，导致 ENOENT，
 * 测试根本没跑起来却被误判为「测试失败」。改为解析 node_modules 内真实 JS 入口后用 node 执行即可绕开。
 */
import fs from 'node:fs';
import path from 'node:path';

/** resolveLocalPackageBin 失败原因分类，便于上层区分「bin 不存在」与「子进程问题」。 */
export type LocalBinErrorKind = 'PACKAGE_NOT_FOUND' | 'BIN_FIELD_MISSING' | 'BIN_ENTRY_MISSING' | 'PATH_ESCAPE';

export interface LocalBinResult {
  ok: boolean;
  /** ok=true 时为该包 JS bin 入口的绝对路径。 */
  binPath?: string;
  kind?: LocalBinErrorKind;
  reason?: string;
}

/**
 * 解析 repoRoot/node_modules/<packageName> 的 package.json bin 字段，得到真实 JS 入口绝对路径。
 * - bin 为字符串：直接作为入口；
 * - bin 为对象：优先取 preferredBinName，缺省时退回与 packageName 同名项，再退回第一项；
 * - 校验入口真实存在，且规范化后仍位于该包目录内（拒绝任何 `..` 穿越）；
 * - 不依赖 PATH，不拼接命令字符串。
 */
export function resolveLocalPackageBin(
  repoRoot: string,
  packageName: string,
  preferredBinName: string,
): LocalBinResult {
  const pkgDir = path.join(repoRoot, 'node_modules', packageName);
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    return { ok: false, kind: 'PACKAGE_NOT_FOUND', reason: `未找到本地依赖包：${packageName}（${pkgJsonPath} 不存在）` };
  }

  let bin: unknown;
  try {
    bin = (JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { bin?: unknown }).bin;
  } catch (err) {
    return { ok: false, kind: 'BIN_FIELD_MISSING', reason: `读取 ${packageName}/package.json 失败：${(err as Error).message}` };
  }

  let relEntry: string | undefined;
  if (typeof bin === 'string') {
    relEntry = bin;
  } else if (bin && typeof bin === 'object') {
    const map = bin as Record<string, string>;
    relEntry = map[preferredBinName] ?? map[packageName] ?? Object.values(map)[0];
  }
  if (!relEntry || typeof relEntry !== 'string') {
    return { ok: false, kind: 'BIN_FIELD_MISSING', reason: `${packageName} 的 package.json 缺少可用的 bin 字段` };
  }

  const abs = path.resolve(pkgDir, relEntry);
  // 规范化后必须仍在包目录内，杜绝 bin 字段里潜在的 `..` 穿越。
  const relFromPkg = path.relative(pkgDir, abs);
  if (relFromPkg.startsWith('..') || path.isAbsolute(relFromPkg)) {
    return { ok: false, kind: 'PATH_ESCAPE', reason: `${packageName} 的 bin 入口越出包目录：${relEntry}` };
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, kind: 'BIN_ENTRY_MISSING', reason: `${packageName} 的 bin 入口不存在：${abs}` };
  }
  return { ok: true, binPath: abs };
}
