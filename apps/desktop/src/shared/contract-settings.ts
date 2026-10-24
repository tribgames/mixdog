// Code Tidy engine status and desktop settings.

/** Where a Code Tidy engine comes from: a managed download under the tools
 *  dir, a binary the host already provides (PATH/project), or nothing yet. */
export type DesktopTidyEngineSource = 'managed' | 'host' | 'missing';

export interface DesktopTidyEngine {
  id: string;
  /** Display name, e.g. "Biome", "ShellCheck", "PSScriptAnalyzer". */
  title: string;
  languages: string[];
  /** 'format' and/or 'lint'. */
  kind: string[];
  /** Resolved version, '' when unknown or missing. */
  version: string;
  source: DesktopTidyEngineSource;
  /** Tidy can download this engine into the managed tools dir. */
  managed: boolean;
  /** Part of the set the built-in Install provisions. */
  core: boolean;
  /** Ships with a language toolchain; tidy never downloads it. */
  toolchain: boolean;
  /** On-disk size of the installed managed version; absent for host engines. */
  bytes?: number;
  /** How the user can provide a missing engine themselves. */
  installHint?: string;
  /** Missing core engine that the Install/Retry control can download now. */
  installable?: boolean;
  /** Host-module engine whose probe has not answered yet: neither installed
   *  nor known to be missing. */
  probing?: boolean;
}

export type DesktopTidyInstallEngineStatus = 'pending' | 'downloading' | 'installed' | 'present' | 'skipped' | 'failed';

export interface DesktopTidyInstallEngine {
  id: string;
  status: DesktopTidyInstallEngineStatus;
  /** Live download bytes; totalBytes is 0 until the server advertises it. */
  receivedBytes: number;
  totalBytes: number;
  version: string;
  /** On-disk size once installed. */
  bytes: number;
  error?: string;
  installHint?: string;
}

/** One in-memory install job. `active` is false once it finished; the engines
 *  then carry the per-engine outcome the card reports. */
export interface DesktopTidyInstallStatus {
  active: boolean;
  /** 0-99 while running, 100 when finished. */
  percent: number;
  startedAt: number;
  updatedAt: number;
  engines: DesktopTidyInstallEngine[];
}

export interface DesktopTidyEngineStatus {
  /** Managed engine root, `<pluginData>/tools`. */
  toolsDir: string;
  /** Engine ids the built-in Install provisions. */
  core: string[];
  engines: DesktopTidyEngine[];
  /** Some engine's host probe is still pending; ask again shortly. */
  probing?: boolean;
  /** Null until this runtime has run an install. */
  installing: DesktopTidyInstallStatus | null;
}

export const NOTIFICATION_VOLUME_DEFAULT = 100;
export const NOTIFICATION_VOLUME_MAX = 400;

export type DesktopSettingKey =
  | 'autoClear'
  | 'autoCompact'
  | 'keepAwake'
  | 'runInBackground'
  | 'usagePinned'
  | 'usageRailShortLong'
  | 'usageAccountsExpanded'
  | 'usageRailSlotsThree'
  | 'usageRailSlotsAll'
  | 'computerControl'
  | 'computerObserveOnly'
  | 'browserControl'
  | 'browserAutoSignIn'
  | 'computerInstalled'
  | 'browserInstalled';

export interface DesktopSettings {
  autoClear: boolean;
  autoCompact: boolean;
  /** Desktop-only: hold a power-save blocker while agents are working. */
  keepAwake: boolean;
  /** Desktop-only: closing the window hides it (tray on Windows/Linux, Dock
   *  on macOS) instead of quitting, so the in-app hosts keep serving. */
  runInBackground: boolean;
  /** Desktop-only (Windows): notification sound volume in percent,
   *  0..NOTIFICATION_VOLUME_MAX. Default NOTIFICATION_VOLUME_DEFAULT. */
  notificationVolume: number;
  /** Activity-rail usage pin mode, shared by desktop and remote surfaces. */
  usagePinned: boolean;
  /** Pinned rail bars: false = the longest period only, true = the shortest
   *  plus the longest period as two bars (default). */
  usageRailShortLong: boolean;
  /** Usage panel and rail show every account of a multi-account provider. */
  usageAccountsExpanded: boolean;
  /** Rail slot limit with expanded accounts: three on, else five; All overrides. */
  usageRailSlotsThree: boolean;
  usageRailSlotsAll: boolean;
  /** Opt-in: expose the agent `computer` tool that controls the local desktop
   *  (Windows). Default off — full-PC control is high risk. */
  computerControl: boolean;
  /** Computer Use observes only: screen, UI, and clipboard reads stay
   *  available while every input action is refused. Default off. */
  computerObserveOnly: boolean;
  /** Opt-in: expose the agent `browser` tool over the in-app browser bridge.
   *  Default off; the browser pane itself stays available either way. */
  browserControl: boolean;
  /** Browser Use signs in by itself with a saved login for the page's exact
   *  origin (once per site per turn; 2FA/CAPTCHA go to the user). Default on. */
  browserAutoSignIn: boolean;
  /** Extensions → Built-in install markers: the card presents Install first
   *  and only shows its toggle after activation. A profile that already had
   *  the control on is treated as installed (grandfathered). */
  computerInstalled: boolean;
  browserInstalled: boolean;
}
