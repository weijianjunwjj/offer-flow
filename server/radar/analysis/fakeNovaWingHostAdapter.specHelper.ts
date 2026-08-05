import type {
  NovaWingHostAdapter,
  NovaWingMainlineContext,
  NovaWingMainlineScope,
} from './novaWingHostAdapter';

/** Test-only controllable fake. No global/default instance is exported. */
export class FakeNovaWingHostAdapter implements NovaWingHostAdapter {
  private rawContext: unknown;
  private failure: Error | null = null;
  readonly calls: Array<{ scopes: NovaWingMainlineScope[] }> = [];

  constructor(context: NovaWingMainlineContext) {
    this.rawContext = context;
  }

  get callCount(): number {
    return this.calls.length;
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  setContext(context: NovaWingMainlineContext): void {
    this.rawContext = context;
    this.failure = null;
  }

  /** Deliberately bypass the TypeScript contract to exercise runtime validation. */
  setRawContext(context: unknown): void {
    this.rawContext = context;
    this.failure = null;
  }

  setRevision(coreRevision: number): void {
    const current = this.rawContext as NovaWingMainlineContext;
    this.rawContext = { ...current, coreRevision };
    this.failure = null;
  }

  setUnavailable(error: Error = new Error('fake unavailable')): void {
    this.failure = error;
  }

  setOversizedContext(): void {
    this.setRawContext({
      coreRevision: 1,
      entries: Array.from({ length: 6 }, (_, index) => ({
        scope: index % 2 === 0 ? 'global' : 'career',
        key: `oversized-${index}`,
        value: 'x'.repeat(7_000),
      })),
    });
  }

  readLatestMainline(input: { scopes: readonly NovaWingMainlineScope[] }): NovaWingMainlineContext {
    this.calls.push({ scopes: [...input.scopes] });
    if (this.failure !== null) throw this.failure;
    return this.rawContext as NovaWingMainlineContext;
  }
}
