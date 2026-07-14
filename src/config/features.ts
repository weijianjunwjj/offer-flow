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
});
