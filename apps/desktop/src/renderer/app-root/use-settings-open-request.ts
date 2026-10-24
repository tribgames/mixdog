import { subscribeDrawerDismiss } from '../drawer-intent';
import { type OpenRequestModule, useModuleOpenRequest } from '../use-module-open-request';

/** "Open Settings" taps against a settings module that may still be loading
 *  (useModuleOpenRequest): the newest tap's destination opens once the module
 *  settles, unless the drawer is asked to close first (at that request, not
 *  at the later commit of the closed state), Settings opens by another route,
 *  or `cancel` reports another navigation. */
export function useSettingsOpenRequest({
  module,
  waits,
  settingsOpen,
}: {
  module: OpenRequestModule;
  /** False when there is no module to wait for. */
  waits(): boolean;
  settingsOpen: boolean;
}) {
  return useModuleOpenRequest({ module, waits, opened: settingsOpen, subscribeDismiss: subscribeDrawerDismiss });
}
