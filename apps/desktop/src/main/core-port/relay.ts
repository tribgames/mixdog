// The main process end of a window's own link to the core: a WebSocket opened from Node (headers, no Origin) piped
// both ways over a MessagePort handed to the window. Text frames cross unchanged; the core's end going away is
// reported as `{t:'closed'}` and the window can end the link with `{t:'close'}`. There is no flow control on a
// MessagePort: a flood from the core buffers in this process.
import WebSocket from 'ws';

import { windowIdFor } from './window-ids';

export type CoreSlot = 'primary' | 'pc';

export interface CoreEndpoint {
  readonly slot: CoreSlot;
  readonly url: string;
  readonly token: string;
  readonly target: 'local' | 'server';
  readonly role: 'main' | `server:${string}`;
}

export const CORE_PORT_CHANNEL = 'mixdog:core-port';
/** The window's request for a port (preload/core-port.ts `mixdogCorePort.open`). */
export const CORE_PORT_OPEN_CHANNEL = 'mixdog:core-port:open';
/** Close code of every socket `closeAll` ends. */
export const CLOSE_ALL_CODE = 4000;
const MAX_INBOUND_BYTES = 16 * 1024 * 1024;

export interface RelaySocket {
  once(event: 'open', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'unexpected-response', listener: (request: unknown, response: { statusCode?: number }) => void): unknown;
  on(event: 'message', listener: (data: { toString(encoding?: string): string }, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: { toString(encoding?: string): string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface RelayPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

export interface RelayChannel {
  readonly port1: RelayPort;
  readonly port2: unknown;
}

export interface RelayWebContents {
  readonly id: number;
  once(event: 'destroyed', listener: () => void): unknown;
  postMessage(channel: string, message: unknown, transfer: unknown[]): void;
}

export interface CorePortRelayOptions {
  endpointFor(webContentsId: number): Promise<CoreEndpoint[]>;
  /** The window scope main's own initialize reply carried; null when the core does not speak it. */
  coreWindowScope(): Promise<number | null>;
  createSocket?(url: string, headers: Record<string, string>): RelaySocket;
  createChannel?(): Promise<RelayChannel> | RelayChannel;
  log?(message: string): void;
}

interface Live {
  socket: RelaySocket | null;
  port: RelayPort | null;
  ended: boolean;
}

function defaultSocket(url: string, headers: Record<string, string>): RelaySocket {
  return new WebSocket(url, { headers, maxPayload: MAX_INBOUND_BYTES, perMessageDeflate: false }) as unknown as RelaySocket;
}

async function defaultChannel(): Promise<RelayChannel> {
  const { MessageChannelMain } = await import('electron');
  return new MessageChannelMain() as unknown as RelayChannel;
}

export class CorePortRelay {
  private readonly live = new Map<string, Live>();
  private readonly watched = new Set<number>();
  private loggedNoScope = false;
  /** Bumped by every open: the port a window receives says which open it answers. */
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: CorePortRelayOptions) {}

  /** Resolves with the generation the delivered port carries; an open superseded before its port is delivered rejects. */
  async open(webContents: RelayWebContents, slot: CoreSlot = 'primary'): Promise<{ generation: number }> {
    if (this.disposed) throw new Error('The core relay is closed.');
    const generation = ++this.generation;
    const windowId = windowIdFor(webContents);
    const key = `${webContents.id}:${slot}`;
    this.watch(webContents);
    this.end(key, 1000, 'superseded');
    const entry: Live = { socket: null, port: null, ended: false };
    this.live.set(key, entry);
    const current = (): boolean => !this.disposed && this.live.get(key) === entry;
    const superseded = (): Error => new Error(`The core port open ${generation} was superseded.`);
    try {
      const scope = await this.options.coreWindowScope();
      if (scope === null && !this.loggedNoScope) {
        this.loggedNoScope = true;
        this.log('[mixdog] core-lacks-window-scope: opening the window port without it');
      }
      if (!current()) throw superseded();
      const endpoint = (await this.options.endpointFor(webContents.id)).find((candidate) => candidate.slot === slot);
      if (!endpoint) throw new Error(`No core endpoint for slot "${slot}".`);
      if (!current()) throw superseded();
      const socket = (this.options.createSocket ?? defaultSocket)(endpoint.url, {
        Authorization: `Bearer ${endpoint.token}`,
        'Mixdog-Window': windowId,
        'Mixdog-Window-Role': endpoint.role,
      });
      entry.socket = socket;
      await new Promise<void>((resolveOpen, rejectOpen) => {
        socket.once('open', () => resolveOpen());
        socket.once('error', rejectOpen);
        socket.once('unexpected-response', (_request, response) => {
          socket.terminate();
          rejectOpen(new Error(`The core refused the connection (HTTP ${response.statusCode}).`));
        });
      });
      // An error always precedes a close event that carries the code.
      socket.on('error', () => {});
      if (!current()) {
        socket.close(1000, 'superseded');
        throw superseded();
      }
      const channel = await (this.options.createChannel ?? defaultChannel)();
      if (!current()) {
        socket.close(1000, 'superseded');
        channel.port1.close();
        throw superseded();
      }
      entry.port = channel.port1;
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          this.log('[mixdog] core sent a binary frame on a window port; dropped');
          return;
        }
        if (!entry.ended) channel.port1.postMessage(data.toString('utf8'));
      });
      socket.on('close', (code, reason) => {
        if (entry.ended) return;
        entry.ended = true;
        if (this.live.get(key) === entry) this.live.delete(key);
        const text = reason.toString('utf8');
        // Why the link went is known here and nowhere after.
        this.log(`[mixdog] core socket closed window=${windowId} slot=${slot} code=${code} reason=${JSON.stringify(text.slice(0, 300))}`);
        channel.port1.postMessage({ t: 'closed', code, reason: text });
        channel.port1.close();
      });
      channel.port1.on('message', ({ data }) => {
        if (entry.ended) return;
        if (typeof data === 'string') socket.send(data);
        else if ((data as { t?: unknown } | null)?.t === 'close') socket.close(1000, 'window closed the port');
      });
      channel.port1.on('close', () => {
        if (!entry.ended) socket.close(1000, 'window port closed');
      });
      channel.port1.start();
      webContents.postMessage(CORE_PORT_CHANNEL, { generation, slot, role: endpoint.role, target: endpoint.target }, [
        channel.port2,
      ]);
      return { generation };
    } catch (error) {
      if (this.live.get(key) === entry) this.live.delete(key);
      entry.ended = true;
      entry.socket?.terminate();
      entry.port?.close();
      throw error;
    }
  }

  closeAll(reason: string): void {
    for (const key of [...this.live.keys()]) this.end(key, CLOSE_ALL_CODE, reason);
  }

  dispose(): void {
    this.disposed = true;
    for (const key of [...this.live.keys()]) this.end(key, 1000, 'relay disposed');
  }

  private watch(webContents: RelayWebContents): void {
    if (this.watched.has(webContents.id)) return;
    this.watched.add(webContents.id);
    webContents.once('destroyed', () => {
      this.watched.delete(webContents.id);
      for (const key of [...this.live.keys()]) {
        if (key.startsWith(`${webContents.id}:`)) this.end(key, 1000, 'window destroyed');
      }
    });
  }

  /** Ends one live link. Only `closeAll` tells the window (it may reopen); a superseded or destroyed link is silent. */
  private end(key: string, code: number, reason: string): void {
    const entry = this.live.get(key);
    if (!entry) return;
    this.live.delete(key);
    if (code === CLOSE_ALL_CODE && !entry.ended) entry.port?.postMessage({ t: 'closed', code, reason });
    entry.ended = true;
    entry.socket?.close(code, reason);
    entry.port?.close();
  }

  private log(message: string): void {
    (this.options.log ?? console.error)(message);
  }
}
