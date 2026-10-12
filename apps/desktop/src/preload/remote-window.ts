import { contextBridge, ipcRenderer } from 'electron';

import { REMOTE_HOST_ARGUMENT, REMOTE_WINDOW_IPC, type RemoteWindowSwitcherBridge } from '../shared/remote-window';

// The "Connect to another PC" window loads the host's relay web app, which runs
// on the remote shim. This preload deliberately exposes NO desktop bridge: only
// which host the window shows, so the page can name it in its chrome and
// identify its pairing claim as a desktop client.
function readHost(): { hostId: string; hostName: string } | null {
  const argument = process.argv.find((value) => value.startsWith(REMOTE_HOST_ARGUMENT));
  if (!argument) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(argument.slice(REMOTE_HOST_ARGUMENT.length))) as {
      id?: unknown;
      name?: unknown;
    };
    return { hostId: String(parsed.id ?? '').slice(0, 64), hostName: String(parsed.name ?? '').slice(0, 80) };
  } catch {
    return null;
  }
}

const host = readHost();
if (host) contextBridge.exposeInMainWorld('mixdogRemoteWindow', Object.freeze(host));

// The top-bar PC switcher: saved PC names and online state, opening a saved
// one, and a way to reach this machine's connection settings. No route,
// credential or host data crosses; the main process checks the caller.
const switcher: RemoteWindowSwitcherBridge = {
  listHosts: () => ipcRenderer.invoke(REMOTE_WINDOW_IPC.list),
  openHost: (id) => ipcRenderer.invoke(REMOTE_WINDOW_IPC.open, String(id).slice(0, 64)),
  manageConnections: () => ipcRenderer.invoke(REMOTE_WINDOW_IPC.manage),
};
if (host) contextBridge.exposeInMainWorld('mixdogRemoteWindowSwitcher', Object.freeze(switcher));
