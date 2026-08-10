/**
 * Simple Direct Edit 执行路径的机器侧逻辑（不调用任何模型）。
 *
 * 该路径只处理「足够简单、足够安全」的定向编辑：由 Node 代码读取目标文件，
 * 把「任务 + 允许文件路径 + 文件内容」交给一次 tools:[]、maxTurns<=2 的 Direct Edit Builder，
 * Builder 只返回 search/replace 形式的 edits；再由 Node 代码严格校验并**原子**写入。
 *
 * 关键安全边界：
 * - 模型无任何文件工具（tools:[]），不能自行探索、读取或写入仓库；
 * - 所有路径都必须落在仓库内，禁止绝对路径与 `..` 穿越；
 * - 每个 edit 的 search 必须在目标文件中唯一匹配，避免误伤；
 * - 全部 edit 校验通过后才统一写盘，任一失败不产生部分修改。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Classification } from './types';
import type { CcAutoConfig } from './config';
import { extractExplicitFiles } from './orchestrator';

/** 单个目标文件的安全上限（字节）：超过则不进入 Direct Edit，退回标准路径。 */
export const DIRECT_EDIT_MAX_FILE_BYTES = 64 * 1024;

/** 命中即视为不适合 Direct Edit（涉及数据库/迁移/依赖/配置/Provider/SSE 等高风险面）。 */
const UNSAFE_TOPIC_PATTERN =
  /schema|migration|迁移|数据库|database|依赖|dependency|package\.json|pnpm-lock|配置|config|provider|deepseek|openai|gemini|sse|鉴权|auth|密钥|secret|token/i;

/**
 * 命中即视为不适合 Direct Edit（需要模型理解代码结构、选择目标或保证语义，不是纯机械变换）。
 *
 * 正向资格：只有 transformation 完全确定 + old/new literal 或明确 insertion 可从任务直接得到
 * + 不需要 AST/语义判断，才允许 Direct Edit。
 * 关键词作为 fail-closed guard —— 只要任务声称需要理解代码结构，一律拒绝。
 */
const REQUIRES_SEMANTIC_UNDERSTANDING =
  /提取(函数|方法|逻辑|变量|常量|类|模块)|extract\s*(function|method|logic|variable|constant|class|module)|重构|refactor|复用|reuse|整理(代码|逻辑|结构|文件)|clean\s*up|优化(结构|设计|架构)|restructure|reorganize|阅读(现有|当前)(代码|结构|逻辑|文件)|read\s*(existing|current)\s*(code|structure|logic|file)|选择(适合|一段)(的)?|find\s*(suitable|appropriate)|choose\s*(suitable|appropriate)|保持(行为|语义)?(不变|一致)|preserve\s*behavior|preserve\s*semantics|抽象|abstract|封装|encapsulate|理解(代码|现有|当前)?(结构|逻辑|语义|行为)|understand\s*(existing|current)?\s*(code|structure|logic|semantics|behavior)|不改变(现有|当前)(行为|逻辑|语义|接口)/i;

export interface DirectEditEligibility {
  eligible: boolean;
  /** 命中条件时提取到的显式目标文件（相对路径，已去重）。 */
  targetFiles: string[];
  /** 不合格时的原因，便于日志与报告说明；合格时为 undefined。 */
  reason?: string;
}

/** 递归遍历时跳过的目录（体积大或与源码无关，避免误命中同名文件）。 */
const RESOLVE_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cc-auto', '.next', '.turbo']);

/**
 * 把任务正文里的单个引用规范化为仓库相对路径：统一用 `/`、去掉开头 `./`、规范化 `.` 段。
 * 绝对路径或包含 `..` 穿越的引用返回 null（不在此静默修复，交由上层原样透传给 prepare 阶段安全拒绝）。
 */
function normalizeRelReference(token: string): string | null {
  if (path.isAbsolute(token)) return null;
  // 统一分隔符后按 posix 语义规范化，保留末段文件名。
  const unified = token.split('\\').join('/');
  const normalized = path.posix.normalize(unified);
  if (normalized.startsWith('..') || normalized === '.' || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

/** 在仓库内按 basename 查找同名文件，返回规范化后的仓库相对路径（跳过 node_modules 等目录）。 */
function findByBasename(repoRoot: string, basename: string): string[] {
  const matches: string[] = [];
  const walk = (absDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (RESOLVE_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(absDir, entry.name));
      } else if (entry.isFile() && entry.name === basename) {
        matches.push(path.relative(repoRoot, path.join(absDir, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(repoRoot);
  return matches;
}

export interface ResolvedFileReferences {
  ok: boolean;
  /** 规范化 + 去重后的仓库相对路径（含无法在仓库定位、原样透传的引用，交由 prepare 阶段判定）。 */
  files: string[];
  /** ok=false 时的原因（同名文件在仓库多处、无法唯一确定）。 */
  reason?: string;
}

/**
 * 把任务正文中的显式文件引用解析为去重后的真实仓库相对路径（纯函数，只读磁盘、不改任何文件）。
 *
 * 规则（见任务说明一）：
 * 1. 先提取带目录的完整仓库相对路径并规范化（`/`、去 `./`、规范 `.` 段）；
 * 2. 仅含文件名的引用（如 `cli.ts`）：
 *    - 若其 basename 与已提取的某个完整路径唯一匹配 → 映射到该完整路径；
 *    - 否则在仓库内查找同名文件，仅当唯一匹配时才映射；
 *    - 仓库内多处同名 → 不猜测，返回 ok:false（该任务不符合 Direct Edit）；
 *    - 仓库内查无此名且不匹配任何完整路径 → 原样保留（交由 prepare 阶段以「文件不存在」拒绝）；
 * 3. 绝对路径 / `..` 穿越引用原样保留（不规范化、不映射），由 prepare 阶段的仓库边界校验拒绝；
 * 4. 最终按规范化后的仓库相对路径去重；不通过 basename 合并两个真实存在的不同文件。
 */
export function resolveExplicitFileReferences(task: string, repoRoot: string): ResolvedFileReferences {
  const raw = extractExplicitFiles(task);
  const fullPaths: string[] = []; // 含目录的规范化完整路径
  const bareNames: string[] = []; // 仅文件名
  const passthrough: string[] = []; // 绝对/穿越路径，原样透传给 prepare 拒绝
  for (const token of raw) {
    const normalized = normalizeRelReference(token);
    if (normalized === null) {
      passthrough.push(token);
      continue;
    }
    if (normalized.includes('/')) fullPaths.push(normalized);
    else bareNames.push(normalized);
  }

  const resolved = new Set<string>(fullPaths);
  for (const name of bareNames) {
    const inFull = fullPaths.filter((p) => p.split('/').pop() === name);
    if (inFull.length === 1) {
      resolved.add(inFull[0]);
      continue;
    }
    if (inFull.length > 1) {
      return { ok: false, files: [], reason: `文件名 ${name} 同时匹配多个已给出的路径，无法唯一确定` };
    }
    const repoMatches = findByBasename(repoRoot, name);
    if (repoMatches.length === 1) {
      resolved.add(repoMatches[0]);
    } else if (repoMatches.length === 0) {
      resolved.add(name); // 交由 prepare 以「文件不存在」拒绝
    } else {
      return { ok: false, files: [], reason: `仓库中存在 ${repoMatches.length} 个名为 ${name} 的文件，无法唯一确定` };
    }
  }
  for (const p of passthrough) resolved.add(p);

  return { ok: true, files: Array.from(resolved) };
}

/**
 * Direct Edit 命中条件（纯函数，不触碰磁盘，供路由判定与单测复用）：
 * - 任务不涉及语义理解（提取/重构/复用/阅读/抽象等），只能做纯机械变换；
 * - complexity === 'simple'；
 * - riskScore === 0；
 * - 任务正文明确包含 1~2 个文件路径；
 * - 目标文件数不超过 maxFiles（maxChangedFiles）；
 * - 任务不涉及数据库/migration/依赖/配置/Provider/SSE 等高风险话题；
 * - 分类未标记 touchesHighRisk。
 *
 * 文件是否真实存在、大小是否超限属于「磁盘事实」，在 prepareDirectEditContext 中校验，
 * 不在此纯函数内做 IO。
 */
export function evaluateDirectEditEligibility(
  classification: Classification,
  task: string,
  config: CcAutoConfig,
  repoRoot?: string,
): DirectEditEligibility {
  // 传入 repoRoot 时用规范化解析（cli.ts↔scripts/ccAuto/cli.ts 视为同一文件、仓库内唯一定位裸文件名）；
  // 不传时退回按正文原样提取（保持既有纯函数单测行为）。
  let targetFiles: string[];
  if (repoRoot) {
    const resolvedRefs = resolveExplicitFileReferences(task, repoRoot);
    if (!resolvedRefs.ok) {
      return { eligible: false, targetFiles: [], reason: resolvedRefs.reason };
    }
    targetFiles = resolvedRefs.files;
  } else {
    targetFiles = extractExplicitFiles(task);
  }
  // Gate 0: 拒绝需要语义理解的任何任务（fail-closed）—— 只能做纯机械变换。
  // 在 complexity/riskScore 检查前先判断，因为 classify 不会为 "extract function" 之类的语义任务加分。
  // 正向资格：只有 transformation 完全确定 + old/new literal 可从任务直接得到 + 不需要 AST/语义判断。
  if (REQUIRES_SEMANTIC_UNDERSTANDING.test(task)) {
    return { eligible: false, targetFiles, reason: '任务需要语义理解（提取/重构/复用/阅读/抽象等），不符合 Direct Edit 纯机械变换资格' };
  }

  if (classification.complexity !== 'simple') {
    return { eligible: false, targetFiles, reason: '复杂度非 simple' };
  }
  if (classification.riskScore !== 0) {
    return { eligible: false, targetFiles, reason: `风险分 ${classification.riskScore} 非 0` };
  }
  if (classification.touchesHighRisk) {
    return { eligible: false, targetFiles, reason: '命中高风险面' };
  }
  if (targetFiles.length < 1 || targetFiles.length > 2) {
    return { eligible: false, targetFiles, reason: `显式目标文件数 ${targetFiles.length} 不在 1~2 之间` };
  }
  if (targetFiles.length > config.limits.maxChangedFiles) {
    return { eligible: false, targetFiles, reason: `目标文件数超过 maxFiles(${config.limits.maxChangedFiles})` };
  }
  if (UNSAFE_TOPIC_PATTERN.test(task)) {
    return { eligible: false, targetFiles, reason: '任务涉及数据库/依赖/配置/Provider/SSE 等高风险话题' };
  }
  return { eligible: true, targetFiles };
}

/** 路径是否安全：必须是仓库内的相对路径，禁止绝对路径与 `..` 穿越。 */
export function isPathWithinRepo(cwd: string, relPath: string): boolean {
  if (path.isAbsolute(relPath)) return false;
  const resolved = path.resolve(cwd, relPath);
  const rel = path.relative(cwd, resolved);
  if (rel === '' ) return false; // 仓库根目录本身不是可编辑文件
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface PreparedFile {
  path: string; // 相对仓库根的路径（规范化后）
  content: string;
  bytes: number;
}

export interface DirectEditContext {
  ok: boolean;
  files: PreparedFile[];
  /** ok=false 时的原因（路径穿越、目标外文件、文件不存在、超限等）。 */
  reason?: string;
}

/**
 * 机器准备上下文：对每个目标文件做路径安全校验、存在性校验、大小校验，并由 Node 读取内容。
 * 任一文件不合规即整体失败（ok:false），不部分准备。绝不调用 Scout 或模型。
 */
export function prepareDirectEditContext(
  cwd: string,
  targetFiles: string[],
): DirectEditContext {
  const files: PreparedFile[] = [];
  const seen = new Set<string>();
  for (const raw of targetFiles) {
    if (!isPathWithinRepo(cwd, raw)) {
      return { ok: false, files: [], reason: `路径不在仓库内或存在穿越：${raw}` };
    }
    const normalized = path.relative(cwd, path.resolve(cwd, raw)).split(path.sep).join('/');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const abs = path.resolve(cwd, normalized);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { ok: false, files: [], reason: `目标文件不存在：${normalized}` };
    }
    const bytes = fs.statSync(abs).size;
    if (bytes > DIRECT_EDIT_MAX_FILE_BYTES) {
      return { ok: false, files: [], reason: `目标文件超过安全上限（${bytes} > ${DIRECT_EDIT_MAX_FILE_BYTES} 字节）：${normalized}` };
    }
    files.push({ path: normalized, content: fs.readFileSync(abs, 'utf8'), bytes });
  }
  if (files.length === 0) {
    return { ok: false, files: [], reason: '没有可准备的目标文件' };
  }
  return { ok: true, files };
}

export interface DirectEdit {
  path: string;
  search: string;
  replace: string;
}

export interface DirectEditBuilderOutput {
  edits: DirectEdit[];
  summary: string;
  suggestedTests?: string[];
}

/** Direct Edit Builder 的独立返回 Schema：只允许 search/replace 形式的 edits。 */
export const DIRECT_EDIT_SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          search: { type: 'string' },
          replace: { type: 'string' },
        },
        required: ['path', 'search', 'replace'],
      },
    },
    summary: { type: 'string' },
    suggestedTests: { type: 'array', items: { type: 'string' } },
  },
  required: ['edits', 'summary'],
};

export interface DirectEditValidation {
  ok: boolean;
  reason?: string;
}

/**
 * 校验 Builder 返回的 edits（纯函数，不写盘）：
 * - edits 非空；
 * - 每个 path 必须属于显式目标文件（allowedFiles，已规范化）；
 * - 涉及的文件数不超过 maxFiles；
 * - search !== replace；
 * - search 在对应文件内容中必须唯一匹配（恰好一次）。
 */
export function validateDirectEdits(
  edits: DirectEdit[],
  files: PreparedFile[],
  config: CcAutoConfig,
): DirectEditValidation {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, reason: 'edits 为空' };
  }
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const touched = new Set<string>();
  for (const edit of edits) {
    const content = byPath.get(edit.path);
    if (content === undefined) {
      return { ok: false, reason: `edit 目标文件不在允许列表内：${edit.path}` };
    }
    if (edit.search === edit.replace) {
      return { ok: false, reason: `search 与 replace 相同，无实际改动：${edit.path}` };
    }
    if (edit.search.length === 0) {
      return { ok: false, reason: `search 为空串，无法定位：${edit.path}` };
    }
    const occurrences = countOccurrences(content, edit.search);
    if (occurrences === 0) {
      return { ok: false, reason: `search 在 ${edit.path} 中零匹配` };
    }
    if (occurrences > 1) {
      return { ok: false, reason: `search 在 ${edit.path} 中匹配 ${occurrences} 处（要求唯一）` };
    }
    touched.add(edit.path);
  }
  if (touched.size > config.limits.maxChangedFiles) {
    return { ok: false, reason: `涉及文件数 ${touched.size} 超过 maxFiles(${config.limits.maxChangedFiles})` };
  }
  return { ok: true };
}

/** 统计 needle 在 haystack 中出现的次数（普通子串，非正则）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

export interface DirectEditApplyResult {
  ok: boolean;
  changedFiles: string[];
  reason?: string;
}

/**
 * 原子应用：先在内存中对所有目标文件套用各自的 edits（校验已保证唯一匹配），
 * 全部成功后才逐个写盘。任一步骤失败即返回 ok:false，且**不写任何文件**（内存计算阶段失败即中止）。
 *
 * 注意：写盘阶段本身在正常文件系统下逐文件同步写入；由于此前已在内存完成全部替换，
 * 写盘阶段不会因内容问题失败，从而保证「校验通过 → 全部写入」的原子语义。
 */
export function applyDirectEdits(
  cwd: string,
  edits: DirectEdit[],
  files: PreparedFile[],
): DirectEditApplyResult {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const nextContent = new Map<string, string>();

  // 阶段一：内存计算，全部成功才进入写盘。
  for (const edit of edits) {
    const current = nextContent.get(edit.path) ?? byPath.get(edit.path);
    if (current === undefined) {
      return { ok: false, changedFiles: [], reason: `apply 目标文件不在允许列表内：${edit.path}` };
    }
    const idx = current.indexOf(edit.search);
    if (idx === -1) {
      return { ok: false, changedFiles: [], reason: `apply 阶段 search 已无法匹配（文件可能被并发改动）：${edit.path}` };
    }
    // 唯一匹配已由 validate 保证；此处按首个匹配替换一次。
    const updated = current.slice(0, idx) + edit.replace + current.slice(idx + edit.search.length);
    nextContent.set(edit.path, updated);
  }

  // 阶段二：写盘。
  const changedFiles: string[] = [];
  for (const [relPath, content] of nextContent) {
    const abs = path.resolve(cwd, relPath);
    fs.writeFileSync(abs, content, 'utf8');
    changedFiles.push(relPath);
  }
  return { ok: true, changedFiles };
}
