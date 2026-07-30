import { describe, expect, it } from 'vitest';
import { checkCommandSafety, checkPathSafety } from './safety';

describe('checkCommandSafety', () => {
  it('拦截 git push --force / -f', () => {
    expect(checkCommandSafety('git push origin main --force').denied).toBe(true);
    expect(checkCommandSafety('git push origin feature -f').denied).toBe(true);
  });

  it('拦截直接 push main', () => {
    expect(checkCommandSafety('git push origin main').denied).toBe(true);
  });

  it('拦截 reset --hard / clean -f / branch -D / tag / drop table', () => {
    expect(checkCommandSafety('git reset --hard HEAD~1').denied).toBe(true);
    expect(checkCommandSafety('git clean -fd').denied).toBe(true);
    expect(checkCommandSafety('git branch -D feature/x').denied).toBe(true);
    expect(checkCommandSafety('git tag v1.0.0').denied).toBe(true);
    expect(checkCommandSafety('DROP TABLE users;').denied).toBe(true);
  });

  it('放行普通只读/构建命令', () => {
    expect(checkCommandSafety('git status --short').denied).toBe(false);
    expect(checkCommandSafety('pnpm vitest run scripts/ccAuto').denied).toBe(false);
    expect(checkCommandSafety('git push origin feature/cc-auto').denied).toBe(false);
  });
});

describe('checkPathSafety', () => {
  it('拦截生产 sqlite 与 .env 与 schema.ts', () => {
    expect(checkPathSafety('data/offerflow.sqlite3').denied).toBe(true);
    expect(checkPathSafety('.env.production').denied).toBe(true);
    expect(checkPathSafety('server/schema.ts').denied).toBe(true);
  });

  it('放行普通业务文件', () => {
    expect(checkPathSafety('src/app/prompt.ts').denied).toBe(false);
  });
});
