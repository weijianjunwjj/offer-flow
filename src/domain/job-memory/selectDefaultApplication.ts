import type { ApplicationWithProjection } from './types';

function compareDescending(
  left: ApplicationWithProjection,
  right: ApplicationWithProjection,
): number {
  const leftMeaningful = left.projection.lastMeaningfulEventAt ?? Number.NEGATIVE_INFINITY;
  const rightMeaningful = right.projection.lastMeaningfulEventAt ?? Number.NEGATIVE_INFINITY;
  return rightMeaningful - leftMeaningful
    || right.application.createdAt - left.application.createdAt
    || right.application.id.localeCompare(left.application.id);
}

export function selectDefaultApplication(
  candidates: readonly ApplicationWithProjection[],
): ApplicationWithProjection | null {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.application.voidedAt === null
      && !candidate.projection.isVoided
      && candidate.projection.projectionStatus !== 'invalid',
  );
  if (eligible.length === 0) return null;
  const active = eligible.filter((candidate) => !candidate.projection.isClosed);
  return [...(active.length > 0 ? active : eligible)].sort(compareDescending)[0] ?? null;
}
