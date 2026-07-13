/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OFFERFLOW_JOB_MEMORY_V2?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
