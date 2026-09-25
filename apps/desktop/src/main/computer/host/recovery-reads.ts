/** Only non-input discovery/diagnostics remain available during user control.
 * Captures, clipboard access and tools that may restore/focus windows stay gated. */
const RECOVERY_READ_ACTIONS = new Set(['list_windows', 'list_apps', 'list_history', 'diagnose']);

export function isComputerRecoveryRead(action: string): boolean {
  return RECOVERY_READ_ACTIONS.has(action);
}
