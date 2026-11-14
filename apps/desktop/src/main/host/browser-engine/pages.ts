/**
 * The pages methods of the browser engine lane (`host/browser/pages/*`): which
 * page a session's command works on (resolve, with the lease the command
 * holds it by), the pages a session owns (list), closing one, and showing,
 * hiding or handing off the session's pane (surface).
 *
 * They are session methods: the page they name may not exist yet, so they go
 * through registerEngineSessionMethod and carry no `facts` of their own beyond
 * the descriptors (which also say whether this call made the page and whether a turn may reclaim it). The placement rules are the old command runner's (a tab
 * reference, a background page, a visible page of its own for an agent
 * command, the pane's page for an adopting one); the pane requests go through
 * the lifecycle, which also reports each reveal and hide as
 * `host/browser/surface` (registerBrowserSurfaceReport listens to it).
 */
import type { PageDescriptor, PageFacts } from '../../../../../../packages/protocol/src/index.ts';
import { type BrowserGuestStateStore } from '../../browser/guest-state';
import { browserSessionId, type BrowserSessionRegistry } from '../../browser/session-registry';
import type { createBrowserGuestLifecycle } from '../../browser/guest-lifecycle';
import type { createBrowserTabs } from '../../browser/tabs';
import type { createBrowserTaskLifecycle } from '../../browser/task-lifecycle';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext } from './context';
import { ENGINE_ERROR } from './errors';
import { admitUrl, loadUrl, type PageHost } from './page';
import { type EnginePageCall, registerEngineSessionMethod } from './registry';

type Guest = NonNullable<ReturnType<BrowserSessionRegistry['liveGuest']>>;
type Lifecycle = ReturnType<typeof createBrowserGuestLifecycle>;

/** The lease store (s4-host-lease): what a command holds a page by while it runs. */
export interface PageLeases {
  acquire(pageId: string, commandId: string, ttlMs: number): string;
}

/** What the pages methods reach besides the engine context; the wiring task builds it from the live host. */
export interface PagesHost {
  sessions: Pick<
    BrowserSessionRegistry,
    'visibleGuests' | 'backgroundPages' | 'currentGuest' | 'liveGuest' | 'backgroundPageForGuest' | 'setAgentPage' | 'sessionIdForGuest'
  >;
  tabs: Pick<ReturnType<typeof createBrowserTabs>, 'resolveTargetGuest'>;
  lifecycle: Pick<
    Lifecycle,
    | 'restoreSession'
    | 'ensureGuest'
    | 'requestBrowserSurface'
    | 'revealPage'
    | 'reportOpenFailure'
    | 'discardCreatedPage'
    | 'discardUntouchedBlank'
    | 'recoverCrashedGuest'
    | 'backgroundEntryByPageId'
    | 'destroyBackgroundPage'
  >;
  taskLifecycle: Pick<ReturnType<typeof createBrowserTaskLifecycle<Guest>>, 'retain'>;
  store: Pick<BrowserGuestStateStore, 'pageId' | 'redactText'> & PageHost['store'];
  leases: PageLeases;
  /** The navigation half shared with `page/navigate` (an `open` with a url loads it the same way). */
  page: Pick<PageHost, 'urls' | 'downloadsForSession' | 'sessionIdOf'>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionOf(params: Record<string, unknown>): string {
  try {
    return browserSessionId(params.sessionId);
  } catch (error) {
    throw new HostRpcError(HOST_INVALID_PARAMS, (error as Error).message);
  }
}

/** Every page of the session, with the name the tab surface gives it (`v1`, or the background name). */
function sessionPages(host: PagesHost, sessionId: string): Array<{ guest: Guest; tabId: string; background: boolean }> {
  const pages = host.sessions.visibleGuests(sessionId).map((guest, index) => ({
    guest,
    tabId: `v${index + 1}`,
    background: false,
  }));
  for (const [name, page] of host.sessions.backgroundPages(sessionId)) {
    if (page.window.isDestroyed() || page.guest.isDestroyed()) continue;
    // A user's tab is shown; every other support page stays hidden (tabs-target.ts).
    pages.push({ guest: page.guest, tabId: name, background: page.kind !== 'user' });
  }
  return pages;
}

/** What a resolve knows of the page it answers with: this call made it, and a turn that ends badly may close it. */
interface Origin {
  created: boolean;
  disposable: boolean;
}

function describe(
  host: PagesHost,
  ctx: EngineContext,
  sessionId: string,
  page: { guest: Guest; tabId: string; background: boolean },
  origin: Origin = { created: false, disposable: false }
): PageDescriptor {
  const pageId = host.store.pageId(page.guest);
  return { pageId, tabId: page.tabId, sessionId, background: page.background, ...origin, facts: ctx.events.facts(pageId) };
}

async function resolve(host: PagesHost, ctx: EngineContext, params: Record<string, unknown>, signal: AbortSignal) {
  const sessionId = sessionOf(params);
  const { lifecycle, sessions } = host;
  const open = isObject(params.open) ? params.open : undefined;
  const tab = isObject(params.tab) ? params.tab : undefined;
  const lease = isObject(params.lease) ? params.lease : undefined;
  if (lease && (typeof lease.commandId !== 'string' || typeof lease.ttlMs !== 'number')) {
    throw new HostRpcError(HOST_INVALID_PARAMS, 'lease needs commandId and ttlMs.');
  }
  const tabRef =
    typeof tab?.pageId === 'string' ? tab.pageId : typeof tab?.index === 'number' ? `v${Math.trunc(tab.index)}` : '';
  const background = params.background === true;
  await lifecycle.restoreSession(sessionId);
  const known = new Set(sessionPages(host, sessionId).map((entry) => entry.guest));
  const previous = sessions.liveGuest(sessionId);
  let target;
  try {
    target = host.tabs.resolveTargetGuest(sessionId, background, tabRef);
  } catch (error) {
    throw new HostRpcError(ENGINE_ERROR.failed, (error as Error).message);
  }
  if (!target && !previous && !open && params.adopt !== true) {
    throw new HostRpcError(ENGINE_ERROR.failed, 'No browser page is open; navigate or use background:true.');
  }
  // An agent command with no tab wants a visible page of its own; an adopting one takes the pane's page.
  const guest = target?.guest ?? (await lifecycle.ensureGuest(sessionId, { reveal: false, adopt: params.adopt === true }));
  const created = !known.has(guest);
  const hidden = target?.background === true;
  // `open` shows a page the person can already see; a page this call had to make is not one.
  const opensForeground = open?.reveal === true && !hidden;
  if (opensForeground && created) {
    lifecycle.discardCreatedPage(sessionId, guest);
    const message = 'Could not show a page: no page is open in this conversation; navigate to one first.';
    lifecycle.reportOpenFailure(sessionId, message);
    throw new HostRpcError(ENGINE_ERROR.failed, message);
  }
  let placement: 'shown' | 'pending' | undefined;
  const backgroundPage = sessions.backgroundPageForGuest(sessionId, guest);
  try {
    await lifecycle.recoverCrashedGuest(guest, signal);
    // The pane follows the page the agent works in; a hidden helper it made is not one the person watches.
    if (backgroundPage?.kind !== 'agent' || !hidden) sessions.setAgentPage(sessionId, guest, 0);
    // A hidden helper never takes the selection from a page the person is on; it only replaces an untouched blank.
    lifecycle.discardUntouchedBlank(sessionId, guest);
    const pageId = host.store.pageId(guest);
    if (typeof open?.url === 'string' && open.url) {
      const url = await admitUrl(host.page, open.url);
      const live = ctx.page(pageId);
      if (!live) throw new HostRpcError(ENGINE_ERROR.pageGone, `page ${pageId} is gone`);
      const call: EnginePageCall = {
        ...live,
        pageId,
        facts: () => ctx.events.facts(pageId),
        guarded: (_expect, start) => start(),
      };
      await loadUrl({ ...host.page, store: host.store }, ctx, call, url, signal, undefined);
    }
    if (open?.reveal === true) {
      host.taskLifecycle.retain(guest);
      placement = await lifecycle.revealPage(sessionId, guest, signal);
    }
  } catch (error) {
    // A failed open (not a cancelled one) tells the shell why, on the page's own line.
    if (opensForeground && !signal.aborted) {
      const message = host.store.redactText(guest, (error as Error).message || String(error));
      lifecycle.reportOpenFailure(sessionId, message, guest.isDestroyed() ? undefined : host.store.pageId(guest));
    }
    // A page this call made holds no document when it failed: it is not left behind as a blank tab.
    if (created) lifecycle.discardCreatedPage(sessionId, guest);
    throw error;
  }
  const entry = sessionPages(host, sessionId).find((candidate) => candidate.guest === guest) ?? {
    guest,
    tabId: target?.tabName ?? '',
    background: hidden,
  };
  // A hidden page is the turn's to reclaim when an agent made it and nobody asked to keep it; the page a session's first command
  // made is too (command-runner.ts: `backgroundPage ? kind === 'agent' && !keepAlive : !previousGuest`).
  const disposable = backgroundPage ? backgroundPage.kind === 'agent' && !backgroundPage.keepAlive : !previous;
  const descriptor = describe(host, ctx, sessionId, entry, { created, disposable });
  const leaseId = lease
    ? host.leases.acquire(descriptor.pageId, lease.commandId as string, lease.ttlMs as number)
    : undefined;
  return { page: descriptor, ...(leaseId === undefined ? {} : { leaseId }), ...(placement ? { placement } : {}) };
}

async function list(host: PagesHost, ctx: EngineContext, params: Record<string, unknown>) {
  const sessionId = sessionOf(params);
  await host.lifecycle.restoreSession(sessionId);
  const pages = sessionPages(host, sessionId).map((entry) => describe(host, ctx, sessionId, entry));
  const current = host.sessions.currentGuest(sessionId);
  return current ? { pages, activePageId: host.store.pageId(current) } : { pages };
}

/** Closes a page of a session's support pages. The visible tab stays with the browser panel. */
async function close(host: PagesHost, ctx: EngineContext, params: Record<string, unknown>) {
  const { pageId, reason } = params;
  if (typeof pageId !== 'string' || !pageId) throw new HostRpcError(HOST_INVALID_PARAMS, 'close needs a pageId.');
  if (reason !== 'agent' && reason !== 'turnEnd' && reason !== 'idle' && reason !== 'discard') {
    throw new HostRpcError(HOST_INVALID_PARAMS, 'close reason must be agent, turnEnd, idle or discard.');
  }
  const live = ctx.page(pageId);
  // A page that is already gone is closed: the answer is the same either way.
  if (!live || live.guest.isDestroyed()) return { closed: false };
  const sessionId = host.sessions.sessionIdForGuest(live.guest);
  if (!sessionId) return { closed: false };
  // The page a failed command made goes only while it holds no document, the visible one included (a refused address leaves no
  // blank tab behind).
  if (reason === 'discard') return { closed: host.lifecycle.discardCreatedPage(sessionId, live.guest) };
  const found = host.lifecycle.backgroundEntryByPageId(sessionId, pageId);
  if (!found || found[1].window.isDestroyed()) {
    // The panel keeps the visible tab for the session; an agent that aimed at it is told what to do instead.
    if (reason === 'agent') {
      throw new HostRpcError(
        ENGINE_ERROR.failed,
        `"${pageId}" is the visible tab, which stays with the browser panel; navigate it elsewhere, or call hide to put the panel away.`
      );
    }
    return { closed: false };
  }
  host.lifecycle.destroyBackgroundPage(sessionId, found[0], found[1]);
  const next = host.sessions.currentGuest(sessionId);
  return next ? { closed: true, nextActivePageId: host.store.pageId(next) } : { closed: true };
}

async function surface(host: PagesHost, ctx: EngineContext, params: Record<string, unknown>, signal: AbortSignal) {
  const sessionId = sessionOf(params);
  const { op, pageId } = params;
  if (op !== 'reveal' && op !== 'hide' && op !== 'handoff') {
    throw new HostRpcError(HOST_INVALID_PARAMS, 'surface op must be reveal, hide or handoff.');
  }
  const live = typeof pageId === 'string' ? ctx.page(pageId) : undefined;
  const owned = live && !live.guest.isDestroyed() && host.sessions.sessionIdForGuest(live.guest) === sessionId;
  let placement: 'shown' | 'pending' | undefined;
  try {
    if (op === 'reveal') {
      if (owned) placement = await host.lifecycle.revealPage(sessionId, live.guest, signal);
      else host.lifecycle.requestBrowserSurface(sessionId, true);
    } else {
      host.lifecycle.requestBrowserSurface(sessionId, op);
    }
  } catch (error) {
    throw new HostRpcError(ENGINE_ERROR.failed, (error as Error).message);
  }
  return {
    ...(owned ? { facts: ctx.events.facts(pageId as string) as PageFacts } : {}),
    ...(placement ? { placement } : {}),
  };
}

/** Registers `host/browser/pages/*`. */
export function registerPages(connection: HostConnection, ctx: EngineContext, host: PagesHost): void {
  const on = (
    method: string,
    handler: (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  ) => registerEngineSessionMethod(connection, ctx, `host/browser/pages/${method}`, handler);
  on('resolve', (params, signal) => resolve(host, ctx, params, signal));
  on('list', (params) => list(host, ctx, params));
  on('close', (params) => close(host, ctx, params));
  on('surface', (params, signal) => surface(host, ctx, params, signal));
}
