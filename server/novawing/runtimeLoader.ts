import type { NovaWingHostAdapter } from '../radar/analysis/novaWingHostAdapter';
import { runtimeInitializationFailed } from './errors';
import type { NovaWingRuntimeHandle } from './runtimeTypes';

export type { NovaWingRuntimeHandle } from './runtimeTypes';

interface NovaWingInfrastructureModule {
  createNovaWingRuntime(options: { databasePath: string }): NovaWingRuntimeHandle;
}

export interface LoadNovaWingRuntimeOptions {
  enabled: boolean;
  databasePath: string;
  injectedAdapter?: NovaWingHostAdapter;
}

export interface LoadedNovaWingRuntime {
  adapter: NovaWingHostAdapter | undefined;
  ownedRuntime: NovaWingRuntimeHandle | undefined;
}

type InfrastructureLoader = () => Promise<NovaWingInfrastructureModule>;

const loadInfrastructure: InfrastructureLoader = async () => import('./infrastructure');

/** Feature-off and injected-fake paths return before the real runtime module is loaded. */
export async function loadNovaWingRuntime(
  options: LoadNovaWingRuntimeOptions,
  loader: InfrastructureLoader = loadInfrastructure,
): Promise<LoadedNovaWingRuntime> {
  if (!options.enabled) {
    return { adapter: options.injectedAdapter, ownedRuntime: undefined };
  }
  if (options.injectedAdapter !== undefined) {
    return { adapter: options.injectedAdapter, ownedRuntime: undefined };
  }
  try {
    const infrastructure = await loader();
    const ownedRuntime = infrastructure.createNovaWingRuntime({
      databasePath: options.databasePath,
    });
    return { adapter: ownedRuntime.adapter, ownedRuntime };
  } catch {
    throw runtimeInitializationFailed();
  }
}
