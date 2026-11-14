// A minimal CDP client (Node's global WebSocket) for the dev Electron main's V8 inspector (dev-isolated.mjs start
// --inspect-main=<port>) and for the instance's renderer page (its --remote-debugging-port).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error(`cdp connect failed: ${e.message ?? 'error'}`)), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`cdp ${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  /** Runtime.evaluate returning the value (JSON-serializable) or throwing the page's exception text. */
  const evaluate = async (expression, { awaitPromise = true, timeoutMs } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`evaluate threw: ${d.exception?.description ?? d.text}`);
    }
    return r.result?.value;
  };
  return { send, evaluate, on: (l) => listeners.add(l), close: () => ws.close() };
}

/** The Electron main's inspector target (`type: node`) on `port`, waited for. */
export async function connectMain(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
      const target = list.find((t) => t.webSocketDebuggerUrl) ?? null;
      if (target) return { target, cdp: await cdpConnect(target.webSocketDebuggerUrl) };
    } catch {}
    if (Date.now() > deadline) throw new Error(`no inspector on 127.0.0.1:${port} after ${timeoutMs} ms`);
    await sleep(500);
  }
}

/** The instance's renderer page (the main window) on its CDP port. */
export async function connectRenderer(cdpPort, rendererPort) {
  const list = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
  const target = list.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${rendererPort}/`));
  if (!target) throw new Error(`no renderer page on CDP ${cdpPort}: ${list.map((t) => `${t.type} ${t.url}`).join(', ')}`);
  return { target, cdp: await cdpConnect(target.webSocketDebuggerUrl), targets: list };
}
