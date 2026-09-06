import { DESKTOP_IPC } from '../shared/contract';
import type { ComputerHost } from './computer';

export function registerComputerSettingsIpc(
  handle: (channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void,
  host?: Pick<ComputerHost, 'readAuthorization' | 'updateAuthorization' | 'authorizationWindows' | 'readFailureDiagnostics'>,
): void {
  const available = () => {
    if (!host) throw new Error('Computer Use settings are available on the local Windows desktop only.');
    return host;
  };
  handle(DESKTOP_IPC.computerReadAuthorization, () => available().readAuthorization());
  handle(DESKTOP_IPC.computerUpdateAuthorization, (_event, value) => available().updateAuthorization(value));
  handle(DESKTOP_IPC.computerAuthorizationWindows, () => available().authorizationWindows());
  handle(DESKTOP_IPC.computerFailureDiagnostics, () => available().readFailureDiagnostics());
}
