/**
 * `host/computer/permissions`: the operating-system grants this process holds, read for the core (which cannot see them).
 * `request` first lets macOS show its own Accessibility and Screen Recording prompts (`requestComputerPermissions`); absent
 * or false only reads. The reads reach Electron, which this module does not, so the process that owns it hands them in.
 */
import type {
  HostComputerPermissionsParams,
  HostComputerPermissionsResult,
} from '../../../../../packages/protocol/src/index.ts';
import type { ComputerPermissions } from '../computer/shared/permissions';
import { HOST_INVALID_PARAMS, HostRpcError, type HostConnection, objectParams } from './connection';

export const HOST_COMPUTER_PERMISSIONS = 'host/computer/permissions';

export interface ComputerPermissionReads {
  /** `readComputerPermissions`. */
  read(): ComputerPermissions | Promise<ComputerPermissions>;
  /** `requestComputerPermissions`. */
  request(): void;
}

export function registerComputerPermissions(connection: HostConnection, reads: ComputerPermissionReads): void {
  connection.handleRequest(HOST_COMPUTER_PERMISSIONS, async (params): Promise<HostComputerPermissionsResult> => {
    const { request } = objectParams<HostComputerPermissionsParams>(params ?? {}, HOST_COMPUTER_PERMISSIONS);
    if (request !== undefined && request !== null && typeof request !== 'boolean') {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_COMPUTER_PERMISSIONS} request must be a boolean.`);
    }
    if (request === true) reads.request();
    const grants = await reads.read();
    return {
      screenCapture: grants.screen_capture,
      accessibility: grants.accessibility,
      input: grants.input,
      ...(grants.linux ? { linux: grants.linux } : {}),
    } as HostComputerPermissionsResult;
  });
}
