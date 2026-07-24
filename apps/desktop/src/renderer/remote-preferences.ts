// Desktop-local channel-relay preferences (user decision): new tasks default
// to remote OFF; the Channels-settings dropdown can flip every fresh task's
// relay ON at creation time. Stored per install — the engine stays the
// authority for the live remote seat itself.
export type RemoteNewTaskMode = 'on' | 'off';

const KEY = 'mixdog.desktop.remote-new-task';

export function remoteNewTaskMode(): RemoteNewTaskMode {
  try {
    return window.localStorage.getItem(KEY) === 'on' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

export function setRemoteNewTaskMode(mode: RemoteNewTaskMode): void {
  try {
    window.localStorage.setItem(KEY, mode === 'on' ? 'on' : 'off');
  } catch {
    // Preference degrades to the in-memory default without storage.
  }
}
