import { contextBridge, ipcRenderer } from 'electron';

// Names duplicate REMOTE_TRANSPORT_PEER_IPC (main/remote-transport/peer-window.ts): that module loads Electron's
// main-process API, which a sandboxed preload cannot import.
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
