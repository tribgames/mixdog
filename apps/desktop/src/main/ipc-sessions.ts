// The session-side handlers that stay in main: the attachment thumbnail (a scaled copy of a stored image for the transcript) and
// the saved remote hosts ("Connect to another PC": their windows are Electron windows). Everything else of a session (the list,
// its lifecycle, prompts, approvals, model routes, the remote-access controls) is a request of the window's own core connection.
import { DESKTOP_IPC } from '../shared/contract';
import { requiredString } from './ipc-validation';
import type { IpcHandle as Handle } from './ipc';
import type { RemoteHostWindows } from './remote-host-windows';
import type { ProtocolConnection } from './protocol/connection';
import { coreErrorForWindow } from './protocol/core-error';

interface SessionIpcOptions {
  handle: Handle;
  /** "Connect to another PC": saved hosts and their windows. */
  remoteHosts?: RemoteHostWindows;
  /** The window's core connection (the thumbnail is its own); without one the thumbnail read fails. */
  core?: Pick<ProtocolConnection, 'call'> | null;
}

export function registerSessionIpc({ handle, remoteHosts, core }: SessionIpcOptions): void {
  handle(DESKTOP_IPC.readAttachmentThumbnail, async (_event, attachmentRef) => {
    if (!core) throw new Error('The core connection is not available.');
    try {
      // `desktop/attachment/thumbnail`: a content hash names the stored image; the core scales it to a 320 px JPEG, hands a small
      // PNG/GIF/WebP it cannot decode over as it is, and answers `dataUrl: null` for anything else.
      return ((await core.call('desktop/attachment/thumbnail', { attachmentRef })) as { dataUrl: string | null }).dataUrl;
    } catch (error) {
      throw coreErrorForWindow(error);
    }
  });
  const requiredRemoteHosts = (): RemoteHostWindows => {
    if (!remoteHosts) throw new Error('Connecting to another PC is unavailable.');
    return remoteHosts;
  };
  handle(DESKTOP_IPC.renameRemoteHost, async (_event, id, name) => {
    await requiredRemoteHosts().rename(requiredString(id, 'id', 64), typeof name === 'string' ? name : '');
  });
  handle(DESKTOP_IPC.listRemoteHosts, () => remoteHosts?.list() ?? []);
  handle(DESKTOP_IPC.connectRemoteHostByCode, (_event, code) =>
    requiredRemoteHosts().connectByCode(requiredString(code, 'code', 16))
  );
  handle(DESKTOP_IPC.openRemoteHost, (_event, id) => requiredRemoteHosts().open(requiredString(id, 'id', 64)));
  handle(DESKTOP_IPC.forgetRemoteHost, (_event, id) => requiredRemoteHosts().forget(requiredString(id, 'id', 64)));
}
