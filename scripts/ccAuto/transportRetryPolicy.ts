import { TransportError } from './providerErrors';
import type { ProviderTransportAudit } from './types';

export const TRANSPORT_CONNECT_RETRY_POLICY_VERSION =
  'connect-timeout-retry-v1' as const;
export const TRANSPORT_CONNECT_RETRY_DELAY_MS = 250;
export const MAX_TRANSPORT_ATTEMPTS = 2;
export const CONNECT_TIMEOUT_RETRY_ERROR_CODE = 'UND_ERR_CONNECT_TIMEOUT' as const;

const MAX_NETWORK_ERROR_CAUSE_DEPTH = 4;
const SAFE_NETWORK_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

export type TransportAttemptOutcome<T> =
  | { ok: true; value: T; audit: ProviderTransportAudit }
  | { ok: false; error: unknown; audit: ProviderTransportAudit };

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one logical Provider invocation with at most two transport attempts.
 * Adapter responses (including every HTTP status) never enter this catch-only
 * policy. Eligibility requires an exact, safe connection-timeout cause code.
 */
export async function executeWithConnectTimeoutRetry<T>(
  attempt: () => Promise<T>,
  sleep: Sleep = defaultSleep,
): Promise<TransportAttemptOutcome<T>> {
  const retryReasons: string[] = [];

  for (let index = 0; index < MAX_TRANSPORT_ATTEMPTS; index += 1) {
    const transportAttempts = index + 1;
    try {
      return {
        ok: true,
        value: await attempt(),
        audit: buildAudit(transportAttempts, retryReasons),
      };
    } catch (error) {
      const canRetry =
        transportAttempts < MAX_TRANSPORT_ATTEMPTS
        && isConnectEstablishmentTimeout(error);
      if (!canRetry) {
        return {
          ok: false,
          error,
          audit: buildAudit(transportAttempts, retryReasons),
        };
      }

      retryReasons.push(CONNECT_TIMEOUT_RETRY_ERROR_CODE);
      await sleep(TRANSPORT_CONNECT_RETRY_DELAY_MS);
    }
  }

  throw new Error('TRANSPORT_RETRY_POLICY_UNREACHABLE');
}

export function isConnectEstablishmentTimeout(error: unknown): boolean {
  return error instanceof TransportError
    && getSafeNetworkErrorCode(error) === CONNECT_TIMEOUT_RETRY_ERROR_CODE;
}

/** Bounded safe-code extraction; never returns messages, stacks, URLs, or bodies. */
export function getSafeNetworkErrorCode(
  error: unknown,
  secrets: readonly string[] = [],
): string | null {
  let current = error;
  const seen = new Set<object>();

  for (let depth = 0; depth < MAX_NETWORK_ERROR_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) return null;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const cause = record.cause && typeof record.cause === 'object'
      ? record.cause as Record<string, unknown>
      : null;

    const causeCode = safeNetworkErrorCode(cause?.code, secrets);
    if (causeCode) return causeCode;

    const directCode = safeNetworkErrorCode(record.code, secrets);
    if (directCode) return directCode;

    const errnoCode = mapNetworkErrno(record.errno);
    if (errnoCode) return errnoCode;

    current = cause;
  }

  return null;
}

function buildAudit(
  transportAttempts: number,
  transportRetryReasons: readonly string[],
): ProviderTransportAudit {
  return {
    transportRetryPolicyVersion: TRANSPORT_CONNECT_RETRY_POLICY_VERSION,
    transportAttempts,
    transportRetryCount: transportRetryReasons.length,
    transportRetryReasons: [...transportRetryReasons],
  };
}

function safeNetworkErrorCode(
  value: unknown,
  secrets: readonly string[],
): string | null {
  if (typeof value !== 'string' || !SAFE_NETWORK_ERROR_CODE_PATTERN.test(value)) return null;
  if (secrets.some((secret) => secret.length > 0 && value.includes(secret))) return null;
  return value;
}

function mapNetworkErrno(value: unknown): string | null {
  if (typeof value !== 'number') return null;
  if (value === -4078 || value === -54) return 'ECONNRESET';
  if (value === -4039 || value === -60) return 'ETIMEDOUT';
  if (value === -3008 || value === -3000) return 'EAI_AGAIN';
  if (value === -4073 || value === -61) return 'ECONNREFUSED';
  return null;
}
