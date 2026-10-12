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

export interface DesktopComputerInputAccess {
  ok: boolean;
  reason?: string;
}

export type DesktopComputerPermissionPane = 'screen' | 'accessibility';
