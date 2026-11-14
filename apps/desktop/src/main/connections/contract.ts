// The connection contract: one desktop process holds this PC's daemon plus a service connection for each server window
// it shows; the ssh sessions themselves are the core's.
import type { DesktopConnectionIdentity } from '../../shared/contract';

export type ConnectionKind = DesktopConnectionIdentity['kind'];

/** This PC's daemon: always open, never closed through the pool. */
export const LOCAL_CONNECTION_ID = 'local';

export type ConnectionIdentity = DesktopConnectionIdentity;
