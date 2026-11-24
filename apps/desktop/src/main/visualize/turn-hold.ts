import { stat } from 'node:fs/promises';

import { MAX_VISUALIZE_GONE_OPENS, type VisualizeHostState, type VisualizeSessionState } from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import type { VisualizeServiceDeps } from './service';
import { displayedPanes, type SessionState, shownLayout, type TabState, view } from './tab-state';
import { isFileMissing } from './targets';
import { keepVersionTurn } from './version-thumbnails';

export interface TurnHold {
  /** Tabs the turn opened or showed, each once, the latest last. */
  reveal: string[];
  /** Each open the turn made (its tool call id) and the tab it landed on:
   *  what the turn-end record of tabs with nothing left to show names. */
  opens: Array<{ tab: string; call: string }>;
  /** Open tabs whose files changed during the turn: reloaded once at its end. */
  reloads: Set<TabState>;
  /** A consumer was told of the hold (a publish kept back, a snapshot read):
   *  its end is published. */
  dirty: boolean;
  /** The turn ended; its held reloads are running. */
  flushing: boolean;
  /** When the turn's first start signal came (ms): the span its versions
   *  record begins there. */
  since: number;
  /** When the turn that started during this one's end started (ms). */
  nextSince?: number;
  /** The tab the user selected since the last turn end began: the end being
   *  applied leaves the panel on it. A selection made while a turn runs ends
   *  with that turn. */
  picked?: string;
  /** What the session shows while the hold lasts, in every window, snapshot
   *  and paired device: its state as of the last turn whose end is applied,
   *  with what the user's own panel commands did to its tabs since, and when
   *  the oldest turn not shown yet started (ms): chat cards of opens made
   *  since then wait. */
  shown: ShownState & { since: number };
}

/** One publication of what the session shows during the hold, to the window
 *  and the remote mirror; its consumers then know of the hold. */
export function publishShown(
  deps: Pick<VisualizeServiceDeps, 'publish' | 'publishHost'> | undefined,
  hold: TurnHold,
  sessionId: string,
  effect: { reveal?: true; tab?: string; updated?: string } = {}
): void {
  hold.dirty = true;
  const event = { held: true as const, heldSince: hold.shown.since, ...effect };
  deps?.publish({ sessionId, state: hold.shown.state, ...event });
  deps?.publishHost?.({ sessionId, state: hold.shown.host, ...event });
}

/** How a tab the session shows during the hold stands to the session's tabs:
 *  `live`, it is the tab as it is now; `past`, the running turn has changed,
 *  closed or replaced it since, and what is shown is a picture from before.
 *  Null when the session does not show the tab. One rule follows for every
 *  command of the user's (panel-commands.ts): a command on a `live` tab runs
 *  on the tab and what is shown follows; on a `past` one it can only arrange
 *  the picture (select it, close it), and what needs the tab itself is
 *  refused until the turn ends. */
export function shownAs(
  ctx: Pick<VisualizeServiceContext, 'sessions'>,
  hold: TurnHold,
  sessionId: string,
  tabId: string
): 'live' | 'past' | null {
  const shown = hold.shown.state.tabs.find((tab) => tab.id === tabId);
  if (!shown) return null;
  // The running turn's own tab, shown at the user's request: viewed, never acted on, until the turn ends.
  if (hold.shown.turn.has(tabId)) return 'past';
  const tab = ctx.sessions.get(sessionId)?.tabs.find((candidate) => candidate.id === tabId);
  return tab && !tab.url && !tab.verify && tab.revision === shown.revision ? 'live' : 'past';
}

/** A command that needs the tab itself (a version, a network switch, a
 *  restore, an export) on a tab shown as a picture from before the running
 *  turn's change: refused, never run on the turn's own work. */
export function refusePast(
  ctx: Pick<VisualizeServiceContext, 'sessions' | 'holds'>,
  sessionId: string,
  tabId: string
): void {
  const hold = ctx.holds.get(sessionId);
  if (!hold || shownAs(ctx, hold, sessionId, tabId) !== 'past') return;
  if (hold.shown.turn.has(tabId)) {
    throw new Error(`The running turn is still writing tab ${tabId}. Try again when the turn ends.`);
  }
  throw new Error(
    `The running turn has changed or closed tab ${tabId}; the panel shows it as it was before. Try again when the turn ends.`
  );
}

/** The tab the session shows of the file (or inline content) `key` during the hold. */
export function shownOfKey(hold: TurnHold, key: string): string | undefined {
  return hold.shown.state.tabs.find((tab) => hold.shown.keys.get(tab.id) === key)?.id;
}

/** What the session shows of `tabId` becomes the tab as `now` has it, or goes when `now` has none. */
function replaceShown(hold: TurnHold, tabId: string, now?: ShownState): void {
  const { state, host, keys, turn, since } = hold.shown;
  if (!state.tabs.some((tab) => tab.id === tabId)) return;
  const put = <T extends { id: string }>(tabs: T[], from: T[] = []): T[] =>
    tabs.flatMap((shown) => (shown.id === tabId ? from.filter((tab) => tab.id === tabId) : [shown]));
  const tabs = put(state.tabs, now?.state.tabs);
  const active = tabs.some((tab) => tab.id === state.active) ? state.active : (tabs.at(-1)?.id ?? null);
  const left = (id: string): boolean => tabs.some((tab) => tab.id === id);
  hold.shown = {
    state: { ...state, tabs, active },
    host: { ...host, tabs: put(host.tabs, now?.host.tabs), active },
    keys: new Map([...keys].filter(([id]) => left(id))),
    turn: new Set([...turn].filter(left)),
    since,
  };
}

/** The user's command ran on `tabId`, a tab shown `live` (a close, a version,
 *  a network switch, a restore): what the session shows of that tab follows
 *  the tab as it now is, or goes with it; the running turn's work stays kept
 *  back. */
export function followShown(
  ctx: Pick<VisualizeServiceContext, 'views' | 'sessions'>,
  hold: TurnHold,
  sessionId: string,
  tabId: string
): void {
  replaceShown(hold, tabId, shownNow(ctx, sessionId));
}

/** The user closed `tabId`, shown as a picture from before the running
 *  turn's change: the picture goes; what the turn made of the tab is its own. */
export function dropShown(hold: TurnHold, tabId: string): void {
  replaceShown(hold, tabId);
}

/** The user selected `tabId` during the hold, as a picture or as the tab
 *  itself: what the session shows moves to it at once (also while a turn's
 *  end is applied, which then leaves the panel on it). */
export function pickShown(
  deps: Pick<VisualizeServiceDeps, 'publish' | 'publishHost'> | undefined,
  hold: TurnHold,
  sessionId: string,
  tabId: string
): void {
  if (hold.shown.state.active === tabId) return;
  selectShown(hold, tabId);
  hold.picked = tabId;
  publishShown(deps, hold, sessionId);
}

/** A session's state as both consumers get it: the desktop window's and the
 *  remote mirror's, with the file (or inline content) each tab is of, and
 *  the tabs among them that are the running turn's own, shown as they were
 *  when the user asked to see them (`turnWork` on their views). */
export interface ShownState {
  state: VisualizeSessionState;
  host: VisualizeHostState;
  keys: ReadonlyMap<string, string>;
  turn: ReadonlySet<string>;
}

/** The session's state right now, kept apart from the tabs it was read from. */
export function shownNow(ctx: Pick<VisualizeServiceContext, 'views' | 'sessions'>, sessionId: string): ShownState {
  const tabs = ctx.sessions.get(sessionId)?.tabs ?? [];
  return {
    ...structuredClone({ state: ctx.views.stateOf(sessionId), host: ctx.views.hostStateOf(sessionId) }),
    keys: new Map(tabs.filter((tab) => !tab.url && !tab.verify).map((tab) => [tab.id, tab.key])),
    turn: new Set(),
  };
}

/** Whether the session shows `tab` as it is now during the hold: a window then draws the tab itself. */
export function showsTab(hold: TurnHold, tab: TabState): boolean {
  return hold.shown.state.tabs.some((shown) => shown.id === tab.id && shown.revision === tab.revision);
}

/** A tab the user opened during the hold (a chat card, a turn's previews, "All visuals") joins what the session
 *  shows, as it is now, and is the one shown; the rest of the running turn's work stays kept back. The session shows
 *  one tab of a file: a picture of an earlier tab of the same one goes. `turn`: the tab is the running turn's own,
 *  which the user asked to see: it is shown as it is now and marked so, and the tab itself is not touched. */
export function joinShown(
  ctx: Pick<VisualizeServiceContext, 'views' | 'sessions'>,
  hold: TurnHold,
  sessionId: string,
  tabId: string,
  turn = false
): void {
  const now = shownNow(ctx, sessionId);
  const key = now.keys.get(tabId);
  if (key === undefined || !now.state.tabs.some((tab) => tab.id === tabId)) return;
  const { state, host, keys, since } = hold.shown;
  const other = (id: string): boolean => id !== tabId && keys.get(id) !== key;
  const put = <T extends { id: string }>(tabs: T[], from: T[]): T[] => {
    const tab = from
      .filter((candidate) => candidate.id === tabId)
      .map((candidate) => (turn ? { ...candidate, turnWork: true as const } : candidate));
    if (!tabs.some((shown) => shown.id === tabId)) return [...tabs.filter((shown) => other(shown.id)), ...tab];
    return tabs.flatMap((shown) => {
      if (shown.id === tabId) return tab;
      return other(shown.id) ? [shown] : [];
    });
  };
  hold.shown = {
    state: { ...state, tabs: put(state.tabs, now.state.tabs), active: tabId },
    host: { ...host, tabs: put(host.tabs, now.host.tabs), active: tabId },
    keys: new Map([...[...keys].filter(([id]) => other(id)), [tabId, key]]),
    turn: new Set([...[...hold.shown.turn].filter(other), ...(turn ? [tabId] : [])]),
    since,
  };
}

/** A card picture of `tab` that arrived during the hold: it is the shown tab's when the session shows the tab as it
 *  is now (a tab the running turn made or changed keeps its picture for that turn's end). */
export function joinPicture(hold: TurnHold, tab: TabState): void {
  if (!tab.thumbnail || !showsTab(hold, tab)) return;
  const picture = { thumbnail: tab.thumbnail, thumbnailVersion: tab.thumbnailVersion ?? 0 };
  const put = <T extends { id: string }>(tabs: T[]): T[] =>
    tabs.map((shown) => (shown.id === tab.id ? { ...shown, ...picture } : shown));
  const { state, host } = hold.shown;
  hold.shown = { ...hold.shown, state: { ...state, tabs: put(state.tabs) }, host: { ...host, tabs: put(host.tabs) } };
}

/** The user selected `tabId` during the hold: what the session shows moves to
 *  it (a tab the running turn made is not shown, so not selected there). */
export function selectShown(hold: TurnHold, tabId: string): void {
  const { state, host } = hold.shown;
  if (state.active === tabId || !state.tabs.some((tab) => tab.id === tabId)) return;
  hold.shown = { ...hold.shown, state: { ...state, active: tabId }, host: { ...host, active: tabId } };
}

/** The session's turn hold when agent actions are held right now. */
export function heldTurn(ctx: Pick<VisualizeServiceContext, 'holds'>, sessionId: string): TurnHold | null {
  const hold = ctx.holds.get(sessionId);
  return hold && !hold.flushing ? hold : null;
}

/** A tab the turn opened (or a publish asked to reveal): kept once, latest
 *  last. `callId` (an open's tool call id) is kept with the tab, so the turn
 *  end can name exactly the opens this turn made of it. */
export function noteReveal(hold: TurnHold, tabId: string, callId?: string): void {
  const index = hold.reveal.indexOf(tabId);
  if (index >= 0) hold.reveal.splice(index, 1);
  hold.reveal.push(tabId);
  if (callId) hold.opens.push({ tab: tabId, call: callId });
}

/** Whether `tab` is drawn and read off screen: a turn holds the panel, or the
 *  tab is verify-only (never shown, so never put on screen). */
export function offscreen(ctx: Pick<VisualizeServiceContext, 'holds'>, sessionId: string, tab: TabState): boolean {
  return tab.verify === true || heldTurn(ctx, sessionId) !== null;
}

/** Longest the turn end waits for the disk checks of `recordGoneOpens`. */
const GONE_CHECK_BUDGET_MS = 1500;

interface GoneCheckOptions {
  /** Test seam: the file system's `stat`. */
  statFile?: (path: string) => Promise<unknown>;
  budgetMs?: number;
}

/** Whether any file a tab shows is gone from disk right now. */
async function targetsGone(tab: TabState, statFile: (path: string) => Promise<unknown>): Promise<boolean> {
  const missing = await Promise.all(
    tab.targets.map((target) =>
      statFile(target.path).then(
        () => false,
        (error: unknown) => isFileMissing(error)
      )
    )
  );
  return missing.some(Boolean);
}

async function recordGoneOpens(
  state: SessionState,
  opens: TurnHold['opens'],
  { statFile = stat, budgetMs = GONE_CHECK_BUDGET_MS }: GoneCheckOptions = {}
): Promise<void> {
  const gone = new Set<string>();
  const checks: Promise<void>[] = [];
  for (const id of new Set(opens.map((open) => open.tab))) {
    const tab = state.tabs.find((candidate) => candidate.id === id);
    if (!tab) gone.add(id);
    else if (tab.url || tab.inline) continue;
    else if (tab.missing) gone.add(id);
    else {
      checks.push(
        targetsGone(tab, statFile).then((missing) => {
          if (missing) gone.add(id);
        })
      );
    }
  }
  if (checks.length) {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    });
    await Promise.race([Promise.all(checks), budget]);
    clearTimeout(timer);
  }
  const records = opens.filter((open) => gone.has(open.tab));
  if (records.length) state.goneOpens = [...(state.goneOpens ?? []), ...records].slice(-MAX_VISUALIZE_GONE_OPENS);
}

/** The tab drawn off screen as one PNG (no panel needed): pages, inline
 *  content, images and PDF / Office files; audio and video cannot be. */
export async function offscreenTabPng(
  ctx: Pick<VisualizeServiceContext, 'deps'>,
  sessionId: string,
  tab: TabState
): Promise<Buffer> {
  if (!ctx.deps.exportBytes) throw new Error('drawing a tab off screen is unavailable here');
  if (displayedPanes(tab).some((pane) => pane.kind === 'audio' || pane.kind === 'video')) {
    throw new Error(
      `tab ${tab.id} shows audio or video, which only the side panel can draw; it opens when this turn ends, capture it then`
    );
  }
  const files = shownLayout(tab, tab.shown?.targets ?? [], tab.targets).map((file) => file.path);
  return ctx.deps.exportBytes(sessionId, view(tab), 'png', 0, files);
}

export function createTurnHolds(
  ctx: Pick<
    VisualizeServiceContext,
    'holds' | 'sessions' | 'publish' | 'reloads' | 'thumbnails' | 'versions' | 'tabs' | 'views'
  > &
    Partial<Pick<VisualizeServiceContext, 'deps'>>
) {
  const { holds } = ctx;
  /** Each session's turn end being applied (the latest, which follows the ones before it). */
  const ends = new Map<string, Promise<void>>();

  /** A turn's own hold, from its first start signal. `before`: the turn whose end is still being applied; the session
   *  keeps showing what it showed until that end is. */
  const start = (sessionId: string, before?: TurnHold): void => {
    const since = Date.now();
    if (before) before.nextSince = since;
    holds.set(sessionId, {
      reveal: [],
      opens: [],
      reloads: new Set(),
      dirty: false,
      flushing: false,
      since,
      shown: before?.shown ?? { ...shownNow(ctx, sessionId), since },
    });
  };

  const flush = async (sessionId: string, hold: TurnHold, end: number): Promise<void> => {
    const { reveal, opens } = hold;
    const turn = { since: hold.since, end };
    const keep = (tab: TabState): void => {
      if (!tab.url && ctx.sessions.get(sessionId)?.tabs.includes(tab)) keepVersionTurn(ctx, sessionId, tab, turn);
    };
    // A failed step still ends the hold with the final publish below (the
    // panel and the turn's cards wait for it); the failure is raised after.
    let failure: unknown = null;
    try {
      // The version each tab the turn opened ends it on is the turn's own: its
      // card reads it from the state, on any device, after any reload. (A tab
      // with a held reload gets it once that reload made its version.)
      for (const id of reveal) {
        const tab = ctx.sessions.get(sessionId)?.tabs.find((candidate) => candidate.id === id);
        if (tab && !hold.reloads.has(tab)) keep(tab);
      }
      // Each publish of these reloads is kept back for the one below.
      for (const tab of hold.reloads) {
        await ctx.reloads.reload(sessionId, tab);
        keep(tab);
      }
      // Then each opened tab's card picture of its final version, so its
      // card appears with it (or with its placeholder once that takes too long).
      const tabs = ctx.sessions.get(sessionId)?.tabs ?? [];
      const opened = reveal.flatMap((id) => tabs.filter((tab) => tab.id === id && !tab.url));
      // A tab the turn only changed (a new kept version) gets its picture too.
      for (const tab of hold.reloads) if (!tab.url && tabs.includes(tab) && !opened.includes(tab)) opened.push(tab);
      await ctx.thumbnails.takeAtTurnEnd(sessionId, opened);
    } catch (error) {
      failure = error;
    } finally {
      // The turn's own end, once, on the final tabs.
      const final = ctx.sessions.get(sessionId);
      if (final) {
        const { statFile, goneCheckBudgetMs } = ctx.deps ?? {};
        await recordGoneOpens(final, opens, { statFile, budgetMs: goneCheckBudgetMs });
      }
      ctx.tabs.closeVerify(sessionId);
      if (holds.get(sessionId) === hold) holds.delete(sessionId);
    }
    const state = ctx.sessions.get(sessionId);
    const shown = state ? reveal.filter((id) => state.tabs.some((tab) => tab.id === id && !tab.url)).at(-1) : undefined;
    const next = holds.get(sessionId);
    // A tab the user selected while this end was applied stays the one shown: the turn's own tab is there beside it,
    // marked, not shown over it.
    const selecting = next ?? hold;
    const picked = state?.tabs.some((tab) => tab.id === selecting.picked && !tab.url && !tab.verify)
      ? selecting.picked
      : undefined;
    selecting.picked = undefined;
    const over = picked !== shown ? picked : undefined;
    if (state && (over ?? shown)) state.active = over ?? shown ?? null;
    if (next) {
      // A turn that started meanwhile: this one's result shows now, at its own end, and is what the session shows
      // until the running turn ends. Nothing of the running turn is in it: what its agent asks for waits for this end
      // (`ended`), and its file changes are only marked.
      const told = Boolean(shown) || hold.dirty || next.dirty;
      next.shown = { ...shownNow(ctx, sessionId), since: hold.nextSince ?? next.since };
      if (told && over) publishShown(ctx.deps, next, sessionId, shown ? { updated: shown } : {});
      else if (told) publishShown(ctx.deps, next, sessionId, shown ? { reveal: true, tab: shown } : {});
    } else if (state && shown) ctx.publish(sessionId, over ? undefined : shown, over ? shown : undefined);
    else if (state && hold.dirty) ctx.publish(sessionId);
    if (failure) throw failure;
  };

  /** The session's turn started (true) or ended; the end applies what the
   *  turn kept back, after the end of the turn before it. Resolves once that is done. */
  const setTurnActive = async (sessionId: string, active: boolean): Promise<void> => {
    const hold = holds.get(sessionId);
    if (active) {
      // A turn's hold is made at its first start signal; later ones of the same turn change nothing.
      if (!hold || hold.flushing) start(sessionId, hold);
      return;
    }
    if (!hold || hold.flushing) return;
    hold.flushing = true;
    hold.picked = undefined;
    const end = Date.now();
    const apply = (): Promise<void> =>
      flush(sessionId, hold, end).catch((error: unknown) => {
        console.warn('visualize turn end failed:', (error as Error).message);
      });
    const before = ends.get(sessionId);
    const ending = before ? before.then(apply) : apply();
    ends.set(sessionId, ending);
    await ending;
    if (ends.get(sessionId) === ending) ends.delete(sessionId);
  };

  return {
    setTurnActive,
    /** The session is deleted: its held turn goes without publishing anything. */
    discard(sessionId: string): void {
      holds.delete(sessionId);
      ends.delete(sessionId);
    },
    /** Resolves once no turn end of the session is being applied. What an agent asks for meanwhile is the next turn's:
     *  it runs after the end, so that end's result holds nothing of it. */
    async ended(sessionId: string): Promise<void> {
      while (ends.has(sessionId)) await ends.get(sessionId);
    },
    /** One row edge of the app feed (`thread/started`, `thread/summary/updated`): the Lead's turn flag as the core changes
     *  it, each turn's end included. The roster republishes at most every 2 s and only a list that changed since, so turns
     *  that follow one another within that never read idle there. */
    observeEdge(thread: { id?: unknown; leadWorking?: unknown }): Promise<void> {
      if (typeof thread?.id !== 'string' || !thread.id) return Promise.resolve();
      return setTurnActive(thread.id, thread.leadWorking === true);
    },
    /** One push of the session roster: a turn runs while the session's `leadWorking` is true
     *  (the roster's `working` also counts the Lead's child agents). */
    observeTurns(sessions: ReadonlyArray<{ id: string; leadWorking?: boolean }>): Promise<void> {
      const present = new Set<string>();
      const changes: Promise<void>[] = [];
      for (const session of sessions) {
        if (!session?.id) continue;
        present.add(session.id);
        changes.push(setTurnActive(session.id, session.leadWorking === true));
      }
      for (const sessionId of [...holds.keys()]) {
        if (!present.has(sessionId)) changes.push(setTurnActive(sessionId, false));
      }
      // A session that left the roster is closed: its verify-only tabs go.
      for (const sessionId of ctx.sessions.keys()) if (!present.has(sessionId)) ctx.tabs.closeVerify(sessionId);
      return Promise.all(changes).then(() => undefined);
    },
  };
}
