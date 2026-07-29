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
  // G5 隔离验收环境（dev:g5-sandbox）专用标记：求职策略页面仅在该沙箱环境下可见，
  // 真实生产入口不启用 G5，因此该标记默认关闭。
  g5SandboxEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_G5_SANDBOX,
    false,
  ),
  // G6 生产迁移演练环境（dev:g6-rehearsal）专用标记：正式启用 G1~G5 路由，
  // 但只显示一条 G6 演练横幅（不显示 G4/G5 沙箱双横幅）。数据来自真实库副本 + 晋升包，
  // 不连接真实数据库。真实生产入口不启用，默认关闭。
  g6RehearsalEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_G6_REHEARSAL,
    false,
  ),
  // G6-B 生产切换后，真实库已升级到 schema v6 并导入 G4/G5 正式版本，
  // 市场位置画像（G4）与求职策略（G5）正式在真实入口开启；仍可通过环境变量显式关闭。
  marketPositionEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_MARKET_POSITION,
    true,
  ),
  strategyWindowEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_STRATEGY_WINDOW,
    true,
  ),
  // V8-2 岗位雷达当前页采集桥：真实生产入口默认不启用（需要 schema v7 且未经批准不得
  // 升级真实库），仅在显式注入 v7 库的开发/测试场景中通过环境变量开启。
  radarEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_RADAR,
    false,
  ),
  // V8-4 单岗位分析面板：独立于 radarEnabled 的门禁，默认关闭；不因 Radar 开启而自动开启，
  // 真实生产入口保持关闭，仅在显式设置 VITE_OFFERFLOW_RADAR_ANALYSIS=true 或测试注入时启用。
  radarAnalysisEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_RADAR_ANALYSIS,
    false,
  ),
  // V8-5 岗位建议批次面板：独立于 radar / radarAnalysis 的门禁，默认关闭；不因其它能力开启而自动开启，
  // 真实生产入口保持关闭，仅在显式设置 VITE_OFFERFLOW_RADAR_RECOMMENDATIONS=true 或测试注入时启用。
  radarRecommendationsEnabled: readBooleanFeatureFlag(
    import.meta.env.VITE_OFFERFLOW_RADAR_RECOMMENDATIONS,
    false,
  ),
});
