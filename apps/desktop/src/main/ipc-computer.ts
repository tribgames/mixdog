// Computer Use readiness reads and the one-press fixes the detail dialog offers.
import type { Shell } from 'electron';
import { DESKTOP_IPC, type DesktopComputerPermissionPane, type DesktopComputerReadiness } from '../shared/contract';
import type { ComputerPermissions } from './computer/shared/permissions';
import type { IpcHandle as Handle } from './ipc';
import type { PcAccess } from './pc-access';

export interface ComputerIpcHost {
  readPermissions(): ComputerPermissions | Promise<ComputerPermissions>;
  /** Shows macOS's own grant prompts for whatever is still undecided. */
  requestPermissions(): void;
  /** Windows: the secure-desktop helper ("PC access") Computer Use setup grants. */
  pcAccess?: PcAccess | null;
}

interface ComputerIpcOptions {
  handle: Handle;
  shell: Pick<Shell, 'openExternal'>;
  computer?: ComputerIpcHost;
}

const PERMISSION_PANES: Record<DesktopComputerPermissionPane, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

export function registerComputerIpc({ handle, shell, computer }: ComputerIpcOptions): void {
  handle(DESKTOP_IPC.computerReadiness, async () => {
    if (!computer) throw new Error('Computer Use is not available in this host.');
    const [permissions, pcAccess] = await Promise.all([
      computer.readPermissions(),
      // A failed read leaves the row out until the next read.
      computer.pcAccess?.readiness().catch(() => undefined),
    ]);
    return {
      platform: process.platform,
      ...permissions,
      ...(pcAccess ? { pcAccess } : {}),
    } as DesktopComputerReadiness;
  });
  handle(DESKTOP_IPC.approvePcAccess, async () => {
    const pcAccess = computer?.pcAccess;
    if (!pcAccess) throw new Error('PC access is not available on this PC.');
    return pcAccess.approve();
  });
  handle(DESKTOP_IPC.openComputerPermissionSettings, async (_event, pane) => {
    if (process.platform !== 'darwin') return;
    if (pane !== 'screen' && pane !== 'accessibility') throw new TypeError('pane must be screen or accessibility.');
    computer?.requestPermissions();
    await shell.openExternal(PERMISSION_PANES[pane]);
  });
}
