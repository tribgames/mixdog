// Computer Use readiness: what the OS still needs before every capability runs.

export type DesktopComputerCapabilityState = 'ready' | 'needs_setup' | 'unsupported' | 'unknown';

export interface DesktopComputerCapability {
  state: DesktopComputerCapabilityState;
  fix?: 'allow_input' | 'relogin' | 'enable_window_helper' | 'install_package';
  package?: string;
  optional?: boolean;
}

export type DesktopComputerCapabilityName =
  | 'capture'
  | 'windows'
  | 'accessibility'
  | 'semanticActions'
  | 'pointer'
  | 'keyboard'
  | 'clipboard'
  | 'ocr';

export interface DesktopLinuxComputerReadiness {
  session: 'wayland' | 'x11';
  desktop: 'gnome' | 'kde' | 'sway' | 'hyprland' | 'other';
  capabilities: Record<DesktopComputerCapabilityName, DesktopComputerCapability>;
}

/** The OS grants Computer Use runs under, as the main process reads them.
 *  `linux` is present on Linux only; macOS reports TCC statuses
 *  ('granted' | 'denied' | 'not-determined' | 'restricted'). */
export interface DesktopComputerReadiness {
  platform: string;
  screen_capture: string;
  accessibility: string;
  input: string;
  linux?: DesktopLinuxComputerReadiness;
}

/** Linux, non-.deb installs: one polkit prompt installs the /dev/uinput access rule. */
export type DesktopComputerInputAccess =
  | { ok: true }
  // `access_unavailable` = repair ran but /dev/uinput is still not writable; `detail` and `exitCode` let the UI pick a translated line.
  // `message` is English, for logs/diagnostics only.
  | {
      ok: false;
      reason: 'cancelled' | 'pkexec_missing' | 'failed' | 'access_unavailable';
      detail?: 'relogin' | 'no-module';
      exitCode?: number;
      message?: string;
    };

export type DesktopComputerPermissionPane = 'screen' | 'accessibility';
