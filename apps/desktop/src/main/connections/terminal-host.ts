import { TERMINAL_SIZE_OWNER_EVENT, type TerminalSizeOwnerEvent } from '../../shared/terminal-size-owner';
import {
  readTerminalActivityEvent,
  TERMINAL_ACTIVITY_EVENT,
  type TerminalActivityEvent,
} from '../../shared/terminal-activity';
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
      // The window is never a size owner: a phone's grid is followed, not claimed.
      const owner = result.sizeOwner as { cols?: unknown; rows?: unknown } | undefined;
      return {
        id: String(result.id || ''),
        replay: String(result.replay || ''),
        ...(owner ? { sizeOwner: { cols: Number(owner.cols) || 0, rows: Number(owner.rows) || 0, own: false } } : {}),
      };
    },
    async attach(id: string) {
      const value = await service.invokeDesktopOperation('termAttach', [id]);
      if (!value || typeof value !== 'object') return null;
      const result = value as Record<string, unknown>;
      const owner = result.sizeOwner as { cols?: unknown; rows?: unknown } | undefined;
      return {
        id: String(result.id || ''),
        replay: String(result.replay || ''),
        ...(owner ? { sizeOwner: { cols: Number(owner.cols) || 0, rows: Number(owner.rows) || 0, own: false } } : {}),
      };
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
    focus(id: string, focused: boolean): void {
      service.notifyDesktopOperation('termFocus', [id, focused, 'desktop']);
    },
    async activity(): Promise<TerminalActivityEvent[]> {
      const value = await service.invokeDesktopOperation('termActivity', []);
      return Array.isArray(value)
        ? value.map(readTerminalActivityEvent).filter((event): event is TerminalActivityEvent => event !== null)
        : [];
    },
    subscribeActivity(listener: (event: TerminalActivityEvent) => void): () => void {
      return subscribe(({ name, value }) => {
        if (name !== TERMINAL_ACTIVITY_EVENT) return;
        const event = readTerminalActivityEvent(value);
        if (event) listener(event);
      });
    },
    subscribeSizeOwner(listener: (event: TerminalSizeOwnerEvent) => void): () => void {
      return subscribe(({ name, value }) => {
        if (name !== TERMINAL_SIZE_OWNER_EVENT || !value || typeof value !== 'object') return;
        const event = value as Record<string, unknown>;
        listener({
          id: String(event.id || ''),
          cols: Number(event.cols) || 0,
          rows: Number(event.rows) || 0,
          own: false,
        });
      });
    },
  };
}
