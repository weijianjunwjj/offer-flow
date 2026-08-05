import type { NovaWingHostAdapter } from '../radar/analysis/novaWingHostAdapter';

/** The only lifecycle surface exposed by the infrastructure layer. */
export interface NovaWingRuntimeHandle {
  readonly adapter: NovaWingHostAdapter;
  close(): void;
}
