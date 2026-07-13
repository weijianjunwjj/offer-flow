export function readBooleanFeatureFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export const features = Object.freeze({
  // Runtime Gate 1 已通过；保留 direct loader 作为短期回滚路径。
  runtimeJobBundleEnabled: true,
  // B3 只允许专用临时联调入口显式开启；默认构建和生产入口保持关闭。
  resumeVersionManagementEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_RESUME_VERSION_MANAGEMENT,
  ),
});
