import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopPetView } from '../shared/desktop-pet';
import { type DesktopPetBridge, DESKTOP_PET_WINDOW_IPC as DESKTOP_PET_IPC } from '../shared/desktop-pet-bridge';

// The desktop pet window's preload: its own narrow channels only (main
// listens on this window's webContents.ipc), never the app's DesktopApi.
const bridge: DesktopPetBridge = {
  onView(listener) {
    const receive = (_event: Electron.IpcRendererEvent, view: DesktopPetView) => listener(view);
    ipcRenderer.on(DESKTOP_PET_IPC.view, receive);
    return () => ipcRenderer.removeListener(DESKTOP_PET_IPC.view, receive);
  },
  onBlurred(listener) {
    const receive = () => listener();
    ipcRenderer.on(DESKTOP_PET_IPC.blurred, receive);
    return () => ipcRenderer.removeListener(DESKTOP_PET_IPC.blurred, receive);
  },
  ready: () => ipcRenderer.send(DESKTOP_PET_IPC.ready),
  painted: () => ipcRenderer.send(DESKTOP_PET_IPC.painted),
  send: (text) => ipcRenderer.invoke(DESKTOP_PET_IPC.send, String(text)),
  open: () => ipcRenderer.send(DESKTOP_PET_IPC.open),
  read: (key) => ipcRenderer.send(DESKTOP_PET_IPC.read, String(key)),
  copy: (key) => ipcRenderer.send(DESKTOP_PET_IPC.copy, String(key)),
  command: (command) => ipcRenderer.send(DESKTOP_PET_IPC.command, String(command)),
  area: (rect) => ipcRenderer.send(DESKTOP_PET_IPC.area, rect),
  drag: (drag) => ipcRenderer.send(DESKTOP_PET_IPC.drag, drag),
  nudge: (dx, dy) => ipcRenderer.send(DESKTOP_PET_IPC.nudge, dx, dy),
  reset: () => ipcRenderer.send(DESKTOP_PET_IPC.reset),
  scale: (scale) => ipcRenderer.send(DESKTOP_PET_IPC.scale, Number(scale)),
  interactive: (on) => ipcRenderer.send(DESKTOP_PET_IPC.interactive, on === true),
  focusInput: (open) => ipcRenderer.send(DESKTOP_PET_IPC.focusInput, open === true),
};

contextBridge.exposeInMainWorld('mixdogPet', Object.freeze(bridge));
