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
  // G3 交接文档明确要求本轮真实生产库禁止升级到 schema v4，
  // 真实入口暂未开启 historyImport 能力，因此前端导航默认不显式暴露该入口，
  // 仅在显式打开该环境变量的测试 / 预发环境中可见。
  historyImportEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_HISTORY_IMPORT,
    false,
  ),
  // G3 隔离验收环境（dev:g3-sandbox）专用标记：仅用于显示不可关闭的提示横幅，
  // 不改变 historyImportEnabled 之外任何其它默认行为。
  g3SandboxEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_G3_SANDBOX,
    false,
  ),
});
