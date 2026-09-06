/** Only non-input discovery/diagnostics remain available during user control.
 * Captures, clipboard access and tools that may restore/focus windows stay gated. */
export function isComputerRecoveryRead(action: string): boolean {
  return action === 'list_windows' || action === 'list_apps' || action === 'diagnose';
}
