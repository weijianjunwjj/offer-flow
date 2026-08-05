import { DatabaseSync } from 'node:sqlite';
import { createNovaWingFacade } from '@weijianjunwjj/nova-wing/core';
import {
  createInjectedSqliteNovaWingStore,
  type SqliteNovaWingStore,
} from '@weijianjunwjj/nova-wing/sqlite';
import {
  developmentApplyNotConfirmed,
  runtimeInitializationFailed,
} from './errors';
import { NovaWingRuntimeAdapter } from './runtimeAdapter';
import type { NovaWingRuntimeHandle } from './runtimeTypes';

export const NOVA_WING_RUNTIME_BUSY_POLICY = Object.freeze({
  busyTimeoutMs: 5_000,
  storeBusyRetries: 2,
  storeBusyRetryDelayMs: 100,
  readBusyRetries: 1,
  readBusyRetryDelayMs: 100,
});

export const NOVA_WING_DEVELOPMENT_APPLY_CONFIRMATION =
  'APPLY_NOVAWING_SCHEMA_FOR_TEST_OR_DEVELOPMENT' as const;

interface NovaWingBusyPolicy {
  busyTimeoutMs: number;
  storeBusyRetries: number;
  storeBusyRetryDelayMs: number;
  readBusyRetries: number;
  readBusyRetryDelayMs: number;
}

export interface CreateNovaWingRuntimeOptions {
  databasePath: string;
  busyPolicy?: Partial<NovaWingBusyPolicy>;
}

export interface ApplyNovaWingSchemaOptions {
  databasePath: string;
  confirmation: typeof NOVA_WING_DEVELOPMENT_APPLY_CONFIRMATION;
  busyPolicy?: Partial<NovaWingBusyPolicy>;
}

function normalizeBusyPolicy(overrides: Partial<NovaWingBusyPolicy> = {}): NovaWingBusyPolicy {
  const policy = { ...NOVA_WING_RUNTIME_BUSY_POLICY, ...overrides };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return policy;
}

function openConnection(databasePath: string, busyTimeoutMs: number): DatabaseSync {
  try {
    return new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: busyTimeoutMs,
    });
  } catch {
    throw runtimeInitializationFailed();
  }
}

function assertDeleteJournalMode(connection: DatabaseSync): void {
  const row = connection.prepare('PRAGMA journal_mode').get() as
    | { journal_mode?: unknown }
    | undefined;
  if (typeof row?.journal_mode !== 'string' || row.journal_mode.toLowerCase() !== 'delete') {
    throw runtimeInitializationFailed();
  }
}

function closeResources(store: SqliteNovaWingStore | undefined, connection: DatabaseSync): void {
  try {
    store?.close();
  } finally {
    connection.close();
  }
}

/** Production runtime: validate-only, independently owns its node:sqlite connection. */
export function createNovaWingRuntime(
  options: CreateNovaWingRuntimeOptions,
): NovaWingRuntimeHandle {
  const policy = normalizeBusyPolicy(options.busyPolicy);
  const connection = openConnection(options.databasePath, policy.busyTimeoutMs);
  let store: SqliteNovaWingStore | undefined;
  try {
    assertDeleteJournalMode(connection);
    store = createInjectedSqliteNovaWingStore({
      connection,
      migrationMode: 'validate',
      busyTimeoutMs: policy.busyTimeoutMs,
      busyRetries: policy.storeBusyRetries,
      busyRetryDelayMs: policy.storeBusyRetryDelayMs,
    });
    const facade = createNovaWingFacade(store);
    const adapter = new NovaWingRuntimeAdapter({
      facade,
      busyRetries: policy.readBusyRetries,
      busyRetryDelayMs: policy.readBusyRetryDelayMs,
    });
    let closed = false;
    return {
      adapter,
      close(): void {
        if (closed) return;
        closed = true;
        closeResources(store, connection);
      },
    };
  } catch {
    try {
      closeResources(store, connection);
    } catch {
      // Preserve the stable initialization error and do not expose close/SQLite details.
    }
    throw runtimeInitializationFailed();
  }
}

/** Explicit test/development-only schema initialization; never called by normal OfferFlow startup. */
export function applyNovaWingSchemaForTestOrDevelopment(
  options: ApplyNovaWingSchemaOptions,
): void {
  if (
    process.env.NODE_ENV === 'production'
    || options.confirmation !== NOVA_WING_DEVELOPMENT_APPLY_CONFIRMATION
  ) {
    throw developmentApplyNotConfirmed();
  }
  const policy = normalizeBusyPolicy(options.busyPolicy);
  const connection = openConnection(options.databasePath, policy.busyTimeoutMs);
  let store: SqliteNovaWingStore | undefined;
  try {
    assertDeleteJournalMode(connection);
    store = createInjectedSqliteNovaWingStore({
      connection,
      migrationMode: 'apply',
      busyTimeoutMs: policy.busyTimeoutMs,
      busyRetries: policy.storeBusyRetries,
      busyRetryDelayMs: policy.storeBusyRetryDelayMs,
    });
  } catch {
    throw runtimeInitializationFailed();
  } finally {
    try {
      closeResources(store, connection);
    } catch {
      // No raw SQLite close error escapes this explicitly bounded initializer.
    }
  }
}
