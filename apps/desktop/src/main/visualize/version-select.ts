import type { VisualizeServiceContext } from './context';
import type { TabState } from './tab-state';
import { noVersion } from './tab-versions';
import { keptTargets } from './versions';

/** Back to live. */
export function showLive(
  tab: TabState,
  invalidate: (tab: TabState) => void,
  releasePanes?: (panes: TabState['panes']) => void
): void {
  if (tab.shown) {
    releasePanes?.(tab.shown.panes);
    invalidate(tab);
  }
  tab.shown = null;
  tab.compare = false;
}

const layoutKey = (tab: TabState) => `${tab.shown?.n ?? ''}|${tab.shown && tab.compare ? 'compare' : ''}`;

export function createVersionSelection(
  ctx: Pick<
    VisualizeServiceContext,
    'versions' | 'panes' | 'leases' | 'thumbnails' | 'tabVersions' | 'tabs' | 'publish' | 'reloads'
  >
) {
  const { versions } = ctx;
  const selectionSeq = new WeakMap<TabState, number>();
  const invalidate = (tab: TabState) => ctx.thumbnails.invalidate(tab);
  const releasePanes = (panes: TabState['panes']) => ctx.tabs.releasePanes(panes);
  const isStale = (tab: TabState, seq: number): boolean => tab.lifetime.signal.aborted || selectionSeq.get(tab) !== seq;

  /** Inline tabs keep their versions in memory: showing one needs no files. */
  const applyInlineSelection = async (
    sessionId: string,
    tab: TabState,
    n: number | null,
    compare: boolean,
    seq: number
  ): Promise<void> => {
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
          const inlineBefore = tab.inline;
          const panes = [await ctx.panes.inlinePaneFor(version.content)];
          if (isStale(tab, seq) || tab.inline !== inlineBefore || !tab.inlineHistory?.includes(version)) {
            releasePanes(panes);
            return;
          }
          if (tab.shown) releasePanes(tab.shown.panes);
          tab.shown = { n, targets: [], panes, restoreAssets: [] };
          ctx.leases.claimLeases(sessionId, tab, panes);
        }
        if (isStale(tab, seq)) return;
        tab.compare = compare;
        if (compare) ctx.leases.claimLeases(sessionId, tab, tab.panes);
        invalidate(tab);
        return;
      }
    }
    showLive(tab, invalidate, releasePanes);
    ctx.leases.claimLeases(sessionId, tab, tab.panes);
  };

  const applyVersionSelection = async (
    sessionId: string,
    tab: TabState,
    n: number | null,
    compare: boolean,
    seq: number
  ): Promise<void> => {
    if (tab.inline) return applyInlineSelection(sessionId, tab, n, compare, seq);
    if (n !== null) {
      const list = versions?.list(sessionId, tab.id) ?? [];
      const version = list.find((candidate) => candidate.n === n);
      if (!version)
        throw noVersion(
          tab,
          n,
          list.map((candidate) => candidate.n)
        );
      if (version !== list.at(-1) || compare || tab.liveUnkept || tab.historyFull) {
        const restoreAssets = await ctx.tabVersions.restoreAssetsOf(sessionId, tab, n);
        if (isStale(tab, seq)) return;
        if (tab.shown?.n === n) {
          tab.shown.restoreAssets = restoreAssets;
        } else {
          const targets = keptTargets(version, tab.targets);
          const panes = await ctx.panes.preparePanes(targets);
          if (isStale(tab, seq)) return;
          tab.shown = { n, targets, panes, restoreAssets };
          ctx.leases.claimLeases(sessionId, tab, panes);
        }
        tab.compare = compare;
        if (compare) ctx.leases.claimLeases(sessionId, tab, tab.panes);
        invalidate(tab);
        return;
      }
    }
    showLive(tab, invalidate);
    ctx.leases.claimLeases(sessionId, tab, tab.panes);
  };

  return {
    /** Show kept version `n` (null = live), beside live when `compare`. The
     *  newest version without compare is live itself. Callers publish. */
    async selectVersion(sessionId: string, tab: TabState, n: number | null, compare: boolean): Promise<void> {
      if (tab.lifetime.signal.aborted) return;
      const seq = (selectionSeq.get(tab) ?? 0) + 1;
      selectionSeq.set(tab, seq);
      const before = layoutKey(tab);
      try {
        await applyVersionSelection(sessionId, tab, n, compare, seq);
      } finally {
        // Pane indices and versions of recorded problems belong to the old
        // layout; the pages that now display start clean.
        if (!isStale(tab, seq) && before !== layoutKey(tab)) {
          tab.problems = [];
          tab.problemSeq += 1;
        }
      }
    },
    /** After a selection: back on live, catch up on changes made meanwhile. */
    async afterSelect(sessionId: string, tab: TabState): Promise<void> {
      if (tab.lifetime.signal.aborted) return;
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
