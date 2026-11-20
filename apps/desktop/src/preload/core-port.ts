import type { ContextBridge, IpcRenderer } from 'electron';

/** The main process sends a MessagePort for the core on this channel; a sandboxed preload cannot hand
 *  it to the page through contextBridge, so it is forwarded as a window message carrying the port. */
const PORT_CHANNEL = 'mixdog:core-port';
const OPEN_CHANNEL = 'mixdog:core-port:open';
/** What the launcher's wait for the core reports (core-port/relay.ts `CORE_BOOT_CHANNEL`). */
const BOOT_CHANNEL = 'mixdog:core-port:boot';
/** `Try again` after a confirmed failure (core-port/relay.ts `CORE_PORT_RETRY_CHANNEL`). */
const RETRY_CHANNEL = 'mixdog:core-port:retry';

export interface CoreBootReport {
  progress: { done: number; total: number; boot: number | null } | null;
  failure: { message: string; exitCode: number | null; stderrPath: string | null } | null;
}

export type CorePortSlot = 'primary' | 'pc';
export interface CorePortOpenOptions {
  slot?: CorePortSlot;
}

export function installCorePort(
  ipcRenderer: Pick<IpcRenderer, 'on' | 'invoke'>,
  contextBridge: Pick<ContextBridge, 'exposeInMainWorld'>
): void {
  ipcRenderer.on(PORT_CHANNEL, (event, payload: { generation: number; slot?: CorePortSlot }) => {
    window.postMessage(
      { type: 'mixdog-core-port', generation: payload.generation, slot: payload.slot ?? 'primary' },
      '*',
      [...event.ports]
    );
  });
  // Kept from the preload's start: main tells the window while it loads, before any page code could listen, and a listener that
  // comes later is given the last report.
  let latest: CoreBootReport | null = null;
  const listeners = new Set<(report: CoreBootReport) => void>();
  ipcRenderer.on(BOOT_CHANNEL, (_event, report: CoreBootReport) => {
    latest = report;
    for (const listener of [...listeners]) listener(report);
  });
  contextBridge.exposeInMainWorld('mixdogCorePort', {
    open: (
      options?: CorePortOpenOptions
    ): Promise<{ generation: number } | { launchFailed: CoreBootReport['failure'] }> =>
      ipcRenderer.invoke(OPEN_CHANNEL, options ?? {}),
    /** The user's `Try again`: main may launch the core again. */
    retry: (): Promise<void> => ipcRenderer.invoke(RETRY_CHANNEL),
    /** Told what the launcher reports while the window waits for its port (the rebuild's progress, a start that cannot succeed); returns the unsubscribe. */
    onBootReport: (listener: (report: CoreBootReport) => void): (() => void) => {
      if (latest) listener(latest);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}
