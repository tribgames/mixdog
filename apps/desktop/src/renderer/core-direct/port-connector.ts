import type { Connector, Target, TransportSink, TransportWriter } from '../../../../../packages/protocol-client/src/api';

export type PortSlot = 'primary' | 'pc';
/** `window.mixdogCorePort`: asks the main process for a new port and says which generation it will carry. */
export interface CorePortBridge {
  open(options?: { slot?: PortSlot }): Promise<{ generation: number }>;
}
/** The part of `window` the connector uses. */
export interface PortMessageHost {
  addEventListener(type: 'message', listener: (event: any) => void): void;
}

export const PORT_TAKE_TIMEOUT_MS = 10_000;

interface PortLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

/** A target id of `pc` takes the second port; every other target takes the primary one. */
function slotOf(target: Target): PortSlot {
  return target.id === 'pc' ? 'pc' : 'primary';
}

export function createPortConnector(
  bridge: CorePortBridge,
  host: PortMessageHost = window,
  timeoutMs: number = PORT_TAKE_TIMEOUT_MS,
): Connector {
  const held = new Map<string, PortLike>();
  const waiting = new Map<string, (port: PortLike) => void>();
  const newest = new Map<PortSlot, number>();
  const key = (slot: PortSlot, generation: number) => `${slot}:${generation}`;

  host.addEventListener('message', (event) => {
    if (event.source !== host) return;
    const data = event.data;
    if (!data || data.type !== 'mixdog-core-port' || typeof data.generation !== 'number') return;
    const port: PortLike | undefined = event.ports?.[0];
    if (!port) return;
    const slot: PortSlot = data.slot === 'pc' ? 'pc' : 'primary';
    const latest = newest.get(slot) ?? -Infinity;
    if (data.generation < latest) {
      port.close();
      return;
    }
    newest.set(slot, data.generation);
    for (const [k, old] of held) {
      if (k.startsWith(`${slot}:`) && Number(k.slice(slot.length + 1)) < data.generation) {
        old.close();
        held.delete(k);
      }
    }
    const k = key(slot, data.generation);
    const waiter = waiting.get(k);
    if (waiter) {
      waiting.delete(k);
      waiter(port);
    } else {
      held.set(k, port);
    }
  });

  function take(slot: PortSlot, generation: number): Promise<PortLike> {
    const k = key(slot, generation);
    const ready = held.get(k);
    if (ready) {
      held.delete(k);
      return Promise.resolve(ready);
    }
    return new Promise<PortLike>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(k);
        reject(new Error(`core port generation ${generation} did not arrive within ${timeoutMs} ms`));
      }, timeoutMs);
      waiting.set(k, (port) => {
        clearTimeout(timer);
        resolve(port);
      });
    });
  }

  return {
    async open(target: Target, sink: TransportSink): Promise<TransportWriter> {
      const slot = slotOf(target);
      const { generation } = await bridge.open({ slot });
      const port = await take(slot, generation);
      let closedSeen = false;
      port.onmessage = (event) => {
        const data = event.data as unknown;
        if (typeof data === 'string') {
          sink.frame(data);
        } else if (data && typeof data === 'object' && (data as { t?: unknown }).t === 'closed') {
          if (closedSeen) return;
          closedSeen = true;
          const { code, reason } = data as { code?: unknown; reason?: unknown };
          sink.closed(typeof code === 'number' ? code : 1006, typeof reason === 'string' ? reason : '');
        }
      };
      return {
        // The sent claim is not used: a port cannot tell when a frame left.
        send: (text) => port.postMessage(text),
        close: (code, reason) => {
          port.postMessage({ t: 'close', code, reason });
          port.close();
        },
      };
    },
  };
}
