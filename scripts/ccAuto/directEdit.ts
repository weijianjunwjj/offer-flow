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

export interface DirectEditEligibility {
  eligible: boolean;
  /** 命中条件时提取到的显式目标文件（相对路径，已去重）。 */
  targetFiles: string[];
  /** 不合格时的原因，便于日志与报告说明；合格时为 undefined。 */
  reason?: string;
}

/**
 * Direct Edit 命中条件（纯函数，不触碰磁盘，供路由判定与单测复用）：
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
): DirectEditEligibility {
  const targetFiles = extractExplicitFiles(task);
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
