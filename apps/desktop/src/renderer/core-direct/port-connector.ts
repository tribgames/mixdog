import type {
  Connector,
  Target,
  TransportSink,
  TransportWriter,
} from '../../../../../packages/protocol-client/src/api';

export type PortSlot = 'primary' | 'pc';
/** What main reports of the wait for the core (main/core-port/boot-progress.ts `BootReport`). */
export interface BootReportShape {
  progress: { done: number; total: number; boot?: number | null; stage?: string } | null;
  failure: { message: string; exitCode: number | null; stderrPath: string | null; blocked?: unknown } | null;
  updating?: boolean;
}
/** `window.mixdogCorePort`: asks the main process for a new port and says which generation it will carry. */
export interface CorePortBridge {
  /** `launchFailed` is main's answer that the core ends at boot the same way each time it is started: not a failure to retry. */
  open(options?: { slot?: PortSlot }): Promise<{ generation: number } | { launchFailed: BootReportShape['failure'] }>;
  /** The user's `Try again` after a confirmed failure: main may launch the core again. */
  retry?(): Promise<void>;
  /** Told what the launcher reports while the core is not yet serving; the last report is replayed to a new listener. */
  onBootReport?(listener: (report: BootReportShape) => void): () => void;
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

/** Settles when main reports no failure (replayed to a listener that comes after it); never, from a bridge that reports nothing. */
function failureCleared(bridge: CorePortBridge): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let off: (() => void) | undefined;
    off = bridge.onBootReport?.((report) => {
      if (report.failure || done) return;
      done = true;
      off?.();
      resolve();
    });
    if (done) off?.();
  });
}

/** The writer and the receipts of one core port: frames, the departure receipt, the settle barrier and the close all travel on this port. */
function bindPort(port: PortLike, sink: TransportSink): TransportWriter {
  let closedSeen = false;
  // This connection's own receipts. A token means something on this port only; the port is closed with the connection, so an old
  // connection's acknowledgement has no port to arrive on and cannot touch a new one, and a token answered twice or never asked
  // for is ignored. Nothing here is a ping and nothing has a deadline: a receipt that does not come is no verdict either way.
  let ended = false;
  let nextToken = 1;
  const writes = new Map<number, { ok(): void; fail(error: Error): void }>();
  const barriers = new Map<number, () => void>();
  const end = (reason: string): void => {
    ended = true;
    for (const write of writes.values()) write.fail(new Error(reason));
    writes.clear();
    for (const release of barriers.values()) release();
    barriers.clear();
  };
  port.onmessage = (event) => {
    const data = event.data as unknown;
    if (ended) return;
    if (typeof data === 'string') {
      sink.frame(data);
    } else if (data && typeof data === 'object' && (data as { t?: unknown }).t === 'sent') {
      const { token, ok } = data as { token?: unknown; ok?: unknown };
      const write = typeof token === 'number' ? writes.get(token) : undefined;
      if (!write) return;
      writes.delete(token as number);
      if (ok === true) write.ok();
      else write.fail(new Error('The write to the core failed.'));
    } else if (data && typeof data === 'object' && (data as { t?: unknown }).t === 'settled') {
      const token = (data as { token?: unknown }).token;
      const release = typeof token === 'number' ? barriers.get(token) : undefined;
      if (!release) return;
      barriers.delete(token as number);
      release();
    } else if (data && typeof data === 'object' && (data as { t?: unknown }).t === 'progress') {
      // The main process saw bytes of a message arrive on the core's socket that is not whole yet.
      if (!closedSeen) sink.progress?.();
    } else if (data && typeof data === 'object' && (data as { t?: unknown }).t === 'closed') {
      if (closedSeen) return;
      closedSeen = true;
      end('The core port closed.');
      const { code, reason } = data as { code?: unknown; reason?: unknown };
      sink.closed(typeof code === 'number' ? code : 1006, typeof reason === 'string' ? reason : '');
    }
  };
  return {
    // The departure receipt is the main process's: it resolves when main's socket send callback reported the write complete.
    send: (text, sent) => {
      if (!sent) return port.postMessage(text);
      const token = nextToken++;
      const receipt = new Promise<void>((ok, fail) => writes.set(token, { ok, fail }));
      receipt.catch(() => {});
      sent(receipt);
      try {
        port.postMessage({ t: 'send', token, text });
      } catch (error) {
        writes.get(token)?.fail(error instanceof Error ? error : new Error(String(error)));
        writes.delete(token);
        throw error;
      }
    },
    // Resolves once main answers, which it does after everything it accepted from the core before the question was posted ahead
    // of the answer on this ordered port. A main that is stalled never answers: the health verdict waits for it.
    settled: () =>
      ended
        ? Promise.resolve()
        : new Promise<void>((release) => {
            const token = nextToken++;
            barriers.set(token, release);
            port.postMessage({ t: 'settle', token });
          }),
    close: (code, reason) => {
      end('The core port was closed.');
      port.postMessage({ t: 'close', code, reason });
      port.close();
    },
  };
}

export function createPortConnector(
  bridge: CorePortBridge,
  host: PortMessageHost = window,
  timeoutMs: number = PORT_TAKE_TIMEOUT_MS
): Connector {
  const held = new Map<string, PortLike>();
  const waiting = new Map<string, (port: PortLike) => void>();
  const newest = new Map<PortSlot, number>();
  const key = (slot: PortSlot, generation: number) => `${slot}:${generation}`;

  host.addEventListener('message', (event) => {
    if (event.source !== host) return;
    const data = event.data;
    if (data?.type !== 'mixdog-core-port' || typeof data.generation !== 'number') return;
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
      let opened = await bridge.open({ slot });
      // The core ends at boot the same way each time it is started (main says so, and the window shows why): another try here would only
      // ask main to start it again. This open stays pending until main says the failure is gone (the user chose Try again, or a core
      // serves); then it asks again.
      while ('launchFailed' in opened) {
        await failureCleared(bridge);
        opened = await bridge.open({ slot });
      }
      const { generation } = opened;
      const port = await take(slot, generation);
      return bindPort(port, sink);
    },
  };
}
