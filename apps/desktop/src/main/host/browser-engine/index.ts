/**
 * The browser engine lane of the desktop host: every `host/browser/*` engine method the core calls, served over
 * the live in-app browser.
 *
 * The connection's method table is fixed for its life and the browser is built after it, so `serveBrowserEngine`
 * registers every method by name at once and builds the lane (the page facts and events, the page leases, the
 * engine context, the handlers: `createBrowserEngine`) when the core first calls one. A new link to the core
 * starts a new lane; the old one is closed with the link. `registerBrowserEngine` is the list of registrations
 * itself.
 *
 * Whether the core drives the browser through this lane is a fact the connection shows: the core calls an
 * engine method only when it composes the engine, and from its first call on it sends no tool action through
 * `host/browser/command`. Until then the host's own command path records the page's events as it always did,
 * and nothing of the lane is sent.
 */
import type { WebContents } from 'electron';

import type { BrowserGuestCdp } from '../../browser/cdp';
import type { createBrowserCommandToolkit } from '../../browser/command-toolkit';
import type { createBrowserGuestLifecycle } from '../../browser/guest-lifecycle';
import type { BrowserHostFoundation } from '../../browser/host-types';
import type { BrowserEmulationOwner } from '../../browser/host-policy';
import { redactBrowserText } from '../../browser/redaction';
import { pause } from '../../browser/settle';
import type { createBrowserTabs } from '../../browser/tabs';
import type { createBrowserTaskLifecycle } from '../../browser/task-lifecycle';
import type { HostConnection } from '../connection';
import type { EngineContext } from './context';
import { pageGone } from './errors';
import { bindGuestState, createPageFacts } from './facts';
import { createEngineEvents, createEngineEventSink } from './events';
import { registerCdpSend } from './cdp-send';
import { registerInputBatch } from './input-batch';
import { createLeases, type Leases } from './lease';
import { type PageHost, registerPage } from './page';
import { type PagesHost, registerPages } from './pages';
import { registerRefCall } from './ref-call';
import { registerRefMint } from './ref-mint';
import { registerScreenshot } from './screenshot';
import { registerSession, type SessionDeps } from './session';
import { registerSignIn, type SignInDeps } from './signin';
import { registerSnapshot } from './snapshot';
import type { TranscriptTap } from './transcript';
import { registerUpload, type UploadDeps } from './upload';

type Toolkit = ReturnType<typeof createBrowserCommandToolkit>;

/** The pieces of the live browser host the lane is built from (browser/host.ts `hostRole().engine`). */
export interface BrowserEnginePorts {
  base: Pick<
    BrowserHostFoundation,
    'state' | 'sessions' | 'cdp' | 'display' | 'documents' | 'urls' | 'urlPolicy' | 'partition' | 'engineIntercept' | 'engineLane'
  >;
  tools: Pick<Toolkit, 'dialogs' | 'input' | 'snapshots' | 'screenshots' | 'refPoints'>;
  lifecycle: ReturnType<typeof createBrowserGuestLifecycle>;
  tabs: ReturnType<typeof createBrowserTabs>;
  taskLifecycle: ReturnType<typeof createBrowserTaskLifecycle<WebContents>>;
  /** The sign-in flows and the turn bookkeeping the core's engine asks about (browser/host-agent.ts builds it). */
  signIn: SignInDeps;
  /** The one owner of a page's emulation, shared with the pane's preset path. */
  emulation: BrowserEmulationOwner;
  /** The folder a saved performance trace goes to when the core does not name one. */
  traceDirectory(): string;
  /** Resident memory of the process painting the page, in MB. */
  processMemoryMb(guest: WebContents): number | undefined;
}

export interface BrowserEngineOptions {
  /** The transcript tap of a development build (transcript.ts); absent in a packaged app. */
  transcript?: TranscriptTap;
}

/** What `registerBrowserEngine` registers the handlers over. */
export interface BrowserEngineDeps {
  pages: PagesHost;
  page: PageHost;
  session: SessionDeps;
  upload: UploadDeps;
  signIn: SignInDeps;
  snapshot: Parameters<typeof registerSnapshot>[2];
  refCall: Parameters<typeof registerRefCall>[2];
  screenshot: Parameters<typeof registerScreenshot>[2];
  /** The privacy check a printed PDF runs, the same one a screenshot runs. */
  cdpSend: Parameters<typeof registerCdpSend>[2];
}

/** Registers every engine method of the lane on `connection`. */
export function registerBrowserEngine(connection: HostConnection, ctx: EngineContext, deps: BrowserEngineDeps): void {
  registerPages(connection, ctx, deps.pages);
  registerPage(connection, ctx, deps.page);
  registerCdpSend(connection, ctx, deps.cdpSend);
  registerInputBatch(connection, ctx);
  registerSnapshot(connection, ctx, deps.snapshot);
  registerRefCall(connection, ctx, deps.refCall);
  registerRefMint(connection, ctx);
  registerScreenshot(connection, ctx, deps.screenshot);
  registerSession(connection, ctx, deps.session);
  registerUpload(connection, ctx, deps.upload);
  registerSignIn(connection, ctx, deps.signIn, deps.snapshot);
}

/** The guests the host has now: the pane's pages and every named background page. */
function liveGuests(sessions: BrowserEnginePorts['base']['sessions']): WebContents[] {
  return [...sessions.visibleGuests(), ...sessions.allBackgroundEntries().map(([, , page]) => page.guest)].filter(
    (guest) => !guest.isDestroyed()
  );
}

/** The engine methods the core calls as requests (each answers), and as notifications. */
export const ENGINE_REQUEST_METHODS: readonly string[] = [
  'host/browser/cdp/send',
  'host/browser/cookies',
  'host/browser/credentials/fill',
  'host/browser/downloads',
  'host/browser/emulation',
  'host/browser/initScripts',
  'host/browser/input/batch',
  'host/browser/intercept',
  'host/browser/page/dialog/answer',
  'host/browser/page/domQuiet',
  'host/browser/page/eval',
  'host/browser/page/navigate',
  'host/browser/page/read',
  'host/browser/page/renderCheckpoint',
  'host/browser/page/stop',
  'host/browser/page/sync',
  'host/browser/pages/close',
  'host/browser/pages/list',
  'host/browser/pages/resolve',
  'host/browser/pages/surface',
  'host/browser/performance',
  'host/browser/ref/call',
  'host/browser/ref/mint',
  'host/browser/revision',
  'host/browser/screenshot',
  'host/browser/signIn',
  'host/browser/snapshot',
  'host/browser/storage',
  'host/browser/turn',
  'host/browser/upload',
  'host/browser/upload/receiver',
];
export const ENGINE_NOTIFICATION_METHODS: readonly string[] = ['host/browser/lease/release'];

type RequestHandler = Parameters<HostConnection['handleRequest']>[1];
type NotificationHandler = Parameters<HostConnection['handleNotification']>[1];

/**
 * One lane over the browser's ports: the shared state, the handlers it registered (kept, not put on the
 * connection) and the binding to the browser (events routed, pane input leased, fills held to the core's page
 * state). `stop` unbinds it and closes what it holds.
 */
export interface BrowserEngine {
  requests: ReadonlyMap<string, RequestHandler>;
  notifications: ReadonlyMap<string, NotificationHandler>;
  /** The core calls an engine method: it drives the browser through this lane from now on. */
  engage(): void;
  engaged(): boolean;
  stop(): void;
}

export function createBrowserEngine(
  connection: HostConnection,
  ports: BrowserEnginePorts,
  options: BrowserEngineOptions = {}
): BrowserEngine {
  const { state, sessions, cdp, display, partition } = ports.base;
  let engaged = false;
  const requests = new Map<string, RequestHandler>();
  const notifications = new Map<string, NotificationHandler>();
  const closers: Array<() => void> = [];
  /** What the lane's modules register on: their handlers are kept here, the rest is the real connection. */
  const served: HostConnection = {
    request: (method, params) => connection.request(method, params),
    notify: (method, params) => connection.notify(method, params),
    sendBinary: (frame) => connection.sendBinary(frame),
    handleRequest: (method, handler) => void requests.set(method, handler),
    handleNotification: (method, handler) => void notifications.set(method, handler),
    servedMethods: () => [...requests.keys(), ...notifications.keys()].sort(),
    onClose: (listener) => void closers.push(listener),
  };
  /** What the lane volunteers (facts, events, the person's input) is sent only to a core that uses the lane. */
  const volunteered: HostConnection = {
    ...served,
    notify: (method, params) => {
      if (engaged) connection.notify(method, params);
    },
  };

  const known = new Map<string, WebContents>();
  const guestOf = (pageId: string): WebContents | undefined => {
    const remembered = known.get(pageId);
    if (remembered) return remembered;
    return liveGuests(sessions).find((guest) => state.pageId(guest) === pageId);
  };
  const background = (guest: WebContents): boolean => {
    const sessionId = sessions.sessionIdForGuest(guest);
    const page = sessionId === undefined ? undefined : sessions.backgroundPageForGuest(sessionId, guest);
    return page !== undefined && page.kind !== 'user';
  };

  const events = createEngineEvents(volunteered, {
    nextSeq: (pageId) => {
      const guest = guestOf(pageId);
      if (!guest) throw pageGone(pageId);
      return state.nextSeq(guest);
    },
    redact: (pageId, text) => {
      const guest = guestOf(pageId);
      return guest ? state.redactText(guest, text) : redactBrowserText(text);
    },
    facts: (pageId) => {
      const guest = guestOf(pageId);
      if (!guest) throw pageGone(pageId);
      return facts.facts(guest);
    },
  });
  const facts = createPageFacts({
    connection: volunteered,
    state,
    source: { background, visible: (guest) => display.isShown(guest) },
    flushEvents: events.flush,
  });
  const unbindState = bindGuestState(state, facts, events, () => engaged);

  const ctx: EngineContext = {
    page(pageId) {
      const guest = guestOf(pageId);
      return guest && !guest.isDestroyed() ? { guest, state: state.for(guest) } : undefined;
    },
    session(sessionId) {
      const pageIds = () =>
        [
          ...sessions.visibleGuests(sessionId),
          ...[...sessions.backgroundPages(sessionId).values()].map((page) => page.guest),
        ]
          .filter((guest) => !guest.isDestroyed())
          .map((guest) => state.pageId(guest));
      return pageIds().length ? { sessionId, pageIds } : undefined;
    },
    cdp,
    events: { flush: events.flush, facts: events.facts },
    redactKnown(pageId, text) {
      const guest = guestOf(pageId);
      return guest ? state.redactText(guest, text) : redactBrowserText(text);
    },
    isEngineMode: () => engaged,
    ...(options.transcript ? { transcript: options.transcript } : {}),
  };
  const leases: Leases = createLeases(volunteered, ctx);
  ctx.leases = leases;

  const stopFollowing = new Map<WebContents, () => void>();
  const follow = (guest: WebContents): void => {
    if (guest.isDestroyed() || stopFollowing.has(guest)) return;
    const pageId = state.pageId(guest);
    known.set(pageId, guest);
    stopFollowing.set(guest, facts.attach(guest));
    // After the facts' own `destroyed` handler: the page's last facts are sent first.
    guest.once('destroyed', () => {
      stopFollowing.delete(guest);
      facts.forget(guest);
      events.drop(pageId);
      leases.forget(pageId);
      known.delete(pageId);
    });
  };

  const urls = ports.base.urls;
  const documents = ports.base.documents;
  const evaluate: BrowserGuestCdp['evaluate'] = (guest, expression, signal, timeoutMs) =>
    cdp.evaluate(guest, expression, signal, timeoutMs);
  const pageHost: PageHost = {
    store: state,
    urls,
    documents,
    handleDialog: ports.tools.dialogs.handleDialog,
    downloadsForSession: (sessionId) => partition.downloadLedger.downloadsForSession(sessionId),
    sessionIdOf: (guest) => sessions.sessionIdForGuest(guest),
    isBackground: background,
    // The core holds every console entry the events carried and the host keeps no ledger of them in this lane,
    // so nothing is below the core's cursor.
    consoleFloor: () => 0,
  };
  registerBrowserEngine(served, ctx, {
    pages: {
      sessions,
      tabs: ports.tabs,
      lifecycle: ports.lifecycle,
      taskLifecycle: ports.taskLifecycle,
      store: state,
      leases,
      page: pageHost,
    },
    page: pageHost,
    session: {
      partitionSession: partition.session,
      urlPolicy: () => ports.base.urlPolicy,
      evaluate,
      invalidateInteractionState: (guest) => state.invalidateInteraction(guest),
      intercept: ports.base.engineIntercept,
      applyFetchPatterns: (guest, signal) => cdp.applyFetchPatterns(guest, signal),
      tracesByGuest: state.slot('performanceTrace'),
      processMemoryMb: ports.processMemoryMb,
      pause,
      emulation: ports.emulation,
      traceDirectory: ports.traceDirectory,
      downloads: (sessionId) => partition.downloadLedger.downloadsForSession(sessionId),
    },
    upload: {
      host: {
        cdp,
        accessibilityRefs: (guest) => state.peek(guest)?.accessibilityRefs,
        resolveRefPoint: ports.tools.refPoints.resolveRefPoint,
        input: ports.tools.input,
        pause,
        pendingFileChooser: (guest) => state.for(guest).pendingFileChooser,
        clearFileChooser: (guest) => {
          state.for(guest).pendingFileChooser = null;
        },
        evaluateInFrames: documents.collect,
        evaluateInFramesByFrame: (guest, expression, signal) => documents.collect.byFrame(guest, expression, signal),
        frames: (guest) => state.for(guest).cdpSessions,
        frameOffsetForSession: (guest, sessionId, signal) =>
          ports.tools.snapshots.frameOffsetForSession(guest, sessionId, signal),
      },
      invalidateInteractionState: (guest) => state.invalidateInteraction(guest),
    },
    signIn: ports.signIn,
    snapshot: {
      captureSnapshotPayload: (guest, command, signal) =>
        ports.tools.snapshots.captureSnapshotPayload(guest, command, signal),
      revision: (guest, signal) => documents.revision(guest, signal),
    },
    refCall: { evaluate },
    cdpSend: { prepareVisualOutput: async (guest, signal) => ports.tools.screenshots.prepareVisualOutput(guest, signal) },
    screenshot: {
      screenshots: ports.tools.screenshots,
      resolveRefRect: (guest, ref, signal) => ports.tools.refPoints.resolveRefRect(guest, ref, signal),
      evaluate,
    },
  });

  const unbind = ports.base.engineLane.bind({
    ctx,
    leases,
    sink: createEngineEventSink(events, (guest) => state.pageId(guest), () => engaged),
    guestAppeared: follow,
    visibilityChanged: (guest) => {
      if (engaged) facts.changed(guest);
    },
  });
  for (const guest of liveGuests(sessions)) follow(guest);

  let stopped = false;
  return {
    requests,
    notifications,
    engage: () => {
      engaged = true;
    },
    engaged: () => engaged,
    stop() {
      if (stopped) return;
      stopped = true;
      unbind();
      unbindState();
      for (const end of stopFollowing.values()) end();
      stopFollowing.clear();
      known.clear();
      for (const close of closers) close();
    },
  };
}

/**
 * Serves every engine method on `connection` over the browser `ports()` resolves (when the core first calls one).
 * Returns what the host's command path asks: whether the core drives the browser through the lane now.
 */
export function serveBrowserEngine(
  connection: HostConnection,
  ports: () => BrowserEnginePorts,
  options: BrowserEngineOptions = {}
): { engineMode(): boolean } {
  let engine: { lane: BrowserEngine; base: BrowserEnginePorts['base'] } | null = null;
  const current = (): BrowserEngine => {
    const next = ports();
    // The browser was built again (its window closed and another opened): the lane follows the live one.
    if (engine && engine.base !== next.base) {
      engine.lane.stop();
      engine = null;
    }
    engine ??= { lane: createBrowserEngine(connection, next, options), base: next.base };
    engine.lane.engage();
    return engine.lane;
  };
  for (const method of ENGINE_REQUEST_METHODS) {
    connection.handleRequest(method, async (params, signal) => {
      const handler = current().requests.get(method);
      if (!handler) throw new Error(`${method} is not served.`);
      return handler(params, signal);
    });
  }
  for (const method of ENGINE_NOTIFICATION_METHODS) {
    connection.handleNotification(method, (params) => current().notifications.get(method)?.(params));
  }
  // The link to the core ended: its lane ends with it, and a new link starts a new one.
  connection.onClose(() => {
    engine?.lane.stop();
    engine = null;
  });
  return { engineMode: () => engine?.lane.engaged() ?? false };
}
