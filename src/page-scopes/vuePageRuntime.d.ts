import type { RuntimeTaskController } from 'vue-page-runtime';

declare module 'vue-page-scope' {
  interface PageScopeBase {
    readonly $task: RuntimeTaskController;
  }
}

export {};
