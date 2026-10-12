/** The operating-system grants as this process holds them right now. */
import { desktopCapturer, systemPreferences } from 'electron';
import { getLinuxComputerReadiness } from '../../../../../../src/runtime/computer-bridge/linux-readiness.mjs';
import { linuxComputerPermissions, type ComputerPermissions } from '../shared/permissions';

export function readComputerPermissions(): ComputerPermissions | Promise<ComputerPermissions> {
  if (process.platform === 'win32') {
    return {
      screen_capture: 'not_required_on_windows',
      accessibility: 'not_required_on_windows',
      input: 'target_integrity_dependent',
    };
  }
  if (process.platform === 'darwin') {
    return {
      screen_capture: systemPreferences.getMediaAccessStatus('screen'),
      accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
      input: 'accessibility_dependent',
    };
  }
  // Linux has no OS grant to read: capabilities are probed, never prompting.
  return getLinuxComputerReadiness().then(linuxComputerPermissions);
}

/** macOS shows its own Accessibility and Screen Recording prompts the first
 *  time an app asks; a grant already given or refused shows nothing. */
export function requestComputerPermissions(): void {
  if (process.platform !== 'darwin') return;
  systemPreferences.isTrustedAccessibilityClient(true);
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return;
  void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined);
}
