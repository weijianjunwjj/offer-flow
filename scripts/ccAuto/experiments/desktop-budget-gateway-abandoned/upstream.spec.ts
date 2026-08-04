/**
 * upstream 测试：API Key 脱敏、URL 脱敏、127.0.0.1 绑定确认。
 */
import { describe, expect, it } from 'vitest';
import { redactHeaderValue, redactUrl } from './upstream';
import { DEFAULT_GATEWAY_CONFIG } from './gatewayConfig';

describe('redactHeaderValue：认证 Header 脱敏', () => {
  it('test-19：Bearer token 脱敏为 Bearer ***', () => {
    expect(redactHeaderValue('Authorization', 'Bearer sk-f1ff381cf7644ef4a2ac12bc02988ac4')).toBe('Bearer ***');
  });

  it('Basic auth 脱敏为 Basic ***', () => {
    expect(redactHeaderValue('Authorization', 'Basic dXNlcjpwYXNz')).toBe('Basic ***');
  });

  it('x-api-key 脱敏', () => {
    expect(redactHeaderValue('x-api-key', 'sk-e255af0ad62463a76339ee90f9d657ca71f466600e68360c7450f935b7804584')).toBe('sk-e***');
  });

  it('非敏感 header 原样保留', () => {
    expect(redactHeaderValue('Content-Type', 'application/json')).toBe('application/json');
    expect(redactHeaderValue('anthropic-version', '2023-06-01')).toBe('2023-06-01');
  });

  it('大小写不敏感匹配', () => {
    expect(redactHeaderValue('AUTHORIZATION', 'Bearer token123')).toBe('Bearer ***');
    expect(redactHeaderValue('X-Api-Key', 'secret')).toBe('***');
  });
});

describe('redactUrl', () => {
  it('无 query string 的 URL 原样返回', () => {
    expect(redactUrl('/v1/messages')).toBe('/v1/messages');
    expect(redactUrl('/claude-desktop/v1/messages')).toBe('/claude-desktop/v1/messages');
  });

  it('有 query string 的 URL 脱敏为 [redacted]', () => {
    expect(redactUrl('/v1/messages?token=secret')).toBe('/v1/messages?[redacted]');
  });
});

describe('DEFAULT_GATEWAY_CONFIG：安全边界', () => {
  it('test-20：host 必须只绑定 127.0.0.1', () => {
    expect(DEFAULT_GATEWAY_CONFIG.host).toBe('127.0.0.1');
    // 绝不绑定 0.0.0.0
    expect(DEFAULT_GATEWAY_CONFIG.host).not.toBe('0.0.0.0');
  });

  it('upstream 也只允许 127.0.0.1', () => {
    expect(DEFAULT_GATEWAY_CONFIG.upstreamHost).toBe('127.0.0.1');
  });
});
