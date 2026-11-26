import { contextBridge, ipcRenderer } from 'electron';

// Names duplicate REMOTE_TRANSPORT_PEER_IPC (main/remote-transport/peer-window.ts): that module loads Electron's
// main-process API, which a sandboxed preload cannot import.
const COMMAND = 'remote-transport-peer:command';
const EVENT = 'remote-transport-peer:event';

const bridge = {
  onCommand(listener: (command: unknown) => void): () => void {
    const receive = (_event: Electron.IpcRendererEvent, command: unknown): void => listener(command);
    ipcRenderer.on(COMMAND, receive);
    return () => {
      ipcRenderer.removeListener(COMMAND, receive);
    };
  },
  emit(event: unknown): void {
    ipcRenderer.send(EVENT, event);
  },
};

contextBridge.exposeInMainWorld('mixdogTransportPeer', Object.freeze(bridge));
