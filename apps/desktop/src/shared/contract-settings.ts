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
  /** Null until this runtime has run an install. */
  installing: DesktopTidyInstallStatus | null;
}

export type DesktopSettingKey =
  | 'autoClear'
  | 'autoCompact'
  | 'keepAwake'
  | 'usagePinned'
  | 'computerControl'
  | 'computerObserveOnly'
  | 'browserControl'
  | 'computerInstalled'
  | 'browserInstalled';

export interface DesktopSettings {
  autoClear: boolean;
  autoCompact: boolean;
  /** Desktop-only: hold a power-save blocker while agents are working. */
  keepAwake: boolean;
  /** Activity-rail usage pin mode, shared by desktop and remote surfaces. */
  usagePinned: boolean;
  /** Opt-in: expose the agent `computer` tool that controls the local desktop
   *  (Windows). Default off — full-PC control is high risk. */
  computerControl: boolean;
  /** Computer Use observes only: screen, UI, and clipboard reads stay
   *  available while every input action is refused. Default off. */
  computerObserveOnly: boolean;
  /** Opt-in: expose the agent `browser` tool over the in-app browser bridge.
   *  Default off; the browser pane itself stays available either way. */
  browserControl: boolean;
  /** Extensions → Built-in install markers: the card presents Install first
   *  and only shows its toggle after activation. A profile that already had
   *  the control on is treated as installed (grandfathered). */
  computerInstalled: boolean;
  browserInstalled: boolean;
}
