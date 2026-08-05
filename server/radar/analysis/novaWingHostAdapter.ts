/**
 * OfferFlow-owned read-only boundary for future NovaWing integration.
 *
 * This contract deliberately exposes only the small projection required to freeze Radar analysis
 * inputs. It has no database, repository, lifecycle, proposal, approval, or write semantics.
 * The current AnalysisService snapshot path is synchronous, so the minimum host contract is also
 * synchronous; a future adapter must map its implementation onto this stable boundary.
 */
export const NOVA_WING_ANALYSIS_SCOPES = ['global', 'career'] as const;

export type NovaWingMainlineScope = (typeof NOVA_WING_ANALYSIS_SCOPES)[number];

export interface NovaWingMainlineEntryProjection {
  scope: NovaWingMainlineScope;
  key: string;
  value: unknown;
}

export interface NovaWingMainlineContext {
  coreRevision: number;
  entries: readonly NovaWingMainlineEntryProjection[];
}

export interface NovaWingHostAdapter {
  readLatestMainline(input: {
    scopes: readonly NovaWingMainlineScope[];
  }): NovaWingMainlineContext;
}
