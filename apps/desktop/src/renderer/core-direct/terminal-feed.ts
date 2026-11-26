import { routeDesktopOperation } from '../../shared/core-lanes/desktop-operation-route';
import { attachNeedsRedraw, TerminalFeedPositions, type TerminalFeedPosition } from '../../shared/terminal-feed-reader';
import {
  compareTerminals,
  createTerminalOutputDecoder,
  terminalOf,
  terminalReply,
  type TerminalId,
} from '../../shared/terminal-protocol';
import { TerminalDataBufferer, type TerminalDataEvent } from './terminal-data-buffer';
import type { DirectContext } from './context';

/** What the pane gets of a tab: its id, the screen up to the feed's position and who owns the size (never this window), and which
 *  terminal of the id that is (none from a core that predates terminal names). */
export type TerminalSession = {
  id: string;
  replay: string;
  sizeOwner?: { cols: number; rows: number; own: boolean };
  terminal?: TerminalId;
};

/** `a` is a later terminal of the id than `b`, or another run's: what `b` was attached for does not show it. */
const replaces = (a: TerminalId, b: TerminalId): boolean => (compareTerminals(a, b) ?? 1) > 0;

/** The output of a tab is coalesced for this long before it reaches the page. */
const OUTPUT_COALESCE_MS = 5;
/** The output the page holds unacknowledged before the core's pty is paused, and the level it resumes at. */
const HIGH_WATERMARK_CHARS = 256 * 1024;
const LOW_WATERMARK_CHARS = 32 * 1024;

export function sessionOf(value: object): TerminalSession {
  const result = value as Record<string, unknown>;
  // The window is never a size owner: a phone's grid is followed, not claimed.
  const owner = result.sizeOwner as { cols?: unknown; rows?: unknown } | undefined;
  const terminal = terminalOf(result.terminal);
  return {
    id: String(result.id || ''),
    replay: String(result.replay || ''),
    ...(owner ? { sizeOwner: { cols: Number(owner.cols) || 0, rows: Number(owner.rows) || 0, own: false } } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

/** Raised when an in-flight attach is invalidated by a detach or dispose before it settles. */
export class TerminalAttachCancelledError extends Error {
  constructor(id: string) {
    super(`Terminal feed attach for ${id} was cancelled.`);
    this.name = 'TerminalAttachCancelledError';
  }
}

export const isTerminalAttachCancelled = (error: unknown): boolean => error instanceof TerminalAttachCancelledError;

/** The terminal tabs whose output feed this connection reads (`process:<id>`): attaching and re-attaching them, the feed
 *  positions they resume from, and the flow control that holds the core's pty back while the page's buffer is full. */
export function createTerminalFeed(
  ctx: DirectContext,
  onData: (event: TerminalDataEvent, gen: number) => void,
  hasConsumer?: (id: string) => boolean
) {
  const { connection } = ctx;
  const output = createTerminalOutputDecoder();
  // Where each tab's feed was read to: a new link's attach resumes from there.
  const positions = new TerminalFeedPositions();
  // The tabs whose output the core holds back because the page's buffer is full: the pause belongs to this connection, so a new
  // link asks for it again.
  const paused = new Set<string>();
  const sendPause = (method: 'termPause' | 'termResume', id: string): void => {
    const { method: name, params } = routeDesktopOperation(method, [id]);
    void ctx.call(name, params).catch(() => {});
  };
  const buffer = new TerminalDataBufferer(
    onData,
    OUTPUT_COALESCE_MS,
    HIGH_WATERMARK_CHARS,
    {
      pause: (id) => {
        paused.add(id);
        sendPause('termPause', id);
      },
      resume: (id) => {
        paused.delete(id);
        sendPause('termResume', id);
      },
    },
    LOW_WATERMARK_CHARS,
    hasConsumer
  );
  // Tabs confirmed attached on the CURRENT connection link (never populated optimistically before the RPC succeeds, and cleared
  // on link loss or replacement to a different client so a failed relink can never masquerade as a live attachment).
  type AttachedFeed = {
    terminal: TerminalId | undefined;
    client: unknown;
    linkGen: number;
  };
  const attached = new Map<string, AttachedFeed>();
  // Tabs with an active consumer that should be recovered via `reattach()` after a link drop/replacement (including a tab whose
  // `termEnsure` succeeded while its first `terminal/attach` hit a link drop), cleared on exit, null attach, detach, or dispose.
  const wanted = new Map<string, TerminalId | undefined>();
  // Monotonic per-tab counter incremented whenever `wanted` advances to a new defined incarnation, so an older in-flight
  // warm-up attach settling late cannot overwrite or retire a newer replacement incarnation requested concurrently.
  let nextWantedSeq = 0;
  const wantedSeq = new Map<string, number>();
  // Shell incarnations already superseded by a newer incarnation for a tab (same-core or cross-core), cleared with `wanted`
  // on detach, dispose, null attach, or current-shell exit so late ensures for an old shell can never downgrade `wanted`.
  const retiredTerminals = new Map<string, Set<string>>();
  // Active server-side `process:<tab>` subscriptions on the current connection (mapped to their owning client), tracked
  // independently of whether the shell is still running so exit + detach and direct dispose always send `feed/unsubscribe`.
  const serverSubscribed = new Map<string, unknown>();
  // The attach in flight per tab, which a second caller joins (a dock hover's warm-up, then the pane's ensure): the core keeps one
  // subscription per feed and connection, and a second attach would replace the first and drop what was still queued on it.
  const attaching = new Map<string, Promise<TerminalSession | null>>();
  // Latest confirmed screen baseline session per tab (updated on fresh attach or snapshot redraw, preserved across
  // seamless replay-mode relinks so it stays aligned with undelivered pre-subscribe output in `buffer`, cleared on teardown).
  const latestSession = new Map<string, TerminalSession>();
  // Monotonic stream snapshot generation per tab: incremented whenever a fresh attach or snapshot redraw establishes
  // a new screen baseline, and preserved across seamless replay-mode relinks so consumers never duplicate replay output.
  let nextFeedGen = 0;
  const feedGen = new Map<string, number>();
  const sessionGenerations = new WeakMap<TerminalSession, number>();
  // Per-tab ref-counted cancellation tokens for active in-flight attaches / joinOrAttach waiters;
  // deleted immediately on detach/dispose or once all in-flight operations settle so closed tab IDs never accumulate.
  type CancelToken = { cancelled: boolean; refs: number };
  const cancelTokens = new Map<string, CancelToken>();
  const acquireCancelToken = (tab: string): CancelToken => {
    let token = cancelTokens.get(tab);
    if (!token) {
      token = { cancelled: false, refs: 0 };
      cancelTokens.set(tab, token);
    }
    token.refs += 1;
    return token;
  };
  const releaseCancelToken = (tab: string, token: CancelToken): void => {
    token.refs -= 1;
    if (token.refs <= 0 && cancelTokens.get(tab) === token) {
      cancelTokens.delete(tab);
    }
  };
  const cancelInflight = (tab: string): void => {
    const token = cancelTokens.get(tab);
    if (!token) return;
    token.cancelled = true;
    cancelTokens.delete(tab);
  };
  // Incremented on link loss/replacement so same-link refresh rejection can tell whether the prior subscription is still live
  // and `onReplaced` never clears held frames belonging to an attach already running on the current link.
  let linkGen = 0;
  let ready = false;
  let unreplacedReady = false;
  const currentClient = (): unknown =>
    typeof connection.client === 'function' ? (connection.client() ?? null) : undefined;
  let activeLinkClient: unknown = currentClient();
  // In-flight `feed/unsubscribe` calls from hiding a terminal pane: a subsequent attach waits for detach to settle before
  // re-subscribing so old frames cannot race into the new atomic replay cut.
  const detaching = new Map<string, Promise<void>>();
  // Raw wire frames arriving during an attach are buffered undecoded (regardless of incarnation) until the attach settles:
  // filtered to the resolved terminal incarnation and decoded only on commit so decoder state and feed positions stay in lockstep.
  type HeldEvent =
    | { kind: 'output'; params: unknown; feed: unknown; terminal?: TerminalId }
    | { kind: 'exited'; feed: unknown; terminal?: TerminalId };
  type HeldAttach = {
    request: Promise<TerminalSession | null>;
    events: HeldEvent[];
    linkGen: number;
    client: unknown;
  };
  const holding = new Map<string, HeldAttach>();
  const clearHolding = (tab: string): void => {
    const entry = holding.get(tab);
    if (!entry) return;
    entry.events.length = 0;
    holding.delete(tab);
  };
  const unsubscribeFeed = (feedId: string): Promise<unknown> => {
    if (typeof connection.client === 'function') {
      const raw = connection.client();
      return raw ? raw.call('feed/unsubscribe', { feedId }) : Promise.resolve();
    }
    return ctx.call('feed/unsubscribe', { feedId });
  };
  const enqueueUnsubscribe = (tab: string): void => {
    const previous = detaching.get(tab);
    const run = () =>
      unsubscribeFeed(`process:${tab}`).then(
        () => undefined,
        () => undefined
      );
    const pending = previous ? previous.then(run) : run();
    detaching.set(tab, pending);
    void pending.finally(() => {
      if (detaching.get(tab) === pending) detaching.delete(tab);
    });
  };
  const terminalKey = (terminal: TerminalId): string => `${terminal.core}\0${terminal.incarnation}`;
  const isRetiredTerminal = (tab: string, terminal: TerminalId | undefined): boolean =>
    terminal !== undefined && (retiredTerminals.get(tab)?.has(terminalKey(terminal)) ?? false);
  const isEarlierTerminal = (candidate: TerminalId | undefined, reference: TerminalId | undefined): boolean => {
    if (!candidate || !reference) return false;
    const cmp = compareTerminals(candidate, reference);
    return cmp !== undefined && cmp < 0;
  };
  const retireTerminal = (tab: string, terminal: TerminalId | undefined): void => {
    if (!terminal) return;
    let retired = retiredTerminals.get(tab);
    if (!retired) {
      retired = new Set();
      retiredTerminals.set(tab, retired);
    }
    retired.add(terminalKey(terminal));
  };
  const isStaleTerminal = (tab: string, terminal: TerminalId | undefined): boolean =>
    terminal !== undefined &&
    (isRetiredTerminal(tab, terminal) ||
      isEarlierTerminal(terminal, wanted.get(tab)) ||
      isEarlierTerminal(terminal, attached.get(tab)?.terminal));
  const advanceWanted = (tab: string, terminal: TerminalId | undefined): TerminalId | undefined => {
    const previous = wanted.get(tab);
    if (!terminal) {
      if (!wanted.has(tab)) wanted.set(tab, undefined);
      return previous;
    }
    if (isStaleTerminal(tab, terminal)) {
      retireTerminal(tab, terminal);
      return previous;
    }
    if (previous && compareTerminals(terminal, previous) === 0) {
      return previous;
    }
    if (previous) {
      retireTerminal(tab, previous);
    }
    wanted.set(tab, terminal);
    wantedSeq.set(tab, ++nextWantedSeq);
    return terminal;
  };
  const clearTerminalState = (tab: string, clearWanted = true): void => {
    attached.delete(tab);
    latestSession.delete(tab);
    if (clearWanted) {
      wanted.delete(tab);
      wantedSeq.delete(tab);
      retiredTerminals.delete(tab);
    }
    feedGen.delete(tab);
    paused.delete(tab);
    positions.forget(tab);
    output.end(tab);
  };
  const handleTerminalExit = (tab: string, exitedTerminal?: TerminalId): void => {
    const wantedTerminal = wanted.get(tab);
    // An older shell's exit must not cancel reconnect recovery for a newer replacement incarnation.
    const keepWanted = Boolean(
      wantedTerminal && exitedTerminal && compareTerminals(exitedTerminal, wantedTerminal) !== 0
    );
    if (keepWanted) retireTerminal(tab, exitedTerminal);
    clearTerminalState(tab, !keepWanted);
  };
  const matchesTerminal = (frameTerminal: TerminalId | undefined, target: TerminalId | undefined): boolean =>
    !(target && frameTerminal && compareTerminals(frameTerminal, target) !== 0);
  const isSupersededByAttach = (feed: unknown, value: unknown): boolean => {
    const sub = (value as { subscription?: { epoch?: unknown; startSeq?: unknown } }).subscription;
    if (typeof sub?.epoch !== 'string' || typeof sub?.startSeq !== 'number') return false;
    const stamp = feed as { epoch?: unknown; seq?: unknown } | undefined;
    if (!stamp || typeof stamp.epoch !== 'string') return false;
    if (stamp.epoch !== sub.epoch) return true;
    return typeof stamp.seq === 'number' && stamp.seq < sub.startSeq;
  };
  const applyHeldEvents = (
    id: string,
    events: HeldEvent[],
    targetTerminal: TerminalId | undefined,
    replyValue?: unknown
  ): void => {
    for (const ev of events) {
      if (!matchesTerminal(ev.terminal, targetTerminal)) continue;
      if (replyValue !== undefined && isSupersededByAttach(ev.feed, replyValue)) continue;
      if (ev.kind === 'output') {
        const { id: outId, data } = output.text(ev.params);
        positions.note(id, ev.feed);
        if (data) buffer.push({ id: outId, data });
      } else {
        handleTerminalExit(id, ev.terminal ?? targetTerminal);
        return;
      }
    }
  };
  // The feed's position an attach answered (frames follow from `startSeq`), unless frames read since are already past it. Noted on
  // every attach, so a tab that printed nothing on a link still resumes on the next one.
  const noteAttached = (id: string, value: unknown): boolean => {
    const subscription = (value as { subscription?: { epoch?: unknown; startSeq?: unknown } }).subscription;
    if (typeof subscription?.startSeq !== 'number') return false;
    const read = positions.resumeFrom(id);
    if (!read || read.epoch !== subscription.epoch || read.seq < subscription.startSeq - 1) {
      positions.note(id, { epoch: subscription.epoch, seq: subscription.startSeq - 1 });
    }
    return true;
  };
  const resolveSuperseded = (
    id: string,
    request: Promise<TerminalSession | null>
  ): Promise<TerminalSession | null> | TerminalSession | undefined => {
    const active = attaching.get(id);
    if (active && active !== request) return active;
    if (attached.has(id)) {
      const latest = latestSession.get(id);
      if (latest) return latest;
    }
    return undefined;
  };
  // `relink`: a new link attaches the tab again from the position its feed was read to; the reply says whether the missed output
  // follows as frames (replay) or the screen is given as it is (snapshot, a new epoch, nothing to resume from), which the page
  // draws anew.
  // `expected`: the terminal an ensure answered, whose attach this is; what an earlier terminal of the id still sends is not its.
  const subscribeFeed = (id: string, relink = false, expected?: TerminalId): Promise<TerminalSession | null> => {
    const token = acquireCancelToken(id);
    const startWantedSeq = wantedSeq.get(id) ?? 0;
    const pendingDetach = detaching.get(id);
    let request!: Promise<TerminalSession | null>;
    const sendAttach = (): Promise<TerminalSession | null> => {
      if (token.cancelled) {
        return Promise.reject(new TerminalAttachCancelledError(id));
      }
      if (attaching.get(id) !== request) {
        const resolved = resolveSuperseded(id, request);
        return resolved !== undefined
          ? Promise.resolve(resolved)
          : Promise.reject(new TerminalAttachCancelledError(id));
      }
      const startLinkGen = linkGen;
      const startAttached = attached.get(id);
      const hadServerSub = serverSubscribed.has(id);
      const resumed: TerminalFeedPosition | undefined = relink ? positions.resumeFrom(id) : undefined;
      const { method, params } = routeDesktopOperation('termAttach', resumed ? [id, resumed] : [id]);
      const heldClient = currentClient();
      serverSubscribed.set(id, heldClient);
      clearHolding(id);
      const heldEntry: HeldAttach = { request, events: [], linkGen: startLinkGen, client: heldClient };
      holding.set(id, heldEntry);
      return ctx.call(method, params).then(
        (reply) => {
          const events = heldEntry.events.splice(0);
          if (holding.get(id) === heldEntry) holding.delete(id);
          const value = reply == null ? null : terminalReply(reply);
          if (token.cancelled) {
            // Detached/cancelled while in flight (e.g. detached while disconnected, then a queued attach reached the server after
            // reconnect): unsubscribe on the server so no orphaned feed subscription stays alive.
            if (value && !attached.has(id) && !attaching.has(id) && !wanted.has(id)) {
              serverSubscribed.delete(id);
              enqueueUnsubscribe(id);
            }
            throw new TerminalAttachCancelledError(id);
          }
          const session = value ? sessionOf(value) : null;
          // A newer attach has the say over the tab: a new link's relink.
          if (attaching.get(id) !== request) {
            const resolved = resolveSuperseded(id, request);
            if (resolved !== undefined) return resolved;
            throw new TerminalAttachCancelledError(id);
          }
          attaching.delete(id);
          if (!value) {
            if (!hadServerSub) serverSubscribed.delete(id);
            const wantedAdvanced = (wantedSeq.get(id) ?? 0) !== startWantedSeq;
            clearTerminalState(id, !wantedAdvanced);
          } else {
            const resolvedTerminal = session?.terminal ?? expected ?? wanted.get(id);
            const wantedAdvanced = (wantedSeq.get(id) ?? 0) !== startWantedSeq;
            const currentWanted = wanted.get(id);
            const prevAttached = attached.get(id)?.terminal;
            if (
              prevAttached &&
              resolvedTerminal &&
              compareTerminals(resolvedTerminal, prevAttached) !== 0 &&
              !(wantedAdvanced && currentWanted && compareTerminals(prevAttached, currentWanted) === 0)
            ) {
              retireTerminal(id, prevAttached);
            }
            attached.set(id, {
              terminal: resolvedTerminal,
              client: heldEntry.client,
              linkGen: heldEntry.linkGen,
            });
            serverSubscribed.set(id, heldEntry.client);
            if (wantedAdvanced && currentWanted) {
              // Another caller (e.g. an explicit ensure for a replacement shell) advanced `wanted` while this attach was in flight:
              // only advance further if this reply is strictly later on the same core; never retire or overwrite the newer `wanted`.
              const cmp = resolvedTerminal ? compareTerminals(resolvedTerminal, currentWanted) : undefined;
              if (cmp !== undefined && cmp > 0) {
                advanceWanted(id, resolvedTerminal);
              } else if (resolvedTerminal && cmp !== 0) {
                retireTerminal(id, resolvedTerminal);
              }
            } else {
              advanceWanted(id, resolvedTerminal);
            }
            if (relink && attachNeedsRedraw(value, resumed)) {
              const gen = ++nextFeedGen;
              feedGen.set(id, gen);
              sessionGenerations.set(session!, gen);
              latestSession.set(id, session!);
              // What the page shows is not this screen's past: a half character left from the old link is dropped, the feed's
              // position is the snapshot's (frames follow from startSeq), and the page draws the screen anew.
              output.end(id);
              positions.forget(id);
              noteAttached(id, value);
              buffer.reset(id, session!.replay);
              if (events.length) applyHeldEvents(id, events, resolvedTerminal, value);
            } else if (!relink) {
              const gen = ++nextFeedGen;
              feedGen.set(id, gen);
              sessionGenerations.set(session!, gen);
              latestSession.set(id, session!);
              // Drop any unflushed coalesced deltas from a previous shell/snapshot before delivering post-cut deltas.
              buffer.release(id);
              output.end(id);
              positions.forget(id);
              noteAttached(id, value);
              if (events.length) applyHeldEvents(id, events, resolvedTerminal, value);
            } else {
              const gen = feedGen.get(id) ?? ++nextFeedGen;
              feedGen.set(id, gen);
              sessionGenerations.set(session!, gen);
              const baseline = latestSession.get(id);
              if (!baseline) latestSession.set(id, session!);
              noteAttached(id, value);
              if (events.length) applyHeldEvents(id, events, resolvedTerminal, value);
              if (baseline && hasConsumer && !hasConsumer(id)) return baseline;
            }
          }
          return session;
        },
        (error: unknown) => {
          const events = heldEntry.events.splice(0);
          if (holding.get(id) === heldEntry) holding.delete(id);
          const currentAttaching = attaching.get(id);
          if (currentAttaching === request) attaching.delete(id);
          if (token.cancelled) {
            throw new TerminalAttachCancelledError(id);
          }
          if (currentAttaching && currentAttaching !== request) {
            return currentAttaching;
          }
          const live = attached.get(id);
          if (live !== undefined && live !== startAttached) {
            const latest = latestSession.get(id);
            if (latest) return latest;
          }
          const stillSameSubscription =
            live !== undefined && (startAttached !== undefined ? live === startAttached : linkGen === startLinkGen);
          if (stillSameSubscription && events.length) {
            applyHeldEvents(id, events, live.terminal);
          }
          throw error;
        }
      );
    };
    const settle = (promise: Promise<TerminalSession | null>): Promise<TerminalSession | null> =>
      promise.finally(() => releaseCancelToken(id, token));
    if (pendingDetach) {
      request = settle(pendingDetach.then(sendAttach));
      attaching.set(id, request);
    } else {
      let run!: () => void;
      request = settle(
        new Promise<TerminalSession | null>((resolve, reject) => {
          run = () => {
            void sendAttach().then(resolve, reject);
          };
        })
      );
      attaching.set(id, request);
      run();
    }
    return request;
  };

  const invalidateCurrentLink = (fromReplaced = false, preserveCurrentHolding = false): Set<string> => {
    const previousLinkGen = linkGen;
    const liveClient = currentClient();
    const sameReadyClient =
      fromReplaced && liveClient !== undefined && liveClient !== null && liveClient === activeLinkClient;
    if (!sameReadyClient) {
      linkGen += 1;
      activeLinkClient = liveClient;
    }
    const preserved = new Set<string>();
    for (const [id, current] of [...attached.entries()]) {
      const keepAttached =
        fromReplaced && liveClient !== undefined && liveClient !== null && current.client === liveClient;
      if (keepAttached) {
        preserved.add(id);
      } else {
        attached.delete(id);
      }
    }
    for (const [id, client] of [...serverSubscribed.entries()]) {
      const keepSub = fromReplaced && liveClient !== undefined && liveClient !== null && client === liveClient;
      if (!keepSub) serverSubscribed.delete(id);
    }
    for (const [id, entry] of [...holding.entries()]) {
      if (attaching.get(id) === entry.request) {
        const isCurrentLink =
          fromReplaced &&
          (liveClient !== undefined
            ? entry.client !== undefined && entry.client !== null && entry.client === liveClient
            : preserveCurrentHolding && entry.linkGen === previousLinkGen);
        if (isCurrentLink) {
          preserved.add(id);
          serverSubscribed.set(id, entry.client);
        } else {
          entry.events.length = 0;
          entry.linkGen = linkGen;
          entry.client = liveClient;
        }
      } else {
        entry.events.length = 0;
        holding.delete(id);
      }
    }
    return preserved;
  };

  // A new link holds none of the old one's feeds: each wanted tab is attached again, and an attach still in flight was the old link's.
  const reattach = (fromReplaced = false, preserveCurrentLink = false): void => {
    const preserved = invalidateCurrentLink(fromReplaced, preserveCurrentLink);
    for (const [id, terminal] of [...wanted.entries()]) {
      if (preserved.has(id)) continue;
      void subscribeFeed(id, true, terminal).catch(() => undefined);
      if (paused.has(id)) sendPause('termPause', id);
    }
  };
  connection.onEvent((event) => {
    if (event.type === 'status') {
      const next = (event as { status: { state: string } }).status.state === 'ready';
      if (next && !ready) {
        unreplacedReady = true;
        reattach();
      } else if (!next) {
        unreplacedReady = false;
        invalidateCurrentLink();
      }
      ready = next;
      return;
    }
    if (event.type !== 'notification') return;
    const { method, params, feed } = (
      event as { notification: { method: string; params?: unknown; feed?: { id: string } } }
    ).notification;
    const tab = String((params as { processHandle?: unknown } | undefined)?.processHandle ?? '');
    const heldAttach = holding.get(tab);
    // A tab's own feed only: the phones' terminal lane (`process:relay`), should this connection read it, repeats every tab's output.
    if (feed?.id !== `process:${tab}` || (!attached.has(tab) && !heldAttach)) return;
    const named = terminalOf((params as { terminal?: unknown } | undefined)?.terminal);
    if (heldAttach) {
      if (method === 'process/outputDelta') {
        heldAttach.events.push({ kind: 'output', params, feed, terminal: named });
      } else if (method === 'process/exited') {
        heldAttach.events.push({ kind: 'exited', feed, terminal: named });
      }
      return;
    }
    // An earlier terminal of the id (its output and exit as it was replaced, before this connection's subscription moved on) is not the
    // one the pane shows.
    const held = attached.get(tab)?.terminal;
    if (held && named && compareTerminals(named, held) !== 0) return;
    if (method === 'process/outputDelta') {
      const { id, data } = output.text(params);
      positions.note(tab, feed);
      if (data) buffer.push({ id, data });
    } else if (method === 'process/exited') {
      handleTerminalExit(tab, named ?? held);
    }
  });
  connection.onReplaced(() => {
    const preserveCurrentLink = unreplacedReady;
    unreplacedReady = false;
    reattach(true, preserveCurrentLink);
  });

  const teardownFeed = (tab: string): void => {
    const shouldUnsubscribe = serverSubscribed.has(tab) || attached.has(tab) || attaching.has(tab);
    serverSubscribed.delete(tab);
    cancelInflight(tab);
    clearHolding(tab);
    buffer.release(tab);
    clearTerminalState(tab);
    attaching.delete(tab);
    if (!shouldUnsubscribe) return;
    enqueueUnsubscribe(tab);
  };

  return {
    isAttached: (id: string): boolean => attached.has(id),
    generation: (id: string): number | null => (attached.has(id) ? (feedGen.get(id) ?? null) : null),
    sessionGeneration: (session: TerminalSession): number | null => sessionGenerations.get(session) ?? null,
    tagSession: (session: TerminalSession, gen: number): void => {
      sessionGenerations.set(session, gen);
    },
    activeCancelTokenCount: (): number => cancelTokens.size,
    flushPending: (id?: string): void => {
      if (id) buffer.flush(id);
      else buffer.flushAll();
    },
    attach: (id: string): Promise<TerminalSession | null> => attaching.get(id) ?? subscribeFeed(id),
    /** The attach that answers for a tab not yet read, or the one in flight; null for a tab already read for `terminal` (or for a later
     *  one of the id), which streams as it is. A tab read for an earlier terminal of the id, or for one no answer named, is attached
     *  again for this one. */
    joinOrAttach: (id: string, terminal?: TerminalId): Promise<TerminalSession | null> | null => {
      const stale = isStaleTerminal(id, terminal);
      const targetTerminal = advanceWanted(id, terminal);
      const pending = attaching.get(id);
      // An attach in flight from before the ensure answers for the tab as it was then: an earlier terminal of the id, a shell already
      // gone, or nothing when it failed. The ensured tab is then attached after it unless a detach/dispose cancelled it.
      if (pending) {
        const token = acquireCancelToken(id);
        const after = (session: TerminalSession | null) => {
          if (token.cancelled) throw new TerminalAttachCancelledError(id);
          if (stale) return session;
          const desired = advanceWanted(id, terminal);
          if (session && !(desired && session.terminal && replaces(desired, session.terminal))) {
            return session;
          }
          return attaching.get(id) ?? subscribeFeed(id, false, desired);
        };
        return pending
          .then(after, (error: unknown) => {
            if (isTerminalAttachCancelled(error) || token.cancelled) {
              throw isTerminalAttachCancelled(error) ? error : new TerminalAttachCancelledError(id);
            }
            return after(null);
          })
          .finally(() => releaseCancelToken(id, token));
      }
      const heldEntry = attached.get(id);
      const held = heldEntry?.terminal;
      if (stale) {
        return heldEntry ? null : subscribeFeed(id, false, targetTerminal);
      }
      const current = heldEntry !== undefined && !(terminal && (!held || replaces(terminal, held)));
      return current ? null : subscribeFeed(id, false, terminal);
    },
    acknowledge: (id: string, charCount: number, gen?: number): void => buffer.acknowledge(id, charCount, gen),
    detach: teardownFeed,
    dispose: teardownFeed,
  };
}
