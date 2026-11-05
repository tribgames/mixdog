// Mock transport for the conformance suite: a scripted peer behind the `Connector` seam.
import type { Connector, Target, TransportSink, TransportWriter } from './api.ts';

export class MockConn {
  readonly sent: string[] = [];
  /** Binary frames the client wrote (X17). */
  readonly binary: Uint8Array[] = [];
  clientClose: { code: number; reason: string } | undefined;
  private waiter: ((t: string) => void) | undefined;
  private closedFlag = false;
  private readonly sink: TransportSink;

  constructor(sink: TransportSink) {
    this.sink = sink;
  }

  readonly writer: TransportWriter = {
    send: (text) => {
      if (this.closedFlag) throw new Error('send on closed mock connection');
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = undefined;
        w(text);
      } else this.sent.push(text);
    },
    sendBinary: (data) => {
      if (this.closedFlag) throw new Error('send on closed mock connection');
      this.binary.push(data);
    },
    close: (code, reason) => {
      this.clientClose = { code, reason };
      queueMicrotask(() => this.serverClose(code, reason));
    },
  };

  /** Next frame the client wrote. */
  nextSent(): Promise<string> {
    const queued = this.sent.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((r) => (this.waiter = r));
  }
  serverSend(frame: unknown): void {
    this.sink.frame(JSON.stringify(frame));
  }
  /** A frame as raw text, for payloads that are not valid JSON. */
  serverSendRaw(text: string): void {
    this.sink.frame(text);
  }
  serverClose(code: number, reason = ''): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.sink.closed(code, reason);
  }
}

export class MockNetwork implements Connector {
  failNext = 0;
  private readonly opened: MockConn[] = [];
  private acceptWaiter: ((c: MockConn) => void) | undefined;

  open(_target: Target, sink: TransportSink): Promise<TransportWriter> {
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error('mock open failure'));
    }
    const c = new MockConn(sink);
    if (this.acceptWaiter) {
      const w = this.acceptWaiter;
      this.acceptWaiter = undefined;
      w(c);
    } else this.opened.push(c);
    return Promise.resolve(c.writer);
  }

  /** The next connection the client opened (in order). */
  accept(): Promise<MockConn> {
    const c = this.opened.shift();
    if (c) return Promise.resolve(c);
    return new Promise((r) => (this.acceptWaiter = r));
  }
}
