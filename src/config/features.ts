export function readBooleanFeatureFlag(
  value: string | undefined,
  defaultValue = false,
): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  return value.trim().toLowerCase() === 'true';
}

export const features = Object.freeze({
  // Runtime Gate 1 已通过；保留 direct loader 作为短期回滚路径。
  runtimeJobBundleEnabled: true,
  // B7-B 后生产默认启用；测试和兼容入口仍可显式传 false。
  jobMemoryV2Enabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_JOB_MEMORY_V2,
    true,
  ),
  // 真实生产库已通过显式授权命令（db:upgrade-real --confirm）升级到 schema v4，
  // 历史补录能力正式在真实入口开启；仍可通过环境变量显式关闭。
  historyImportEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_HISTORY_IMPORT,
    true,
  ),
  // G3 隔离验收环境（dev:g3-sandbox）专用标记：仅用于显示不可关闭的提示横幅，
  // 不改变 historyImportEnabled 之外任何其它默认行为。
  g3SandboxEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_G3_SANDBOX,
    false,
  ),
  // G4 隔离验收环境（dev:g4-sandbox）专用标记：市场位置画像仅在该沙箱环境下可见，
  // 真实生产入口不启用 G4，因此该标记默认关闭。
  g4SandboxEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_G4_SANDBOX,
    false,
  ),
});
