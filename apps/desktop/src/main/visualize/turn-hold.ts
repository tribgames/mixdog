/**
 * Visualize during an agent turn: the panel is left alone while the turn
 * runs. Opens still update the tab state (so check, inspect and capture find
 * their tabs and read them off screen) but activate and reveal nothing; a file
 * change of an open tab only marks it; every publish goes out `held` (chat
 * cards and marks read it, the panel does not). When the turn ends (done,
 * stopped, failed or cancelled alike, so partial work is still shown) the
 * marked tabs reload once, each tab the turn opened gets its chat card's
 * picture of its final version, and one ordinary publish brings the panel up
 * on the last tab the turn opened.
 */
import type { VisualizeServiceContext } from './context';
import { displayedPanes, shownLayout, type TabState, view } from './tab-state';
import { keepVersionTurn } from './version-thumbnails';

export interface TurnHold {
  /** Tabs the turn opened or showed, each once, the latest last. */
  reveal: string[];
  /** Open tabs whose files changed during the turn: reloaded once at its end. */
  reloads: Set<TabState>;
  /** A publish was kept back. */
  dirty: boolean;
  /** The turn ended; its held reloads are running. */
  flushing: boolean;
  /** Another turn started while this one was flushing. */
  again: boolean;
  /** The user's panel commands in progress: they apply at once. */
  bypass: number;
  /** When the turn started (ms): its opens get their chat cards at its end.
   *  A hold carried over another turn keeps the first turn's start. */
  since: number;
  /** When this hold's own turn started (ms): the span recorded with the
   *  versions it ends on, never merged with a turn carried into it. */
  spanSince: number;
  /** When the turn that interrupted this one's flush started (ms). */
  nextSince?: number;
}

/** The session's turn hold when agent actions are held right now. */
export function heldTurn(ctx: Pick<VisualizeServiceContext, 'holds'>, sessionId: string): TurnHold | null {
  const hold = ctx.holds.get(sessionId);
  return hold && !hold.flushing && hold.bypass === 0 ? hold : null;
}

/** A tab the turn opened (or a publish asked to reveal): kept once, latest last. */
export function noteReveal(hold: TurnHold, tabId: string): void {
  const index = hold.reveal.indexOf(tabId);
  if (index >= 0) hold.reveal.splice(index, 1);
  hold.reveal.push(tabId);
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
  ctx: Pick<VisualizeServiceContext, 'holds' | 'sessions' | 'publish' | 'reloads' | 'thumbnails' | 'versions'>
) {
  const { holds } = ctx;
  const start = (sessionId: string, carried?: TurnHold): void => {
    holds.set(sessionId, {
      reveal: carried?.reveal ?? [],
      reloads: new Set(),
      dirty: carried?.dirty ?? false,
      flushing: false,
      again: false,
      bypass: 0,
      since: carried?.since ?? Date.now(),
      spanSince: carried?.nextSince ?? Date.now(),
    });
  };

  const flush = async (sessionId: string, hold: TurnHold): Promise<void> => {
    hold.flushing = true;
    // This turn's own span, fixed now: a turn starting while the flush runs
    // is another turn, and its versions get its own span.
    const turn = { since: hold.spanSince, end: Date.now() };
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
      for (const id of hold.reveal) {
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
      if (!hold.again) {
        const tabs = ctx.sessions.get(sessionId)?.tabs ?? [];
        const opened = hold.reveal.flatMap((id) => tabs.filter((tab) => tab.id === id && !tab.url));
        // A tab the turn only changed (a new kept version) gets its picture too.
        for (const tab of hold.reloads) if (!tab.url && tabs.includes(tab) && !opened.includes(tab)) opened.push(tab);
        await ctx.thumbnails.takeAtTurnEnd(sessionId, opened);
      }
    } catch (error) {
      failure = error;
    } finally {
      if (holds.get(sessionId) === hold) holds.delete(sessionId);
    }
    // A turn that started meanwhile holds this one's result until it ends too.
    if (hold.again) start(sessionId, hold);
    else {
      const state = ctx.sessions.get(sessionId);
      const shown = state
        ? hold.reveal.filter((id) => state.tabs.some((tab) => tab.id === id && !tab.url)).at(-1)
        : undefined;
      if (state && shown) {
        state.active = shown;
        ctx.publish(sessionId, shown);
      } else if (state && hold.dirty) ctx.publish(sessionId);
    }
    if (failure) throw failure;
  };

  /** The session's turn started (true) or ended; the end applies what the
   *  turn kept back. Resolves once that is done. */
  const setTurnActive = async (sessionId: string, active: boolean): Promise<void> => {
    const hold = holds.get(sessionId);
    if (active) {
      if (!hold) start(sessionId);
      else if (hold.flushing) {
        hold.again = true;
        hold.nextSince = Date.now();
      }
      return;
    }
    if (!hold) return;
    if (hold.flushing) {
      hold.again = false;
      return;
    }
    await flush(sessionId, hold).catch((error: unknown) => {
      console.warn('visualize turn end failed:', (error as Error).message);
    });
  };

  return {
    setTurnActive,
    /** One push of the session roster: a session's turn runs while its Lead
     *  works; a session that left the roster has no turn. The roster omits
     *  `leadWorking` while the Lead is idle, and its `working` also counts the
     *  Lead's child agents: reading `working` held the turn (and every chat
     *  card of it) for as long as a background agent ran. */
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
      return Promise.all(changes).then(() => undefined);
    },
  };
}

export type TurnHolds = ReturnType<typeof createTurnHolds>;
