/**
 * The page methods of the browser engine lane (`host/browser/page/*`): navigate,
 * stop, eval, read, renderCheckpoint, domQuiet, dialog/answer and sync. Each is
 * a thin handler over the host modules that already do the work (the url policy
 * and admission, the document collector, the render checkpoint, the dom-quiet
 * observer, the dialog answer); what is new here is the wire shape, the
 * `expect` binding right beside each CDP send, and the -32014 / -32015 exits.
 *
 * Results and errors pass the registry's redaction (registry.ts), so nothing
 * here masks secrets itself.
 */
import type {
  BrowserMailLink as WireMailLink,
  BrowserPendingDialog,
  FrameRef,
  PageFacts,
  Precondition,
} from '../../../../../../packages/protocol/src/index.ts';
import { CDP_REQUEST_TIMEOUT_MS, EXTRACT_MAX_LIMIT, MAX_EVALUATE_SCRIPT_CHARS, NAVIGATE_SETTLE_TIMEOUT_MS, READ_DEFAULT_CHARS } from '../../browser/host-types';
import { bounded } from '../../browser/cdp-bounded';
import type { createBrowserDialogReport } from '../../browser/dialog-report';
import { createBrowserDomQuiet } from '../../browser/dom-quiet';
import type { createBrowserDocuments } from '../../browser/documents';
import { type BrowserGuestStateStore, pushBounded } from '../../browser/host-state';
import { redactBrowserText } from '../../browser/redaction';
import { pause } from '../../browser/settle';
import { type BrowserMailLink, mailLinkWindowMs } from '../../browser/url-policy';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext } from './context';
import { ENGINE_ERROR } from './errors';
import { checkPrecondition } from './precondition';
import { type EnginePageCall, type EngineParams, registerEngineMethod } from './registry';

/** The most text one `read` of kind text returns; the registry moves nothing but base64, so this keeps a result under its limit. */
const READ_MAX_CHARS_WIRE = 120_000;
/** The page text the observation reads is cut at a million characters; no read starts past it. */
const READ_MAX_OFFSET = 1_000_000;
/** Page attributes `read` with a selector brings back beside each match's text when the command names none. */
const READ_SELECTOR_ATTRIBUTES = ['href', 'src', 'alt', 'title', 'name', 'value'];
/** The most attributes one selector read brings back (the old `extract` took up to twelve). */
const READ_SELECTOR_MAX_ATTRIBUTES = 12;
const EVAL_MIN_TIMEOUT_MS = 500;
const EVAL_MAX_TIMEOUT_MS = 30_000;
const DOM_QUIET_MAX_MS = 30_000;
const CHECKPOINT_MAX_MS = 10_000;
const UTILITY_WORLD = 'mixdog-observation';

type Documents = ReturnType<typeof createBrowserDocuments>;

/** What the page methods reach besides the engine context; the wiring task builds it from the live host. */
export interface PageHost {
  store: Pick<BrowserGuestStateStore, 'invalidateInteraction' | 'for'>;
  /** url-admission.ts `validatedAgentUrl`: the policy (synchronous rules) and the DNS check. */
  urls: { validatedAgentUrl(raw: string, mailLink?: BrowserMailLink): Promise<string> };
  documents: Pick<Documents, 'readPage' | 'extractPage' | 'renderCheckpoint' | 'revision' | 'collect'>;
  /** dialog-report.ts `handleDialog`. */
  handleDialog: ReturnType<typeof createBrowserDialogReport>['handleDialog'];
  /** The downloads of a session (a navigation that ends in a download is not a failed one). */
  downloadsForSession(sessionId: string): Array<{ url: string }>;
  sessionIdOf(guest: EnginePageCall['guest']): string | undefined;
  /** The page is a hidden one (its frames never paint). */
  isBackground(guest: EnginePageCall['guest']): boolean;
  /** The console ledger's floor of the page (events.ts); `host/browser/page/sync` hands it to the core. */
  consoleFloor(pageId: string): number;
}

function failed(message: string): HostRpcError {
  return new HostRpcError(ENGINE_ERROR.failed, message);
}

function refused(reason: string): HostRpcError {
  return new HostRpcError(ENGINE_ERROR.refused, reason, { reason });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

/** `text` without a high surrogate left at its end by a cut. */
function withoutLoneHalf(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return text.length > 1 && last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

function toWireDialog(dialog: NonNullable<EnginePageCall['state']['pendingDialog']>): BrowserPendingDialog {
  return {
    type: dialog.type,
    message: dialog.message,
    defaultPrompt: dialog.defaultPrompt,
    openedAt: dialog.openedAt,
    sessionId: dialog.sessionId,
    bridge: Boolean(dialog.bridgeRequestId),
  } as BrowserPendingDialog;
}

/** -32014: a page that is parked on a dialog accepts nothing but the answer; CDP would queue the call behind it. */
export function assertNotBlocked(page: Pick<EnginePageCall, 'state'>): void {
  const dialog = page.state.pendingDialog;
  if (dialog) {
    throw new HostRpcError(ENGINE_ERROR.dialogBlocking, `a ${dialog.type} dialog blocks the page`, {
      dialog: toWireDialog(dialog),
    });
  }
}

/**
 * `beforeDispatch` of a CDP send: the `expect` is checked in the same
 * synchronous step in which the command leaves (cdp-execution.ts runs it right
 * before the dispatch, after every wait), so nothing is awaited between them.
 */
export function guardBeforeDispatch(page: EnginePageCall, expect: unknown): (() => void) | undefined {
  if (expect === undefined || expect === null) return undefined;
  return () => checkPrecondition(expect as Precondition, page, page.facts);
}

/** The CDP session a `FrameRef` names; a session that is not one of the page's is a plain failure. */
function frameTarget(page: EnginePageCall, frame: unknown): { sessionId?: string; frameId?: string } {
  if (frame === undefined || frame === null) return {};
  if (!isObject(frame)) throw new HostRpcError(HOST_INVALID_PARAMS, 'frame must be an object.');
  const { sessionId, frameId } = frame as FrameRef;
  if (sessionId !== undefined && !page.state.cdpSessions.has(sessionId)) {
    throw failed(`frame session ${sessionId} is not attached to the page`);
  }
  return { sessionId, frameId };
}

/**
 * The wire mail link (`{url, expiresAt}`) as the url policy reads it. The core
 * decided the provenance; the host keeps checking what it can see: the exact
 * https link, inside the sign-in window that ends at `expiresAt`.
 */
function policyMailLink(link: unknown): BrowserMailLink | undefined {
  if (link === undefined || link === null) return undefined;
  if (!isObject(link) || typeof link.url !== 'string' || typeof link.expiresAt !== 'number') {
    throw new HostRpcError(HOST_INVALID_PARAMS, 'mailLink needs url and expiresAt.');
  }
  const { url, expiresAt } = link as unknown as WireMailLink;
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return { url, from_domain: hostname, read_at: expiresAt - mailLinkWindowMs() };
}

/** The policy's verdict on `raw`: the normalised url, or the -32015 refusal that carries the reason. */
export async function admitUrl(host: Pick<PageHost, 'urls'>, raw: string, mailLink?: unknown): Promise<string> {
  try {
    return await host.urls.validatedAgentUrl(raw, policyMailLink(mailLink));
  } catch (error) {
    if (error instanceof HostRpcError) throw error;
    throw refused(redactBrowserText((error as Error)?.message || String(error)));
  }
}

/**
 * Loads `url` in the guest (the body of the old navigate action): the page is
 * stopped when the call is cancelled, a load that was aborted or ended in a
 * download is not a failure, a dialog that opens during the load ends the wait
 * (the facts carry it), and a real failure is noted among the page's network
 * failures.
 */
export async function loadUrl(
  host: Pick<PageHost, 'store' | 'downloadsForSession' | 'sessionIdOf'>,
  ctx: Pick<EngineContext, 'cdp'>,
  page: EnginePageCall,
  url: string,
  signal: AbortSignal,
  expect: unknown
): Promise<void> {
  const { guest, state } = page;
  await ctx.cdp.guestDebugger(guest);
  const stopNavigation = () => {
    if (!guest.isDestroyed() && guest.isLoading()) {
      try {
        guest.stop();
      } catch {
        /* teardown can race cancellation */
      }
    }
  };
  // The check and the load start are one synchronous step: nothing is awaited between them. The load itself is
  // not awaited here (the wrapper object keeps the promise out of the await).
  const started = await page
    .guarded(expect as Precondition | undefined, async () => {
      host.store.invalidateInteraction(guest);
      signal.addEventListener('abort', stopNavigation, { once: true });
      const loading = guest.loadURL(url).catch(async (error: Error) => {
        // Aborted top-level loads (redirect chains, downloads) are not failures of the command itself.
        if (/ERR_ABORTED/.test(String(error?.message))) return;
        if (/ERR_FAILED/.test(String(error?.message))) {
          const owner = host.sessionIdOf(guest);
          for (let attempt = 0; attempt < 20; attempt += 1) {
            if (owner && host.downloadsForSession(owner).some((download) => download.url === url)) return;
            await pause(25, signal);
          }
        }
        throw error;
      });
      return { loading };
    })
    .catch((error) => {
      signal.removeEventListener('abort', stopNavigation);
      throw error;
    });
  const load = started.loading;
  load.catch(() => undefined);
  try {
    const navigation = bounded(load, NAVIGATE_SETTLE_TIMEOUT_MS, 'navigation', signal, stopNavigation).then(
      () => ({ done: true as const, error: null }),
      (error: unknown) => ({ done: true as const, error })
    );
    for (;;) {
      const next = await Promise.race([
        navigation,
        pause(25, signal).then(() => ({ done: false as const, error: null })),
      ]);
      if (next.done) {
        if (next.error) throw next.error;
        return;
      }
      // A dialog that opened during the load is the page's state now: the reply carries it in the facts.
      if (state.pendingDialog) return;
    }
  } catch (error) {
    stopNavigation();
    if (signal.aborted) throw error;
    pushBounded(host.store.for(guest).networkFailures, (error as Error).message);
    throw failed(`navigation failed: ${redactBrowserText((error as Error).message)}`);
  } finally {
    signal.removeEventListener('abort', stopNavigation);
  }
}

async function navigate(host: PageHost, ctx: EngineContext, params: EngineParams, signal: AbortSignal, page: EnginePageCall) {
  const { guest } = page;
  const { kind, url, mailLink, expect } = params;
  if (kind === 'url') {
    if (typeof url !== 'string' || !url) throw new HostRpcError(HOST_INVALID_PARAMS, 'navigate needs a url.');
    const admitted = await admitUrl(host, url, mailLink);
    await loadUrl(host, ctx, page, admitted, signal, expect);
    return {};
  }
  if (kind === 'reload') {
    await ctx.cdp.guestDebugger(guest);
    await page.guarded(expect as Precondition | undefined, async () => {
      host.store.invalidateInteraction(guest);
      guest.reload();
    });
    return {};
  }
  if (kind === 'back' || kind === 'forward') {
    const history = guest.navigationHistory;
    if (kind === 'back' ? !history.canGoBack() : !history.canGoForward()) {
      // An answer, not a failure: the old `back` replied with this line and the agent reads it as text.
      return { refused: { reason: `Cannot go ${kind}: no ${kind === 'back' ? 'earlier' : 'later'} history entry.` } };
    }
    await page.guarded(expect as Precondition | undefined, async () => {
      host.store.invalidateInteraction(guest);
      if (kind === 'back') history.goBack();
      else history.goForward();
    });
    return {};
  }
  throw new HostRpcError(HOST_INVALID_PARAMS, 'navigate kind must be url, reload, back or forward.');
}

/** The page's revision once its frames confirmed a render checkpoint; undefined when that is not proven. */
async function settledRevision(
  host: Pick<PageHost, 'documents' | 'isBackground'>,
  guest: EnginePageCall['guest'],
  signal: AbortSignal
): Promise<string | undefined> {
  try {
    // A frame that never confirmed the checkpoint may still be changing: its silence is not proof.
    if ((await host.documents.renderCheckpoint(guest, host.isBackground(guest), signal)) === false) return undefined;
    return await host.documents.revision(guest, signal);
  } catch {
    // The script may already have run: an unreadable page only costs the caller its refs.
    return undefined;
  }
}

interface EvaluateResponse {
  result?: { value?: unknown; description?: string; objectId?: string };
  exceptionDetails?: { text?: string; lineNumber?: number; columnNumber?: number; exception?: { description?: string } };
}

async function evaluate(host: PageHost, ctx: EngineContext, params: EngineParams, signal: AbortSignal, page: EnginePageCall) {
  const { guest } = page;
  const expression = params.expression;
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new HostRpcError(HOST_INVALID_PARAMS, 'eval needs an expression.');
  }
  if (expression.length > MAX_EVALUATE_SCRIPT_CHARS) {
    throw failed(`eval expression is limited to ${MAX_EVALUATE_SCRIPT_CHARS} characters`);
  }
  assertNotBlocked(page);
  const { sessionId, frameId } = frameTarget(page, params.frame);
  const timeoutMs = clamp(params.timeoutMs, 5_000, EVAL_MIN_TIMEOUT_MS, EVAL_MAX_TIMEOUT_MS);
  const world = params.world === 'utility' ? 'utility' : 'main';
  const returnByValue = params.returnByValue !== false;
  const send = <T>(method: string, body: Record<string, unknown>, beforeDispatch?: () => void) =>
    ctx.cdp.call<T>(guest, method, body, signal, { sessionId, timeoutMs, beforeDispatch });
  const runtime: Record<string, unknown> = {
    expression,
    returnByValue,
    awaitPromise: params.awaitPromise !== false,
    includeCommandLineAPI: true,
    userGesture: true,
  };
  if (world === 'utility') {
    // The page's own scripts cannot reach this world: its isolated copy of the frame's document.
    let target = frameId;
    if (!target) {
      const tree = await send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {});
      target = tree.frameTree.frame.id;
    }
    const created = await send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: target,
      worldName: UTILITY_WORLD,
    });
    runtime.contextId = created.executionContextId;
  } else if (frameId && !sessionId) {
    throw failed('eval in the main world of a frame needs the sessionId of the frame target; use world "utility" for a frame id');
  }
  // A script that provably leaves the page alone keeps the refs the caller holds (the old evaluate action). The refs are the
  // core engine's: it asks with `checkUnchanged` and invalidates them itself from the answer and from a failure.
  const keepsRefs = params.checkUnchanged === true;
  const url = guest.getURL();
  const before = keepsRefs ? await settledRevision(host, guest, signal) : undefined;
  const response = await send<EvaluateResponse>('Runtime.evaluate', runtime, guardBeforeDispatch(page, params.expect));
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    return {
      exception: {
        text: details.exception?.description || details.text || 'page script failed',
        line: details.lineNumber,
        column: details.columnNumber,
      },
    };
  }
  const remote = response.result;
  if (!returnByValue && remote?.objectId) ctx.cdp.releaseObject(guest, remote.objectId, sessionId);
  const unchanged =
    before !== undefined &&
    guest.getURL() === url &&
    !page.state.pendingDialog &&
    !page.state.openedPopups.length &&
    before === (await settledRevision(host, guest, signal));
  return { value: remote && 'value' in remote ? remote.value : (remote?.description ?? null), ...(keepsRefs ? { unchanged } : {}) };
}

const TEXT_OF_FRAME = '(() => document.body?.innerText || "")()';
const HIDDEN_TEXT_OF_FRAME = '(() => document.documentElement?.textContent || "")()';
const DOCUMENT_OF_FRAME =
  '(() => ({ url: location.href, origin: location.origin, title: document.title, readyState: document.readyState, textLength: (document.body?.innerText || "").length }))()';

async function read(host: PageHost, ctx: EngineContext, params: EngineParams, signal: AbortSignal, page: EnginePageCall) {
  const { guest } = page;
  assertNotBlocked(page);
  const kind = params.kind;
  const options = isObject(params.options) ? params.options : {};
  const maxChars = clamp(options.maxChars, READ_DEFAULT_CHARS, 1, READ_MAX_CHARS_WIRE);
  // Where a text read starts: a text longer than one read returns is read in parts, each from where the last ended.
  const offset = clamp(options.offset, 0, 0, READ_MAX_OFFSET);
  const frame = frameTarget(page, options.frame);
  // The frame a ref names: by id, or by the child session that owns it.
  const frameId = frame.frameId ?? (frame.sessionId ? page.state.cdpSessions.get(frame.sessionId)?.frameId : undefined);
  const inFrame = async <T>(expression: string): Promise<Array<[string, T]>> => {
    const frames = await host.documents.collect.byFrame<T>(guest, expression, signal);
    return frames.filter(([id]) => !frameId || id === frameId).map(([id, value]) => [id, value]);
  };
  if (kind === 'text') {
    if (typeof options.selector === 'string' && options.selector.trim()) {
      const named = Array.isArray(options.attributes)
        ? options.attributes
            .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
            .slice(0, READ_SELECTOR_MAX_ATTRIBUTES)
        : [];
      const rows = await host.documents.extractPage(
        guest,
        options.selector.trim(),
        named.length ? named : READ_SELECTOR_ATTRIBUTES,
        clamp(options.limit, EXTRACT_MAX_LIMIT, 1, EXTRACT_MAX_LIMIT),
        signal
      );
      return {
        payload: { url: guest.getURL(), title: guest.getTitle(), ...rows },
        truncated: rows.total > rows.rows.length,
      };
    }
    if (frameId || options.includeHidden === true) {
      const texts = await inFrame<string>(options.includeHidden === true ? HIDDEN_TEXT_OF_FRAME : TEXT_OF_FRAME);
      const joined = texts.map(([, value]) => value).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      const part = withoutLoneHalf(joined.slice(offset, offset + maxChars));
      return {
        payload: { url: guest.getURL(), title: guest.getTitle(), text: part, total: joined.length, offset },
        truncated: joined.length > offset + part.length,
      };
    }
    const result = await host.documents.readPage(guest, '', maxChars, offset, signal);
    // A part never ends inside a surrogate pair: the next part starts where this one ends, and a lone half does not survive JSON.
    const text = withoutLoneHalf(result.text);
    return { payload: { ...result, text }, truncated: result.total > result.offset + text.length };
  }
  if (kind === 'documents') {
    const documents = await inFrame<Record<string, unknown>>(DOCUMENT_OF_FRAME);
    return {
      payload: { documents: documents.map(([id, document]) => ({ frameId: id, ...document })) },
      truncated: false,
    };
  }
  if (kind === 'frames') {
    // Every frame of the page and of each child target, as the targets themselves report them.
    const sessions: Array<string | undefined> = [
      undefined,
      ...[...page.state.cdpSessions].filter(([, target]) => target.type === 'iframe').map(([id]) => id),
    ];
    const frames: Array<Record<string, unknown>> = [];
    for (const sessionId of sessions) {
      const tree = await ctx.cdp.call<{ frameTree: FrameTree }>(guest, 'Page.getFrameTree', {}, signal, { sessionId });
      const visit = (node: FrameTree, parentFrameId?: string) => {
        frames.push({ frameId: node.frame.id, parentFrameId, sessionId, url: node.frame.url, name: node.frame.name });
        for (const child of node.childFrames ?? []) visit(child, node.frame.id);
      };
      visit(tree.frameTree);
    }
    return { payload: { frames }, truncated: false };
  }
  throw new HostRpcError(HOST_INVALID_PARAMS, 'read kind must be text, documents or frames.');
}

interface FrameTree {
  frame: { id: string; url?: string; name?: string };
  childFrames?: FrameTree[];
}

async function renderCheckpoint(host: PageHost, params: EngineParams, signal: AbortSignal, page: EnginePageCall) {
  assertNotBlocked(page);
  const timeoutMs = clamp(params.timeoutMs, 1_000, 1, CHECKPOINT_MAX_MS);
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const reached = await host.documents.renderCheckpoint(
      page.guest,
      host.isBackground(page.guest),
      AbortSignal.any([signal, deadline])
    );
    return { reached };
  } catch (error) {
    // Only the deadline of this call is "not reached"; cancellation and real failures are errors.
    if (signal.aborted || !deadline.aborted) throw error;
    return { reached: false };
  }
}

/** The document-change counters of a revision (documents.ts BROWSER_OBSERVATION_REVISION), summed over its frames. */
function domCounter(revision: string): number {
  return revision.split('|').reduce((sum, frame) => sum + (Number(frame.split(':')[6]) || 0), 0);
}

async function domQuiet(host: PageHost, ctx: EngineContext, params: EngineParams, signal: AbortSignal, page: EnginePageCall) {
  const { guest } = page;
  assertNotBlocked(page);
  const quietMs = clamp(params.quietMs, 350, 1, DOM_QUIET_MAX_MS);
  const timeoutMs = clamp(params.timeoutMs, 1_500, quietMs, DOM_QUIET_MAX_MS);
  const wait = createBrowserDomQuiet({
    quietMs,
    timeoutMs,
    evaluate: async <T>(target: typeof guest, expression: string, cancel?: AbortSignal): Promise<T> => {
      const response = await ctx.cdp.call<EvaluateResponse>(
        target,
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        cancel,
        { timeoutMs: timeoutMs + CDP_REQUEST_TIMEOUT_MS }
      );
      if (response.exceptionDetails) throw failed(response.exceptionDetails.exception?.description || 'dom quiet observer failed');
      return response.result?.value as T;
    },
  });
  const before = domCounter(await host.documents.revision(guest, signal));
  const startedAt = Date.now();
  await wait(guest, signal);
  // The observer ends at its own hard timer too; one that ran the whole timeout never saw a quiet window.
  const quiet = Date.now() - startedAt < timeoutMs;
  const after = domCounter(await host.documents.revision(guest, signal));
  return { quiet, mutations: Math.max(0, after - before) };
}

async function answerDialog(host: PageHost, params: EngineParams, signal: AbortSignal, page: EnginePageCall) {
  const { guest, state } = page;
  if (typeof params.accept !== 'boolean') throw new HostRpcError(HOST_INVALID_PARAMS, 'dialog answer needs accept.');
  if (!state.pendingDialog) return { answered: false };
  const promptText = typeof params.promptText === 'string' ? params.promptText : '';
  const guard = guardBeforeDispatch(page, params.expect);
  await host.handleDialog(guest, params.accept, promptText, signal, guard);
  return { answered: true };
}

/** Registers `host/browser/page/*`. */
export function registerPage(connection: HostConnection, ctx: EngineContext, host: PageHost): void {
  const on = (
    method: string,
    handler: (params: EngineParams, signal: AbortSignal, page: EnginePageCall) => Promise<unknown>
  ) => registerEngineMethod(connection, ctx, `host/browser/page/${method}`, handler);
  on('navigate', (params, signal, page) => navigate(host, ctx, params, signal, page));
  on('stop', async (_params, _signal, page) => {
    if (!page.guest.isDestroyed() && page.guest.isLoading()) page.guest.stop();
    return {};
  });
  on('eval', (params, signal, page) => evaluate(host, ctx, params, signal, page));
  on('read', (params, signal, page) => read(host, ctx, params, signal, page));
  on('renderCheckpoint', (params, signal, page) => renderCheckpoint(host, params, signal, page));
  on('domQuiet', (params, signal, page) => domQuiet(host, ctx, params, signal, page));
  on('dialog/answer', (params, signal, page) => answerDialog(host, params, signal, page));
  on('sync', async (_params, _signal, page) => {
    // The queued events go out first, so the facts the core resets to are not older than any it received.
    ctx.events.flush(page.pageId);
    return { facts: ctx.events.facts(page.pageId) as PageFacts, consoleFloor: host.consoleFloor(page.pageId) };
  });
}
