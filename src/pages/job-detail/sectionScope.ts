import { injectJobDetailScope, type JobDetailScope } from '../../page-scopes/jobDetailScope';

export function useInjectedDetailScope(required: boolean): JobDetailScope | null {
  if (!required) return null;
  const scope = injectJobDetailScope();
  if (scope === null) throw new Error('岗位详情 Section 必须由 JobDetailPage Scope owner 提供');
  return scope;
}
