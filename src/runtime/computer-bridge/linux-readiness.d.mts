export type LinuxComputerCapabilityState = 'ready' | 'needs_setup' | 'unsupported' | 'unknown';
export interface LinuxComputerCapability {
  state: LinuxComputerCapabilityState;
  fix?: 'allow_input' | 'install_window_helper' | 'install_package';
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
export const CAPABILITY_UNAVAILABLE_CODE: 'computer_capability_unavailable';
export function detectSession(env: Record<string, string | undefined>): 'wayland' | 'x11';
export function checkLinuxComputerReadiness(options?: Record<string, unknown>): Promise<LinuxComputerReadiness>;
export function getLinuxComputerReadiness(options?: Record<string, unknown>): Promise<LinuxComputerReadiness>;
export function missingCapabilities(
  readiness: LinuxComputerReadiness,
  command: Record<string, unknown>
): LinuxComputerMissingCapability[];
export function linuxComputerPreflight(options?: Record<string, unknown>): Promise<LinuxComputerRefusal | null>;
export function resetLinuxComputerPreflightCache(): void;export const FIX_MESSAGES: Readonly<Record<'allow_input' | 'install_window_helper' | 'install_package', string>>;
export const REFUSAL_MESSAGE: string;
