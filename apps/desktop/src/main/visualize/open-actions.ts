import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import type { VisualizeInlineContent } from '../../shared/visualize';
import { MAX_VISUALIZE_VERSIONS } from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import type { HistoryEntry } from './history';
import { loadIsCurrent } from './reloads';
import {
  displayedPanes,
  type FileTarget,
  fileTargetsKey,
  findClosedRequestedHistory,
  findClosedRequestedHistoryExact,
  findFileTab,
  findVerifyRequestedTab,
  historyEntryMatchesRequestedTab,
  inlineKey,
  installLivePanes,
  problemsOf,
  rekeyFileTab,
  requestedPathsKey,
  requestedTargetsKey,
  resolvedCanonicalKey,
  resolveFileTabKey,
  sameInline,
  summary,
  type TabState,
  type VisualizeResult,
  versionNote,
  view,
  withProblems,
} from './tab-state';
import {
  insidePath,
  liveFilesFingerprint,
  parseVisualizeRequest,
  resolveVisualizeTarget,
  type VisualizeRequest,
  type VisualizeTarget,
} from './targets';
import { checkTabOffscreen } from './read-actions';
import {
  heldTurn,
  joinShown,
  offscreen,
  publishShown,
  selectShown,
  shownAs,
  shownOfKey,
  type TurnHold,
} from './turn-hold';
import { shownVersionOf } from './version-thumbnails';

type OpenRequest = Extract<VisualizeRequest, { action: 'open' }>;

type OpenContext = Pick<
  VisualizeServiceContext,
  | 'deps'
  | 'sessions'
  | 'sessionOf'
  | 'sessionCwds'
  | 'nextLoadStamp'
  | 'sessionReleaseEpoch'
  | 'isSessionReleased'
  | 'panes'
  | 'tabs'
  | 'leases'
  | 'thumbnails'
  | 'tabVersions'
  | 'views'
  | 'publish'
  | 'problems'
  | 'reloads'
  | 'holds'
  | 'panelSize'
>;

/** The user's own open, during a turn, of a file (or inline content, `key`) that needs no open, and must not be one:
 *  the session shows it as a picture from before the running turn's change (turn-hold.ts `shownAs`), which is brought
 *  up; or only the running turn has a tab of it, which is shown as it is now, marked as the turn's, and not touched
 *  (so the turn's end shows what the turn made of it). False when the open is to run. */
function viewsWithoutOpening(
  ctx: Pick<OpenContext, 'deps' | 'holds' | 'sessions' | 'views'>,
  sessionId: string,
  key: string
): boolean {
  const hold = ctx.holds.get(sessionId);
  if (!hold) return false;
  const shown = shownOfKey(hold, key);
  if (shown && shownAs(ctx, hold, sessionId, shown) === 'live') return false;
  const own = ctx.sessions
    .get(sessionId)
    ?.tabs.find((candidate) => candidate.key === key && !candidate.url && !candidate.verify);
  // A picture from before the turn's change stays that picture; the turn's own tab is seen as it is now, each time
  // it is asked for (and as it last was once the turn has closed it).
  const picture = shown !== undefined && !hold.shown.turn.has(shown);
  const tab = picture ? shown : (own?.id ?? shown);
  if (!tab) return false;
  if (!picture && own) joinShown(ctx, hold, sessionId, own.id, true);
  else selectShown(hold, tab);
  hold.picked = tab;
  publishShown(ctx.deps, hold, sessionId, { reveal: true, tab });
  return true;
}

const isPreTurnPast = (
  ctx: Pick<OpenContext, 'holds' | 'sessions'>,
  hold: TurnHold | undefined,
  sessionId: string,
  tabId: string
): boolean => hold !== undefined && !hold.shown.turn.has(tabId) && shownAs(ctx, hold, sessionId, tabId) === 'past';

/** Find a shown file tab inside `hold.shown` by requested path (exact, then Windows folded),
 *  reporting whether a closed history entry owns `(cwd, files)` so canonical fallback is blocked. */
function findHeldFileTabByRequested(
  hold: TurnHold,
  cwd: string,
  files: readonly FileTarget[],
  canonicalKey: string,
  { turnOnly, liveHistory }: { turnOnly: boolean; liveHistory?: readonly HistoryEntry[] }
): { tabId?: string; closedHistory: boolean } {
  const shownIds = new Set(hold.shown.state.tabs.map((tab) => tab.id));
  const entries = [...hold.shown.fileTabs.entries()].filter(
    ([id]) => shownIds.has(id) && hold.shown.turn.has(id) === turnOnly
  );
  const requestedKey = requestedTargetsKey(cwd, files);
  const canonicalMatches = (info: { missing?: boolean; canonicalKey?: string }): boolean => {
    if (info.missing && process.platform === 'win32') {
      return info.canonicalKey?.toLowerCase() === canonicalKey.toLowerCase();
    }
    return info.canonicalKey === canonicalKey;
  };
  const byExact = entries.find(
    ([, info]) =>
      info.targets.length === files.length &&
      requestedPathsKey(info.cwd, info.targets) === requestedKey &&
      (!turnOnly || canonicalMatches(info))
  );
  if (byExact) return { tabId: byExact[0], closedHistory: false };
  const openEntries = turnOnly
    ? [...hold.shown.fileTabs.entries()].filter(([id]) => shownIds.has(id) && !hold.shown.turn.has(id))
    : entries;
  const isOpen = (entry: HistoryEntry): boolean =>
    openEntries.some(
      ([id, info]) => hold.shown.keys.get(id) === entry.key && historyEntryMatchesRequestedTab(entry, info)
    );
  const history = liveHistory ? [...hold.shown.history, ...liveHistory] : hold.shown.history;
  if (findClosedRequestedHistoryExact({ isOpen, history }, cwd, files, canonicalKey)) {
    return { closedHistory: true };
  }
  if (process.platform === 'win32') {
    const foldedRequestedKey = requestedKey.toLowerCase();
    const byFolded = entries.find(
      ([, info]) =>
        info.targets.length === files.length &&
        requestedPathsKey(info.cwd, info.targets).toLowerCase() === foldedRequestedKey &&
        canonicalMatches(info)
    );
    if (byFolded) return { tabId: byFolded[0], closedHistory: false };
  }
  if (findClosedRequestedHistory({ isOpen, history }, cwd, files, canonicalKey)) {
    return { closedHistory: true };
  }
  return { closedHistory: false };
}

function findHeldFileTabByCanonical(
  hold: TurnHold,
  canonicalKey: string,
  { turnOnly }: { turnOnly: boolean }
): string | undefined {
  const shownIds = new Set(hold.shown.state.tabs.map((tab) => tab.id));
  const entries = [...hold.shown.fileTabs.entries()].filter(
    ([id]) => shownIds.has(id) && hold.shown.turn.has(id) === turnOnly
  );
  return (
    entries.find(([id, info]) => !info.missing && hold.shown.keys.get(id) === canonicalKey)?.[0] ??
    entries.find(([, info]) => !info.missing && info.canonicalKey === canonicalKey)?.[0]
  );
}

function revealHeldTab(
  deps: Pick<OpenContext['deps'], 'publish' | 'publishHost' | 'revokeInlinePage'> | undefined,
  hold: TurnHold,
  sessionId: string,
  tabId: string
): void {
  selectShown(hold, tabId);
  hold.picked = tabId;
  publishShown(deps, hold, sessionId, { reveal: true, tab: tabId });
}

/** File-open counterpart to `viewsWithoutOpening`: matches frozen pre-turn tabs strictly against
 *  `hold.shown`, prioritizes exact/folded hidden verify tabs ahead of canonical fallbacks, and
 *  honors frozen closed history before matching live or turn-only tabs by canonical target. */
function viewFileWithoutOpening(
  ctx: Pick<OpenContext, 'deps' | 'holds' | 'sessions' | 'views'>,
  sessionId: string,
  cwd: string,
  files: readonly FileTarget[],
  canonicalKey: string
): boolean {
  const hold = ctx.holds.get(sessionId);
  if (!hold) return false;
  const selectOrOpen = (tabId: string): boolean => {
    if (shownAs(ctx, hold, sessionId, tabId) === 'live') return false;
    revealHeldTab(ctx.deps, hold, sessionId, tabId);
    return true;
  };
  const preTurnRequested = findHeldFileTabByRequested(hold, cwd, files, canonicalKey, { turnOnly: false });
  if (preTurnRequested.tabId) return selectOrOpen(preTurnRequested.tabId);

  const currentState = ctx.sessions.get(sessionId);
  const liveCandidates = (currentState?.tabs ?? []).filter(
    (candidate) => !isPreTurnPast(ctx, hold, sessionId, candidate.id)
  );
  if (findVerifyRequestedTab(liveCandidates, cwd, files, canonicalKey)) return false;

  if (!preTurnRequested.closedHistory) {
    const preTurnCanonical = findHeldFileTabByCanonical(hold, canonicalKey, { turnOnly: false });
    if (preTurnCanonical) return selectOrOpen(preTurnCanonical);
  }

  const combinedHistory = [...(currentState?.history ?? []), ...hold.shown.history];
  const own = findFileTab(liveCandidates, cwd, files, canonicalKey, combinedHistory, {
    ignoreVerify: true,
  });
  if (own) {
    if (shownAs(ctx, hold, sessionId, own.id) === 'live') return false;
    if (own.missing || fileTargetsKey(own.targets) !== canonicalKey) return false;
    joinShown(ctx, hold, sessionId, own.id, true);
    hold.picked = own.id;
    publishShown(ctx.deps, hold, sessionId, { reveal: true, tab: own.id });
    return true;
  }
  const turnRequested = findHeldFileTabByRequested(hold, cwd, files, canonicalKey, {
    turnOnly: true,
    liveHistory: currentState?.history,
  });
  const turnTab =
    turnRequested.tabId ??
    (!turnRequested.closedHistory ? findHeldFileTabByCanonical(hold, canonicalKey, { turnOnly: true }) : undefined);
  if (!turnTab) return false;
  revealHeldTab(ctx.deps, hold, sessionId, turnTab);
  return true;
}

/** Select a pre-turn picture already shown during a hold (no open needed). */
function selectHeldPicture(
  ctx: Pick<OpenContext, 'deps' | 'holds' | 'sessions'>,
  sessionId: string,
  tabId: string
): boolean {
  const hold = ctx.holds.get(sessionId);
  if (!hold || !tabId || hold.shown.turn.has(tabId)) return false;
  if (shownAs(ctx, hold, sessionId, tabId) !== 'past') return false;
  revealHeldTab(ctx.deps, hold, sessionId, tabId);
  return true;
}

/** A reopened tab goes to the end of the session's tabs, like a fresh open. */
function moveToEnd(tabs: TabState[], tab: TabState): void {
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.push(tab);
}

function addNewTab(
  ctx: Pick<OpenContext, 'tabs'>,
  state: ReturnType<OpenContext['sessionOf']>,
  sessionId: string,
  fields: Pick<TabState, 'label' | 'key' | 'cwd'> & Partial<TabState>
): TabState {
  state.counter += 1;
  const lastCanonicalKey = fields.lastCanonicalKey ?? resolvedCanonicalKey(fields.targets);
  const tab: TabState = {
    id: `v${state.counter}`,
    revision: 0,
    targets: [],
    panes: [],
    unwatch: [],
    lifetime: new AbortController(),
    reloadTimer: null,
    problems: [],
    problemSeq: 0,
    ...fields,
    ...(lastCanonicalKey ? { lastCanonicalKey } : {}),
  };
  ctx.tabs.addTab(sessionId, tab);
  return tab;
}

function reuseTab(
  ctx: Pick<OpenContext, 'thumbnails'>,
  tabs: TabState[],
  tab: TabState,
  label: string | undefined,
  cwd: string,
  panes: TabState['panes'],
  fields: Partial<TabState>
): void {
  tab.label = label ?? tab.label;
  tab.cwd = cwd;
  installLivePanes(tab, panes, fields);
  tab.problems = [];
  ctx.thumbnails.invalidate(tab);
  moveToEnd(tabs, tab);
}

/** The shared tail of a file or inline open on a committed tab: activation,
 *  publish, placement text, load check and the result. */
async function finishOpen(
  ctx: Pick<
    OpenContext,
    | 'deps'
    | 'sessionOf'
    | 'sessionCwds'
    | 'isSessionReleased'
    | 'thumbnails'
    | 'views'
    | 'publish'
    | 'problems'
    | 'holds'
    | 'panelSize'
  >,
  request: OpenRequest,
  tab: TabState,
  open: {
    releaseEpoch: number;
    held: boolean;
    user: boolean;
    versionError: Error | null;
    what: string;
    live: string;
    note: () => string;
    settle: () => Promise<void>;
    recordsCwd: () => boolean;
  }
): Promise<VisualizeResult> {
  const { sessionId, cwd } = request;
  const { held } = open;
  const verify = request.verify === true;
  if (!held && !verify) ctx.sessionOf(sessionId).active = tab.id;
  if (!verify) ctx.views.rememberTab(sessionId, tab, true);
  ctx.publish(sessionId, verify ? undefined : tab.id, undefined, verify ? undefined : request.callId, open.user);
  // A verify placement stays synchronous: the load check below must start before another open can replace the panes.
  let placed: string;
  if (verify) placed = verifyPlacement(ctx, sessionId, tab, open.what);
  else if (held) placed = await heldPlacement(ctx.deps, sessionId, tab, open.what);
  else placed = await placement(ctx.deps, sessionId, tab, open.what);
  let loaded = '';
  if (held || verify) loaded = await heldLoadCheck(ctx, sessionId, cwd, tab);
  else await open.settle();
  if (!ctx.isSessionReleased?.(sessionId, open.releaseEpoch) && !tab.lifetime.signal.aborted) {
    if (open.recordsCwd()) ctx.sessionCwds.set(sessionId, cwd);
    if (!verify) ctx.thumbnails.refresh(sessionId, tab);
  }
  return {
    text: withProblems(
      tab,
      `${placed}${open.note()}${versionNote(tab)}${versionErrorNote(open.versionError, tab, open.live)}${loaded}`
    ),
    ...(verify ? {} : { tabs: [summary(tab)] }),
    ...problemsOf(tab),
  };
}

/** Show the kept `version` a request asks for; a failure is only a note of
 *  the result, since the tab was already opened (and published) live. */
async function selectRequested(
  ctx: Pick<OpenContext, 'tabVersions'>,
  sessionId: string,
  tab: TabState,
  version: number
): Promise<Error | null> {
  try {
    await ctx.tabVersions.selectVersion(sessionId, tab, version, false);
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** "v3", or "v3 (version 2)" from a tab's second kept version on: chat cards
 *  read the tab id and the version their open made from the result text (no
 *  version named on a host that keeps them = version 1). */
function tabRef(tab: TabState): string {
  const n = shownVersionOf(tab);
  return n > 1 ? `${tab.id} (version ${n})` : tab.id;
}

/** Where the opened tab went: "Showing" only when the user can see it now,
 *  else what stands between it and the user, so the agent can say so. Keeps
 *  the literal "as tab vN" (chat cards read the tab id from it). */
async function placement(
  deps: Pick<OpenContext['deps'], 'onScreen'>,
  sessionId: string,
  tab: TabState,
  what: string
): Promise<string> {
  const state = (await deps.onScreen?.(sessionId, view(tab))) ?? 'visible';
  if (state === 'visible') return `Showing ${what} in the side panel as tab ${tabRef(tab)}.`;
  if (state === 'background') {
    return `Opened ${what} in the side panel as tab ${tabRef(tab)}, but the Mixdog window is in the background (another app has the focus); tell the user it is waiting in the Mixdog window.`;
  }
  if (state === 'covered') {
    return `Opened ${what} in the side panel as tab ${tabRef(tab)}, but something in the Mixdog window covers the panel (a dialog, Settings or another overlay); the user must close it to see the tab.`;
  }
  if (state === 'other-tab') {
    return `Opened ${what} in the side panel as tab ${tabRef(tab)}, but the panel keeps showing another tab the user picked; the new tab is only marked updated in the panel's tab strip, so tell the user it is there.`;
  }
  return `Opened ${what} as tab ${tabRef(tab)}, but it is not on screen (the window is minimized or hidden, or the session is not shown); the user must bring the Mixdog window and this session's visualize panel up to see it.`;
}

/** An open during an agent turn (turn-hold.ts): kept, shown when the turn
 *  ends, and whether the user can reach the session to see it then. Keeps
 *  the literal "as tab vN" (chat cards read the tab id from it). */
async function heldPlacement(
  deps: Pick<OpenContext['deps'], 'sessionReach'>,
  sessionId: string,
  tab: TabState,
  what: string
): Promise<string> {
  const reach = (await deps.sessionReach?.(sessionId)) ?? 'shown';
  const prepared = `Prepared ${what} as tab ${tabRef(tab)}`;
  const offscreen = 'check, inspect and capture work on the tab now, off screen.';
  if (reach === 'not-open') {
    return `${prepared}, but this session is not open in the Mixdog window, so the user will not see it when this turn ends; tell the user to open this conversation to see it. ${offscreen}`;
  }
  const ends = `${prepared}; the side panel shows it when this turn ends`;
  if (reach === 'background') {
    return `${ends}, but the Mixdog window is in the background (another app has the focus); tell the user it is waiting in the Mixdog window. ${offscreen}`;
  }
  if (reach === 'hidden') {
    return `${ends}, but the Mixdog window is minimized or hidden; tell the user to bring the Mixdog window up to see it. ${offscreen}`;
  }
  return `${ends} (it is left alone until then, so open again freely after edits). ${offscreen}`;
}

/** A verify open (`input.verify`): the agent's own check, never shown to the
 *  user. Never "as tab vN" (chat cards read that wording) and no tab list in
 *  the result, so no card is drawn. */
function verifyPlacement(ctx: Pick<OpenContext, 'holds'>, sessionId: string, tab: TabState, what: string): string {
  const ends = tab.verify ? 'it closes when the turn ends' : 'it was already open and stays as it is';
  const off = offscreen(ctx, sessionId, tab) ? ' check, inspect and capture work on the tab now, off screen.' : '';
  return `Opened ${what} for checking only (tab ${tabRef(tab)}); the user is not shown it, ${ends}.${off}`;
}

/** A verify open creates its tab verify-only (set before `addTab`, so the
 *  tab limit already sees it) and leaves an open tab as it was (a shown tab
 *  never turns verify-only). A plain open of a verify-only tab shows it: it
 *  now counts toward the tab limit. */
function promoteVerify(ctx: Pick<OpenContext, 'tabs'>, sessionId: string, tab: TabState, verify: boolean): void {
  if (verify || !tab.verify) return;
  tab.verify = undefined;
  ctx.tabs.enforceLimit(sessionId);
}

/** The files an open names, relative to the working directory when inside it. */
function describeFiles(cwd: string, files: FileTarget[]): string {
  return files
    .map((target) => {
      // A file outside the working directory is named by its full path.
      const name = insidePath(cwd, target.path) ? relative(cwd, target.path).replace(/\\/g, '/') : target.path;
      return `${name || target.label} (${target.kind})`;
    })
    .join(', ');
}

async function heldLoadCheck(
  ctx: Pick<OpenContext, 'deps' | 'panelSize'>,
  sessionId: string,
  cwd: string,
  tab: TabState
): Promise<string> {
  const panes = displayedPanes(tab);
  const pages = panes.some((pane) => pane.kind === 'html');
  const inline = panes.some((pane) => pane.kind === 'inline');
  if (pages ? !ctx.deps.inspectOffscreen : !(inline && ctx.deps.exportBytes)) return '';
  try {
    const { problems } = await checkTabOffscreen(ctx, sessionId, cwd, tab);
    return problems.length
      ? `\nPage problems while it loaded off screen:\n${problems.map((line) => `- ${line}`).join('\n')}`
      : '';
  } catch (error) {
    return `\nThe off-screen load check failed: ${(error as Error).message}`;
  }
}

/** The result's note on a requested version that could not be shown. */
function versionErrorNote(error: Error | null, tab: TabState, live: string): string {
  return error ? ` Version not shown: ${error.message}; tab ${tab.id} shows the ${live}.` : '';
}

/** `open` with `input.content`: a direct-renderer tab, no files. Reopening
 *  the same title keeps the tab and adds a version when the content changed. */
async function openInline(
  ctx: Pick<
    OpenContext,
    | 'deps'
    | 'sessions'
    | 'sessionOf'
    | 'sessionCwds'
    | 'sessionReleaseEpoch'
    | 'isSessionReleased'
    | 'panes'
    | 'tabs'
    | 'leases'
    | 'thumbnails'
    | 'tabVersions'
    | 'views'
    | 'publish'
    | 'problems'
    | 'holds'
    | 'panelSize'
  >,
  request: OpenRequest,
  content: VisualizeInlineContent,
  user: boolean
): Promise<VisualizeResult> {
  const { sessionOf } = ctx;
  const { sessionId, cwd } = request;
  const releaseEpoch = ctx.sessionReleaseEpoch?.(sessionId) ?? 0;
  const held = !user && heldTurn(ctx, sessionId) !== null;
  const verify = request.verify === true;
  const key = inlineKey(content);
  if (user && viewsWithoutOpening(ctx, sessionId, key)) return { text: '' };
  const pane = await ctx.panes.inlinePaneFor(content);
  if (ctx.isSessionReleased?.(sessionId, releaseEpoch)) {
    ctx.tabs.releasePanes([pane]);
    throw new Error(`visualize session "${sessionId}" was released`);
  }
  const state = sessionOf(sessionId);
  let tab = state.tabs.find((candidate) => candidate.key === key);
  if (tab) {
    ctx.tabs.releasePanes(tab.panes);
    if (tab.shown) ctx.tabs.releasePanes(tab.shown.panes);
    reuseTab(ctx, state.tabs, tab, request.label, cwd, [pane], { inline: content });
  } else {
    tab = addNewTab(ctx, state, sessionId, {
      label: request.label ?? pane.label,
      key,
      cwd,
      inline: content,
      inlineHistory: [],
      panes: [pane],
      allowNetwork: true,
      ...(verify ? { verify: true } : {}),
    });
  }
  promoteVerify(ctx, sessionId, tab, verify);
  tab.rendered = new Set();
  tab.shown = null;
  tab.compare = false;
  ctx.leases.claimLeases(sessionId, tab, tab.panes);
  const history = tab.inlineHistory ?? [];
  if (!history.length || !sameInline(history[history.length - 1].content, content)) {
    history.push({ n: (history.at(-1)?.n ?? 0) + 1, at: Date.now(), content });
    if (history.length > MAX_VISUALIZE_VERSIONS) history.shift();
  }
  tab.inlineHistory = history;
  tab.versions = history.map(({ n, at, turns }) => ({ n, at, ...(turns?.length ? { turns } : {}) }));
  const versionError =
    request.version === undefined ? null : await selectRequested(ctx, sessionId, tab, request.version);
  assertOpenTabActive(ctx, sessionId, releaseEpoch, tab, false);
  const target = tab;
  return finishOpen(ctx, request, target, {
    releaseEpoch,
    held,
    user,
    versionError,
    what: `inline ${content.kind}${content.title ? ` "${content.title}"` : ''}`,
    live: 'live content',
    note: () => ' Open again with the same title to add a version.',
    settle: async () => {
      await ctx.problems.awaitInlineRender(target);
      if (displayedPanes(target).some((candidate) => candidate.kind === 'html')) await ctx.problems.settle(target, 1);
    },
    recordsCwd: () => true,
  });
}

function assertOpenTabActive(
  ctx: Pick<OpenContext, 'isSessionReleased' | 'tabs' | 'tabVersions'>,
  sessionId: string,
  releaseEpoch: number,
  tab: TabState,
  dropVersions: boolean
): void {
  if (ctx.isSessionReleased?.(sessionId, releaseEpoch)) {
    ctx.tabs.end(tab);
    if (dropVersions) ctx.tabVersions.dropVersions(sessionId, tab.id);
    throw new Error(`visualize session "${sessionId}" was released`);
  }
  if (tab.lifetime.signal.aborted) {
    ctx.tabs.end(tab);
    if (dropVersions) ctx.tabVersions.dropVersions(sessionId, tab.id);
    throw new Error(`visualize tab "${tab.id}" was closed`);
  }
}

/** `open` of a web URL: handed to the session's browser panel; the tab
 *  only records it. */
async function openUrl(
  ctx: Pick<OpenContext, 'deps' | 'sessionOf' | 'tabs'>,
  request: OpenRequest,
  target: Extract<VisualizeTarget, { kind: 'url' }>
): Promise<VisualizeResult> {
  const { deps, sessionOf } = ctx;
  const { sessionId, cwd } = request;
  if (!deps.browserAvailable()) {
    throw new Error('web URLs open in the browser panel, which needs the Browser Use feature installed');
  }
  // The pane opens this URL in a new tab and names it with this id: the page
  // that tab creates (not an older page at the same address, nor a tab the
  // user opened) is the one the browser tool must drive.
  const openRequestId = randomUUID();
  const watch = deps.watchBrowserTab?.(sessionId, openRequestId);
  try {
    deps.publish({ sessionId, openUrl: target.url, openRequestId });
    deps.publishHost?.({ sessionId, openUrl: target.url });
  } catch (error) {
    watch?.cancel();
    throw error;
  }
  const state = sessionOf(sessionId);
  let tab = state.tabs.find((candidate) => candidate.url === target.url);
  tab ??= addNewTab(ctx, state, sessionId, {
    label: request.label ?? target.label,
    key: `url:${target.url}`,
    cwd,
    url: target.url,
  });
  // The tab id only names this record: the browser tool's `v1` is the panel's
  // first open page, often an older one. The page's own id (`p…`) is what
  // the browser tool takes. Without a browser host nothing is awaited.
  const pageId = (await watch?.page) ?? null;
  const text = pageId
    ? `Opened ${target.url} in the session's browser panel as page ${pageId}; pass tab:"${pageId}" to the browser tool.`
    : `Opened ${target.url} in the session's browser panel; its page id (p…) is not known yet, so find it with the browser tool's list_tabs.`;
  return { text, tabs: [summary(tab)] };
}

export function createOpenActions(ctx: OpenContext) {
  const { deps, sessionOf, sessionCwds } = ctx;

  /** `user`: the user's own open (a chat card, a turn's previews), never a running turn's work: it shows at once,
   *  and during a turn joins what the session shows. */
  async function open(request: OpenRequest, user = false): Promise<VisualizeResult> {
    if (!deps.windowAvailable()) throw new Error('the Mixdog desktop window is not open');
    if (request.content) return openInline(ctx, request, request.content, user);
    const { sessionId, cwd } = request;
    const releaseEpoch = ctx.sessionReleaseEpoch?.(sessionId) ?? 0;
    const stamp = ctx.nextLoadStamp();
    const targets = await Promise.all(request.targets.map((target) => resolveVisualizeTarget(cwd, target)));
    if (ctx.isSessionReleased?.(sessionId, releaseEpoch)) {
      throw new Error(`visualize session "${sessionId}" was released`);
    }
    const web = targets.filter((target) => target.kind === 'url');
    if (web.length) {
      if (targets.length > 1) {
        throw new Error('a web URL opens alone in the browser panel; pass it as the only target');
      }
      if (request.version !== undefined)
        throw new Error('input.version applies to file tabs; a web URL keeps no versions');
      if (request.verify)
        throw new Error('input.verify applies to file and inline tabs; a web URL opens in the browser panel');
      return openUrl(ctx, request, web[0]);
    }
    const files = targets as FileTarget[];
    const key = fileTargetsKey(files);
    if (user && viewFileWithoutOpening(ctx, sessionId, cwd, files, key)) return { text: '' };
    const panes = await ctx.panes.preparePanes(files);
    if (ctx.isSessionReleased?.(sessionId, releaseEpoch)) {
      ctx.tabs.releasePanes(panes);
      throw new Error(`visualize session "${sessionId}" was released`);
    }
    const liveStat = await liveFilesFingerprint(files);
    if (ctx.isSessionReleased?.(sessionId, releaseEpoch)) {
      ctx.tabs.releasePanes(panes);
      throw new Error(`visualize session "${sessionId}" was released`);
    }
    const state = sessionOf(sessionId);
    const activeHold = user ? ctx.holds.get(sessionId) : undefined;
    const openCandidates = activeHold
      ? state.tabs.filter((candidate) => !isPreTurnPast(ctx, activeHold, sessionId, candidate.id))
      : state.tabs;
    const openHistory = activeHold ? [...state.history, ...activeHold.shown.history] : state.history;
    let tab =
      findFileTab(openCandidates, cwd, files, key, openHistory) ??
      findVerifyRequestedTab(openCandidates, cwd, files, key);
    const verify = request.verify === true;
    const wasVerify = tab?.verify === true;
    const label = request.label ?? files.map((target) => target.label).join(' · ');
    // A reload or reopen started after this open already committed newer
    // files and cwd: this open's resolution is stale and is dropped.
    const stale = tab !== undefined && !loadIsCurrent(tab, stamp);
    if (tab && stale) {
      ctx.tabs.releasePanes(panes);
      tab.label = request.label ?? tab.label;
      moveToEnd(state.tabs, tab);
    } else if (tab) {
      ctx.tabs.dispose(tab);
      reuseTab(ctx, state.tabs, tab, request.label, cwd, panes, {
        loadedStamp: stamp,
        targets: files,
        ...(liveStat ? { liveStat } : { liveStat: undefined }),
      });
      if (!wasVerify || verify) rekeyFileTab(state, tab, files);
    } else {
      const tabKey = resolveFileTabKey(state, cwd, files, { syncHistory: !verify });
      tab = addNewTab(ctx, state, sessionId, {
        label,
        key: tabKey,
        cwd,
        loadedStamp: stamp,
        targets: files,
        panes,
        allowNetwork: true,
        ...(liveStat ? { liveStat } : {}),
        ...(verify ? { verify: true } : {}),
      });
    }
    promoteVerify(ctx, sessionId, tab, verify);
    if (wasVerify && !verify) {
      resolveFileTabKey(state, tab.cwd, tab.targets, { tab, syncHistory: true, promoteFromVerify: true });
    }
    if (!stale) {
      ctx.leases.claimLeases(sessionId, tab, panes);
      ctx.reloads.watchTab(sessionId, tab);
    }
    // An agent open shows the live files; a kept version only on request.
    if (tab.shown) ctx.thumbnails.invalidate(tab);
    tab.shown = null;
    tab.compare = false;
    tab.pendingReload = false;
    await ctx.tabVersions.recordVersion(sessionId, tab);
    assertOpenTabActive(ctx, sessionId, releaseEpoch, tab, true);
    const versionError =
      request.version === undefined ? null : await selectRequested(ctx, sessionId, tab, request.version);
    assertOpenTabActive(ctx, sessionId, releaseEpoch, tab, true);
    const held = !user && heldTurn(ctx, sessionId) !== null;
    const target = tab;
    return finishOpen(ctx, request, target, {
      releaseEpoch,
      held,
      user,
      versionError,
      what: describeFiles(cwd, files),
      live: 'live files',
      note: () => {
        if (target.verify) return '';
        return ` The tab reloads when ${files.length > 1 ? 'these files change' : 'the file changes'}.`;
      },
      settle: async () => {
        if (panes.some((pane) => pane.kind === 'html')) await ctx.problems.settle(target, 1);
      },
      recordsCwd: () => !stale && target.cwd === cwd,
    });
  }

  return {
    open,
    /** Open `targets` (or inline `content`) again in the session's last working
     *  directory: the working directory is main's to know, never the client's,
     *  and the targets are validated exactly like an agent open. */
    async reopen(
      sessionId: string,
      targets: string[],
      content: VisualizeInlineContent | undefined,
      label: string | undefined,
      preferredCwd?: string,
      preferredTabId?: string
    ): Promise<void> {
      if (preferredTabId && selectHeldPicture(ctx, sessionId, preferredTabId)) return;
      const tabCwd = preferredTabId
        ? (ctx.holds.get(sessionId)?.shown.host.tabs.find((tab) => tab.id === preferredTabId)?.cwd ??
          ctx.sessions.get(sessionId)?.tabs.find((tab) => tab.id === preferredTabId && !tab.url && !tab.verify)?.cwd)
        : undefined;
      const cwd = preferredCwd ?? tabCwd ?? sessionCwds.get(sessionId) ?? (await deps.sessionCwd?.(sessionId)) ?? null;
      if (!cwd) throw new Error("the session's working directory is unknown; ask the agent to show it again");
      await open(
        parseVisualizeRequest({
          sessionId,
          cwd,
          action: 'open',
          input: { ...(content ? { content } : { targets }), ...(label ? { label } : {}) },
        }) as OpenRequest,
        true
      );
    },
  };
}

export type OpenActions = ReturnType<typeof createOpenActions>;
