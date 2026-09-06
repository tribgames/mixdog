import { contextBridge, ipcRenderer } from 'electron';

// The dedicated overlay preload exposes no desktop input or general IPC API.
contextBridge.exposeInMainWorld('mixdogComputerControl', (request: unknown) =>
  ipcRenderer.invoke('computer-overlay-control', request));
