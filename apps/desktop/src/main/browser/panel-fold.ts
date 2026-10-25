/**
 * A session whose last page went away (the agent's close_tab, a page closing
 * itself, its window destroyed, reclaim, the user's ×) folds its panel, as the
 * user's × on the last tab does, instead of leaving it on a blank page.
 *
 * The panel keeps reading frames until the hide reaches it, and a read for a
 * session with no page would make one (the blank start page a panel the user
 * opens shows). So from the loss until the shell confirms the panel closed
 * (its last pane stops reading, `panelShown(false)`), or at most
 * PANEL_FOLD_MS, a frame read makes no page: it waits, then takes a page made
 * meanwhile or fails. The person's own intent ends that hold at once: a panel
 * opening (`panelShown(true)`) or an address they navigate to (`user`) gets
 * the blank start page as before. Releasing a session (unload, deletion) and
 * host teardown are not losses: they run `quietly`.
 */
import type { WebContents } from 'electron';
import type { BrowserSessionRegistry } from './session-registry';

/** The longest a fold waits for the shell's confirmation. */
export const PANEL_FOLD_MS = 1_500;

type Hold = { done: Promise<void>; end(): void };

export function createBrowserPanelFold(host: {
  sessions: Pick<BrowserSessionRegistry, 'onLastPageGone' | 'paneGuest'>;
  hide(sessionId: string): void;
  holdMs?: number;
}) {
  const holdMs = host.holdMs ?? PANEL_FOLD_MS;
  const holds = new Map<string, Hold>();
  /** Panes reading each session's pages now, as `${sender}:${pane}`: the
   *  shell (webContents) that reported them and the pane's own id. */
  const shownPanes = new Map<string, Set<string>>();
  const watchedSenders = new WeakSet<object>();
  let quiet = 0;

  host.sessions.onLastPageGone((sessionId) => {
    if (quiet) return;
    holds.get(sessionId)?.end();
    let resolve = () => {};
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    const timer = setTimeout(() => hold.end(), holdMs);
    const hold: Hold = {
      done,
      end: () => {
        clearTimeout(timer);
        if (holds.get(sessionId) === hold) holds.delete(sessionId);
        resolve();
      },
    };
    holds.set(sessionId, hold);
    host.hide(sessionId);
  });

  /** Pane `pane` of shell `sender` started (`true`) or stopped reading the
   *  session's pages. A shell that reloads, crashes or closes reports no
   *  stop, so its panes are dropped then. */
  function panelShown(
    sessionId: string,
    shown: boolean,
    sender: Pick<WebContents, 'id' | 'on'>,
    pane: string
  ): void {
    if (!watchedSenders.has(sender)) {
      watchedSenders.add(sender);
      const id = sender.id;
      const forget = () => forgetSender(id);
      sender.on('did-navigate', forget);
      sender.on('render-process-gone', forget);
      sender.on('destroyed', forget);
    }
    const key = `${sender.id}:${pane}`;
    const panes = shownPanes.get(sessionId) ?? new Set<string>();
    if (shown) panes.add(key);
    else panes.delete(key);
    if (panes.size) shownPanes.set(sessionId, panes);
    else shownPanes.delete(sessionId);
    // Opening is the person asking for the panel; the last pane closing is
    // the fold done. Either way no stale read is left to guard against.
    if (shown || !panes.size) holds.get(sessionId)?.end();
  }

  /** Shell `sender`'s document is gone: none of its panes reads anything. */
  function forgetSender(sender: number): void {
    const prefix = `${sender}:`;
    for (const [sessionId, panes] of shownPanes) {
      for (const key of panes) if (key.startsWith(prefix)) panes.delete(key);
      if (panes.size) continue;
      shownPanes.delete(sessionId);
      holds.get(sessionId)?.end();
    }
  }

  /** Removals that are no loss of the session's last page. */
  function quietly<T>(work: () => T): T {
    quiet += 1;
    try {
      return work();
    } finally {
      quiet -= 1;
    }
  }

  /** The page a panel shows: the session's own, else (`create`) the blank
   *  start page — never one a frame read makes while the panel folds for a
   *  lost page. `user`: the person asked for it (an address they entered). */
  async function panePage(
    sessionId: string,
    create: () => Promise<WebContents>,
    options: { user?: boolean } = {}
  ): Promise<WebContents> {
    const existing = host.sessions.paneGuest(sessionId);
    if (existing) return existing;
    const hold = holds.get(sessionId);
    if (!hold) return create();
    if (options.user) {
      hold.end();
      return create();
    }
    await hold.done;
    const made = host.sessions.paneGuest(sessionId);
    if (made) return made;
    throw new Error('The browser page closed; its panel is closing.');
  }

  return { quietly, panePage, panelShown };
}
