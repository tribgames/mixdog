// The OS proxy (WinINET/registry, macOS settings, PAC, WPAD, exceptions) for
// this PC's daemon. Chromium follows it; Node does not, so the daemon asks this
// app per origin (src/runtime/shared/llm/system-proxy.mjs
// attachSystemProxyResolver): the desktop service it hosts publishes each
// lookup as an event, and the window answers with session.resolveProxy. The
// answer is never exported as HTTPS_PROXY / HTTP_PROXY / NO_PROXY, which every
// shell and tool the daemon spawns would inherit.

/** Must match SYSTEM_PROXY_REQUEST_EVENT in src/runtime/shared/llm/system-proxy.mjs. */
export const SYSTEM_PROXY_REQUEST_EVENT = 'system-proxy-request';
/** Attaches the calling app as the resolver of the connection's daemon. */
export const SYSTEM_PROXY_ATTACH_OPERATION = 'systemProxyAttach';
/** The window's answer to one lookup. */
export const SYSTEM_PROXY_RESOLVED_OPERATION = 'systemProxyResolved';
/** The daemon goes DIRECT after the same bound. */
export const SYSTEM_PROXY_RESOLVE_TIMEOUT_MS = 3_000;

export interface SystemProxyModule {
  attachSystemProxyResolver(resolve: (origin: string) => Promise<unknown>): () => void;
}

/**
 * The daemon side (in the desktop service): this PC's resolver, attached while
 * at least one desktop client that asked for it is connected (by its client
 * epoch, released with the client). `load` gives the daemon's system-proxy
 * module (undefined on an older daemon), `request` asks the window once.
 */
export function createSystemProxyLease(
  load: () => Promise<SystemProxyModule> | undefined,
  request: (origin: string) => Promise<unknown>
) {
  const epochs = new Set<number>();
  let attachment: Promise<(() => void) | null> | null = null;
  const detach = (): void => {
    const current = attachment;
    attachment = null;
    void current?.then((release) => release?.());
  };
  return {
    async attach(epoch: number): Promise<boolean> {
      if (!Number.isSafeInteger(epoch)) return false;
      epochs.add(epoch);
      attachment ??= Promise.resolve(load())
        .then((module) => module?.attachSystemProxyResolver(request) ?? null)
        .catch(() => null);
      return (await attachment) !== null;
    },
    release(epoch: number): void {
      if (epochs.delete(epoch) && epochs.size === 0) detach();
    },
    dispose(): void {
      epochs.clear();
      detach();
    },
  };
}

/**
 * The window side: answer one lookup event (`{ id, args: [origin] }`) with
 * Chromium's answer for that origin. A failure answers with the error's name
 * only: its message may quote a PAC URL with credentials.
 */
export async function answerSystemProxyRequest(
  value: unknown,
  resolveProxy: (url: string) => Promise<string>,
  settle: (args: unknown[]) => Promise<unknown>
): Promise<void> {
  const request = value && typeof value === 'object' ? (value as { id?: unknown; args?: unknown }) : {};
  const id = typeof request.id === 'string' ? request.id : '';
  if (!id) return;
  try {
    const url = new URL(String(Array.isArray(request.args) ? request.args[0] : ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('not an http(s) origin');
    await settle([id, true, await resolveProxy(url.origin), null]);
  } catch (error) {
    await settle([id, false, null, error instanceof Error ? error.name : 'Error']).catch(() => {});
  }
}
