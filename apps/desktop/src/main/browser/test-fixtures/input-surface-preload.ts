import { contextBridge, ipcRenderer } from 'electron';
import { DESKTOP_IPC } from '../../../shared/contract';

contextBridge.exposeInMainWorld('mixdogDesktop', {
  browserPageFrame: (sessionId: string, previousId?: string) =>
    ipcRenderer.invoke(DESKTOP_IPC.browserPageFrame, sessionId, previousId),
  browserPageControl: (sessionId: string, input: unknown) =>
    ipcRenderer.invoke(DESKTOP_IPC.browserPageControl, sessionId, input),
  browserSetActiveGuest: (sessionId: string, id: number, active: boolean) =>
    ipcRenderer.invoke(DESKTOP_IPC.browserSetActiveGuest, sessionId, id, active),
  browserConfigureGuestViewport: (sessionId: string, id: number, config: unknown) =>
    ipcRenderer.invoke(DESKTOP_IPC.browserConfigureGuestViewport, sessionId, id, config),
  onBrowserGuestViewportChanged: (listener: (value: unknown) => void) => {
    const receive = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on(DESKTOP_IPC.browserGuestViewportChanged, receive);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.browserGuestViewportChanged, receive);
  },
});
