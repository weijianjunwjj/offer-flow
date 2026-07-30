import { describe, expect, it } from 'vitest';
import { classifyTask } from './classify';

describe('classifyTask', () => {
  it('纯文案/文档任务 → simple，不含高风险', () => {
    const result = classifyTask('修改文案：把按钮文字改成"确认投递"');
    expect(result.complexity).toBe('simple');
    expect(result.touchesHighRisk).toBe(false);
  });

  it('命中高风险关键词（schema/迁移）→ 风险分显著提升', () => {
    const result = classifyTask('给 server/schema.ts 新增一个字段并写 migration');
    expect(result.touchesHighRisk).toBe(true);
    expect(result.riskScore).toBeGreaterThanOrEqual(4);
  });

  it('命中强推/生产库关键词 → complex 或至少 normal，风险分不为 0', () => {
    const result = classifyTask('需要 force push 到生产环境处理数据库问题');
    expect(result.riskScore).toBeGreaterThan(0);
    expect(result.complexity).not.toBe('simple');
  });

  it('预估文件数 > 5 → 提升为 complex', () => {
    const result = classifyTask('优化一下这几个模块', 8);
    expect(result.complexity).toBe('complex');
  });

  it('普通两文件 bug 修复描述 → normal', () => {
    const result = classifyTask('修复登录页跳转报错的 bug', 2);
    expect(result.complexity).toBe('normal');
  });

  it('风险分始终落在 0-10 范围', () => {
    const result = classifyTask('force push --hard drop table 生产 schema 鉴权 secret token 重构 架构 跨模块', 20);
    expect(result.riskScore).toBeLessThanOrEqual(10);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
  });
});
