// Explorer tree shape: the lazily listed directory map behind the Files pane,
// its project-relative path grammar, and every pure transition that loading,
// refresh and auto-reveal apply to that map. No React and no IPC here, so
// explorer-tree-model.test.mjs pins the ordering rules directly.
import type { DesktopDirEntry } from '../shared/contract';
import { sortExplorerEntries } from './explorer-logic';

/** One directory level. `entries` stays undefined until it has been listed. */
export interface ExplorerDirState {
  entries?: DesktopDirEntry[];
  expanded: boolean;
  error?: string;
}

/** The tree: directory rel path ("" is the project root) → its listed level. */
export type ExplorerDirs = ReadonlyMap<string, ExplorerDirState>;

export interface ExplorerDirListing {
  rel: string;
  entries: DesktopDirEntry[];
}

/** One flattened visible row: the shared coordinate space for keyboard
 *  navigation, shift ranges, type-ahead and indent guides. */
export interface ExplorerRow {
  rel: string;
  name: string;
  dir: boolean;
  level: number;
  parentRel: string;
  expanded: boolean;
  error?: string;
}

/** Parent directory of a rel path; the project root answers "". */
export function explorerParentRel(rel: string): string {
  return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
}

/** Child rel path; the root parent contributes no leading separator. */
export function explorerChildRel(parentRel: string, name: string): string {
  return parentRel ? `${parentRel}/${name}` : name;
}

/** Absolute path of a rel entry (Copy path / Shift+Alt+C). */
export function explorerAbsolutePath(projectPath: string, rel: string): string {
  return `${projectPath.replace(/[\\/]+$/, '')}/${rel}`;
}

/** Merge a partial state into one directory; unseen directories start collapsed. */
export function patchExplorerDir(dirs: ExplorerDirs, rel: string, next: Partial<ExplorerDirState>): ExplorerDirs {
  const map = new Map(dirs);
  map.set(rel, { expanded: false, ...map.get(rel), ...next });
  return map;
}

/** Refresh apply: fresh listings replace the directories the tree still knows.
 *  A directory that disappeared while the listings were in flight is skipped
 *  instead of being resurrected without its expansion state. */
export function withExplorerDirEntries(dirs: ExplorerDirs, listings: readonly ExplorerDirListing[]): ExplorerDirs {
  const next = new Map(dirs);
  for (const listing of listings) {
    const existing = next.get(listing.rel);
    if (existing) next.set(listing.rel, { ...existing, entries: listing.entries });
  }
  return next;
}

/** Watcher apply: only a directory that was already listed and whose contents
 *  really changed repaints, so a quiet poll never re-renders the tree. */
export function withChangedExplorerDirEntries(
  dirs: ExplorerDirs,
  rel: string,
  entries: DesktopDirEntry[]
): ExplorerDirs {
  const existing = dirs.get(rel);
  if (!existing?.entries || JSON.stringify(existing.entries) === JSON.stringify(entries)) return dirs;
  return withExplorerDirEntries(dirs, [{ rel, entries }]);
}

/** Directories a full refresh re-lists: the root plus everything expanded. */
export function explorerRefreshTargets(dirs: ExplorerDirs): string[] {
  return [...dirs.entries()].filter(([rel, state]) => rel === '' || state.expanded).map(([rel]) => rel);
}

/** Collapse All enablement: some non-root directory is currently expanded. */
export function explorerHasExpandedDirs(dirs: ExplorerDirs): boolean {
  return [...dirs.entries()].some(([rel, state]) => rel !== '' && state.expanded);
}

/** Collapse All: every non-root directory folds. An already folded tree keeps
 *  its identity so the pane skips the re-render. */
export function collapseExplorerDirs(dirs: ExplorerDirs): ExplorerDirs {
  let changedAny = false;
  const next = new Map(dirs);
  for (const [rel, state] of next) {
    if (rel === '' || !state.expanded) continue;
    next.set(rel, { ...state, expanded: false });
    changedAny = true;
  }
  return changedAny ? next : dirs;
}

/** Flattened visible rows, depth-first, directories first per level. A failed
 *  directory contributes one error row in place of its children. */
export function explorerVisibleRows(dirs: ExplorerDirs): ExplorerRow[] {
  const out: ExplorerRow[] = [];
  const walk = (rel: string, level: number): void => {
    const state = dirs.get(rel);
    if (!state?.expanded) return;
    if (state.error) {
      out.push({
        rel: `${rel}\u0000error`,
        name: state.error,
        dir: false,
        level,
        parentRel: rel,
        expanded: false,
        error: state.error,
      });
      return;
    }
    if (!state.entries) return;
    for (const entry of sortExplorerEntries(state.entries)) {
      const childRel = explorerChildRel(rel, entry.name);
      const expanded = entry.dir && dirs.get(childRel)?.expanded === true;
      out.push({ rel: childRel, name: entry.name, dir: entry.dir, level, parentRel: rel, expanded });
      if (entry.dir && expanded) walk(childRel, level + 1);
    }
  };
  walk('', 0);
  return out;
}

/** One step of the auto-reveal walk toward `rel`:
 *  - `load`/`expand`: the ancestor that has to be listed or opened next; each
 *    step re-runs the walk once the tree state lands.
 *  - `pending`: an ancestor listing is already in flight, so nothing to do.
 *  - `blocked`: an ancestor failed to list, so the reveal is abandoned.
 *  - `ready`: every ancestor is open and the row itself can be revealed. */
export type ExplorerRevealStep = { kind: 'load' | 'expand'; rel: string } | { kind: 'pending' | 'blocked' | 'ready' };

export function explorerRevealStep(dirs: ExplorerDirs, rel: string): ExplorerRevealStep {
  const segments = rel.split('/');
  let cursor = '';
  for (let index = 0; index < segments.length - 1; index += 1) {
    cursor = explorerChildRel(cursor, segments[index]);
    const state = dirs.get(cursor);
    if (!state?.entries) return state?.expanded ? { kind: 'pending' } : { kind: 'load', rel: cursor };
    if (state.error) return { kind: 'blocked' };
    if (!state.expanded) return { kind: 'expand', rel: cursor };
  }
  return { kind: 'ready' };
}
