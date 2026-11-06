/**
 * What a takeover does to the window process, whichever feed reports it (the core's server requests, takeover-feed.ts;
 * the Node-era session snapshots): the gate holds the session's Browser Use (and the screen for a screen takeover), a
 * login takeover opens its sign-in window, a browser takeover opens the handed-over page once human control is ready,
 * and a settled, expired or replaced takeover forgets the page it handed over.
 */
export interface TakeoverStateUpdate {
  sessionId?: unknown;
  snapshot?: unknown;
}

export interface TakeoverStateDeps {
  gate: {
    onSessionState(update: TakeoverStateUpdate): string;
    ready(sessionId: string, id: string): Promise<boolean>;
  };
  login: { sync(sessionId: string, login: unknown): void };
  loginOf(snapshot: unknown): unknown;
  /** The in-app browser host, once it exists. */
  browser(): { endTakeoverPage(sessionId: string, current: string): void; openForTakeover(sessionId: string, id: string): void } | null | undefined;
  /** Fixes the handed-over page as the takeover starts; false when the tab cannot be handed over (the takeover is declined). */
  capture(sessionId: string, id: string, tab: string): boolean;
}

export function createTakeoverStateHandler(deps: TakeoverStateDeps): (update: TakeoverStateUpdate) => void {
  return (update) => {
    const surface = deps.gate.onSessionState(update);
    const login = update?.snapshot ? deps.loginOf(update.snapshot) : null;
    const approval = (
      update?.snapshot as
        | { toolApproval?: { id?: unknown; kind?: unknown; takeover?: { tab?: unknown } | null } | null }
        | undefined
    )?.toolApproval;
    const id = String(approval?.id ?? 'takeover');
    if (update?.sessionId && update.snapshot) {
      deps.login.sync(String(update.sessionId), login);
      // A settled (or replaced) takeover forgets the page it handed over.
      deps.browser()?.endTakeoverPage(String(update.sessionId), approval?.kind === 'takeover' ? id : '');
    }
    if (surface !== 'browser') return;
    const sessionId = String(update.sessionId);
    // The handed-over page is fixed as the takeover starts (login or not), so
    // later tab moves never retarget the handoff or the post-login reload.
    // A tab that cannot be handed over declines the takeover with the reason.
    const tab = typeof approval?.takeover?.tab === 'string' ? approval.takeover.tab : '';
    if (!deps.capture(sessionId, id, tab)) return;
    if (login) return;
    void deps.gate.ready(sessionId, id).then((ready) => {
      if (ready) deps.browser()?.openForTakeover(sessionId, id);
    });
  };
}