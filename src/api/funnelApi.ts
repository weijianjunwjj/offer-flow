import type { FunnelQuery, FunnelResult } from '../domain/funnel';
import { apiGet, type ReadOptions } from './client';

function toQueryString(query: FunnelQuery): string {
  const params = new URLSearchParams();
  if (query.city) params.set('city', query.city);
  if (query.jobFamily) params.set('jobFamily', query.jobFamily);
  if (query.channel) params.set('channel', query.channel);
  if (query.resumeVersionId) params.set('resumeVersionId', query.resumeVersionId);
  if (query.from !== undefined && query.from !== null) params.set('from', String(query.from));
  if (query.to !== undefined && query.to !== null) params.set('to', String(query.to));
  if (query.timeGranularity && query.timeGranularity !== 'none') {
    params.set('timeGranularity', query.timeGranularity);
  }
  if (query.groupBy && query.groupBy !== 'none') {
    params.set('groupBy', query.groupBy);
  }
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

export const funnelApi = {
  async get(query: FunnelQuery = {}, options?: ReadOptions): Promise<FunnelResult> {
    return apiGet<FunnelResult>(`/funnel${toQueryString(query)}`, options);
  },
};
