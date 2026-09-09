import type { WebContentsView, Cookie, CookiesSetDetails, Session } from 'electron';

export interface BrowserCookiePartitionKey {
  topLevelSite: string;
  hasCrossSiteAncestor: boolean;
}

export interface BrowserCookie extends Cookie {
  partitionKey?: BrowserCookiePartitionKey;
}

export interface BrowserCookieSetDetails extends CookiesSetDetails {
  partitionKey?: BrowserCookiePartitionKey;
}

export interface BrowserCookieFilter {
  url?: string;
  name?: string;
  /** null selects only unpartitioned cookies; omission selects every partition. */
  partitionKey?: BrowserCookiePartitionKey | null;
}

export interface BrowserCookieJar {
  readonly supportsPartitions?: boolean;
  get(filter: BrowserCookieFilter): Promise<BrowserCookie[]>;
  set(details: BrowserCookieSetDetails): Promise<void>;
  remove(url: string, name: string, partitionKey?: BrowserCookiePartitionKey): Promise<void>;
  flushStore(): Promise<void>;
}

export function storedCookieSetDetails(cookie: BrowserCookie): BrowserCookieSetDetails {
  if (!cookie.domain) throw new Error('Stored cookie has no domain.');
  const host = cookie.domain.replace(/^\./, '');
  return {
    url: `https://${host}${cookie.path || '/'}`,
    name: cookie.name,
    value: cookie.value,
    ...(!cookie.hostOnly ? { domain: cookie.domain } : {}),
    path: cookie.path || '/',
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(!cookie.session ? { expirationDate: cookie.expirationDate } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookiePartitionKey(cookie.partitionKey) } : {}),
  };
}

function parseCookiePartition(value: unknown): { key: BrowserCookiePartitionKey; site: URL } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cookie partition identity is invalid.');
  }
  const key = value as Partial<BrowserCookiePartitionKey>;
  if (typeof key.topLevelSite !== 'string' || typeof key.hasCrossSiteAncestor !== 'boolean') {
    throw new Error('Cookie partition identity is invalid.');
  }
  let site: URL;
  try {
    site = new URL(key.topLevelSite);
  } catch {
    throw new Error('Cookie partition identity is invalid.');
  }
  return {
    key: { topLevelSite: key.topLevelSite, hasCrossSiteAncestor: key.hasCrossSiteAncestor },
    site,
  };
}

/** Browser-internal UI state is not a portable web-site session. */
export function isBrowserInternalCookiePartition(value: unknown): boolean {
  const parsed = parseCookiePartition(value);
  if (!parsed) return false;
  const { key, site } = parsed;
  return ['chrome:', 'chrome-untrusted:'].includes(site.protocol)
    && Boolean(site.hostname)
    && !site.username && !site.password && site.pathname === ''
    && !site.search && !site.hash
    && key.topLevelSite === `${site.protocol}//${site.host}`;
}

/** Reject an unrepresentable key instead of widening it to an ordinary cookie. */
export function cookiePartitionKey(value: unknown): BrowserCookiePartitionKey | undefined {
  const parsed = parseCookiePartition(value);
  if (!parsed) return undefined;
  const { key, site } = parsed;
  if (!['https:', 'http:'].includes(site.protocol) || site.origin !== key.topLevelSite) {
    throw new Error('Cookie partition identity is invalid.');
  }
  return key;
}

function samePartition(left?: BrowserCookiePartitionKey, right?: BrowserCookiePartitionKey | null): boolean {
  return left?.topLevelSite === right?.topLevelSite
    && left?.hasCrossSiteAncestor === right?.hasCrossSiteAncestor;
}

function matches(cookie: BrowserCookie, filter: BrowserCookieFilter): boolean {
  if (filter.name !== undefined && cookie.name !== filter.name) return false;
  if (filter.partitionKey !== undefined && !samePartition(cookie.partitionKey, filter.partitionKey)) return false;
  if (!filter.url) return true;
  const url = new URL(filter.url);
  const domain = (cookie.domain || '').replace(/^\./, '');
  if (url.hostname !== domain && (cookie.hostOnly || !url.hostname.endsWith(`.${domain}`))) return false;
  if (cookie.secure && url.protocol !== 'https:') return false;
  const path = cookie.path || '/';
  return url.pathname === path
    || (url.pathname.startsWith(path) && (path.endsWith('/') || url.pathname[path.length] === '/'));
}

interface ProtocolCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expires: number;
  sameSite?: 'None' | 'Lax' | 'Strict';
  partitionKey?: BrowserCookiePartitionKey;
  partitionKeyOpaque?: boolean;
}

class CookieContextError extends Error {}

function fromProtocol(cookie: ProtocolCookie): BrowserCookie {
  if (cookie.partitionKeyOpaque) {
    throw new Error('An opaque cookie partition cannot be safely backed up or restored.');
  }
  const partitionKey = cookiePartitionKey(cookie.partitionKey);
  return {
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    hostOnly: !cookie.domain.startsWith('.'), secure: cookie.secure, httpOnly: cookie.httpOnly,
    session: cookie.session,
    sameSite: cookie.sameSite === 'None' ? 'no_restriction'
      : cookie.sameSite === 'Lax' ? 'lax' : cookie.sameSite === 'Strict' ? 'strict' : 'unspecified',
    ...(!cookie.session ? { expirationDate: cookie.expires } : {}),
    ...(partitionKey ? { partitionKey } : {}),
  };
}

/**
 * The private, blank target is tied to the supplied Electron Session, never
 * the browser-wide default context or an external Chrome profile. CDP retains
 * partition identity that Electron's cookie API cannot represent.
 */
export function createBrowserCookieJar(partition: Session): BrowserCookieJar & { dispose(): Promise<void> } {
  let view: WebContentsView | undefined;
  let ready: Promise<WebContentsView> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let generation = 0;

  function closeTarget() {
    generation += 1;
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    view = undefined;
    ready = undefined;
  }

  function target(): Promise<WebContentsView> {
    if (!ready) {
      const expectedGeneration = generation;
      ready = (async () => {
        const { WebContentsView } = await import('electron');
        if (disposed || generation !== expectedGeneration) throw new Error('Cookie target was closed.');
        const owner = new WebContentsView({
          webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        view = owner;
        const contents = owner.webContents;
        if (contents.session !== partition) throw new CookieContextError('Cookie context ownership mismatch.');
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.debugger.attach('1.3');
        await contents.loadURL('about:blank');
        return owner;
      })();
    }
    return ready;
  }

  function send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const result = chain.then(async () => {
      if (disposed) throw new Error('Cookie storage is closed.');
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          target().then((owner) => owner.webContents.debugger.sendCommand(method, params) as Promise<T>),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Cookie storage command timed out.')), 10_000);
          }),
        ]);
      } catch (error) {
        closeTarget();
        if (error instanceof CookieContextError) throw error;
        // Protocol errors can contain cookie values. Never forward their text.
        throw new Error(`Cookie storage ${method} failed; no automatic retry was performed.`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    chain = result.catch(() => undefined);
    return result;
  }

  async function get(filter: BrowserCookieFilter): Promise<BrowserCookie[]> {
    // Storage.getCookies resolves browser-managed contexts, not Electron's
    // Session contexts, and otherwise silently reads the default partition.
    // The target-scoped Network method retains the exact owning Session.
    const response = await send<{ cookies: ProtocolCookie[] }>('Network.getAllCookies');
    return response.cookies.map(fromProtocol).filter((cookie) => matches(cookie, filter));
  }

  return {
    supportsPartitions: true,
    get,
    async set(details) {
      if (disposed) throw new Error('Cookie storage is closed.');
      const partitionKey = cookiePartitionKey(details.partitionKey);
      if (!partitionKey) {
        await partition.cookies.set(details);
        return;
      }
      if (details.secure !== true) throw new Error('Partitioned cookies require Secure.');
      const result = await send<{ success: boolean }>('Network.setCookie', {
        url: details.url, name: details.name || '', value: details.value || '',
        ...(details.domain ? { domain: details.domain } : {}),
        path: details.path || '/', secure: true, httpOnly: details.httpOnly === true,
        ...(details.expirationDate !== undefined ? { expires: details.expirationDate } : {}),
        ...(details.sameSite && details.sameSite !== 'unspecified' ? {
          sameSite: details.sameSite === 'no_restriction' ? 'None' : details.sameSite === 'lax' ? 'Lax' : 'Strict',
        } : {}),
        partitionKey,
      });
      if (!result.success) throw new Error('Partitioned cookie was not accepted.');
    },
    async remove(url, name, partitionKey) {
      for (const cookie of await get({ url, name, partitionKey: partitionKey ?? null })) {
        await send('Network.deleteCookies', {
          domain: cookie.domain, path: cookie.path, name: cookie.name,
          ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
        });
      }
    },
    flushStore: () => partition.cookies.flushStore(),
    async dispose() {
      disposed = true;
      await chain;
      closeTarget();
    },
  };
}
