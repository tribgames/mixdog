// Per-pane dock state: the dock map, its persistence and the commands that open, close and reorder what a pane dock holds.
// pane id across restarts.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  PANE_SIDE_DOCK_KEY,
  SESSION_RAIL_KEY,
  PANE_DOCK_BROWSER_SURFACE,
  PANE_DOCK_TERMINAL_SURFACE,
  LEGACY_SIDE_SURFACE_KEYS,
  CLOSED_ENTRY,
  firstPanelRoot,
  storablePaneSideDocks,
  normalizePaneSideDocks,
  samePaneSideDocks,
  sameParked,
  paneDockRestored,
  withParkedOpen,
  paneLocalSurface,
  paneDockForeign,
  reconcilePaneDockOwners,
  ownedBy,
  withPaneDockFileOpened,
  withPaneDockFileActivated,
  withPaneDockFileKept,
  withPaneDockFileClosed,
  withPaneDockFolderOpened,
  withPaneDockFolderClosed,
  withPaneDockDiffOpened,
  withPaneDockDiffClosed,
  type PaneSideDiffRequest,
  type PaneSideDockEntry,
} from './pane-side-dock-model';

import type { WorkbenchSideViewGroup, WorkbenchSideViewId } from './workbench-side-view-layout';
import { getSidePanelMode, sidePanelLayout, subscribeSidePanelMode } from './side-panel-preferences';
import { getLinkPreview, subscribeLinkPreview } from './link-preview-preference';
import { sameSideFiles, sideFileTabDirtyKey } from './side-file-tabs';

function readStoredPaneSideDocks(): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(PANE_SIDE_DOCK_KEY) || 'null');
  } catch {
    return null;
  }
}

function modeDefaultOpen(): boolean {
  return sidePanelLayout(getSidePanelMode()).dockOpen;
}

/** Opening keeps whatever child the dock already had and falls back to the
 *  first panel root; a dock with no child at all stays closed. */
function openedPaneDockEntry(entry: PaneSideDockEntry, firstRoot: WorkbenchSideViewId | null): PaneSideDockEntry {
  const view = entry.view ?? firstRoot;
  return { ...entry, open: view !== null || entry.surface !== '', view };
}

/** The dock map follows the live pane list and the current right-side layout:
 *  splits, closes, and view moves re-shape it declaratively, and the
 *  side-panel mode policy owns the open/folded half of its contract. */
function usePaneSideDockShape({
  leafKey,
  groupsKey,
  sessionsKey,
  leafIdsRef,
  groupsRef,
  paneSessionsRef,
  isDirty,
  ownerOf,
  setDocks,
}: {
  leafKey: string;
  groupsKey: string;
  /** Changes with the session ids of each pane's tabs and the one it shows. */
  sessionsKey: string;
  leafIdsRef: { current: readonly string[] };
  groupsRef: { current: readonly WorkbenchSideViewGroup[] };
  paneSessionsRef: { current: Readonly<Record<string, readonly string[]>> | undefined };
  isDirty: (leafId: string, fileKey: string) => boolean;
  ownerOf: PaneDockOwnerOf;
  setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>;
}): void {
  // Splits, closes, and view moves re-shape the map declaratively: entries
  // follow the live pane list and the CURRENT right-side layout, so a view
  // dragged to the left sidebar can never linger as a pane's active view.
  // Owned entries follow their session's tab first, so a pane that closes
  // while its session moves hands the owned state over before it drops; an
  // owner shown again then takes its parked front back.
  const followOwners = (current: Record<string, PaneSideDockEntry>) => {
    const paneSessions = paneSessionsRef.current;
    const owned = paneSessions ? reconcilePaneDockOwners(current, paneSessions, isDirty) : current;
    let restored = owned;
    for (const [leafId, entry] of Object.entries(owned)) {
      const back = paneDockRestored(entry, ownerOf(leafId));
      if (back !== entry) restored = { ...restored, [leafId]: back };
    }
    return restored;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: leafKey/groupsKey are the change triggers for the ref-held leaf ids and groups
  useEffect(() => {
    setDocks((current) => {
      const next = normalizePaneSideDocks(
        followOwners(current),
        leafIdsRef.current,
        groupsRef.current,
        modeDefaultOpen(),
        true
      );
      return samePaneSideDocks(current, next) ? current : next;
    });
  }, [leafKey, groupsKey]);
  // A tab switch or a tab moving between live panes only re-homes owned
  // state: the live entries are not re-read as if from storage (that drops
  // file tabs opened with a file-scoped access token, which never survive a
  // restart but must survive a tab switch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionsKey is the change trigger for the ref-held pane sessions and shown sessions
  useEffect(() => {
    setDocks(followOwners);
  }, [sessionsKey]);
  // The side-panel mode policy still owns the dock half of its contract:
  // switching to open-both expands every pane dock, close-* folds them.
  useEffect(
    () =>
      subscribeSidePanelMode(() => {
        const open = modeDefaultOpen();
        setDocks((current) => {
          const next: Record<string, PaneSideDockEntry> = {};
          for (const [leafId, entry] of Object.entries(current)) {
            next[leafId] = {
              ...entry,
              open: open && (entry.view !== null || entry.surface !== ''),
            };
          }
          return samePaneSideDocks(current, next) ? current : next;
        });
      }),
    [setDocks]
  );
}

function usePaneSideDockStorage(docks: Record<string, PaneSideDockEntry>): void {
  // The retired beside-the-panel surface store is merged into this dock.
  useEffect(() => {
    for (const key of LEGACY_SIDE_SURFACE_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* cosmetic */
      }
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(PANE_SIDE_DOCK_KEY, JSON.stringify(storablePaneSideDocks(docks)));
    } catch {
      // Dock state remains active for this renderer session.
    }
  }, [docks]);
}

/** The single writer for a pane's dock entry: it applies the caller's update
 *  and keeps the previous entry object when nothing actually changed. */
function usePaneSideDockPatch({
  groupsRef,
  setDocks,
}: {
  groupsRef: { current: readonly WorkbenchSideViewGroup[] };
  setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: groupsRef is a ref read at call time; setDocks is a useState setter owned by usePaneSideDocks
  return useCallback(
    (
      leafId: string,
      updater: (entry: PaneSideDockEntry, firstRoot: WorkbenchSideViewId | null) => PaneSideDockEntry
    ) => {
      setDocks((current) => {
        const firstRoot = firstPanelRoot(groupsRef.current);
        const entry = current[leafId] ?? { ...CLOSED_ENTRY, view: firstRoot };
        const next = updater(entry, firstRoot);
        const same =
          next.open === entry.open &&
          next.view === entry.view &&
          next.surface === entry.surface &&
          next.diff === entry.diff &&
          sameSideFiles(next.files, entry.files) &&
          (next.activeFile ?? null) === (entry.activeFile ?? null) &&
          (next.folder ?? null) === (entry.folder ?? null) &&
          (next.owner ?? '') === (entry.owner ?? '') &&
          sameParked(next.parked, entry.parked);
        return same && current[leafId] ? current : { ...current, [leafId]: next };
      });
    },
    []
  );
}

type PaneSideDockPatch = ReturnType<typeof usePaneSideDockPatch>;

/** A diff or file target from a project tool or transcript link: a trimmed
 *  project and a forward-slash, project-relative path. */
function cleanDockTarget(project: string, rel: string): { project: string; rel: string } {
  return {
    project: String(project || '').trim(),
    rel: String(rel || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, ''),
  };
}

/** Header-tab, open, and fold commands for the unit as a whole. */
function usePaneDockViewCommands(patch: PaneSideDockPatch, ownerOf: PaneDockOwnerOf) {
  /** Header-tab click contract: a panel view lands in the body, the browser lands as its stacked
   *  surface; folding stays with the dock's own toggle/close controls.
   *  One rule for every caller (header buttons, reveals, dock-tab events):
   *  while another session's file tabs, Files tree or diff are in front, a
   *  tab that does not own them opens what it picked, and the owner's front
   *  (which child, open or folded) is parked in `parked`. The file tabs,
   *  Files tree and diff themselves stay in the entry, mounted (unsaved
   *  edits intact); the owner gets its front back when it is shown again
   *  (paneDockRestored). The owner's own pick drops a parked front. */
  const select = useCallback(
    (leafId: string, id: WorkbenchSideViewId) => {
      const owner = ownerOf(leafId);
      patch(leafId, (entry) => {
        const { parked: previous, ...base } = entry;
        const picked =
          id === PANE_DOCK_BROWSER_SURFACE || id === PANE_DOCK_TERMINAL_SURFACE
            ? { ...base, open: true, surface: id }
            : { ...base, open: true, view: id, surface: '' };
        // The owner's front: parked now, or kept parked across another non-owner pick.
        let parked: PaneSideDockEntry['parked'];
        if (paneDockForeign(entry, owner)) parked = { open: entry.open, surface: entry.surface };
        else if (entry.owner && entry.owner !== owner && previous && paneLocalSurface(previous.surface))
          parked = previous;
        return parked ? { ...picked, parked } : picked;
      });
    },
    [patch, ownerOf]
  );
  /** Ensure the dock is open, optionally landing on a specific child. */
  const open = useCallback(
    (leafId: string, id?: WorkbenchSideViewId) => {
      if (id) {
        select(leafId, id);
        return;
      }
      const owner = ownerOf(leafId);
      patch(leafId, (entry, firstRoot) =>
        paneDockForeign(entry, owner) ? withParkedOpen(entry, true, firstRoot) : openedPaneDockEntry(entry, firstRoot)
      );
    },
    [patch, select, ownerOf]
  );
  const setOpen = useCallback(
    (leafId: string, nextOpen: boolean) => {
      const owner = ownerOf(leafId);
      patch(leafId, (entry, firstRoot) => {
        if (paneDockForeign(entry, owner)) return withParkedOpen(entry, nextOpen, firstRoot);
        return nextOpen ? openedPaneDockEntry(entry, firstRoot) : { ...entry, open: false };
      });
    },
    [patch, ownerOf]
  );
  /** Fold/unfold the WHOLE unit — header, panel view, browser,
   *  and diff surfaces together. Children survive the fold. */
  const toggle = useCallback(
    (leafId: string) => {
      const owner = ownerOf(leafId);
      patch(leafId, (entry, firstRoot) => {
        if (paneDockForeign(entry, owner)) return withParkedOpen(entry, !entry.parked?.open, firstRoot);
        return entry.open ? { ...entry, open: false } : openedPaneDockEntry(entry, firstRoot);
      });
    },
    [patch, ownerOf]
  );
  return { select, open, setOpen, toggle };
}

/** The session a pane shows right now ('' for none): it owns what opens in its dock. */
type PaneDockOwnerOf = (leafId: string) => string;

/** Opens and closes the unit's single file diff. */
function usePaneDockDiffCommands(patch: PaneSideDockPatch, ownerOf: PaneDockOwnerOf) {
  const openDiff = useCallback(
    (leafId: string, project: string, rel: string, request: PaneSideDiffRequest) => {
      const { project: cleanProject, rel: cleanRel } = cleanDockTarget(project, rel);
      if (!cleanProject || !cleanRel) return;
      const owner = ownerOf(leafId);
      patch(leafId, (entry) =>
        ownedBy(
          withPaneDockDiffOpened(entry, {
            kind: 'diff',
            project: cleanProject,
            rel: cleanRel,
            ...request,
          }),
          owner
        )
      );
    },
    [patch, ownerOf]
  );
  const closeDiff = useCallback(
    (leafId: string) => {
      patch(leafId, (entry) => withPaneDockDiffClosed(entry));
    },
    [patch]
  );
  return { openDiff, closeDiff };
}

/** The side file tabs: open, close, activate, and keep. */
function usePaneDockFileCommands(
  patch: PaneSideDockPatch,
  /** Dirty keys of the open file tabs; dirty tabs are never evicted. */
  dirtyKeysRef: { current: ReadonlySet<string> },
  ownerOf: PaneDockOwnerOf
) {
  const openFile = useCallback(
    (
      leafId: string,
      project: string,
      rel: string,
      line?: number,
      accessToken?: string,
      column?: number,
      request?: { preview?: boolean; from?: string; sidePreview?: boolean }
    ) => {
      const { project: cleanProject, rel: cleanRel } = cleanDockTarget(project, rel);
      if (!cleanProject || !cleanRel) return;
      const nonce = Date.now();
      const owner = ownerOf(leafId);
      patch(leafId, (entry) =>
        ownedBy(
          withPaneDockFileOpened(
            entry,
            {
              project: cleanProject,
              rel: cleanRel,
              ...(line ? { line } : {}),
              ...(line && column ? { column } : {}),
              ...(accessToken ? { accessToken } : {}),
            },
            nonce,
            {
              preview: request?.preview,
              from: request?.from,
              sidePreview: request?.sidePreview,
              now: nonce,
              isDirty: (fileKey) => dirtyKeysRef.current.has(sideFileTabDirtyKey(leafId, fileKey)),
            }
          ),
          owner
        )
      );
    },
    [patch, dirtyKeysRef, ownerOf]
  );
  const closeFile = useCallback(
    (leafId: string, fileKey?: string) => {
      patch(leafId, (entry) => withPaneDockFileClosed(entry, fileKey));
    },
    [patch]
  );
  const activateFile = useCallback(
    (leafId: string, fileKey: string) => {
      const owner = ownerOf(leafId);
      patch(leafId, (entry) => {
        const activated = withPaneDockFileActivated(entry, fileKey);
        return activated === entry ? entry : ownedBy(activated, owner);
      });
    },
    [patch, ownerOf]
  );
  const keepFile = useCallback(
    (leafId: string, fileKey: string) => {
      patch(leafId, (entry) => withPaneDockFileKept(entry, fileKey));
    },
    [patch]
  );
  return { openFile, closeFile, activateFile, keepFile };
}

/** The Files tree a transcript folder link opens. */
function usePaneDockFolderCommands(patch: PaneSideDockPatch, ownerOf: PaneDockOwnerOf) {
  const openFolder = useCallback(
    (leafId: string, project: string, rel: string) => {
      const cleanProject = String(project || '').trim();
      const trimmedRel = String(rel || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
      const cleanRel = trimmedRel === '.' ? '' : trimmedRel;
      if (!cleanProject) return;
      const nonce = Date.now();
      const owner = ownerOf(leafId);
      patch(leafId, (entry) =>
        ownedBy(withPaneDockFolderOpened(entry, { project: cleanProject, rel: cleanRel }, nonce), owner)
      );
    },
    [patch, ownerOf]
  );
  const closeFolder = useCallback(
    (leafId: string) => {
      patch(leafId, (entry) => withPaneDockFolderClosed(entry));
    },
    [patch]
  );
  return { openFolder, closeFolder };
}

/** Every command a dock header, tab, or project tool can issue. */
function usePaneSideDockCommands({
  groupsRef,
  dirtyKeysRef,
  ownerOf,
  setDocks,
}: {
  groupsRef: { current: readonly WorkbenchSideViewGroup[] };
  /** Dirty keys of the open file tabs; dirty tabs are never evicted. */
  dirtyKeysRef: { current: ReadonlySet<string> };
  ownerOf: PaneDockOwnerOf;
  setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>;
}) {
  const patch = usePaneSideDockPatch({ groupsRef, setDocks });
  return {
    ...usePaneDockViewCommands(patch, ownerOf),
    ...usePaneDockDiffCommands(patch, ownerOf),
    ...usePaneDockFileCommands(patch, dirtyKeysRef, ownerOf),
    ...usePaneDockFolderCommands(patch, ownerOf),
  };
}

/** Link preview turned off: a preview tab becomes a normal tab. */
function useLinkPreviewKeep(setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>): void {
  useEffect(() => {
    const apply = () => {
      if (getLinkPreview()) return;
      setDocks((current) => {
        let changed = false;
        const next: Record<string, PaneSideDockEntry> = {};
        for (const [leafId, entry] of Object.entries(current)) {
          const kept = withPaneDockFileKept(entry);
          if (kept !== entry) changed = true;
          next[leafId] = kept;
        }
        return changed ? next : current;
      });
    };
    apply();
    return subscribeLinkPreview(apply);
  }, [setDocks]);
}

function readStoredSessionRails(leafIds: readonly string[]): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(SESSION_RAIL_KEY) || '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id) => leafIds.includes(id)) : []);
  } catch {
    return new Set();
  }
}

/** Which panes have their session panel on: a pane's own switch, kept apart
 *  from its dock (opening, switching or closing a dock view leaves it). */
function usePaneSessionRails(leafIds: readonly string[], leafKey: string) {
  const [rails, setRails] = useState(() => readStoredSessionRails(leafIds));
  const leafIdsRef = useRef(leafIds);
  leafIdsRef.current = leafIds;
  // biome-ignore lint/correctness/useExhaustiveDependencies: leafKey is the change trigger for the ref-held leaf ids
  useEffect(() => {
    setRails((current) => {
      const live = [...current].filter((id) => leafIdsRef.current.includes(id));
      return live.length === current.size ? current : new Set(live);
    });
  }, [leafKey]);
  // What storage holds: the set read at mount is not written back.
  const storedRef = useRef(rails);
  useEffect(() => {
    if (storedRef.current === rails) return;
    storedRef.current = rails;
    try {
      window.localStorage.setItem(SESSION_RAIL_KEY, JSON.stringify([...rails]));
    } catch {
      // The switch holds for this renderer session.
    }
  }, [rails]);
  const railOpen = useCallback((leafId: string) => rails.has(leafId), [rails]);
  const setRailOpen = useCallback((leafId: string, open: boolean) => {
    setRails((current) => {
      if (current.has(leafId) === open) return current;
      const next = new Set(current);
      if (open) next.add(leafId);
      else next.delete(leafId);
      return next;
    });
  }, []);
  const toggleRail = useCallback(
    (leafId: string) => setRails((current) => {
      const next = new Set(current);
      if (!next.delete(leafId)) next.add(leafId);
      return next;
    }),
    []
  );
  return { railOpen, setRailOpen, toggleRail };
}

export function usePaneSideDocks({
  leafIds,
  groups,
  sessionOf,
  paneSessions,
}: {
  leafIds: readonly string[];
  groups: readonly WorkbenchSideViewGroup[];
  /** The session each pane shows ('' for none), read when something opens in its dock. */
  sessionOf?: (leafId: string) => string;
  /** The session ids of each pane's tabs: owned dock state follows them
   *  (reconcilePaneDockOwners). Absent: ownership is not reconciled. */
  paneSessions?: Readonly<Record<string, readonly string[]>>;
}) {
  const leafKey = leafIds.join('\0');
  const groupsKey = groups.map((group) => group.join(',')).join('|');
  const [docks, setDocks] = useState<Record<string, PaneSideDockEntry>>(() =>
    normalizePaneSideDocks(readStoredPaneSideDocks(), leafIds, groups, modeDefaultOpen())
  );
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const leafIdsRef = useRef(leafIds);
  leafIdsRef.current = leafIds;
  const paneSessionsRef = useRef(paneSessions);
  paneSessionsRef.current = paneSessions;
  const sessionsKey = paneSessions
    ? Object.entries(paneSessions)
        .map(([leafId, ids]) => `${leafId}:${ids.join(',')}`)
        .join('|')
    : '';
  const dirtyKeysRef = useRef<ReadonlySet<string>>(new Set());
  const isDirty = useCallback(
    (leafId: string, fileKey: string) => dirtyKeysRef.current.has(sideFileTabDirtyKey(leafId, fileKey)),
    []
  );
  const sessionOfRef = useRef(sessionOf);
  sessionOfRef.current = sessionOf;
  const ownerOf = useCallback((leafId: string) => sessionOfRef.current?.(leafId) ?? '', []);
  // What each pane shows: an owner shown again gets its parked front back.
  const shownKey = sessionOf ? leafIds.map((leafId) => `${leafId}:${sessionOf(leafId)}`).join('|') : '';
  usePaneSideDockShape({
    leafKey,
    groupsKey,
    sessionsKey: `${sessionsKey}\n${shownKey}`,
    leafIdsRef,
    groupsRef,
    paneSessionsRef,
    isDirty,
    ownerOf,
    setDocks,
  });
  usePaneSideDockStorage(docks);
  useLinkPreviewKeep(setDocks);
  const { railOpen, setRailOpen, toggleRail } = usePaneSessionRails(leafIds, leafKey);
  const entryFor = useCallback((leafId: string): PaneSideDockEntry => docks[leafId] ?? CLOSED_ENTRY, [docks]);
  const {
    select,
    open,
    setOpen,
    toggle,
    openDiff,
    closeDiff,
    openFile,
    closeFile,
    activateFile,
    keepFile,
    openFolder,
    closeFolder,
  } = usePaneSideDockCommands({
    groupsRef,
    dirtyKeysRef,
    ownerOf,
    setDocks,
  });
  return {
    docks,
    dirtyKeysRef,
    entryFor,
    select,
    open,
    setOpen,
    toggle,
    openDiff,
    closeDiff,
    openFile,
    closeFile,
    activateFile,
    keepFile,
    openFolder,
    closeFolder,
    railOpen,
    setRailOpen,
    toggleRail,
  };
}
