import { contextBridge, ipcRenderer } from 'electron';

// The direct-transport peer host's preload: its two channels only (main listens
// on this window's webContents.ipc), never the app's DesktopApi. The names are
// REMOTE_TRANSPORT_PEER_IPC (main/remote-transport/peer-window.ts); that module
// loads Electron's main-process API, so a sandboxed preload cannot import it.
// Payloads are forwarded as they are: carrier bytes stay Uint8Array (structured
// clone, no base64), and main validates every event.
const COMMAND = 'remote-transport-peer:command';
const EVENT = 'remote-transport-peer:event';

const bridge = {
  onCommand(listener: (command: unknown) => void): void {
    ipcRenderer.on(COMMAND, (_event, command: unknown) => listener(command));
  },
  emit(event: unknown): void {
    ipcRenderer.send(EVENT, event);
  },
};

contextBridge.exposeInMainWorld('mixdogTransportPeer', Object.freeze(bridge));
