/**
 * `host/computer/internalWindows`: the desktop's own Computer Use windows (cursor overlay, pill, screen indicator), which the
 * core leaves out of every window list (`computer/overlay/internal-windows.ts`).
 */
import type { HostComputerInternalWindowsResult } from '../../../../../packages/protocol/src/index.ts';
import { listComputerUseInternalWindowIds } from '../computer/overlay/internal-windows';
import type { HostConnection } from './connection';

export const HOST_COMPUTER_INTERNAL_WINDOWS = 'host/computer/internalWindows';

export function computerInternalWindows(): HostComputerInternalWindowsResult {
  return { windowIds: listComputerUseInternalWindowIds() };
}

export function registerComputerInternalWindows(connection: HostConnection): void {
  connection.handleRequest(HOST_COMPUTER_INTERNAL_WINDOWS, async () => computerInternalWindows());
}
