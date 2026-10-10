import {
  useAppModuleWarmup,
  useAppSettingsPreload,
  useAppThemePreference,
  useStartupCommitMeasurement,
} from '../use-app-boot';

/** Startup-only side effects with no render output: lazy sidebar module
 *  warmup, first-commit timing, the settings preload and the theme. */
export function useAppFrameBootEffects(
  startupSettled: boolean,
  trackSidebarPanelModule: Parameters<typeof useAppModuleWarmup>[1]
) {
  useAppModuleWarmup(startupSettled, trackSidebarPanelModule);
  useStartupCommitMeasurement();
  useAppSettingsPreload();
  useAppThemePreference();
}
