// The pane shows the page the agent works in. The host reports that page, the
// turn that drove it and whether the user paused following (`agentPage`); the
// pause lives in the host so every window showing the session obeys one pick.
// The pane selects the agent's page while it is not paused. "보기" (`resume`)
// lifts the pause and shows the agent's page at once.
import type { DesktopBrowserTab } from '../shared/contract';

type AgentPage = { tabId: string; turn: number; paused: boolean };

/** What the follower reads of the pane's page: the host's facts and the
 *  events that announce a change in them. */
export interface AgentFollowView {
  getAgentPage(): AgentPage | undefined;
  getTabs(): DesktopBrowserTab[];
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Tries per page and turn before a failing selection is left alone. */
export const AGENT_FOLLOW_TRIES = 3;
/** Wait before a failed selection is tried again. */
export const AGENT_FOLLOW_RETRY_MS = 250;

const timerLater = (run: () => void, ms: number): (() => void) => {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
};

export function createBrowserAgentFollow(
  select: (tabId: string, follow: 'agent' | 'resume') => Promise<unknown> | void,
  later: (run: () => void, ms: number) => () => void = timerLater
) {
  let latest: AgentPage | null = null;
  let source: AgentFollowView | null = null;
  // Changes with every attach and detach: a selection begun under an earlier
  // attachment must not schedule or run anything when it settles.
  let attachment = 0;
  let cancelRetry: (() => void) | null = null;
  // The page+turn already asked for, so a slow selection is not asked again;
  // a failed one is released so it can be tried again.
  let requested = '';
  let attempts = { key: '', count: 0 };
  // "보기" pressed before the first sample said which page the agent has.
  let resumeWanted = false;

  const keyOf = (page: AgentPage) => `${page.tabId}:${page.turn}`;
  const stopRetry = () => {
    cancelRetry?.();
    cancelRetry = null;
  };

  /** Metadata that did not change raises no event, so a failure schedules
   *  its own look at the page's current facts. */
  function retrySoon(page: AgentPage, follow: 'agent' | 'resume'): void {
    if (!source || attempts.count >= AGENT_FOLLOW_TRIES) return;
    const live = attachment;
    stopRetry();
    cancelRetry = later(() => {
      cancelRetry = null;
      if (live !== attachment || !source) return;
      if (follow === 'resume') {
        if (latest && keyOf(latest) === keyOf(page) && requested === '') start(latest, 'resume');
      } else observe(source.getAgentPage(), source.getTabs());
    }, AGENT_FOLLOW_RETRY_MS);
  }

  function start(page: AgentPage, follow: 'agent' | 'resume'): void {
    const key = keyOf(page);
    requested = key;
    attempts = { key, count: (attempts.key === key ? attempts.count : 0) + 1 };
    const live = attachment;
    const failed = () => {
      if (live !== attachment || requested !== key) return;
      requested = '';
      retrySoon(page, follow);
    };
    try {
      Promise.resolve(select(page.tabId, follow)).catch(failed);
    } catch {
      failed();
    }
  }

  function resume(): void {
    if (!latest) {
      resumeWanted = true;
      return;
    }
    attempts = { key: '', count: 0 };
    start(latest, 'resume');
  }

  /** A metadata sample: the agent's page and the strip as the host has it. */
  function observe(agentPage: AgentPage | undefined, tabs: readonly DesktopBrowserTab[]): void {
    latest = agentPage ?? null;
    if (agentPage && resumeWanted) {
      resumeWanted = false;
      resume();
      return;
    }
    if (!agentPage || agentPage.paused || !tabs.some((tab) => tab.id === agentPage.tabId)) {
      requested = '';
      stopRetry();
      return;
    }
    const key = keyOf(agentPage);
    if (tabs.find((tab) => tab.active)?.id === agentPage.tabId) {
      requested = key;
      attempts = { key: '', count: 0 };
      stopRetry();
      return;
    }
    if (requested === key) return;
    if (attempts.key === key && attempts.count >= AGENT_FOLLOW_TRIES) return;
    start(agentPage, 'agent');
  }

  /** Follow the view's agent page; returns the teardown. */
  function attach(view: AgentFollowView): () => void {
    source = view;
    attachment += 1;
    const sample = () => observe(view.getAgentPage(), view.getTabs());
    view.addEventListener('agent-page', sample);
    view.addEventListener('tabs-changed', sample);
    sample();
    return () => {
      view.removeEventListener('agent-page', sample);
      view.removeEventListener('tabs-changed', sample);
      stopRetry();
      if (source !== view) return;
      source = null;
      attachment += 1;
      requested = '';
    };
  }

  return {
    observe,
    attach,
    /** "브라우저 · 보기": show the agent's page again and follow it. */
    resume,
  };
}
