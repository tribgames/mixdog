// The section reads live in shared/core-lanes/section-reads.ts (no Node module); this process supplies the machine's name.
import { hostname } from 'node:os';

import { notificationPreferencesState as notificationPreferencesStateOf, type OperationHost } from '../../shared/core-lanes/section-reads';

export * from '../../shared/core-lanes/section-reads';

export const DEFAULT_OPERATION_HOST: Pick<OperationHost, 'hostName'> = { hostName: hostname };

/** A PC that has set no remote-access name is shown by this machine's name. */
export const notificationPreferencesState = (
  snapshot: Parameters<typeof notificationPreferencesStateOf>[0],
  args: readonly unknown[],
  host: Partial<OperationHost>
) => notificationPreferencesStateOf(snapshot, args, { ...host, hostName: host.hostName ?? DEFAULT_OPERATION_HOST.hostName });
