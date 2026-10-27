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
export interface LinuxComputerMissingCapability {
  capability: LinuxComputerCapabilityName;
  state: LinuxComputerCapabilityState;
  fix?: LinuxComputerCapability['fix'];
  package?: string;
  code: string;
  message: string;
}
export interface LinuxComputerRefusal {
  code: 'computer_capability_unavailable';
  missing: LinuxComputerMissingCapability[];
  message: string;
}
export const MIN_WINDOW_HELPER_VERSION: number;
export const CAPABILITY_UNAVAILABLE_CODE: 'computer_capability_unavailable';
export function detectSession(env: Record<string, string | undefined>): 'wayland' | 'x11';
export function detectDesktop(
  env: Record<string, string | undefined>,
  session: 'wayland' | 'x11'
): LinuxComputerReadiness['desktop'];
export function checkLinuxComputerReadiness(options?: Record<string, unknown>): Promise<LinuxComputerReadiness>;
export function getLinuxComputerReadiness(options?: Record<string, unknown>): Promise<LinuxComputerReadiness>;
export function missingCapabilities(
  readiness: LinuxComputerReadiness,
  command: Record<string, unknown>
): LinuxComputerMissingCapability[];
export function linuxComputerPreflight(options?: Record<string, unknown>): Promise<LinuxComputerRefusal | null>;
export function resetLinuxComputerPreflightCache(): void;
export const GNOME_EXTENSION_UUID: 'mixdog-windows@mixdog.io';
export function gnomeExtensionDirs(env?: Record<string, string | undefined>): string[];
export const CAPTURE_FALLBACK_NOTE: string;
export function linuxCaptureFallback(
  options?: Record<string, unknown>
): Promise<{ command: Record<string, unknown>; note: string } | null>;
