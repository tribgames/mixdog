// Desktop-local channel-relay reservation (user decision): a NEW TASK always
// enters remote OFF. The draft toggle arms a ONE-SHOT reservation that the
// started task consumes, and entering any new draft resets it — the stored
// value only bridges the draft toggle to its own submit, never across tasks
// or restarts. The engine stays the authority for the live remote seat.
export type RemoteNewTaskMode = 'on' | 'off';

const KEY = 'mixdog.desktop.remote-new-task';
const CHANGE_EVENT = 'mixdog:remote-new-task-mode-changed';
let fallbackMode: RemoteNewTaskMode = 'off';

export function remoteNewTaskMode(): RemoteNewTaskMode {
  try {
    fallbackMode = window.localStorage.getItem(KEY) === 'on' ? 'on' : 'off';
    return fallbackMode;
  } catch {
    return fallbackMode;
  }
}

export function setRemoteNewTaskMode(mode: RemoteNewTaskMode): void {
  fallbackMode = mode === 'on' ? 'on' : 'off';
  try {
    window.localStorage.setItem(KEY, fallbackMode);
  } catch {
    // Preference degrades to the in-memory default without storage.
  }
  try {
    window.dispatchEvent(new window.Event(CHANGE_EVENT));
  } catch {
    // A non-browser renderer import keeps the in-memory fallback only.
  }
}

export function subscribeRemoteNewTaskMode(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}
