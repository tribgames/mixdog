import type { DesktopSectionsSnapshot } from '../contract-sections';
import { record, remoteMember, remoteSection } from './section-reads';

/** `ProtocolConnection.call`, as the lane wraps it. */
export type CoreCall = (method: string, params: unknown) => Promise<unknown>;

/** The whole `remote` value. A section over the inline limit is published as a stub (`value = null`); its detail is
 *  paged with `remoteAccess/state`. */
async function remoteValue(snapshot: DesktopSectionsSnapshot, call: CoreCall): Promise<Record<string, unknown>> {
  const value = remoteSection(snapshot);
  return record(value === null ? await call('remoteAccess/state', {}) : value);
}

/** A member of the `remote` section, paged in full when the section is a stub. */
export async function remotePagedMember(
  snapshot: DesktopSectionsSnapshot,
  name: string,
  call: CoreCall
): Promise<unknown> {
  return remoteMember(await remoteValue(snapshot, call), name);
}

/** The remote descriptor from the section, by state:
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

/** Starts remote access unless `activate` is false, then answers the descriptor. The start that activates is
 *  `remoteAccess/activate`; it answers the section value as it stands afterwards. The core makes it a no-op while
 *  access is switched off, so it is not sent then. */
export async function remoteAccessInfo(
  snapshot: DesktopSectionsSnapshot,
  args: readonly unknown[],
  call: CoreCall
): Promise<unknown> {
  const held = await remoteValue(snapshot, call);
  const activate = args[0] !== false && remoteMember(held, 'disabled') !== true;
  if (activate) return remoteDescriptor(record(await call('remoteAccess/activate', {})));
  // Every ask retries a client listing that failed earlier. The leg is up but has not answered a listing: ask the core
  // to list now (`remoteAccess/state`).
  const info = record(remoteMember(held, 'info'));
  return remoteDescriptor(
    info.enabled === true && info.connected !== true ? record(await call('remoteAccess/state', {})) : held
  );
}
