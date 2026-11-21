import { subscribeDrawerDismiss } from '../drawer-intent';
import { type OpenRequestModule, useModuleOpenRequest } from '../use-module-open-request';

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
