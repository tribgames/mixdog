import type { ContextBridge, IpcRenderer } from 'electron';

/** The main process sends a MessagePort for the core on this channel; a sandboxed preload cannot hand
 *  it to the page through contextBridge, so it is forwarded as a window message carrying the port. */
const PORT_CHANNEL = 'mixdog:core-port';
const OPEN_CHANNEL = 'mixdog:core-port:open';

export type CorePortSlot = 'primary' | 'pc';
export interface CorePortOpenOptions {
  slot?: CorePortSlot;
}

export function installCorePort(
  ipcRenderer: Pick<IpcRenderer, 'on' | 'invoke'>,
  contextBridge: Pick<ContextBridge, 'exposeInMainWorld'>,
): void {
  ipcRenderer.on(PORT_CHANNEL, (event, payload: { generation: number; slot?: CorePortSlot }) => {
    window.postMessage(
      { type: 'mixdog-core-port', generation: payload.generation, slot: payload.slot ?? 'primary' },
      '*',
      [...event.ports],
    );
  });
  contextBridge.exposeInMainWorld('mixdogCorePort', {
    open: (options?: CorePortOpenOptions): Promise<{ generation: number }> => ipcRenderer.invoke(OPEN_CHANNEL, options ?? {}),
  });
}
