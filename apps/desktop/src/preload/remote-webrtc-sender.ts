import { contextBridge, ipcRenderer } from 'electron';

import {
  REMOTE_WEBRTC_SENDER_IPC,
  type RemoteWebrtcSenderCommand,
  type RemoteWebrtcSenderEvent,
} from '../shared/remote-webrtc-sender';

// The live-view sender window's preload: its two channels only (main listens
// on this window's webContents.ipc), never the app's DesktopApi.
const bridge = {
  onCommand(listener: (command: RemoteWebrtcSenderCommand) => void): void {
    ipcRenderer.on(REMOTE_WEBRTC_SENDER_IPC.command, (_event, command: RemoteWebrtcSenderCommand) =>
      listener(command)
    );
  },
  emit(event: RemoteWebrtcSenderEvent): void {
    ipcRenderer.send(REMOTE_WEBRTC_SENDER_IPC.event, event);
  },
};

contextBridge.exposeInMainWorld('mixdogWebrtcSender', Object.freeze(bridge));
