// The worker side of the ext-host frame protocol (frame.mjs): one call at a time, chunks under a
// byte window the core re-grants, cancel through an AbortSignal. Nothing here knows office or pdf;
// the methods live in methods.mjs.
import { CALL_WINDOW_BYTES, FrameDecoder, Kind, MAX_CHUNK_BYTES, encodeFrame } from './frame.mjs';

const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * handlers: `{ [method]: async (ctx) => ({ value, pin }) }`.
 *   ctx = { id, method, params, paths, thread, cwd, signal, emit(bytes), requestBrowser() }
 *   `emit` sends chunk bytes and waits while the call's window is exhausted.
 *   `requestBrowser` asks the core for the shared render browser's DevTools endpoint.
 *   `pin: true` tells the core this worker now holds state for the call's thread.
 */
export function runWorker({ handlers, input, write, exit, windowBytes = CALL_WINDOW_BYTES }) {
  const decoder = new FrameDecoder();
  let active = null;

  const send = (kind, id, body) => write(encodeFrame(kind, id, body));

  function wakeAll(call, settle) {
    const waiters = [...call.waiters];
    call.waiters.clear();
    for (const waiter of waiters) settle(waiter);
  }

  // A promise the core's next credit/browser frame resolves and a cancel rejects.
  function wait(call, onWaiter) {
    return new Promise((resolve, reject) => {
      if (call.controller.signal.aborted) return reject(coded('cancelled', 'call cancelled'));
      const waiter = { resolve, reject };
      call.waiters.add(waiter);
      onWaiter?.(waiter);
    });
  }

  async function emit(call, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      if (call.credit === 0) await wait(call);
      const size = Math.min(bytes.length - offset, call.credit, MAX_CHUNK_BYTES);
      if (size === 0) continue;
      call.credit -= size;
      send(Kind.CHUNK, call.id, bytes.subarray(offset, offset + size));
      offset += size;
    }
  }

  function requestBrowser(call) {
    call.browser ??= (async () => {
      send(Kind.NEED_BROWSER, call.id);
      const answer = await wait(call, (waiter) => {
        call.browserWaiter = waiter;
      });
      if (answer.error) throw coded('browser_unavailable', String(answer.error));
      return answer.ws;
    })();
    call.browser.catch(() => {}); // a handler that stopped waiting must not leave an unhandled rejection
    return call.browser;
  }

  async function runCall(call, request) {
    let frame;
    let pin = false;
    try {
      const handler = Object.hasOwn(handlers, request.method) ? handlers[request.method] : null;
      if (!handler) throw coded('unknown_method', `unknown ext-host method ${request.method}`);
      const outcome = await handler({
        id: call.id,
        method: request.method,
        params: request.params ?? null,
        paths: request.paths ?? [],
        thread: request.thread ?? '',
        cwd: request.cwd ?? '',
        signal: call.controller.signal,
        emit: (bytes) => emit(call, bytes),
        requestBrowser: () => requestBrowser(call),
      });
      pin = outcome?.pin === true;
      frame = { ok: outcome?.value ?? null, pin };
    } catch (error) {
      frame = { err: { code: String(error?.code ?? 'failed'), message: String(error?.message ?? error) }, pin };
    }
    if (call.controller.signal.aborted) frame = { err: { code: 'cancelled', message: 'call cancelled' }, pin };
    send(Kind.RESULT, call.id, Buffer.from(JSON.stringify(frame)));
    active = null;
  }

  function onFrame({ kind, id, body }) {
    switch (kind) {
      case Kind.CALL: {
        if (active) throw new Error('ext-host: a call arrived while another is running');
        const call = {
          id,
          controller: new AbortController(),
          credit: windowBytes,
          waiters: new Set(),
          browser: null,
          browserWaiter: null,
        };
        call.controller.signal.addEventListener(
          'abort',
          () => wakeAll(call, (waiter) => waiter.reject(coded('cancelled', 'call cancelled'))),
          { once: true }
        );
        active = call;
        void runCall(call, JSON.parse(body.toString('utf8')));
        return;
      }
      case Kind.CANCEL:
        if (active?.id === id) active.controller.abort();
        return;
      case Kind.CREDIT:
        if (active?.id === id) {
          active.credit += body.readUInt32BE(0);
          wakeAll(active, (waiter) => waiter.resolve());
        }
        return;
      case Kind.BROWSER:
        if (active?.id === id && active.browserWaiter) {
          const waiter = active.browserWaiter;
          active.browserWaiter = null;
          active.waiters.delete(waiter);
          waiter.resolve(JSON.parse(body.toString('utf8')));
        }
        return;
      case Kind.BYE:
        shutdown();
        return;
      default:
        throw new Error(`ext-host: unknown frame kind ${kind}`);
    }
  }

  function shutdown() {
    active?.controller.abort();
    exit(0);
  }

  input.on('data', (bytes) => {
    try {
      for (const frame of decoder.push(bytes)) onFrame(frame);
    } catch (error) {
      process.stderr.write(`ext-host protocol error: ${error?.message ?? error}\n`);
      exit(2);
    }
  });
  input.on('end', shutdown);
  send(Kind.READY, 0);
}
