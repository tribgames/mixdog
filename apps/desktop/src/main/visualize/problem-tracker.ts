import type { VisualizeProblem } from '../../shared/visualize';
import { blockedNetworkMessage, isOutsideNetworkUrl } from '../../shared/visualize-network-policy';
import type { VisualizeServiceContext } from './context';
import { buildProblem, classifyConsole, leasePrefixOf, type PageConsoleReport, recordProblem } from './page-problems';
import { displayedPanes, problemRootsOf, type TabState } from './tab-state';

/** A page counts as settled after this long without a new problem. */
const PROBLEM_QUIET_MS = 400;
export const PROBLEM_SETTLE_ROUNDS = 6;

export interface PaneOfTab {
  sessionId: string;
  tab: TabState;
  index: number;
  version?: number;
}

/** The tab and HTML pane whose page-server lease any of `urls` belongs to,
 *  among the panes the tab displays (a kept version's, compare layout
 *  included): `index` is the displayed index, `version` the kept version. */
function paneOfLeaseUrl(sessions: VisualizeServiceContext['sessions'], urls: string[]): PaneOfTab | null {
  for (const [sessionId, state] of sessions) {
    for (const tab of state.tabs) {
      const panes = displayedPanes(tab);
      const index = panes.findIndex((pane) => {
        const prefix = pane.kind === 'html' ? leasePrefixOf(pane.url) : '';
        return prefix !== '' && urls.some((url) => url.startsWith(prefix));
      });
      if (index >= 0) return { sessionId, tab, index, version: panes[index].version };
    }
  }
  return null;
}

const MAX_TRACKED_PREFIXES = 64;
const MAX_CONFIRMED_PATHS_PER_PREFIX = 32;

function normalizedLeasePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/, 1)[0];
  }
}

export function createProblemTracker(
  ctx: Pick<VisualizeServiceContext, 'sessions' | 'delay' | 'views' | 'publish' | 'reloads'>
) {
  const { sessions, delay } = ctx;
  const { renderIdOf } = ctx.views;
  const publish = (sessionId: string) => ctx.publish(sessionId);

  const attemptedPrefixes = new WeakMap<TabState, Set<string>>();
  const recoveryPrefixes = new WeakMap<TabState, Set<string>>();
  const confirmedPaths = new WeakMap<TabState, Map<string, Set<string>>>();
  const inFlightPrefixes = new WeakMap<TabState, Set<string>>();

  const prefixSet = (map: WeakMap<TabState, Set<string>>, tab: TabState): Set<string> => {
    let set = map.get(tab);
    if (!set) {
      set = new Set();
      map.set(tab, set);
    }
    return set;
  };

  const rememberPrefix = (set: Set<string>, prefix: string): void => {
    set.delete(prefix);
    set.add(prefix);
    while (set.size > MAX_TRACKED_PREFIXES) set.delete(set.values().next().value as string);
  };

  const rememberConfirmedPath = (tab: TabState, prefix: string, path: string): void => {
    let byPrefix = confirmedPaths.get(tab);
    if (!byPrefix) {
      byPrefix = new Map();
      confirmedPaths.set(tab, byPrefix);
    }
    let paths = byPrefix.get(prefix);
    if (!paths) {
      paths = new Set();
    } else {
      byPrefix.delete(prefix);
    }
    byPrefix.set(prefix, paths);
    while (byPrefix.size > MAX_TRACKED_PREFIXES) byPrefix.delete(byPrefix.keys().next().value as string);
    paths.delete(path);
    paths.add(path);
    while (paths.size > MAX_CONFIRMED_PATHS_PER_PREFIX) paths.delete(paths.values().next().value as string);
  };

  const paneOfUrl = (urls: string[]): PaneOfTab | null => paneOfLeaseUrl(sessions, urls);

  const recordPageProblem = (
    found: PaneOfTab,
    draft: { kind: VisualizeProblem['kind']; message: string; source: string; line: number }
  ) => {
    const { sessionId, tab, index, version } = found;
    const next = recordProblem(tab.problems, buildProblem({ ...draft, pane: index, version }, problemRootsOf(tab)));
    tab.problems = next.list;
    tab.problemSeq += 1;
    if (next.added) publish(sessionId);
  };

  /** One-shot lease recovery for an expired page-server lease. Returns true
   *  when a refresh was started or is already in flight for this prefix. */
  const tryRecoverExpiredLease = (
    found: PaneOfTab,
    draft: { kind: VisualizeProblem['kind']; message: string; source: string; line: number },
    detail: { url: string; is404: boolean }
  ): boolean => {
    const { sessionId, tab, index, version } = found;
    // Live missing state must not block lease recovery for a displayed kept version.
    if (tab.verify || (version === undefined && tab.missing) || tab.lifetime.signal.aborted) return false;
    if (!sessions.get(sessionId)?.tabs.includes(tab)) return false;
    const pane = displayedPanes(tab)[index];
    if (pane?.kind !== 'html') return false;
    const prefix = leasePrefixOf(pane.url);
    if (!prefix) return false;
    if (detail.is404) {
      const targetPath = normalizedLeasePath(detail.url);
      const isEntryUrl = targetPath === normalizedLeasePath(pane.url);
      const wasConfirmedOnLease = confirmedPaths.get(tab)?.get(prefix)?.has(targetPath) === true;
      // A sub-path (e.g. broken link or missing nested iframe) that never loaded
      // on this lease is a real 404, not an expired lease.
      if (!isEntryUrl && !wasConfirmedOnLease) return false;
    }
    const inFlight = prefixSet(inFlightPrefixes, tab);
    if (inFlight.has(prefix)) return true;
    const attempted = prefixSet(attemptedPrefixes, tab);
    const unconfirmed = prefixSet(recoveryPrefixes, tab);
    if (attempted.has(prefix) || unconfirmed.has(prefix)) return false;
    rememberPrefix(attempted, prefix);
    inFlight.add(prefix);
    void ctx.reloads
      .refreshLease(sessionId, tab, version)
      .then((result) => {
        if (result.outcome === 'refreshed') {
          for (const refreshed of result.panes) {
            const nextPrefix = refreshed.kind === 'html' ? leasePrefixOf(refreshed.url) : '';
            if (nextPrefix) rememberPrefix(unconfirmed, nextPrefix);
          }
          return;
        }
        if (result.outcome === 'failed') {
          const current = displayedPanes(tab)[index];
          if (
            !tab.lifetime.signal.aborted &&
            sessions.get(sessionId)?.tabs.includes(tab) &&
            current?.kind === 'html' &&
            leasePrefixOf(current.url) === prefix
          ) {
            recordPageProblem(found, draft);
          }
        }
      })
      .finally(() => {
        inFlight.delete(prefix);
      });
    return true;
  };

  /** The panel finished rendering inline pane `index` (of the displayed
   *  panes); a failure becomes a page problem like any other. */
  const reportInlineRender = (sessionId: string, tab: TabState, index: number, renderId: string, error?: string) => {
    const pane = displayedPanes(tab)[index];
    if (pane?.kind !== 'inline' || !pane.inline) return;
    // One report per render instance of exactly this tab / version / session,
    // from the desktop window or a remote client (whichever reports first);
    // anything else (a stale, repeated or foreign id) is ignored.
    const expected = renderIdOf(sessionId, tab, index, pane);
    const remote = renderIdOf(sessionId, tab, index, pane, 'remote');
    tab.rendersSpent ??= new Map();
    const spent = tab.rendersSpent;
    if ((renderId !== expected && renderId !== remote) || spent.has(expected)) return;
    for (const [id, revision] of spent) if (revision !== tab.revision) spent.delete(id);
    spent.set(expected, tab.revision);
    tab.rendered?.add(index);
    tab.problemSeq += 1;
    if (!error) return;
    recordPageProblem(
      { sessionId, tab, index, version: pane.version },
      {
        kind: 'render',
        message: `The ${pane.inline.kind} could not be rendered: ${error.replace(/\s+/g, ' ').trim()}`,
        source: pane.label,
        line: 0,
      }
    );
  };

  const reportRemoteBlockedNetwork = (
    sessionId: string,
    tab: TabState,
    index: number,
    url: string,
    resource: string
  ) => {
    const pane = displayedPanes(tab)[index];
    if (pane?.kind !== 'html') return;
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return;
    }
    if (!isOutsideNetworkUrl(target)) return;
    recordPageProblem(
      { sessionId, tab, index, version: pane.version },
      { kind: 'blocked-network', message: blockedNetworkMessage(target.host, resource), source: '', line: 0 }
    );
  };

  return {
    paneOfUrl,
    recordPageProblem,
    reportInlineRender,
    reportRemoteBlockedNetwork,
    /** Wait until no problem was reported (and no reload is pending) for one
     *  quiet interval, at most `rounds` intervals. */
    async settle(tab: TabState, rounds: number): Promise<void> {
      for (let round = 0; round < rounds; round += 1) {
        const seen = tab.problemSeq;
        await delay(PROBLEM_QUIET_MS);
        if (tab.problemSeq === seen && !tab.reloadTimer) return;
      }
    },
    /** Wait (bounded) until the panel reports every inline pane of the tab
     *  rendered, then until it stops reporting problems, so a failed render
     *  rides the tool result. */
    async awaitInlineRender(tab: TabState): Promise<void> {
      // Only static panes report a render; scripted pages report problems as pages do.
      const pending = () =>
        displayedPanes(tab).some((pane, index) => pane.kind === 'inline' && !tab.rendered?.has(index));
      for (let round = 0; round < PROBLEM_SETTLE_ROUNDS && pending(); round += 1) await delay(PROBLEM_QUIET_MS);
    },
    /** A console message of any frame of the main window (Electron's
     *  `console-message`); kept only when it is a problem of a displayed page. */
    reportConsole(report: PageConsoleReport & { frameUrl: string }): void {
      const classified = classifyConsole(report);
      const found = classified && paneOfUrl([report.frameUrl, report.sourceId]);
      if (!classified || !found) return;
      recordPageProblem(found, { ...classified, source: report.sourceId, line: report.lineNumber });
    },
    /** A pane's page (re)committed: its earlier problems are stale. An error
     *  response is itself a problem. */
    reportNavigation(url: string, httpResponseCode: number): void {
      const found = paneOfUrl([url]);
      if (!found) return;
      const { sessionId, tab, index } = found;
      const kept = tab.problems.filter((problem) => problem.pane !== index);
      const cleared = kept.length !== tab.problems.length;
      tab.problems = kept;
      tab.problemSeq += 1;
      if (httpResponseCode < 400) {
        const pane = displayedPanes(tab)[index];
        const prefix = pane?.kind === 'html' ? leasePrefixOf(pane.url) : '';
        if (prefix) {
          const targetPath = normalizedLeasePath(url);
          rememberConfirmedPath(tab, prefix, targetPath);
          if (targetPath === normalizedLeasePath(pane.url)) recoveryPrefixes.get(tab)?.delete(prefix);
        }
        if (cleared) publish(sessionId);
        return;
      }
      const draft = {
        kind: 'load' as const,
        message: `The page responded with HTTP ${httpResponseCode}`,
        source: url,
        line: 0,
      };
      if (httpResponseCode === 404 && tryRecoverExpiredLease(found, draft, { url, is404: true })) {
        if (cleared) publish(sessionId);
        return;
      }
      recordPageProblem(found, draft);
    },
    /** A pane's page could not be loaded at all. */
    reportLoadFailure(url: string, description: string): void {
      const found = paneOfUrl([url]);
      if (!found) return;
      const draft = {
        kind: 'load' as const,
        message: `The page failed to load: ${description}`,
        source: url,
        line: 0,
      };
      if (tryRecoverExpiredLease(found, draft, { url, is404: false })) return;
      recordPageProblem(found, draft);
    },
  };
}

export type ProblemTracker = ReturnType<typeof createProblemTracker>;
