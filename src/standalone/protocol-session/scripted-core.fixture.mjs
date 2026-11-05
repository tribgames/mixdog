// Test double of the Rust core's wire behaviour for the session view: the protocol-client mock transport plus a
// scripted peer that answers the requests a TUI session makes (initialize, thread/start, thread/resume, turn/*,
// session actions) and feeds thread notifications with a feed stamp. It is a stand-in until the real core lands.
import { readFileSync } from 'node:fs';
import { MockNetwork } from '../../../packages/protocol-client/src/mock.ts';

const OPTIONS = JSON.parse(
  readFileSync(new URL('../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);

export const summary = (id, cwd) => ({
  id,
  preview: '',
  title: id,
  updatedAt: 1,
  messageCount: 0,
  cwd,
  classification: {},
});

/** A handler's full answer: esult or rror, and notifications to send after it. A plain return value is the result. */
export class Reply {
  constructor({ result, error, then = [] }) {
    this.result = result;
    this.error = error;
    this.then = then;
  }
}

export class ScriptedCore {
  constructor({ cwd = '/work', instance = 's1', handlers = {} } = {}) {
    this.net = new MockNetwork();
    this.cwd = cwd;
    this.instance = instance;
    this.handlers = handlers;
    this.received = [];
    this.conns = [];
    this.threads = new Map();
    this.created = 0;
    this.serving = this.#accept();
  }

  get conn() {
    return this.conns.at(-1);
  }

  /** Methods of the requests (not notifications) the client sent, in order. */
  methods() {
    return this.received.filter((frame) => frame.id !== undefined).map((frame) => frame.method);
  }

  request(method) {
    return this.received.filter((frame) => frame.method === method);
  }

  thread(id) {
    if (!this.threads.has(id)) this.threads.set(id, { epoch: 'e1', seq: 10, items: [], log: [] });
    return this.threads.get(id);
  }

  frame(id, method, params) {
    const thread = this.thread(id);
    thread.seq += 1;
    const frame = { method, params, feed: { id, epoch: thread.epoch, seq: thread.seq } };
    thread.log.push(frame);
    if (method === 'item/completed') thread.items.push(params.item);
    return frame;
  }

  /** Publishes a feed notification of `threadId` to the connected client. */
  emit(threadId, method, params) {
    this.conn.serverSend(this.frame(threadId, method, params));
  }

  async #accept() {
    for (;;) {
      const conn = await this.net.accept();
      this.conns.push(conn);
      void this.#pump(conn);
    }
  }

  async #pump(conn) {
    for (;;) {
      const frame = JSON.parse(await conn.nextSent());
      this.received.push(frame);
      if (frame.id === undefined) continue;
      const { result, error, then = [] } = this.#answer(frame);
      conn.serverSend(error ? { id: frame.id, error } : { id: frame.id, result });
      for (const next of then) conn.serverSend(next);
    }
  }

  #answer(frame) {
    const custom = this.handlers[frame.method];
    if (custom) {
      const answered = custom(frame.params, this, frame);
      if (answered !== undefined) return answered instanceof Reply ? answered : { result: answered };
    }
    switch (frame.method) {
      case 'initialize':
        return { result: { ...OPTIONS.initializeResult, serverInstanceId: this.instance } };
      case 'thread/start': {
        this.created += 1;
        const id = `t${this.created}`;
        return { result: { thread: summary(id, frame.params.projectPath ?? this.cwd) } };
      }
      case 'thread/resume': {
        const { threadId, resumeFrom } = frame.params;
        const thread = this.thread(threadId);
        const info = summary(threadId, this.cwd);
        if (resumeFrom?.epoch === thread.epoch) {
          const missed = thread.log.filter((entry) => entry.feed.seq > resumeFrom.seq);
          return {
            result: { thread: info, subscription: { id: `sub-${threadId}`, mode: 'replay', epoch: thread.epoch, startSeq: resumeFrom.seq + 1 } },
            then: missed,
          };
        }
        const snapshot = {
          method: 'thread/snapshot',
          params: { thread: info, state: {}, items: thread.items, hasOlder: false },
          feed: { id: threadId, epoch: thread.epoch, seq: thread.seq },
        };
        return {
          result: { thread: info, subscription: { id: `sub-${threadId}`, mode: 'snapshot', epoch: thread.epoch, startSeq: thread.seq + 1 } },
          then: [snapshot],
        };
      }
      case 'turn/start':
        return { result: { kind: 'started', turnId: 'u1' } };
      case 'turn/interrupt':
        return { result: { cancelRequested: true, turnId: 'u1' } };
      case 'thread/unsubscribe':
        return { result: {} };
      default:
        return { result: null };
    }
  }
}
