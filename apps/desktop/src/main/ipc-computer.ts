// Computer Use readiness reads and the one-press fixes the detail dialog offers.
import type { Shell } from 'electron';
import type { PcAccessApproval, PcAccessReadiness } from '../../../../packages/protocol/src/index.ts';
import {
  DESKTOP_IPC,
  type DesktopComputerPermissionPane,
  type DesktopComputerReadiness,
  type DesktopPcAccessApproval,
  type DesktopPcAccessReadiness,
} from '../shared/contract';
import type { ComputerPermissions } from './computer/shared/permissions';
import type { IpcHandle as Handle } from './ipc';

export interface ComputerIpcHost {
  readPermissions(): ComputerPermissions | Promise<ComputerPermissions>;
  /** Shows macOS's own grant prompts for whatever is still undecided. */
  requestPermissions(): void;
}

interface ComputerIpcOptions {
  handle: Handle;
  shell: Pick<Shell, 'openExternal'>;
  computer?: ComputerIpcHost;
  /** The core's desktop operations: `pcAccessReadiness` and `pcAccessApprove` are its `pcAccess/*` requests. */
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
}

const PERMISSION_PANES: Record<DesktopComputerPermissionPane, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

/** The core's readiness as the row reads it. */
export function pcAccessRowOf(readiness: PcAccessReadiness): DesktopPcAccessReadiness {
  if (!readiness.supported) return { state: 'unavailable' };
  if (readiness.otherUser) return { state: 'other-user' };
  if (!readiness.installed || readiness.outdated) return { state: 'not-installed' };
  if (readiness.owed.unknown > 0) return { state: 'revocations-unknown' };
  return { state: readiness.needsEnroll ? 'needs-enroll' : 'ready' };
}

/** The core's approval as the row reads it. */
export function pcAccessApprovalOf({ outcome, detail, exitCode }: PcAccessApproval): DesktopPcAccessApproval {
  const extra = { ...(detail ? { detail } : {}), ...(exitCode === undefined ? {} : { exitCode }) };
  if (outcome === 'installed' || outcome === 'updated' || outcome === 'enrolled') return { outcome: 'done' };
  if (outcome === 'nothing') return { outcome: 'nothing-to-do' };
  return { outcome, ...extra };
}

export function registerComputerIpc({ handle, shell, computer, invokeDesktopOperation }: ComputerIpcOptions): void {
  handle(DESKTOP_IPC.computerReadiness, async () => {
    if (!computer) throw new Error('Computer Use is not available in this host.');
    const [permissions, pcAccess] = await Promise.all([
      computer.readPermissions(),
      // PC access exists on Windows only; a failed read leaves the row out until the next read.
      process.platform === 'win32'
        ? invokeDesktopOperation<PcAccessReadiness>('pcAccessReadiness', []).then(pcAccessRowOf, () => undefined)
        : undefined,
    ]);
    return {
      platform: process.platform,
      ...permissions,
      ...(pcAccess ? { pcAccess } : {}),
    } as DesktopComputerReadiness;
  });
  handle(DESKTOP_IPC.approvePcAccess, async () => {
    if (process.platform !== 'win32') throw new Error('PC access is not available on this PC.');
    return pcAccessApprovalOf(await invokeDesktopOperation<PcAccessApproval>('pcAccessApprove', []));
  });
  handle(DESKTOP_IPC.openComputerPermissionSettings, async (_event, pane) => {
    if (process.platform !== 'darwin') return;
    if (pane !== 'screen' && pane !== 'accessibility') throw new TypeError('pane must be screen or accessibility.');
    computer?.requestPermissions();
    await shell.openExternal(PERMISSION_PANES[pane]);
  });
}
