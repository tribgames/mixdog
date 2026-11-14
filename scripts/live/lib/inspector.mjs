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

// ── R2 instruments, run inside the Electron main through Runtime.evaluate ──

/** Starts (or restarts) the event-loop delay histogram (10 ms resolution) and a 1 s ELU sampler in the main process. */
export const R2_START = `(() => {
  const ph = process.getBuiltinModule('node:perf_hooks');
  const prior = globalThis.__latR2;
  if (prior) { clearInterval(prior.timer); prior.eld.disable(); }
  const eld = ph.monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  // Electron's main process does not feed libuv's idle-time metrics, so eventLoopUtilization() reads 0/0 there; the main
  // thread's own CPU time (process.threadCpuUsage, Node 23.9+) over wall time is the duty cycle that is measured instead.
  const thread = () => { const u = process.threadCpuUsage ? process.threadCpuUsage() : null; return u ? u.user + u.system : null; };
  let last = ph.performance.eventLoopUtilization();
  let lastCpu = thread();
  let lastProc = process.cpuUsage();
  let lastAt = ph.performance.now();
  const samples = [];
  const timer = setInterval(() => {
    const now = ph.performance.eventLoopUtilization();
    const d = ph.performance.eventLoopUtilization(now, last);
    last = now;
    const at = ph.performance.now();
    const cpu = thread();
    const proc = process.cpuUsage();
    const wallUs = (at - lastAt) * 1000;
    const mem = process.memoryUsage();
    samples.push({
      t: Date.now(), wallMs: wallUs / 1000,
      mainThreadCpuPct: cpu !== null && lastCpu !== null ? ((cpu - lastCpu) / wallUs) * 100 : null,
      mainProcessCpuPct: ((proc.user + proc.system - lastProc.user - lastProc.system) / wallUs) * 100,
      elu: d.utilization, eluActiveMs: d.active, eluIdleMs: d.idle, heapUsed: mem.heapUsed, rss: mem.rss,
    });
    lastCpu = cpu; lastProc = proc; lastAt = at;
  }, 1000);
  globalThis.__latR2 = { eld, samples, timer, startedAt: Date.now(), resolutionMs: 10, cpuAtStart: thread(), wallAtStart: ph.performance.now() };
  return { ok: true, startedAt: globalThis.__latR2.startedAt, threadCpuUsage: typeof process.threadCpuUsage };
})()`;

/** Reads the window since the last read (ELU samples, delay histogram in ms) and resets the histogram. */
export const R2_READ = `(() => {
  const s = globalThis.__latR2;
  if (!s) return { ok: false };
  const h = s.eld;
  const ms = (ns) => (Number.isFinite(ns) ? ns / 1e6 : null);
  const u = process.threadCpuUsage ? process.threadCpuUsage() : null;
  const wallUs = (process.getBuiltinModule('node:perf_hooks').performance.now() - s.wallAtStart) * 1000;
  const out = {
    ok: true, from: s.startedAt, to: Date.now(), resolutionMs: s.resolutionMs,
    // The whole window: main-thread CPU time / wall time (Windows thread times tick at ~15.6 ms).
    mainThreadCpuPctWindow: u && s.cpuAtStart !== null ? ((u.user + u.system - s.cpuAtStart) / wallUs) * 100 : null,
    samples: s.samples.splice(0),
    delay: { count: h.count, min: ms(h.min), mean: ms(h.mean), stddev: ms(h.stddev), max: ms(h.max),
      p50: ms(h.percentile(50)), p90: ms(h.percentile(90)), p95: ms(h.percentile(95)), p99: ms(h.percentile(99)) },
  };
  h.reset();
  s.startedAt = Date.now();
  s.cpuAtStart = u ? u.user + u.system : null;
  s.wallAtStart = process.getBuiltinModule('node:perf_hooks').performance.now();
  return out;
})()`;

export const R2_STOP = `(() => { const s = globalThis.__latR2; if (s) { clearInterval(s.timer); s.eld.disable(); delete globalThis.__latR2; } return true; })()`;

const META = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);

/** Shares of the profile's meta nodes ((idle), (program), (garbage collector)) and the JS share (everything else). */
export function profileShares(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const { samples = [], timeDeltas = [] } = profile;
  const totals = { idle: 0, program: 0, gc: 0, js: 0 };
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const dt = timeDeltas[i + 1] ?? timeDeltas[i] ?? 0;
    const name = byId.get(samples[i])?.callFrame.functionName;
    if (name === '(idle)') totals.idle += dt;
    else if (name === '(program)') totals.program += dt;
    else if (name === '(garbage collector)') totals.gc += dt;
    else totals.js += dt;
    total += dt;
  }
  const pct = (v) => (total ? Math.round((v / total) * 1000) / 10 : 0);
  return { totalMs: Math.round(total / 1000), idlePct: pct(totals.idle), programPct: pct(totals.program), gcPct: pct(totals.gc), jsPct: pct(totals.js), busyPct: pct(total - totals.idle) };
}

/** Top `n` functions by self time of a CDP Profiler profile (the meta nodes left out; see profileShares). */
export function topFunctions(profile, n = 10) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const { samples = [], timeDeltas = [] } = profile;
  for (let i = 0; i < samples.length; i += 1) {
    const dt = timeDeltas[i + 1] ?? timeDeltas[i] ?? 0;
    self.set(samples[i], (self.get(samples[i]) ?? 0) + dt);
  }
  const agg = new Map();
  let total = 0;
  for (const [id, us] of self) {
    const node = byId.get(id);
    if (!node) continue;
    const cf = node.callFrame;
    total += us;
    if (META.has(cf.functionName)) continue;
    const key = `${cf.functionName || '(anonymous)'} ${cf.url ? cf.url.replace(/^.*[\\/]/, '') : ''}:${cf.lineNumber + 1}`;
    agg.set(key, (agg.get(key) ?? 0) + us);
  }
  // pct: of the whole window (idle included); `profileShares` gives the idle/program/gc split.
  return [...agg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([fn, us]) => ({ fn, selfMs: Math.round(us / 10) / 100, pct: total ? Math.round((us / total) * 10000) / 100 : 0 }));
}
