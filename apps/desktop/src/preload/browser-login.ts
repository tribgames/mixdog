import { contextBridge, ipcRenderer } from 'electron';

// The sign-in window's own shell (main/browser/login-popup.ts) only: 닫기,
// 완료 and the navigation facts it shows. The site's page has no preload.
contextBridge.exposeInMainWorld('mixdogBrowserLogin', {
  close: () => ipcRenderer.invoke('browser-login-control', { action: 'close' }),
  complete: () => ipcRenderer.invoke('browser-login-control', { action: 'complete' }),
  onState: (listener: (state: unknown) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state);
    ipcRenderer.on('browser-login-state', receive);
    return () => {
      ipcRenderer.removeListener('browser-login-state', receive);
    };
  },
});
