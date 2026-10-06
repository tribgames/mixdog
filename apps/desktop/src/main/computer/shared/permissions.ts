/**
 * The operating-system grants Computer Use runs under. Windows needs none:
 * capture and input are bounded by window integrity instead. macOS gates
 * pixels behind Screen Recording and input plus the accessibility tree behind
 * Accessibility, and both are granted to the app, outside Mixdog's control.
 */
export interface ComputerPermissions {
  screen_capture: string;
  accessibility: string;
  input: string;
}

const MACOS_GRANT_REQUIRED = new Set(['not-determined', 'denied', 'restricted']);

export const SCREEN_RECORDING_GUIDANCE =
  'macOS Screen Recording is not granted to Mixdog; allow Mixdog in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen Mixdog (a grant made while Mixdog runs applies only after it restarts)';

export const ACCESSIBILITY_GUIDANCE =
  'macOS Accessibility is not granted to Mixdog; allow Mixdog in System Settings > Privacy & Security > Accessibility';

/** True when macOS reports that this process may not read screen pixels. */
export function screenCaptureBlocked(permissions: ComputerPermissions): boolean {
  return MACOS_GRANT_REQUIRED.has(permissions.screen_capture);
}

/** True when macOS reports that this process may not drive input or read the
 *  accessibility tree. */
export function accessibilityBlocked(permissions: ComputerPermissions): boolean {
  return MACOS_GRANT_REQUIRED.has(permissions.accessibility);
}
