import { describe, expect, it } from 'vitest';
import { apiBaseUrl, appBaseUrl, buildPreviewUrl, OFFERFLOW_BASE_URL } from './radarCaptureClient';

describe('capture client base URLs', () => {
  it('keeps API on 127.0.0.1:17365 loopback', () => {
    expect(apiBaseUrl).toBe('http://127.0.0.1:17365');
    // 旧字面量仍等于 API 基址，供 e2e 替换使用。
    expect(OFFERFLOW_BASE_URL).toBe('http://127.0.0.1:17365');
  });

  it('points the app (frontend) at localhost:5173 in dev', () => {
    expect(appBaseUrl).toBe('http://localhost:5173');
  });
});

describe('buildPreviewUrl', () => {
  it('opens the Radar import page on the frontend app host, not the API host', () => {
    const url = buildPreviewUrl('abc');
    expect(url).toBe('http://localhost:5173/#/radar/import?sessionId=abc');
    expect(url.startsWith(appBaseUrl)).toBe(true);
    expect(url.startsWith(apiBaseUrl)).toBe(false);
  });

  it('URL-encodes the sessionId', () => {
    const url = buildPreviewUrl('a b/c?d=1&e=2');
    expect(url).toBe(
      'http://localhost:5173/#/radar/import?sessionId=a%20b%2Fc%3Fd%3D1%26e%3D2',
    );
  });
});
