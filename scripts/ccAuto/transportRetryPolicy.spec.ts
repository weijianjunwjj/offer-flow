import { describe, expect, it, vi } from 'vitest';
import { ProviderProtocolError, TransportError } from './providerErrors';
import {
  CONNECT_TIMEOUT_RETRY_ERROR_CODE,
  executeWithConnectTimeoutRetry,
  MAX_TRANSPORT_ATTEMPTS,
  TRANSPORT_CONNECT_RETRY_DELAY_MS,
  TRANSPORT_CONNECT_RETRY_POLICY_VERSION,
} from './transportRetryPolicy';

function transportError(code: string): TransportError {
  return new TransportError('safe transport failure', {
    transient: true,
    cause: Object.assign(new Error('safe cause'), { code }),
  });
}

function fakeSleep(calls: number[]): (ms: number) => Promise<void> {
  return async (ms) => { calls.push(ms); };
}

describe('connect-timeout retry policy v1', () => {
  it('A: retries one connect timeout and returns the successful response', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(transportError(CONNECT_TIMEOUT_RETRY_ERROR_CODE))
      .mockResolvedValueOnce({ status: 200 });
    const delays: number[] = [];

    const outcome = await executeWithConnectTimeoutRetry(attempt, fakeSleep(delays));

    expect(outcome).toMatchObject({
      ok: true,
      value: { status: 200 },
      audit: {
        transportRetryPolicyVersion: TRANSPORT_CONNECT_RETRY_POLICY_VERSION,
        transportAttempts: 2,
        transportRetryCount: 1,
        transportRetryReasons: [CONNECT_TIMEOUT_RETRY_ERROR_CODE],
      },
    });
    expect(attempt).toHaveBeenCalledTimes(MAX_TRANSPORT_ATTEMPTS);
    expect(delays).toEqual([TRANSPORT_CONNECT_RETRY_DELAY_MS]);
  });

  it('B: stops after two connect timeouts', async () => {
    const attempt = vi.fn()
      .mockRejectedValue(transportError(CONNECT_TIMEOUT_RETRY_ERROR_CODE));
    const delays: number[] = [];

    const outcome = await executeWithConnectTimeoutRetry(attempt, fakeSleep(delays));

    expect(outcome.ok).toBe(false);
    expect(outcome.audit).toEqual({
      transportRetryPolicyVersion: TRANSPORT_CONNECT_RETRY_POLICY_VERSION,
      transportAttempts: 2,
      transportRetryCount: 1,
      transportRetryReasons: [CONNECT_TIMEOUT_RETRY_ERROR_CODE],
    });
    expect(attempt).toHaveBeenCalledTimes(MAX_TRANSPORT_ATTEMPTS);
    expect(delays).toEqual([TRANSPORT_CONNECT_RETRY_DELAY_MS]);
  });

  it.each([
    ['HTTP 400', { status: 400 }],
    ['HTTP 401', { status: 401 }],
    ['HTTP 403', { status: 403 }],
    ['HTTP 404', { status: 404 }],
    ['HTTP 409', { status: 409 }],
    ['HTTP 422', { status: 422 }],
    ['C: HTTP 429', { status: 429 }],
    ['D: HTTP 500', { status: 500 }],
    ['HTTP 503', { status: 503 }],
  ])('%s is an Adapter response and is never replayed', async (_label, response) => {
    const attempt = vi.fn().mockResolvedValue(response);
    const delays: number[] = [];

    const outcome = await executeWithConnectTimeoutRetry(attempt, fakeSleep(delays));

    expect(outcome).toMatchObject({
      ok: true,
      value: response,
      audit: { transportAttempts: 1, transportRetryCount: 0 },
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it.each([
    ['E: ECONNRESET', () => transportError('ECONNRESET')],
    ['ETIMEDOUT', () => transportError('ETIMEDOUT')],
    ['F: headers timeout', () => transportError('UND_ERR_HEADERS_TIMEOUT')],
    ['body timeout', () => transportError('UND_ERR_BODY_TIMEOUT')],
    ['AbortError', () => Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['G: invalid model response', () => new ProviderProtocolError('invalid response')],
  ])('%s is not retryable', async (_label, errorFactory) => {
    const attempt = vi.fn().mockRejectedValue(errorFactory());
    const delays: number[] = [];

    const outcome = await executeWithConnectTimeoutRetry(attempt, fakeSleep(delays));

    expect(outcome).toMatchObject({
      ok: false,
      audit: { transportAttempts: 1, transportRetryCount: 0 },
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('H: a retry that obtains HTTP 401 stops without a third attempt', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(transportError(CONNECT_TIMEOUT_RETRY_ERROR_CODE))
      .mockResolvedValueOnce({ status: 401 });
    const delays: number[] = [];

    const outcome = await executeWithConnectTimeoutRetry(attempt, fakeSleep(delays));

    expect(outcome).toMatchObject({
      ok: true,
      value: { status: 401 },
      audit: {
        transportAttempts: 2,
        transportRetryCount: 1,
        transportRetryReasons: [CONNECT_TIMEOUT_RETRY_ERROR_CODE],
      },
    });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([TRANSPORT_CONNECT_RETRY_DELAY_MS]);
  });

  it('requires a TransportError, not a generic error carrying the same code', async () => {
    const error = Object.assign(new Error('generic failure'), {
      code: CONNECT_TIMEOUT_RETRY_ERROR_CODE,
    });
    const attempt = vi.fn().mockRejectedValue(error);

    const outcome = await executeWithConnectTimeoutRetry(attempt, async () => undefined);

    expect(outcome).toMatchObject({
      ok: false,
      audit: { transportAttempts: 1, transportRetryCount: 0 },
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
