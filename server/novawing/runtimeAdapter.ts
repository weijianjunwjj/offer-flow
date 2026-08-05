import {
  isNovaWingError,
  type MainlineEntry,
  type NovaWingFacade,
} from '@weijianjunwjj/nova-wing/core';
import { NovaWingContextError } from '../radar/analysis/novaWingContext';
import type {
  NovaWingHostAdapter,
  NovaWingMainlineContext,
  NovaWingMainlineScope,
} from '../radar/analysis/novaWingHostAdapter';

export interface NovaWingRuntimeAdapterOptions {
  facade: NovaWingFacade;
  busyRetries: number;
  busyRetryDelayMs: number;
}

function finiteNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function wait(milliseconds: number): void {
  if (milliseconds === 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function projectEntry(entry: MainlineEntry): NovaWingMainlineContext['entries'][number] {
  return {
    scope: entry.scope,
    key: entry.memoryKey,
    value: {
      assertionType: entry.assertionType,
      category: entry.category,
      rationale: entry.rationale,
      statement: entry.statement,
    },
  };
}

/**
 * OfferFlow's read-only projection over the public NovaWing facade.
 * It exposes no connection, store, facade, proposal, migration, snapshot, or write capability.
 */
export class NovaWingRuntimeAdapter implements NovaWingHostAdapter {
  private readonly facade: NovaWingFacade;
  private readonly busyRetries: number;
  private readonly busyRetryDelayMs: number;

  constructor(options: NovaWingRuntimeAdapterOptions) {
    this.facade = options.facade;
    this.busyRetries = finiteNonNegativeInteger(options.busyRetries, 'busyRetries');
    this.busyRetryDelayMs = finiteNonNegativeInteger(options.busyRetryDelayMs, 'busyRetryDelayMs');
  }

  readLatestMainline(input: {
    scopes: readonly NovaWingMainlineScope[];
  }): NovaWingMainlineContext {
    for (let attempt = 0; attempt <= this.busyRetries; attempt += 1) {
      try {
        const context = this.facade.getContext({ scopes: input.scopes });
        return {
          coreRevision: context.coreRevision,
          entries: context.entries.map(projectEntry),
        };
      } catch (error) {
        if (isNovaWingError(error) && error.code === 'STORE_BUSY' && attempt < this.busyRetries) {
          wait(this.busyRetryDelayMs);
          continue;
        }
        throw new NovaWingContextError(
          'NOVA_WING_CONTEXT_UNAVAILABLE',
          'NovaWing 分析上下文暂不可用',
        );
      }
    }
    throw new NovaWingContextError(
      'NOVA_WING_CONTEXT_UNAVAILABLE',
      'NovaWing 分析上下文暂不可用',
    );
  }
}
