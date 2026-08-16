/**
 * Provider-neutral next-action fixtures for the Writer model-profile benchmark.
 * The long-lived worker contract and task stay fixed; only the current
 * observation changes so SEARCH / READ / WRITE can be calibrated horizontally.
 */

export type WriterDecisionActionClass = 'READ' | 'SEARCH' | 'WRITE' | 'FINAL' | 'INVALID';
export type WriterExpectedActionClass = Extract<
  WriterDecisionActionClass,
  'READ' | 'SEARCH' | 'WRITE'
>;

export interface WriterDecisionFixture {
  id: string;
  version: string;
  phase: 'IMPLEMENT';
  systemInstructions: string[];
  taskInput: string;
  userInstructions: string[];
  repositorySearchRoots: string[];
  confirmedTargetPaths: string[];
  allowedPaths: string[];
  currentFiles: Array<{ path: string; content: string }>;
  availableTools: Array<{
    name: 'read_file' | 'grep' | 'glob' | 'write_file' | 'edit_file';
    purpose: string;
  }>;
  observationState: {
    discoveryRequired: boolean;
    targetConfirmed: boolean;
    targetContentAvailable: boolean;
    implementationContextSufficient: boolean;
  };
  previousObservations: Array<{
    kind: 'DISCOVERY_REQUIRED' | 'DISCOVERY_COMPLETED' | 'TARGET_CONFIRMED' | 'TOOL_RESULT';
    detail: string;
  }>;
  observedNextAction?: { toolName: string; actionClass: WriterDecisionActionClass };
  expectedNextActionClass: WriterExpectedActionClass;
}

export function classifyWriterDecisionAction(toolName: string | null): WriterDecisionActionClass {
  if (toolName === 'read_file') return 'READ';
  if (toolName === 'grep' || toolName === 'glob') return 'SEARCH';
  if (toolName === 'write_file' || toolName === 'edit_file') return 'WRITE';
  if (toolName === null) return 'FINAL';
  return 'INVALID';
}

const SYSTEM_INSTRUCTIONS = [
  '你只能在宿主授权的工作区范围内使用文件工具。',
  '只能使用提供的 read_file、grep、glob、write_file、edit_file。',
  '不得声称执行未提供的 Bash、Git 或测试命令，不得请求凭证。',
  '不得读取 .git、.env、.cc-auto/config.json、node_modules 等保护路径。',
  '工具错误必须作为事实接受，不得绕过安全边界或虚构工具结果。',
  '最终回答只能总结经过工具验证的事实。',
  'write_file 和 edit_file 只能写入已批准路径，写入结果以 Dispatcher 返回为准。',
];

const TASK_INPUT = '为 formatDisplayName 补充一个前后空白裁剪单测';
const USER_INSTRUCTIONS = [
  TASK_INPUT,
  '根据当前 Observation 选择推进任务所需的下一步动作。',
];
const TARGET_PATH = 'src/utils/formatDisplayName.spec.ts';
const REPOSITORY_SEARCH_ROOTS = ['src'];

const AVAILABLE_TOOLS: WriterDecisionFixture['availableTools'] = [
  { name: 'read_file', purpose: '读取工作区授权范围内的 UTF-8 文本文件。' },
  { name: 'grep', purpose: '在批准的 repository search roots 内进行纯文本子串搜索。' },
  { name: 'glob', purpose: '在批准的 repository search roots 内按 *、**、? 匹配文件。' },
  { name: 'write_file', purpose: '安全写入 UTF-8 文本文件，只能写入已批准路径。' },
  { name: 'edit_file', purpose: '安全替换文本；只能写入已批准路径，oldText 必须唯一且精确匹配。' },
];

const CURRENT_TARGET_CONTENT = `import { describe, expect, it } from 'vitest';
import { formatDisplayName } from './formatDisplayName';

describe('formatDisplayName', () => {
  it('returns an empty string for an empty value', () => {
    expect(formatDisplayName('')).toBe('');
  });
});
`;

function commonFixture(): Pick<
  WriterDecisionFixture,
  | 'version'
  | 'phase'
  | 'systemInstructions'
  | 'taskInput'
  | 'userInstructions'
  | 'repositorySearchRoots'
  | 'availableTools'
> {
  return {
    version: 'v1',
    phase: 'IMPLEMENT',
    systemInstructions: [...SYSTEM_INSTRUCTIONS],
    taskInput: TASK_INPUT,
    userInstructions: [...USER_INSTRUCTIONS],
    repositorySearchRoots: [...REPOSITORY_SEARCH_ROOTS],
    availableTools: AVAILABLE_TOOLS.map(tool => ({ ...tool })),
  };
}

/** Fixture A: target and current content are present, so implementation can start. */
export const WRITER_DECISION_FIXTURE: WriterDecisionFixture = {
  ...commonFixture(),
  id: 'writer-has-confirmed-target-and-current-content-v1',
  confirmedTargetPaths: [TARGET_PATH],
  allowedPaths: [TARGET_PATH],
  currentFiles: [{ path: TARGET_PATH, content: CURRENT_TARGET_CONTENT }],
  observationState: {
    discoveryRequired: false,
    targetConfirmed: true,
    targetContentAvailable: true,
    implementationContextSufficient: true,
  },
  previousObservations: [
    { kind: 'DISCOVERY_COMPLETED', detail: '目标文件已经由只读 Discovery 确认并通过 FileScope 批准。' },
    { kind: 'TOOL_RESULT', detail: 'read_file 已成功返回上方目标文件全文。' },
  ],
  observedNextAction: { toolName: 'read_file', actionClass: 'READ' },
  expectedNextActionClass: 'WRITE',
};

/** Fixture B: the target is confirmed and approved, but its content is absent. */
export const WRITER_READ_DECISION_FIXTURE: WriterDecisionFixture = {
  ...commonFixture(),
  id: 'writer-has-confirmed-target-without-current-content-v1',
  confirmedTargetPaths: [TARGET_PATH],
  allowedPaths: [TARGET_PATH],
  currentFiles: [],
  observationState: {
    discoveryRequired: false,
    targetConfirmed: true,
    targetContentAvailable: false,
    implementationContextSufficient: false,
  },
  previousObservations: [
    { kind: 'DISCOVERY_COMPLETED', detail: 'Discovery 已结束，不需要 repository-wide search。' },
    { kind: 'TARGET_CONFIRMED', detail: `目标文件 ${TARGET_PATH} 已确认并通过 FileScope 批准。` },
    { kind: 'TOOL_RESULT', detail: '当前 Observation 尚未包含目标文件正文；正文是实施所必需的缺失上下文。' },
  ],
  expectedNextActionClass: 'READ',
};

/** Fixture C: the task is known, but repository discovery has not found a target. */
export const WRITER_SEARCH_DECISION_FIXTURE: WriterDecisionFixture = {
  ...commonFixture(),
  id: 'writer-needs-repository-discovery-v1',
  confirmedTargetPaths: [],
  allowedPaths: [],
  currentFiles: [],
  observationState: {
    discoveryRequired: true,
    targetConfirmed: false,
    targetContentAvailable: false,
    implementationContextSufficient: false,
  },
  previousObservations: [
    { kind: 'DISCOVERY_REQUIRED', detail: '尚未确认 target path，现有信息不足以直接确定目标文件。' },
    { kind: 'TOOL_RESULT', detail: '需要在批准的 repository search roots 内进行 discovery；不得猜测固定文件路径。' },
  ],
  expectedNextActionClass: 'SEARCH',
};

export const WRITER_DECISION_FIXTURES: readonly WriterDecisionFixture[] = [
  WRITER_DECISION_FIXTURE,
  WRITER_READ_DECISION_FIXTURE,
  WRITER_SEARCH_DECISION_FIXTURE,
];
