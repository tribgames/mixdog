// The remote-access operations that need more than a member read of the `remote` section (desktop-services.md §2.2,
// §7): the section is `{info, settings, claims, clients, controllerKeys, owedKeys, pairCode, pushRegistered, disabled}`.
// Each answer is what Node's handler returned in the same state (recorded from the real service:
// protocol/fixtures/remote-info-node-states.json).
import type { DesktopSectionsSnapshot } from '../contract-sections';
import { remoteMember, remoteSection } from './section-reads';

/** `ProtocolConnection.call`, as the lane wraps it. */
export type CoreCall = (method: string, params: unknown) => Promise<unknown>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The whole `remote` value. A section over the inline limit is published as a stub and the held entry keeps
 *  `value = null` (protocol-client `SectionEntry`); its detail is paged with the section's list method,
 *  `remoteAccess/state` (desktop-services.md §2.2, "the client library pages the detail with the section's list
 *  method"). */
async function remoteValue(snapshot: DesktopSectionsSnapshot, call: CoreCall): Promise<Record<string, unknown>> {
  const value = remoteSection(snapshot);
  return record(value === null ? await call('remoteAccess/state', {}) : value);
}

/** A member of the `remote` section, paged in full when the section is a stub. */
export async function remotePagedMember(snapshot: DesktopSectionsSnapshot, name: string, call: CoreCall): Promise<unknown> {
  return remoteMember(await remoteValue(snapshot, call), name);
}

/** Node's `remote.descriptor()` from the section, by state (recorded from Node):
 *  - the user switched access off: `{relay: {clientUrl: '', token: '', clients}, enabled: false}`;
 *  - the relay leg is up and registered: `{relay: {clientUrl, token, clients}, enabled: true}` (no `connected`);
 *  - every other state (no leg yet, leg not answering, no relay URL, an install that never chose): `null`. */
export function remoteDescriptor(value: Record<string, unknown>): unknown {
  const info = remoteMember(value, 'info');
  if (info === null) return null;
  const { connected, ...descriptor } = record(info);
  if (descriptor.enabled === true) return connected === true ? descriptor : null;
  return remoteMember(value, 'disabled') === true ? descriptor : null;
}

/** Node: `remote.start(activate !== false)`, then `descriptor()`. The start that activates is `remoteAccess/activate`;
 *  it answers the section value as it stands afterwards. The core makes it a no-op while access is switched off, so
 *  it is not sent then, as Node's start returned before activating. */
export async function remoteAccessInfo(snapshot: DesktopSectionsSnapshot, args: readonly unknown[], call: CoreCall): Promise<unknown> {
  const held = await remoteValue(snapshot, call);
  const activate = args[0] !== false && remoteMember(held, 'disabled') !== true;
  if (activate) return remoteDescriptor(record(await call('remoteAccess/activate', {})));
  // Node's descriptor asked the relay for its clients on every ask, so a listing that failed earlier was retried by this
  // one. The leg is up but has not answered a listing: ask the core to list now (`remoteAccess/state`).
  const info = record(remoteMember(held, 'info'));
  return remoteDescriptor(info.enabled === true && info.connected !== true ? record(await call('remoteAccess/state', {})) : held);
}