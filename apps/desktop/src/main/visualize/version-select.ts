/**
 * Showing a tab's kept version instead of (or beside) live: file tabs from
 * the version store's snapshot folder, inline tabs from memory.
 */
import type { VisualizeServiceContext } from './context';
import type { TabState } from './tab-state';
import { noVersion } from './tab-versions';
import { keptTargets } from './versions';

/** Back to live. */
export function showLive(tab: TabState, invalidate: (tab: TabState) => void): void {
  if (tab.shown) invalidate(tab);
  tab.shown = null;
  tab.compare = false;
}

const layoutKey = (tab: TabState) => `${tab.shown?.n ?? ''}|${tab.shown && tab.compare ? 'compare' : ''}`;

export function createVersionSelection(
  ctx: Pick<
    VisualizeServiceContext,
    'versions' | 'panes' | 'leases' | 'thumbnails' | 'tabVersions' | 'publish' | 'reloads'
  >
) {
  const { versions } = ctx;
  const invalidate = (tab: TabState) => ctx.thumbnails.invalidate(tab);

  /** Inline tabs keep their versions in memory: showing one needs no files. */
  const applyInlineSelection = async (tab: TabState, n: number | null, compare: boolean): Promise<void> => {
    const history = tab.inlineHistory ?? [];
    if (n !== null) {
      const version = history.find((candidate) => candidate.n === n);
      if (!version)
        throw noVersion(
          tab,
          n,
          history.map((candidate) => candidate.n)
        );
      if (version !== history.at(-1) || compare) {
        if (tab.shown?.n !== n) {
          const panes = [await ctx.panes.inlinePaneFor(version.content)];
          tab.shown = { n, targets: [], panes, restoreAssets: [] };
          ctx.leases.claimLeases(tab, panes);
        }
        tab.compare = compare;
        invalidate(tab);
        return;
      }
    }
    showLive(tab, invalidate);
  };

  const applyVersionSelection = async (
    sessionId: string,
    tab: TabState,
    n: number | null,
    compare: boolean
  ): Promise<void> => {
    if (tab.inline) return applyInlineSelection(tab, n, compare);
    if (n !== null) {
      const list = versions?.list(sessionId, tab.id) ?? [];
      const version = list.find((candidate) => candidate.n === n);
      if (!version)
        throw noVersion(
          tab,
          n,
          list.map((candidate) => candidate.n)
        );
      if (version !== list.at(-1) || compare) {
        const restoreAssets = await ctx.tabVersions.restoreAssetsOf(sessionId, tab, n);
        if (tab.shown?.n === n) {
          tab.shown.restoreAssets = restoreAssets;
        } else {
          const targets = keptTargets(version, tab.targets);
          const panes = await ctx.panes.preparePanes(targets);
          tab.shown = { n, targets, panes, restoreAssets };
          ctx.leases.claimLeases(tab, panes);
        }
        tab.compare = compare;
        invalidate(tab);
        return;
      }
    }
    showLive(tab, invalidate);
  };

  return {
    /** Show kept version `n` (null = live), beside live when `compare`. The
     *  newest version without compare is live itself. Callers publish. */
    async selectVersion(sessionId: string, tab: TabState, n: number | null, compare: boolean): Promise<void> {
      const before = layoutKey(tab);
      try {
        await applyVersionSelection(sessionId, tab, n, compare);
      } finally {
        // Pane indices and versions of recorded problems belong to the old
        // layout; the pages that now display start clean.
        if (before !== layoutKey(tab)) {
          tab.problems = [];
          tab.problemSeq += 1;
        }
      }
    },
    /** After a selection: back on live, catch up on changes made meanwhile. */
    async afterSelect(sessionId: string, tab: TabState): Promise<void> {
      if (!tab.shown && tab.pendingReload) {
        tab.pendingReload = false;
        await ctx.reloads.reload(sessionId, tab);
        return;
      }
      ctx.publish(sessionId);
    },
  };
}

export type VersionSelection = ReturnType<typeof createVersionSelection>;
