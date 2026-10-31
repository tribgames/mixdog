import { SETTINGS_CHANGED_EVENT } from '../shared/settings-changed';
import type { MixdogConfigModule } from './settings-store';

/** Publish a settings-changed event with the `agent` scope whenever a persisted
 *  change alters anything outside the desktop section (agent settings, output
 *  style, memory, channels…) or a stored key, whoever wrote it: the setup tool,
 *  a `/` command, the TUI, another process or a hand edit. Open settings pages
 *  in the window, on paired phones and the host's reused read caches follow.
 *  The desktop section has its own owners and scope. Returns the unsubscribe
 *  (undefined on a config layer without change events). */
export function watchAgentSettings(
  config: Pick<MixdogConfigModule, 'readConfig' | 'subscribeConfigChange' | 'secretChangeTokens'>,
  publish: (name: string, value: unknown) => void
): (() => void) | undefined {
  const snapshot = (): string => {
    const root = config.readConfig();
    const { desktop: _desktop, ...rest } =
      root && typeof root === 'object' && !Array.isArray(root) ? (root as Record<string, unknown>) : {};
    return JSON.stringify([rest, config.secretChangeTokens?.() ?? {}]);
  };
  let known = snapshot();
  return config.subscribeConfigChange?.(() => {
    const next = snapshot();
    if (next === known) return;
    known = next;
    publish(SETTINGS_CHANGED_EVENT, { scope: 'agent' });
  });
}
