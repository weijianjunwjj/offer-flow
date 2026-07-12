import { registerPlugin } from 'vue-page-scope';
import taskPlugin from 'vue-page-runtime';

let registered = import.meta.hot?.data?.pageRuntimeRegistered === true;

export function registerPageRuntime(): boolean {
  if (registered) return false;
  registerPlugin(taskPlugin);
  registered = true;
  if (import.meta.hot?.data) import.meta.hot.data.pageRuntimeRegistered = true;
  return true;
}

registerPageRuntime();
