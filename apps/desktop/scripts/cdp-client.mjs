// Shared CDP websocket client for the desktop probes: one socket, id-matched
// requests with per-instance timeouts, and event subscriptions. Probes differ
// only in their timeout budgets, so those are constructor options.
export class CdpClient {
  constructor(url, { defaultTimeoutMs = 20_000, connectTimeoutMs = 15_000 } = {}) {
    this.socket = new WebSocket(url);
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  /** Subscribe to a CDP event (`Tracing.dataCollected` …); returns unsubscribe. */
  on(method, listener) {
    const set = this.listeners.get(method) || new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => {
      set.delete(listener);
    };
  }

  async connect() {
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        if (message.method) {
          for (const listener of this.listeners.get(message.method) || []) listener(message.params);
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), this.connectTimeoutMs);
      this.socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolvePromise();
        },
        { once: true }
      );
      this.socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP websocket failed.'));
        },
        { once: true }
      );
    });
  }

  request(method, params = {}, timeoutMs = this.defaultTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = this.defaultTimeoutMs) {
    const response = await this.request(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs
    );
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  close() {
    this.socket.close();
  }
}

/** Polls the CDP target list until the renderer page is debuggable. `pollMs`
 *  is the caller's own interval; each request is bounded by the time left on
 *  the deadline, so a CDP socket that accepts and then hangs cannot outlive
 *  it. */
export async function waitForTarget(port, child, { pollMs = 50, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}.`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      }).then((response) => response.json());
      const target = targets.find(
        (candidate) => candidate.type === 'page' && candidate.url?.includes('/out/renderer/index.html')
      );
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {
      // CDP is not listening yet.
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
  throw new Error(`CDP target did not appear on port ${port}.`);
}

/** The errors a renderer throws while it is swapping execution contexts
 *  (reload, boot navigation) — retryable, unlike a real evaluation failure. */
const CONTEXT_SWAP = /Execution context was destroyed|Cannot find context|Failed to read the 'localStorage' property/i;

/** Evaluates across those swaps until `timeoutMs` runs out. Callers pin their
 *  own budget: the probes measure different phases. */
export async function evaluateStable(client, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await client.evaluate(expression, Math.max(1_000, deadline - Date.now()));
    } catch (error) {
      lastError = error;
      if (!CONTEXT_SWAP.test(String(error?.message || error))) throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw lastError || new Error('Renderer execution context did not stabilize.');
}

/** Asks the app to quit, then terminates it if it has not exited within
 *  `graceMs`. Profile-level cleanup stays with the caller that owns it. */
export async function stopApp(client, child, { graceMs = 4_000 } = {}) {
  try {
    await client.evaluate('window.mixdogDesktop?.quit?.()', 5_000);
  } catch {
    // Process termination below is the bounded fallback.
  }
  client.close();
  await Promise.race([
    new Promise((done) => child.once('exit', done)),
    new Promise((done) => setTimeout(done, graceMs)),
  ]);
  if (child.exitCode === null) child.kill();
}
