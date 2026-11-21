export type LinuxComputerCapabilityState = 'ready' | 'needs_setup' | 'unsupported' | 'unknown';
export interface LinuxComputerCapability {
  state: LinuxComputerCapabilityState;
  fix?: 'allow_input' | 'relogin' | 'enable_window_helper' | 'install_package';
  package?: string;
  optional?: boolean;
}
export type LinuxComputerCapabilityName =
  | 'capture'
  | 'windows'
  | 'accessibility'
  | 'semanticActions'
  | 'pointer'
  | 'keyboard'
  | 'clipboard'
  | 'ocr';
export interface LinuxComputerReadiness {
  session: 'wayland' | 'x11';
  desktop: 'gnome' | 'kde' | 'sway' | 'hyprland' | 'other';
  capabilities: Record<LinuxComputerCapabilityName, LinuxComputerCapability>;
}
export function detectSession(env: Record<string, string | undefined>): 'wayland' | 'x11';
export function detectDesktop(
  env: Record<string, string | undefined>,
  session: 'wayland' | 'x11'
): LinuxComputerReadiness['desktop'];
export function checkLinuxComputerReadiness(options?: Record<string, unknown>): Promise<LinuxComputerReadiness>;
export function getLinuxComputerReadiness(options?: Record<string, unknown>): Promise<LinuxComputerReadiness>;
