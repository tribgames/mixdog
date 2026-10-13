import type { DesktopService } from '../desktop-service-contract';
import type { DesktopTerminalHost } from '../ipc-terminal';
import type { TerminalSpawnProfile } from '../terminal-contract';

type TerminalService = Pick<DesktopService, 'invokeDesktopOperation' | 'subscribeDesktopEvents'> & {
  notifyDesktopOperation(method: string, args?: unknown[]): void;
};

/** PTYs are owned by the connection's daemon; the window forwards control and
 *  receives output events from that daemon only. */
export function createServiceTerminalHost(service: TerminalService): DesktopTerminalHost {
  const subscribe = (listener: (event: { name: string; value: unknown }) => void): (() => void) =>
    service.subscribeDesktopEvents?.(listener) ?? (() => {});
  return {
    async ensure(id: string | null, cwd: string | null, profile?: TerminalSpawnProfile | string | null) {
      const value = await service.invokeDesktopOperation('termEnsure', [id, cwd, profile ?? null]);
      if (!value || typeof value !== 'object') {
        throw new Error('The service terminal did not return a session.');
      }
      const result = value as Record<string, unknown>;
      return { id: String(result.id || ''), replay: String(result.replay || '') };
    },
    write(id: string, data: string): void {
      // Keystrokes take the fire-and-forget lane: a response frame per keypress
      // only queued the input behind whatever session request was in flight.
      service.notifyDesktopOperation('termWrite', [id, data]);
    },
    resize(id: string, cols: number, rows: number): void {
      service.notifyDesktopOperation('termResize', [id, cols, rows]);
    },
    pauseOutput(id: string): void {
      void service.invokeDesktopOperation('termPause', [id]).catch(() => {});
    },
    resumeOutput(id: string): void {
      void service.invokeDesktopOperation('termResume', [id]).catch(() => {});
    },
    dispose(id: string): void {
      void service.invokeDesktopOperation('termDispose', [id]).catch(() => {});
    },
    subscribe(listener: (event: { id: string; data: string }) => void): () => void {
      return subscribe(({ name, value }) => {
        if (name !== 'terminal-data' || !value || typeof value !== 'object') return;
        const event = value as Record<string, unknown>;
        listener({ id: String(event.id || ''), data: String(event.data || '') });
      });
    },
  };
}
