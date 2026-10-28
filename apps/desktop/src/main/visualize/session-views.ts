/**
 * What a session's visualize state looks like from outside: the desktop
 * window's state (with signed inline render ids), the remote mirror's host
 * state (with each pane's resolved file) and the session's "All visuals"
 * history.
 */
import { createHmac, randomBytes } from 'node:crypto';

import type {
  VisualizeHistoryItem,
  VisualizeHostPane,
  VisualizeHostState,
  VisualizePaneView,
  VisualizeSessionState,
  VisualizeTabView,
} from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import { type HistoryEntry, historyId, historyItems, rememberHistory } from './history';
import { noteReveal } from './turn-hold';
import {
  paneKindOf,
  remoteLabelOf,
  remoteTargetOf,
  type SessionState,
  shownLayout,
  type TabState,
  view,
} from './tab-state';

/** Inline panes carry their content, not a file: no host path at all. */
const inlineHost = (pane: VisualizePaneView, extra: Partial<VisualizeHostPane> = {}): VisualizeHostPane => ({
  kind: pane.kind,
  label: pane.label,
  target: pane.target,
  path: '',
  remoteTarget: pane.target,
  ...(pane.inline ? { inline: pane.inline } : {}),
  ...extra,
});

/** The live panes of a tab as the remote mirror sees them. */
const liveHostPanes = (tab: TabState): VisualizeHostPane[] =>
  tab.inline
    ? tab.panes.map((pane) => inlineHost(pane))
    : tab.targets.map((target) => ({
        kind: target.kind,
        label: target.label,
        target: target.target,
        path: target.path,
        remoteTarget: remoteTargetOf(target),
        root: target.root,
      }));

/** The shown kept version's panes, served from its snapshot folder. */
function keptHostPanes(tab: TabState): VisualizeHostPane[] {
  const shown = tab.shown;
  if (!shown) return [];
  if (tab.inline) return shown.panes.map((pane) => inlineHost(pane, { version: shown.n }));
  return shown.targets.map((target) => ({
    kind: target.kind,
    label: target.label,
    target: target.target,
    path: target.path,
    remoteTarget: remoteTargetOf(target),
    root: target.root,
    version: shown.n,
  }));
}

export function createSessionViews(
  sessions: Map<string, SessionState>,
  sessionOf: (sessionId: string) => SessionState
) {
  /** Signs the render ids issued to the desktop window. */
  const renderSecret = randomBytes(32);

  /** One render instance's id: bound to this service's secret, the session,
   *  the tab, its revision (every remount bumps it), the displayed pane and
   *  the version it shows. Issued with the tab state, never guessable. A
   *  remote client's id is signed apart, so neither audience learns the
   *  other's. */
  const renderIdOf = (
    sessionId: string,
    tab: TabState,
    index: number,
    pane: Pick<VisualizePaneView, 'version'>,
    audience: 'desktop' | 'remote' = 'desktop'
  ): string =>
    createHmac('sha256', renderSecret)
      .update(
        [
          sessionId,
          tab.id,
          tab.revision,
          index,
          pane.version ?? 'live',
          ...(audience === 'remote' ? ['remote'] : []),
        ].join('\0')
      )
      .digest('base64url');

  const withRenderIds = (sessionId: string, tab: TabState, tabView: VisualizeTabView): VisualizeTabView => ({
    ...tabView,
    panes: tabView.panes.map((pane, index) =>
      pane.kind === 'inline' ? { ...pane, renderId: renderIdOf(sessionId, tab, index, pane) } : pane
    ),
  });

  /** The "All visuals" list: what the session opened, open tabs marked. */
  const historyOf = (sessionId: string, remote: boolean): VisualizeHistoryItem[] => {
    const state = sessions.get(sessionId);
    if (!state) return [];
    const open = new Map(
      state.tabs.filter((tab) => !tab.url && !tab.verify).map((tab) => [tab.key, tab.versions?.length ?? 1])
    );
    return historyItems(state.history, open, remote);
  };

  /** Remember `tab` in its session's history (moved to the front when
   *  `touch`: it was just opened). Web pages are not visuals. */
  const rememberTab = (sessionId: string, tab: TabState, touch: boolean) => {
    if (tab.url || tab.verify) return;
    const state = sessionOf(sessionId);
    const previous = state.history.find((entry) => entry.key === tab.key);
    const live = tab.inline
      ? tab.panes.map((pane) => ({ target: pane.target, remoteTarget: pane.target }))
      : tab.targets.map((target) => ({
          target: target.target,
          remoteTarget: remoteTargetOf(target),
        }));
    const entry: HistoryEntry = {
      id: historyId(tab.key),
      key: tab.key,
      label: tab.label,
      remoteLabel: remoteLabelOf(tab, live),
      kind: tab.inline ? tab.inline.kind : paneKindOf(tab),
      targets: tab.inline ? [] : tab.targets.map((target) => target.target),
      ...(tab.inline ? { content: tab.inline } : {}),
      at: touch || !previous ? Date.now() : previous.at,
      versions: tab.versions?.length ?? 1,
    };
    if (touch || !previous) state.history = rememberHistory(state.history, entry);
    else state.history = state.history.map((candidate) => (candidate === previous ? entry : candidate));
  };

  const stateOf = (sessionId: string): VisualizeSessionState => {
    const state = sessions.get(sessionId);
    // Only the desktop window gets render ids (remote states are built from
    // the host state, which carries none).
    const tabs = (state?.tabs ?? [])
      .filter((tab) => !tab.url && !tab.verify)
      .map((tab) => withRenderIds(sessionId, tab, view(tab)));
    const active =
      state?.active && tabs.some((tab) => tab.id === state.active) ? state.active : (tabs.at(-1)?.id ?? null);
    const history = historyOf(sessionId, false);
    const goneOpens = state?.goneOpens ?? [];
    return {
      sessionId,
      tabs,
      active,
      ...(goneOpens.length ? { goneOpens } : {}),
      ...(history.length ? { history } : {}),
    };
  };

  const hostStateOf = (sessionId: string): VisualizeHostState => {
    const { tabs: views, active, goneOpens } = stateOf(sessionId);
    const tabs = (sessions.get(sessionId)?.tabs ?? []).filter((tab) => !tab.url && !tab.verify);
    const history = historyOf(sessionId, true);
    return {
      sessionId,
      active,
      ...(goneOpens ? { goneOpens } : {}),
      ...(history.length ? { history } : {}),
      tabs: views.map((view, index) => {
        const tab = tabs[index];
        const live = liveHostPanes(tab);
        return {
          ...view,
          remoteLabel: remoteLabelOf(tab, live),
          cwd: tab.cwd,
          // Inline panes carry the remote render id their report needs.
          panes: shownLayout(tab, keptHostPanes(tab), live).map((pane, paneIndex) =>
            pane.kind === 'inline'
              ? { ...pane, remoteRenderId: renderIdOf(sessionId, tab, paneIndex, pane, 'remote') }
              : pane
          ),
        };
      }),
    };
  };

  return { renderIdOf, rememberTab, stateOf, hostStateOf };
}

export type SessionViews = ReturnType<typeof createSessionViews>;

/** `publish` of the service: a picture of an older revision is stopped first
 *  (every revision change is published, so it stops mid-capture instead of
 *  running to its end), then the desktop window and the remote mirror get
 *  the session's state. */
export function createPublish(ctx: Pick<VisualizeServiceContext, 'deps' | 'views' | 'thumbnails' | 'holds'>) {
  return (sessionId: string, revealTab?: string, updatedTab?: string, callId?: string): void => {
    ctx.thumbnails.cancelStale(sessionId);
    // A running agent turn (turn-hold.ts): the reveal waits for its end, and
    // the state goes out `held`, which the panel does not show; while the
    // turn's end applies, nothing goes out until its one final publish.
    const hold = ctx.holds.get(sessionId);
    if (hold && hold.bypass === 0) {
      if (revealTab) noteReveal(hold, revealTab, callId);
      hold.dirty = true;
      if (hold.flushing) return;
      const updated = updatedTab ? { updated: updatedTab } : {};
      const held = { held: true, heldSince: hold.since };
      ctx.deps.publish({ sessionId, state: ctx.views.stateOf(sessionId), ...held, ...updated });
      ctx.deps.publishHost?.({ sessionId, state: ctx.views.hostStateOf(sessionId), ...held, ...updated });
      return;
    }
    let reveal: { reveal: true; tab: string } | { updated: string } | Record<string, never> = {};
    if (revealTab) reveal = { reveal: true, tab: revealTab };
    else if (updatedTab) reveal = { updated: updatedTab };
    ctx.deps.publish({ sessionId, state: ctx.views.stateOf(sessionId), ...reveal });
    ctx.deps.publishHost?.({ sessionId, state: ctx.views.hostStateOf(sessionId), ...reveal });
  };
}
