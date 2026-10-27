// The local rollout switch of the direct phone↔PC transport (docs/
// remote-transport.md §6): the developer option "Direct phone connection
// (test)", stored by the runtime at agent config `developer.directPhoneConnection`
// (src/runtime/shared/developer-options.mjs). Off unless that value is the
// boolean true; a missing, unreadable or malformed config means off.
//
// The daemon reads it ONCE, when the desktop service starts: it decides
// whether the peer service exists (desktop-service.ts) and so whether the
// E2EE challenge offers `transportWebrtc` at all. A change therefore applies
// after Mixdog restarts. The desktop app does not read it: it attaches to
// whatever the daemon answers (peer-link.ts).

/** The runtime's developer option id. */
export const DIRECT_PHONE_CONNECTION_OPTION = 'directPhoneConnection';

/** The runtime's config module, as `runtime.loadConfig()` returns it. */
interface TransportSwitchConfigModule {
  readConfig(): unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Whether a whole mixdog config has the option stored as boolean true. */
export function directPhoneConnectionStored(config: unknown): boolean {
  return record(record(record(config).agent).developer)[DIRECT_PHONE_CONNECTION_OPTION] === true;
}

/** The switch, read from the stored config; any failure means off. */
export async function readDirectPhoneConnection(
  loadConfig: () => Promise<TransportSwitchConfigModule>
): Promise<boolean> {
  try {
    return directPhoneConnectionStored((await loadConfig()).readConfig());
  } catch {
    return false;
  }
}
