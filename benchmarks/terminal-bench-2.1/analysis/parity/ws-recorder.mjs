// The `ws` package as Node's providers see it, standing in for the socket at the transport boundary: the module the
// pool imports (`await import('ws')`) resolves to this file (ws-hooks.mjs), so the pool's own handshake code builds the
// headers and url, and its own send path writes the frames. The recorder keeps what was handed to the socket, and
// plays the scripted server: a dial is accepted or refused as the script says, and each frame sent is answered with the
// next scripted event list. Nothing leaves the process; no timer runs (a reply is delivered when the stream consumer
// attaches its `message` listener, which is when a real server's reply would find a reader).
import { EventEmitter } from 'node:events';

export const traffic = { sink: null, script: null };

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class Upgrade extends EventEmitter {
  constructor(statusCode, headers, body) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
    this.body = body;
  }
}

export default class WebSocket extends EventEmitter {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = 2;
  static CLOSED = CLOSED;

  constructor(url, options = {}) {
    super();
    this.readyState = CONNECTING;
    this.pending = [];
    traffic.sink.push({ kind: 'ws-handshake', url: String(url), headers: Object.entries(options.headers || {}) });
    const dial = traffic.script.dials.shift() ?? { accept: true };
    queueMicrotask(() => {
      if (dial.accept) {
        this.emit('upgrade', new Upgrade(101, {}, ''));
        this.readyState = OPEN;
        this.emit('open');
        return;
      }
      const response = new Upgrade(dial.status, dial.headers || {}, dial.body || '');
      this.emit('unexpected-response', {}, response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(response.body));
        response.emit('end');
      });
    });
  }

  on(event, listener) {
    super.on(event, listener);
    if (event === 'message') this.deliver();
    return this;
  }

  send(payload, callback) {
    traffic.sink.push({ kind: 'ws-frame', text: String(payload) });
    this.pending.push(traffic.script.replies.shift() ?? []);
    callback?.(null);
  }

  /** Replies to the frames sent, once someone reads. */
  deliver() {
    if (!this.pending.length || this.listenerCount('message') < 2) return;
    const events = this.pending.shift();
    queueMicrotask(() => {
      for (const event of events) this.emit('message', Buffer.from(JSON.stringify(event)), false);
    });
  }

  ping() {}
  close() {
    this.readyState = CLOSED;
  }
  terminate() {
    this.readyState = CLOSED;
  }
}
