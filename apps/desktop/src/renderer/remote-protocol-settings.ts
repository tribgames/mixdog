// The phone's activity rail pins (audit PH-2 "Settings": `readActivityRailPins`, `updateActivityRailPins`) and their push, over the
// protocol. Node (b6f10295a) kept the pins in the config's `desktop.activityRailPins` (settings-store.ts:268-291) and sent every paired
// phone the saved `{pins, revision}` as `activity-rail-pins-changed` after each update, whoever made it (desktop-operations.ts:425-431,
// remote-relay-push-lanes.ts:50-62); a phone that connected later was sent nothing and read the pins when it mounted. The core keeps
// the same value in the `desktop` subtree of its `config` section: a read is that section's held value, an update is one
// `config/value/write`, and the push is the section's next revision with a pins revision the page has not been told.
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { normalizeActivityRailPins, storedPinsState, type ActivityRailPinsState } from '../shared/activity-rail-pins';
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The held pins (Node's `readActivityRailPins`: null until some client saved them). */
const heldPins = (client: Client): ActivityRailPinsState | null =>
  storedPinsState(record(client.store.section('config', 'desktop')?.value).activityRailPins);

/** Node's phone read a refused call as an `Error` carrying the host's text (remote-shim-dispatch.ts:165-178). */
const refused = (text: string): Error => new Error(text);

async function updatePins(pins: unknown, host: PhoneProtocolHost): Promise<ActivityRailPinsState> {
  // settings-store.ts:274-275: the list is checked before anything is written.
  if (!normalizeActivityRailPins(pins)) throw refused('Activity rail pins must be an array of supported destinations.');
  const reply = record(await host.client().call('config/value/write', { path: 'desktop.activityRailPins', value: pins } as never));
  const values = reply.values;
  const state = storedPinsState(Array.isArray(values) ? values[0] : undefined);
  if (!state) throw refused('The config write did not return valid activity rail pins.');
  return state;
}

/** Tells the page each pins revision the connected client hears live; what a connection's snapshot holds is not announced. */
function followPins(host: PhoneProtocolHost, client: Client): () => void {
  let told = heldPins(client)?.revision ?? 0;
  return client.store.subscribe((change) => {
    // A snapshot announces every section it holds (`store.owed` is set while it does): it is where the pins stand, not a change.
    if (change.type === 'appSnapshot') told = heldPins(client)?.revision ?? 0;
    if (change.type !== 'section' || change.section !== 'config' || change.key !== 'desktop' || client.store.owed) return;
    const state = heldPins(client);
    if (!state || state.revision === told) return;
    told = state.revision;
    host.ctx.fanOut(host.ctx.activityRailPinsListeners, state);
  });
}

export const adapter: PhoneProtocolAdapter = {
  group: 'settings',
  calls: {
    readActivityRailPins: (_params, host) => heldPins(host.client()),
    // remote-methods.ts:915: a phone's update never initializes; only its first argument reaches the store.
    updateActivityRailPins: ([pins], host) => updatePins(pins, host),
  },
  install(host) {
    let off: (() => void) | undefined;
    const stop = host.onClient?.((client) => {
      off?.();
      off = followPins(host, client);
    });
    return () => {
      stop?.();
      off?.();
    };
  },
};
