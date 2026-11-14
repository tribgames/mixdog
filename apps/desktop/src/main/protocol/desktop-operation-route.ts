import {
  createOperationLane as createSharedOperationLane,
  type OperationLane,
} from '../../shared/core-lanes/desktop-operation-route';
import type { OperationHost } from '../../shared/core-lanes/section-reads';
import { DEFAULT_OPERATION_HOST } from './section-reads';

export * from '../../shared/core-lanes/desktop-operation-route';

type SharedOptions = Parameters<typeof createSharedOperationLane>[0];

/** The lane for this process: the shared lane is told the OS and the machine name it runs on (it reads no process of its own). */
export function createOperationLane({
  protocol,
  host,
  platform = process.platform as SharedOptions['platform'],
}: Pick<SharedOptions, 'protocol'> & { host?: Partial<OperationHost>; platform?: SharedOptions['platform'] }): OperationLane {
  return createSharedOperationLane({
    protocol,
    platform,
    host: { ...host, hostName: host?.hostName ?? DEFAULT_OPERATION_HOST.hostName },
  });
}
