/** A visible surface follows display cadence, independently of input completion.
 * Wakeups replace a scheduled read, never overlap one or wait for an idle-page
 * backoff. Recovery errors alone use a bounded slower cadence. */
export function createBrowserPresentationLoop(host: {
  read(): Promise<void>;
  visible(): boolean;
  now(): number;
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
  failed(error: unknown): number;
}) {
  const interval = 1000 / 60;
  let stopped = false;
  let running = false;
  let timer: unknown;
  function schedule(delay: number) {
    if (timer !== undefined) host.cancel(timer);
    timer = host.schedule(() => { timer = undefined; void poll(); }, delay);
  }
  async function poll() {
    if (stopped || running || !host.visible()) return;
    running = true;
    const started = host.now();
    let delay: number | undefined;
    try { await host.read(); }
    catch (error) { if (!stopped) delay = host.failed(error); }
    finally {
      running = false;
      if (!stopped && host.visible()) schedule(delay ?? Math.max(0, interval - (host.now() - started)));
    }
  }
  return {
    wake() {
      if (stopped) return;
      if (timer !== undefined) { host.cancel(timer); timer = undefined; }
      if (!running) void poll();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) host.cancel(timer);
      timer = undefined;
    },
  };
}
