/**
 * Runtime problems of displayed visualize pages: which tab and pane a page
 * report belongs to, recording it on the tab, and waiting for a page (or an
 * inline render) to settle so its problems ride a tool result.
 */
import type { VisualizeProblem } from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import { buildProblem, classifyConsole, leasePrefixOf, type PageConsoleReport, recordProblem } from './page-problems';
import { displayedPanes, realCwdOfTab, type TabState } from './tab-state';

/** A page counts as settled after this long without a new problem. */
const PROBLEM_QUIET_MS = 400;
export const PROBLEM_SETTLE_ROUNDS = 6;

export interface PaneOfTab {
  sessionId: string;
  tab: TabState;
  index: number;
  version?: number;
}

/** The tab's cwd as given and as resolved: both are stripped from problem
 *  text (an unreadable cwd only as given). */
const rootsOf = (tab: TabState): string[] => {
  const real = realCwdOfTab(tab);
  return real === tab.cwd ? [tab.cwd] : [tab.cwd, real];
};

export function createProblemTracker(ctx: Pick<VisualizeServiceContext, 'sessions' | 'delay' | 'views' | 'publish'>) {
  const { sessions, delay } = ctx;
  const { renderIdOf } = ctx.views;
  const publish = (sessionId: string) => ctx.publish(sessionId);

  /** The tab and HTML pane whose page-server lease any of `urls` belongs to,
   *  among the panes the tab displays (a kept version's, compare layout
   *  included): `index` is the displayed index, `version` the kept version. */
  const paneOfUrl = (urls: string[]): PaneOfTab | null => {
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
  };

  const recordPageProblem = (
    found: PaneOfTab,
    draft: { kind: VisualizeProblem['kind']; message: string; source: string; line: number }
  ) => {
    const { sessionId, tab, index, version } = found;
    const next = recordProblem(tab.problems, buildProblem({ ...draft, pane: index, version }, rootsOf(tab)));
    tab.problems = next.list;
    tab.problemSeq += 1;
    if (next.added) publish(sessionId);
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

  return {
    paneOfUrl,
    recordPageProblem,
    reportInlineRender,
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
      if (httpResponseCode >= 400) {
        recordPageProblem(found, {
          kind: 'load',
          message: `The page responded with HTTP ${httpResponseCode}`,
          source: url,
          line: 0,
        });
      } else if (cleared) {
        publish(sessionId);
      }
    },
    /** A pane's page could not be loaded at all. */
    reportLoadFailure(url: string, description: string): void {
      const found = paneOfUrl([url]);
      if (found)
        recordPageProblem(found, {
          kind: 'load',
          message: `The page failed to load: ${description}`,
          source: url,
          line: 0,
        });
    },
  };
}

export type ProblemTracker = ReturnType<typeof createProblemTracker>;
