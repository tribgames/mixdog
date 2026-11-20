// The main process end of a window's own link to the core: a WebSocket opened from Node (headers, no Origin) piped
// both ways over a MessagePort handed to the window. Text frames cross unchanged; the core's end going away is
// reported as `{t:'closed'}` and the window can end the link with `{t:'close'}`. There is no flow control on a
// MessagePort: a flood from the core buffers in this process.
import WebSocket from 'ws';

import { createLinkLog } from '../../../../../packages/protocol-client/src/link-log.mjs';
import { observeSocketProgress } from '../protocol/socket-progress';
import type { BootFailure, BootReport, BootReportSource } from './boot-progress';
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
/** What the window is told while its `open` waits for the core: a `BootReport` (the index rebuild's `{done, total}` sessions or null,\n *  and the failure of a start that ends the same way each time or null). */
export const CORE_BOOT_CHANNEL = 'mixdog:core-port:boot';
/** The window's `Try again` after a confirmed failure (preload/core-port.ts `mixdogCorePort.retry`). */
export const CORE_PORT_RETRY_CHANNEL = 'mixdog:core-port:retry';
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
  /** `done` runs when the write completed locally (with the error if it failed). */
  send(text: string, done?: (error?: Error | null) => void): void;
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
  /** Told the boot progress; a window without it (a test double) is not told. */
  send?(channel: string, message: BootReport): void;
  isDestroyed?(): boolean;
}

export interface CorePortRelayOptions {
  endpointFor(webContentsId: number, slot: CoreSlot): Promise<CoreEndpoint[]>;
  /** The window scope main's own initialize reply carried; null when the core does not speak it. */
  coreWindowScope(): Promise<number | null>;
  /** What the launcher's wait for the core reports (rebuild progress, a start that cannot succeed): relayed to a window for as long as its open lives. */
  bootReports?: BootReportSource;
  createSocket?(url: string, headers: Record<string, string>): RelaySocket;
  createChannel?(): Promise<RelayChannel> | RelayChannel;
  log?(message: string): void;
  /** The desktop diagnostics sink: one record per window link opened, failed to open, closed or ended by this side. */
  diagnostic?(event: string, fields: Record<string, unknown>): void;
}

interface Live {
  socket: RelaySocket | null;
  port: RelayPort | null;
  ended: boolean;
  /** Which open made it, who it is for, and when its socket opened (for the close line). */
  generation: number;
  window: string;
  slot: CoreSlot;
  openedAt: number;
  /** Ends what this open tells its window of the boot; run when the open settles and when the entry ends, whichever is first. */
  stopReports?: () => void;
  /** The link's one close line, whoever ends it and however (a later call is a no-op): the lifecycle boundary of the link. */
  finish(initiator: 'core-or-network' | 'desktop' | 'window', code: number, reason: string, error?: string): void;
}

/** What the launcher recorded when it named a start that cannot succeed (boot-progress.ts), on the error or the one it caused. */
function launchFailedOf(error: unknown): BootFailure | null {
  const held = error as { coreLaunchFailed?: BootFailure; cause?: unknown } | null;
  return (
    held?.coreLaunchFailed ??
    (held?.cause as { coreLaunchFailed?: BootFailure } | null | undefined)?.coreLaunchFailed ??
    null
  );
}

function defaultSocket(url: string, headers: Record<string, string>): RelaySocket {
  return new WebSocket(url, {
    headers,
    maxPayload: MAX_INBOUND_BYTES,
    perMessageDeflate: false,
  }) as unknown as RelaySocket;
}

async function defaultChannel(): Promise<RelayChannel> {
  const { MessageChannelMain } = await import('electron');
  return new MessageChannelMain() as unknown as RelayChannel;
}

export class CorePortRelay {
  private readonly live = new Map<string, Live>();
  private readonly watched = new Set<number>();
  /** A failed slot waits for PC recovery even while the window's other slot keeps dialing. */
  private readonly parked = new Map<string, () => void>();
  private loggedNoScope = false;
  /** Bumped by every open: the port a window receives says which open it answers. */
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: CorePortRelayOptions) {}

  /** Resolves with the generation the delivered port carries; an open superseded before its port is delivered rejects. */
  async open(
    webContents: RelayWebContents,
    slot: CoreSlot = 'primary'
  ): Promise<{ generation: number } | { launchFailed: BootFailure }> {
    if (this.disposed) throw new Error('The core relay is closed.');
    const generation = ++this.generation;
    const windowId = windowIdFor(webContents);
    const key = `${webContents.id}:${slot}`;
    this.parked.get(key)?.();
    this.watch(webContents);
    const replaced = this.live.has(key);
    this.end(key, 1000, 'superseded');
    // Every line of this link carries who it is for; the open line is written where the socket opens, the close line by `finish`.
    const linkLog = createLinkLog(this.options.diagnostic, { link: 'window-port', window: windowId, slot, generation });
    let finished = false;
    const entry: Live = {
      socket: null,
      port: null,
      ended: false,
      generation,
      window: windowId,
      slot,
      openedAt: 0,
      finish: (initiator, code, reason, error) => {
        if (finished) return;
        finished = true;
        linkLog('core-link-close', {
          code,
          reason: reason.slice(0, 200),
          openMs: entry.openedAt ? Date.now() - entry.openedAt : 0,
          initiator,
          ...(error ? { error } : {}),
        });
      },
    };
    this.live.set(key, entry);
    const current = (): boolean => !this.disposed && this.live.get(key) === entry;
    const superseded = (): Error => new Error(`The core port open ${generation} was superseded.`);
    entry.stopReports = this.relayReports(webContents, current);
    try {
      const scope = await this.options.coreWindowScope();
      if (scope === null && !this.loggedNoScope) {
        this.loggedNoScope = true;
        this.log('[mixdog] core-lacks-window-scope: opening the window port without it');
      }
      if (!current()) throw superseded();
      const endpoint = (await this.options.endpointFor(webContents.id, slot)).find(
        (candidate) => candidate.slot === slot
      );
      if (!endpoint) throw new Error(`No core endpoint for slot "${slot}".`);
      if (!current()) throw superseded();
      const socket = (this.options.createSocket ?? defaultSocket)(endpoint.url, {
        Authorization: `Bearer ${endpoint.token}`,
        'Mixdog-Window': windowId,
        'Mixdog-Window-Role': endpoint.role,
      });
      entry.socket = socket;
      // An error always precedes a close event that carries the code. This listener is the link's one place that sees the
      // peer or the network end it, before or after the channel exists; what only exists with the channel is done only then.
      let socketError = '';
      socket.on('error', (error) => {
        socketError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      });
      socket.on('close', (code, reason) => {
        const text = reason.toString('utf8');
        entry.finish('core-or-network', code, text, socketError);
        if (!entry.port || entry.ended) return;
        entry.ended = true;
        if (this.live.get(key) === entry) this.live.delete(key);
        // Why the link went is known here and nowhere after.
        this.log(
          `[mixdog] core socket closed window=${windowId} slot=${slot} code=${code} reason=${JSON.stringify(text.slice(0, 300))}`
        );
        entry.port.postMessage({ t: 'closed', code, reason: text });
        entry.port.close();
      });
      await new Promise<void>((resolveOpen, rejectOpen) => {
        socket.once('open', () => resolveOpen());
        socket.once('error', rejectOpen);
        socket.once('unexpected-response', (_request, response) => {
          socket.terminate();
          rejectOpen(new Error(`The core refused the connection (HTTP ${response.statusCode}).`));
        });
      });
      entry.openedAt = Date.now();
      // `replaced`: a live link of this window and slot was still open and was ended for this one; otherwise the last one had closed already (a reconnect) or there was none.
      linkLog('core-link-open', { role: endpoint.role, replaced });
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
      // The window cannot see a socket's bytes arrive, only whole messages: it is told, as a fact, that bytes of one are arriving.
      observeSocketProgress(socket, () => {
        if (!entry.ended) channel.port1.postMessage({ t: 'progress' });
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          this.log('[mixdog] core sent a binary frame on a window port; dropped');
          return;
        }
        if (!entry.ended) channel.port1.postMessage(data.toString('utf8'));
      });
      channel.port1.on('message', ({ data }) => {
        if (entry.ended) return;
        if (typeof data === 'string') {
          socket.send(data);
          return;
        }
        const note = data as { t?: unknown; token?: unknown; text?: unknown } | null;
        if (note?.t === 'send' && typeof note.token === 'number' && typeof note.text === 'string') {
          // A write receipt for the window's health check: told back only when the socket's own send callback has run, with whether
          // it succeeded. It is a fact about this write, not a ping, and the window never counts it as progress.
          const token = note.token;
          const receipt = (ok: boolean): void => {
            if (!entry.ended) channel.port1.postMessage({ t: 'sent', token, ok });
          };
          try {
            socket.send(note.text, (error) => receipt(!error));
          } catch {
            receipt(false);
          }
        } else if (note?.t === 'settle' && typeof note.token === 'number') {
          // Everything this side accepted from the core before now has been posted ahead of this on the same ordered port.
          channel.port1.postMessage({ t: 'settled', token: note.token });
        } else if (note?.t === 'close') {
          entry.finish('window', 1000, 'window closed the port');
          socket.close(1000, 'window closed the port');
        }
      });
      channel.port1.on('close', () => {
        if (entry.ended) return;
        entry.finish('window', 1000, 'window port closed');
        socket.close(1000, 'window port closed');
      });
      channel.port1.start();
      webContents.postMessage(CORE_PORT_CHANNEL, { generation, slot, role: endpoint.role, target: endpoint.target }, [
        channel.port2,
      ]);
      return { generation };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      if (!entry.openedAt) linkLog('core-link-open-failed', { message });
      // A socket that opened and is torn down by a failed or superseded setup: its close line says so.
      else entry.finish('desktop', 1006, `setup failed: ${message}`);
      const active = current();
      if (active) this.live.delete(key);
      entry.ended = true;
      entry.socket?.terminate();
      entry.port?.close();
      // A start that ends the same way each time is an answer, not an error to retry: the window stops asking and shows why.
      const launchFailed = launchFailedOf(error);
      if (launchFailed && active) {
        this.park(webContents, key);
        return { launchFailed };
      }
      throw error;
    } finally {
      entry.stopReports?.();
    }
  }

  /** Tells the window what the launcher reports of the boot, now and at each change, for as long as `current()` says this open
   *  is the live one; the returned function ends it (and is safe to call again). A superseded or ended open never sends. */
  private relayReports(webContents: RelayWebContents, current: () => boolean): () => void {
    const source = this.options.bootReports;
    if (!source) return () => {};
    let off: (() => void) | null = null;
    const stop = (): void => {
      off?.();
      off = null;
    };
    const tell = (report: BootReport): void => {
      if (!current() || webContents.isDestroyed?.()) return stop();
      webContents.send?.(CORE_BOOT_CHANNEL, report);
    };
    const now = source.current();
    if (now.progress || now.failure) tell(now);
    off = source.subscribe(tell);
    return stop;
  }
  /** A window that was answered `launchFailed` waits for the failure to go away: it is told, from now until it opens again or is destroyed. */
  private park(webContents: RelayWebContents, key: string): void {
    this.parked.get(key)?.();
    const source = this.options.bootReports;
    if (!source) return;
    let off: (() => void) | null = null;
    const stop = (): void => {
      off?.();
      off = null;
      if (this.parked.get(key) === stop) this.parked.delete(key);
    };
    const tell = (report: BootReport): void => {
      if (webContents.isDestroyed?.()) return stop();
      webContents.send?.(CORE_BOOT_CHANNEL, report);
      if (!report.failure) stop();
    };
    this.parked.set(key, stop);
    off = source.subscribe(tell);
    // The failure may have gone between the open's end and now: the window is told what stands.
    tell(source.current());
  }

  /** The user chose to try again: a confirmed failure is withdrawn, and the next open launches the core. */
  retryLaunch(): void {
    this.options.bootReports?.retry();
  }

  closeAll(reason: string): void {
    for (const key of [...this.live.keys()]) this.end(key, CLOSE_ALL_CODE, reason);
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of [...this.parked.values()]) stop();
    for (const key of [...this.live.keys()]) this.end(key, 1000, 'relay disposed');
  }

  private watch(webContents: RelayWebContents): void {
    if (this.watched.has(webContents.id)) return;
    this.watched.add(webContents.id);
    webContents.once('destroyed', () => {
      this.watched.delete(webContents.id);
      this.parked.get(`${webContents.id}:primary`)?.();
      this.parked.get(`${webContents.id}:pc`)?.();
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
    entry.finish('desktop', code, reason);
    entry.stopReports?.();
    if (code === CLOSE_ALL_CODE && !entry.ended) entry.port?.postMessage({ t: 'closed', code, reason });
    entry.ended = true;
    entry.socket?.close(code, reason);
    entry.port?.close();
  }

  private log(message: string): void {
    (this.options.log ?? console.error)(message);
  }
}
