/**
 * The tab lifecycle of a session: finding, adding (with eviction), showing,
 * disposing and closing tabs, and the agent's `close` action.
 */
import { ACTIVATE_SETTLE_MS, type VisualizeServiceContext } from './context';
import { summary, type TabState, type VisualizeResult } from './tab-state';
import type { VisualizeRequest } from './targets';

const MAX_TABS_PER_SESSION = 8;

export function createTabs(
  ctx: Pick<
    VisualizeServiceContext,
    'sessions' | 'sessionOf' | 'delay' | 'views' | 'thumbnails' | 'reloads' | 'tabVersions' | 'publish'
  >
) {
  const { sessions, sessionOf } = ctx;

  const dispose = (tab: TabState): void => {
    for (const stop of tab.unwatch) stop();
    tab.unwatch = [];
    ctx.reloads.cancelScheduledReload(tab);
    ctx.thumbnails.cancel(tab);
  };

  /** Forget `tab`: kept in the session's history, its watchers, jobs and
   *  versions released. */
  const retire = (sessionId: string, tab: TabState): void => {
    ctx.views.rememberTab(sessionId, tab, false);
    dispose(tab);
    ctx.tabVersions.dropVersions(sessionId, tab.id);
  };

  const findTab = (sessionId: string, id: string): TabState => {
    const state = sessions.get(sessionId);
    const tab = state?.tabs.find((candidate) => candidate.id === id);
    if (tab) return tab;
    const open = state?.tabs.map((candidate) => candidate.id) ?? [];
    throw new Error(`no visualize tab "${id}"; ${open.length ? `open tabs: ${open.join(', ')}` : 'no tabs are open'}`);
  };

  /** The oldest tabs go once the session holds more than the limit; verify-only
   *  tabs are never shown, so they neither count nor get evicted. */
  const enforceLimit = (sessionId: string): void => {
    const state = sessionOf(sessionId);
    while (state.tabs.filter((tab) => !tab.verify).length > MAX_TABS_PER_SESSION) {
      const evicted = state.tabs.splice(
        state.tabs.findIndex((tab) => !tab.verify),
        1
      )[0];
      retire(sessionId, evicted);
    }
  };

  const closeTab = (sessionId: string, tabId: string): void => {
    const state = sessions.get(sessionId);
    const tab = state?.tabs.find((candidate) => candidate.id === tabId);
    if (!state || !tab) return;
    retire(sessionId, tab);
    state.tabs.splice(state.tabs.indexOf(tab), 1);
    if (state.active === tab.id) {
      state.active = state.tabs.filter((candidate) => !candidate.url && !candidate.verify).at(-1)?.id ?? null;
    }
    ctx.publish(sessionId);
    const shown = state.tabs.find((candidate) => candidate.id === state.active);
    if (shown) ctx.thumbnails.whenMissing(sessionId, shown);
  };

  return {
    dispose,
    findTab,
    closeTab,
    enforceLimit,
    /** Close the verify-only tabs of the session (all, or only those in `only`);
     *  they are never shown, so nothing is published. */
    closeVerify(sessionId: string, only?: ReadonlySet<string>): void {
      const state = sessions.get(sessionId);
      if (!state) return;
      const closing = (tab: TabState): boolean => tab.verify === true && (!only || only.has(tab.id));
      for (const tab of state.tabs.filter(closing)) retire(sessionId, tab);
      state.tabs = state.tabs.filter((tab) => !closing(tab));
    },
    addTab(sessionId: string, tab: TabState): void {
      sessionOf(sessionId).tabs.push(tab);
      enforceLimit(sessionId);
    },
    /** Make `tab` the displayed one; resolves once a newly shown tab had time
     *  to mount and load. */
    async display(sessionId: string, tab: TabState): Promise<void> {
      const state = sessionOf(sessionId);
      if (state.active === tab.id) return;
      state.active = tab.id;
      ctx.publish(sessionId);
      await ctx.delay(ACTIVATE_SETTLE_MS);
    },
    /** The agent's `close`: one tab, or every visualize tab of the session. */
    close(request: Extract<VisualizeRequest, { action: 'close' }>): VisualizeResult {
      const { sessionId } = request;
      const state = sessions.get(sessionId);
      if (request.tab) {
        const tab = findTab(sessionId, request.tab);
        // The page itself belongs to the browser panel; visualize cannot close it.
        if (tab.url)
          throw new Error(`tab ${tab.id} is a page in the browser panel (${tab.url}); close it with the browser tool`);
        const count = tab.versions?.length ?? 0;
        closeTab(sessionId, tab.id);
        const history = count > 1 ? ` Its ${count} kept versions were discarded.` : '';
        return { text: `Closed visualize tab ${tab.id}.${history}`, tabs: (state?.tabs ?? []).map(summary) };
      }
      const closing = (state?.tabs ?? []).filter((tab) => !tab.url);
      const browserPages = (state?.tabs ?? []).filter((tab) => tab.url);
      const histories = closing
        .filter((tab) => (tab.versions?.length ?? 0) > 1)
        .map((tab) => `${tab.id} (${tab.versions?.length} versions)`);
      for (const tab of closing) retire(sessionId, tab);
      // The session entry stays (empty): its tab counter must not restart, or
      // a new tab would take the id an older chat card still names.
      if (state) {
        state.tabs = browserPages;
        state.active = null;
      }
      ctx.publish(sessionId);
      const count = closing.length;
      const plural = count === 1 ? '' : 's';
      const closed = count ? `Closed ${count} visualize tab${plural}.` : 'No visualize tabs were open.';
      const kept = browserPages.length
        ? ` Still open in the browser panel: ${browserPages.map((tab) => `${tab.id} (${tab.url})`).join(', ')}; close those with the browser tool.`
        : '';
      const discarded = histories.length ? ` Discarded the version history of ${histories.join(', ')}.` : '';
      return { text: `${closed}${discarded}${kept}`, tabs: browserPages.map(summary) };
    },
  };
}

export type TabLifecycle = ReturnType<typeof createTabs>;
