import { describe, expect, it } from 'vitest';
import { parseFlags, stripDuplicateRunToken } from './cli';

describe('parseFlags：CLI 参数解析', () => {
  it('旧调用方式（空格分隔 --budget 2.00 --max-files 2 --max-fix-rounds 1 --no-commit）：取值型 flag 消费下一个 token，不泄漏进任务正文', () => {
    const { flags, positional } = parseFlags([
      '--budget', '2.00', '--max-files', '2', '--max-fix-rounds', '1', '--no-commit',
      '优化 report 子命令的帮助文案，明确表达查看模型调用、渠道费用和验证结果',
    ]);
    expect(flags.get('budget')).toBe('2.00');
    expect(flags.get('max-files')).toBe('2');
    expect(flags.get('max-fix-rounds')).toBe('1');
    expect(flags.get('no-commit')).toBe('true');
    // 关键契约：任务正文只剩自然语言，不含任何 run/预算/文件数/修复轮数参数。
    expect(positional.join(' ')).toBe('优化 report 子命令的帮助文案，明确表达查看模型调用、渠道费用和验证结果');
    expect(positional.join(' ')).not.toMatch(/^\s*run\s|--|2\.00|max-files|max-fix-rounds/);
  });

  it('新格式 --budget=2.00 等 --key=value：同样不泄漏进 positional', () => {
    const { flags, positional } = parseFlags([
      '--budget=2.00', '--max-files=2', '--max-fix-rounds=1', '--no-commit',
      '优化 report 子命令的帮助文案，同步更新测试',
    ]);
    expect(flags.get('budget')).toBe('2.00');
    expect(flags.get('max-files')).toBe('2');
    expect(flags.get('max-fix-rounds')).toBe('1');
    expect(flags.get('no-commit')).toBe('true');
    expect(positional.join(' ')).toBe('优化 report 子命令的帮助文案，同步更新测试');
  });

  it('--no-commit 等布尔开关不消费下一个 token', () => {
    const { flags, positional } = parseFlags(['--no-commit', '修改文案：调整按钮文案']);
    expect(flags.get('no-commit')).toBe('true');
    expect(positional).toEqual(['修改文案：调整按钮文案']);
  });

  it('--estimated-files=N 与自然语言任务描述共存时，positional 只保留任务描述', () => {
    const { flags, positional } = parseFlags(['修复登录页跳转报错的 bug', '--estimated-files=3']);
    expect(flags.get('estimated-files')).toBe('3');
    expect(positional.join(' ')).toBe('修复登录页跳转报错的 bug');
  });

  it('resume/report 的位置参数（run-id）不受 flags 干扰', () => {
    const { positional } = parseFlags(['run-12345-abcde']);
    expect(positional[0]).toBe('run-12345-abcde');
  });

  it('无任何 flag 时 positional 等于原始参数', () => {
    const { flags, positional } = parseFlags(['修改文案：调整按钮文案']);
    expect(flags.size).toBe(0);
    expect(positional).toEqual(['修改文案：调整按钮文案']);
  });

  it('取值型 flag 位于参数末尾且缺值时，不越界读取（视为布尔）', () => {
    const { flags, positional } = parseFlags(['修改文案', '--budget']);
    expect(flags.get('budget')).toBe('true');
    expect(positional).toEqual(['修改文案']);
  });
});

describe('stripDuplicateRunToken：剥离 package.json 已内置的重复 run 子命令', () => {
  it('复现 Phase-1 真实故障：手动追加的第二个 "run" 不得拼入任务正文', () => {
    // package.json 的 cc:auto 脚本已绑定 `run`；若调用方再手动传一次
    // `pnpm cc:auto run "<任务>" --budget 2.00 ...`，parseFlags 会把这个多余的
    // "run" 当作 positional[0]，与真实的 Phase-1 损坏任务描述
    // （"run 2.00 2 1 优化..."）完全对应。
    const { positional: rawPositional } = parseFlags([
      'run', '--budget', '2.00', '--max-files', '2', '--max-fix-rounds', '1',
      '优化 scripts/ccAuto/cli.ts 中 report 子命令的一处帮助文案',
    ]);
    const { positional, stripped } = stripDuplicateRunToken(rawPositional);
    expect(stripped).toBe(true);
    expect(positional.join(' ')).toBe('优化 scripts/ccAuto/cli.ts 中 report 子命令的一处帮助文案');
    expect(positional.join(' ')).not.toMatch(/^\s*run\s/);
  });

  it('正常调用（未重复 run）时不做任何剥离', () => {
    const { positional: rawPositional } = parseFlags(['优化登录页文案']);
    const { positional, stripped } = stripDuplicateRunToken(rawPositional);
    expect(stripped).toBe(false);
    expect(positional).toEqual(['优化登录页文案']);
  });

  it('任务正文本身以 "run" 开头（自然语言场景，如 "run 一次冒烟测试"）时会被误剥离首词——仅剥离一次，不影响后续内容完整性', () => {
    // 记录已知边界：该策略无法区分"重复子命令"和"任务原文恰好以 run 开头"，
    // 但只剥离一次且立即打印提示日志，不会静默丢失多个词。
    const { positional: rawPositional } = parseFlags(['run', '一次冒烟测试']);
    const { positional, stripped } = stripDuplicateRunToken(rawPositional);
    expect(stripped).toBe(true);
    expect(positional).toEqual(['一次冒烟测试']);
  });
});
