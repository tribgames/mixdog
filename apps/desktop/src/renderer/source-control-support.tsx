import type React from 'react';
import { useLayoutEffect, useMemo, useState } from 'react';
import type { DesktopGitFile } from '../shared/contract';
import { anchoredPanelGeometry, intersectRects, rectFrom, viewportRect } from './anchored-panel';
import { t } from './i18n';
import { scmStatusKind, type ScmStatusKind } from './ScmStatusIcon';

export interface SourceControlDiffRequest {
  source: 'staged' | 'unstaged' | 'commit' | 'session';
  hash?: string;
  untracked?: boolean;
}

export const indexOnly = (file: DesktopGitFile): boolean =>
  !file.conflicted && file.index !== ' ' && file.index !== '?' && file.worktree === ' ';

const stagedInIndex = (file: DesktopGitFile): boolean => !file.conflicted && file.index !== ' ' && file.index !== '?';

export const partiallyStaged = (file: DesktopGitFile): boolean =>
  stagedInIndex(file) && !file.untracked && file.worktree !== ' ';

export const HISTORY_PAGE_SIZE = 40;
export const SCM_FILE_ROW_HEIGHT = 31;
export const SCM_COMMIT_ROW_HEIGHT = 46;
const SCM_ROW_OVERSCAN = 6;
export const HISTORY_PREFETCH_ROWS = 8;
export const DEFAULT_BRANCH_NAMES = ['main', 'master', 'trunk'];

const GIT_RESET_DIRTY_CODE = 'git-reset-dirty-worktree';

export function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function isDirtyResetRefusal(reason: unknown): boolean {
  if (typeof reason === 'object' && reason !== null && (reason as { code?: unknown }).code === GIT_RESET_DIRTY_CODE)
    return true;
  return /--mixed reset rewrites the index/.test(reasonText(reason));
}

export function leavesStateBehind(key: string): boolean {
  return /^(revert-commit|cherry-pick|reset|revert:|discard-all|resolve:|continue|abort-operation|pull|sync|stash)/.test(
    key
  );
}

export function gitRemoteWebUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  if (!trimmed) return '';
  const ssh = /^(?:ssh:\/\/)?(?:git@)?([^:/]+)[:/](.+)$/i.exec(trimmed);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (ssh && !trimmed.includes('://')) return `https://${ssh[1]}/${ssh[2]}`;
  return '';
}

export function pullRequestUrl(remoteUrl: string, branch: string): string {
  const base = gitRemoteWebUrl(remoteUrl);
  if (!base || !branch) return '';
  const encoded = branch.split('/').map(encodeURIComponent).join('/');
  if (/gitlab/i.test(base)) {
    return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
  }
  return `${base}/compare/${encoded}?expand=1`;
}

export function statusKind(file: DesktopGitFile): ScmStatusKind {
  if (file.conflicted) return 'conflicted';
  if (file.untracked) return 'new';
  const value = file.index !== ' ' && file.index !== '?' ? file.index : file.worktree;
  return scmStatusKind(value);
}

export function pathsFor(file: DesktopGitFile): string[] {
  return file.oldPath ? [file.oldPath, file.path] : [file.path];
}

export const SCM_SORT_KEY = 'mixdog.desktop.scm-sort-key.v1';
export type ScmSortKey = 'path' | 'name' | 'status';

export function changedFilesLabel(total: number, visible: number): string {
  if (visible !== total) {
    return total === 1
      ? t('{{visible}} of {{total}} changed file', { visible, total })
      : t('{{visible}} of {{total}} changed files', { visible, total });
  }
  return total === 1 ? t('{{count}} changed file', { count: total }) : t('{{count}} changed files', { count: total });
}

export const emptySummary = () => t('Empty commit message');
export const unknownAuthor = () => t('Unknown author');

export function useAnchoredPanel(
  open: boolean,
  trigger: React.RefObject<HTMLElement | null>,
  panel: React.RefObject<HTMLElement | null>,
  options: {
    preferredWidth: number;
    minWidth?: number;
    align?: 'start' | 'end';
    placement?: 'below' | 'above';
    boundary?: React.RefObject<HTMLElement | null>;
  }
): React.CSSProperties {
  const { preferredWidth, minWidth, align, placement, boundary } = options;
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed' });
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const anchor = trigger.current;
      const surface = panel.current;
      if (!anchor || !surface) return;
      const viewport = viewportRect();
      const boundaryElement = boundary?.current;
      const bounds = boundaryElement ? intersectRects(rectFrom(boundaryElement), viewport) : viewport;
      const geometry = anchoredPanelGeometry({
        trigger: rectFrom(anchor),
        bounds,
        preferredWidth,
        minWidth,
        naturalHeight: surface.scrollHeight || surface.offsetHeight,
        align,
        placement,
      });
      setStyle({
        position: 'fixed',
        left: geometry.left,
        top: geometry.top,
        width: geometry.width,
        maxHeight: geometry.maxHeight,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [align, boundary, minWidth, open, panel, placement, preferredWidth, trigger]);
  return style;
}

export interface ScmRowWindow {
  start: number;
  end: number;
  leading: number;
  trailing: number;
  measured: boolean;
  /** The viewport's scroll offset, height and width as last measured. */
  top: number;
  height: number;
  width: number;
  /** Where a row starts, and the whole list's extent. */
  offsetOf(index: number): number;
  total: number;
}

/** A row taller than the list's uniform row: its index and how much taller. */
export type RowExtent = { index: number; extra: number };
const NO_EXTENTS: readonly RowExtent[] = [];

/** Uniform rows of `rowHeight`, except the few `extents` (sorted by index):
 *  every lookup walks the exceptions, never the rows. */
export function rowWindowLayout(count: number, rowHeight: number, extents: readonly RowExtent[]) {
  const offsetOf = (index: number) => {
    let offset = index * rowHeight;
    for (const extent of extents) {
      if (extent.index >= index) break;
      offset += extent.extra;
    }
    return offset;
  };
  /** Rows starting before `y` (or at it, `inclusive`). */
  const rowsStartingBefore = (y: number, inclusive: boolean) => {
    const uniform = (base: number) =>
      inclusive ? Math.floor((y - base) / rowHeight) + 1 : Math.ceil((y - base) / rowHeight);
    let base = 0;
    for (const extent of extents) {
      const start = extent.index * rowHeight + base;
      if (inclusive ? y < start : y <= start) return Math.max(0, Math.min(count, uniform(base)));
      const end = start + rowHeight + extent.extra;
      if (inclusive ? y < end : y <= end) return Math.min(count, extent.index + 1);
      base += extent.extra;
    }
    return Math.max(0, Math.min(count, uniform(base)));
  };
  let extra = 0;
  for (const extent of extents) extra += extent.extra;
  return { offsetOf, rowsStartingBefore, total: count * rowHeight + extra };
}

export function useRowWindow(
  viewport: React.RefObject<HTMLElement | null>,
  rowHeight: number,
  count: number,
  active: boolean,
  resetKey: string,
  extents: readonly RowExtent[] = NO_EXTENTS
): ScmRowWindow {
  const [metrics, setMetrics] = useState({ top: 0, height: 0, width: 0 });
  /** The viewport NODE is tracked as state, not read once from the ref: the
   *  dock swaps its whole body (InitialSurface → list, tab switches, remounts)
   *  without `active` or `count` changing, and a listener bound to the old
   *  node left the window frozen on stale metrics (user: 소스컨트롤 스크롤해도
   *  항목이 비어있는). Comparing after every commit re-binds on the new node. */
  const [node, setNode] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const next = active ? viewport.current : null;
    if (next !== node) setNode(next);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: count and rowHeight are triggers that re-measure the viewport when the list shape changes
  useLayoutEffect(() => {
    if (!node) return undefined;
    const measure = () => {
      const top = node.scrollTop;
      const height = node.clientHeight;
      const width = node.clientWidth;
      setMetrics((current) =>
        current.top === top && current.height === height && current.width === width ? current : { top, height, width }
      );
    };
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const Observer = typeof window.ResizeObserver === 'function' ? window.ResizeObserver : null;
    const observer = Observer ? new Observer(measure) : null;
    observer?.observe(node);
    return () => {
      node.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [node, count, rowHeight]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger that scrolls the window back to the top
  useLayoutEffect(() => {
    if (!node) return;
    node.scrollTop = 0;
    setMetrics((current) => (current.top === 0 ? current : { ...current, top: 0 }));
  }, [node, resetKey]);
  return useMemo(() => {
    const { top, height, width } = metrics;
    const { offsetOf, rowsStartingBefore, total } = rowWindowLayout(count, rowHeight, extents);
    const window_ = (start: number, end: number, measured: boolean) => ({
      start,
      end,
      leading: offsetOf(start),
      trailing: total - offsetOf(end),
      measured,
      top,
      height,
      width,
      offsetOf,
      total,
    });
    if (height <= 0) {
      // Viewport not measured yet (first commit, a box-less scroller): mount
      // only what the tallest plausible viewport could show at the offset.
      // Mounting EVERY row here and windowing on the next commit made a dock
      // with a few hundred changes pay a full list build — rows, path
      // measurement, layout — for one frame that the real window immediately
      // threw away (user: 소스 제어 누르면 히칭).
      const viewportGuess = typeof window === 'undefined' ? 800 : window.innerHeight;
      const start = Math.max(0, rowsStartingBefore(top, true) - 1 - SCM_ROW_OVERSCAN);
      const end = Math.min(count, Math.max(start, rowsStartingBefore(top + viewportGuess, false) + SCM_ROW_OVERSCAN));
      return window_(start, end, false);
    }
    if (total <= height) return window_(0, count, true);
    const start = Math.max(0, rowsStartingBefore(top, true) - 1 - SCM_ROW_OVERSCAN);
    const end = Math.min(count, Math.max(start, rowsStartingBefore(top + height, false) + SCM_ROW_OVERSCAN));
    return window_(start, end, true);
  }, [count, metrics, rowHeight, extents]);
}

export function RowSpacer({ height, edge }: { height: number; edge: 'leading' | 'trailing' }) {
  return <div className="dock-scm-row-spacer" data-scm-spacer={edge} aria-hidden="true" style={{ height }} />;
}

/** A window's rows in order — its range plus any pinned rows outside it — with
 *  spacers standing in for every row between them, at the layout's heights. */
export function windowedRows(
  rowWindow: Pick<ScmRowWindow, 'start' | 'end' | 'offsetOf' | 'total'>,
  count: number,
  pinned: readonly number[],
  render: (index: number) => React.ReactNode
): React.ReactNode[] {
  const mounted: number[] = [];
  for (let index = rowWindow.start; index < rowWindow.end; index += 1) mounted.push(index);
  for (const index of pinned) {
    if (index >= 0 && index < count && !(index >= rowWindow.start && index < rowWindow.end) && !mounted.includes(index))
      mounted.push(index);
  }
  mounted.sort((left, right) => left - right);
  const nodes: React.ReactNode[] = [];
  let next = 0;
  for (const index of mounted) {
    if (index > next) {
      const height = rowWindow.offsetOf(index) - rowWindow.offsetOf(next);
      nodes.push(<RowSpacer key={`gap:${next}`} edge="leading" height={height} />);
    }
    nodes.push(render(index));
    next = index + 1;
  }
  if (next < count) {
    nodes.push(<RowSpacer key="gap:end" edge="trailing" height={rowWindow.total - rowWindow.offsetOf(next)} />);
  }
  return nodes;
}
