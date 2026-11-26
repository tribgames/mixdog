import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createConversationReleaseGate, type ConversationReleaseGate } from './conversation-release';
import { registerIdleReclaim } from './idle-reclaim';
import type { NavigationSelection, WorkspaceSelection } from './nav-types';
import { paneActiveSelection, type PaneLeaf } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
import { navigationKey } from './text-format';

type ConversationOwner = {
  key: string;
  leafId: string;
  selectionKey: string;
  /** This owner has painted `selectionKey` while retained. */
  warm: boolean;
  retained: boolean;
};

export type ConversationSurface = {
  leaf: PaneLeaf;
  selectionKey: string;
  active: Extract<NavigationSelection, { kind: 'session' | 'new' }>;
  handoff: boolean;
  parked: boolean;
  /** A recently shown session kept mounted, unpainted, behind the active one. */
  retained: boolean;
  /** Its owner already painted this selection while retained: switching back
   *  is a visibility flip, so no close handoff may present another session in it. */
  warm: boolean;
  /** Stable Conversation owner key (the portal's React key). */
  owner: string;
  /** Laid out behind the conversation its pane still shows, until it says it can be shown (pane-presentation.ts). */
  preparing?: boolean;
  /** The conversation its pane still shows while the one it switched to prepares: painted, not interactive. */
  outgoing?: boolean;
  /** Counts the times this owner was put up to be presented. */
  visit?: number;
};

export type PaneSurfaceSnapshot = {
  key: string;
  leaf: PaneLeaf;
};

export function paneSurfaceKey(leaf: PaneLeaf): string {
  const active = paneActiveSelection(leaf);
  if (!active) return 'empty';
  if (isConversationSelection(active)) return 'conversation';
  return navigationKey(active);
}

export function isConversationSelection(
  selection: WorkspaceSelection | null | undefined
): selection is Extract<NavigationSelection, { kind: 'session' | 'new' }> {
  return selection?.kind === 'session' || selection?.kind === 'new';
}

/** Every selection that renders its own persistent surface behind the chat
 *  layer: the conversation stays mounted and parked underneath it. */
export function parksConversationBehindSelection(selection: WorkspaceSelection | null): boolean {
  return selection?.kind === 'file' || usesPersistentUtilityPortal(selection);
}

export function usesPersistentUtilityPortal(selection: WorkspaceSelection | null): boolean {
  return (
    selection?.kind === 'studio' ||
    selection?.kind === 'terminal' ||
    selection?.kind === 'browser' ||
    selection?.kind === 'diff' ||
    selection?.kind === 'pull-request'
  );
}

export function retainSurfaceForOneFrame(previousLeaf: PaneLeaf, currentLeaf: PaneLeaf): boolean {
  const previous = paneActiveSelection(previousLeaf);
  // Only an open tab may bridge a switch. A closed tab must leave in this commit.
  if (!previous || !currentLeaf.tabs.some((tab) => navigationKey(tab) === navigationKey(previous))) return false;
  // A utility destination needs its physical portal slot in the same commit.
  // Holding the outgoing layer suppresses that slot; a missed retirement frame
  // then leaves a newly opened Studio mounted nowhere and the pane stays blank.
  if (usesPersistentUtilityPortal(paneActiveSelection(currentLeaf))) return false;
  return isConversationSelection(previous) || parksConversationBehindSelection(previous);
}

type UtilityHandoffMap = ReadonlyMap<string, string>;

const workspaceUtilityHandoffs = new Map<symbol, Map<string, string>>();
const utilityHandoffListeners = new Set<() => void>();
let activeUtilityHandoffsSnapshot: UtilityHandoffMap = new Map();

function utilityHandoffMapsEqual(a: UtilityHandoffMap, b: UtilityHandoffMap): boolean {
  if (a.size !== b.size) return false;
  for (const [leafId, surfaceKey] of a) {
    if (b.get(leafId) !== surfaceKey) return false;
  }
  return true;
}

function rebuildUtilityHandoffs(): void {
  const next = new Map<string, string>();
  for (const entries of workspaceUtilityHandoffs.values()) {
    for (const [leafId, surfaceKey] of entries) next.set(leafId, surfaceKey);
  }
  if (utilityHandoffMapsEqual(activeUtilityHandoffsSnapshot, next)) return;
  activeUtilityHandoffsSnapshot = next;
  for (const listener of [...utilityHandoffListeners]) listener();
}

function setWorkspaceUtilityHandoffs(owner: symbol, entries: Map<string, string>): void {
  workspaceUtilityHandoffs.set(owner, entries);
  rebuildUtilityHandoffs();
}

function deleteWorkspaceUtilityHandoffs(owner: symbol): void {
  if (!workspaceUtilityHandoffs.delete(owner)) return;
  rebuildUtilityHandoffs();
}

export function subscribeUtilitySurfaceHandoffs(listener: () => void): () => void {
  utilityHandoffListeners.add(listener);
  return () => utilityHandoffListeners.delete(listener);
}

export function currentUtilitySurfaceHandoffs(): UtilityHandoffMap {
  return activeUtilityHandoffsSnapshot;
}

export function hasActivePaneHandoffWorkspace(): boolean {
  return workspaceUtilityHandoffs.size > 0;
}

/**
 * Tracks each leaf's previous surface so an outgoing selection can paint for
 * exactly one more frame (inert, above the incoming conversation).
 */
export function usePaneSurfaceHandoffs(leaves: readonly PaneLeaf[]) {
  const workspaceOwnerRef = useRef<symbol | null>(null);
  if (!workspaceOwnerRef.current) workspaceOwnerRef.current = Symbol('pane-surface-handoffs');
  const workspaceOwner = workspaceOwnerRef.current;
  const previousPaneSurfaces = useRef(new Map<string, PaneSurfaceSnapshot>());
  const paneSurfaceHandoffs = useRef(new Map<string, PaneSurfaceSnapshot>());
  const [, setSurfaceHandoffRevision] = useState(0);
  const currentPaneSurfaces = new Map<string, PaneSurfaceSnapshot>();
  const liveLeafIds = new Set(leaves.map((leaf) => leaf.id));
  for (const leaf of leaves) {
    const current = { key: paneSurfaceKey(leaf), leaf };
    const previous = previousPaneSurfaces.current.get(leaf.id);
    const handoff = paneSurfaceHandoffs.current.get(leaf.id);
    currentPaneSurfaces.set(leaf.id, current);
    if (previous && previous.key !== current.key && retainSurfaceForOneFrame(previous.leaf, current.leaf)) {
      paneSurfaceHandoffs.current.set(leaf.id, previous);
    } else if (handoff && (handoff.key === current.key || !retainSurfaceForOneFrame(handoff.leaf, current.leaf))) {
      paneSurfaceHandoffs.current.delete(leaf.id);
    }
  }
  for (const leafId of paneSurfaceHandoffs.current.keys()) {
    if (!liveLeafIds.has(leafId)) paneSurfaceHandoffs.current.delete(leafId);
  }
  previousPaneSurfaces.current = currentPaneSurfaces;
  const utilityHandoffs = new Map<string, string>();
  for (const [leafId, snapshot] of paneSurfaceHandoffs.current) {
    const current = currentPaneSurfaces.get(leafId);
    const active = paneActiveSelection(snapshot.leaf);
    if (current && snapshot.key !== current.key && active && usesPersistentUtilityPortal(active)) {
      utilityHandoffs.set(leafId, navigationKey(active));
    }
  }
  const utilityHandoffsKey = [...utilityHandoffs].map(([leafId, key]) => `${leafId}\0${key}`).join('\x01');
  // biome-ignore lint/correctness/useExhaustiveDependencies: utilityHandoffsKey is the content signature of utilityHandoffs
  useLayoutEffect(() => {
    setWorkspaceUtilityHandoffs(workspaceOwner, utilityHandoffs);
  }, [workspaceOwner, utilityHandoffsKey]);
  useLayoutEffect(() => () => deleteWorkspaceUtilityHandoffs(workspaceOwner), [workspaceOwner]);
  const retireHandoffs = () => setSurfaceHandoffRevision((value) => value + 1);
  return { currentPaneSurfaces, paneSurfaceHandoffs, retireHandoffs };
}

/** Retires each pane's outgoing surface handoff on the next animation frame once
 *  any preparing incoming conversation in that pane is ready to paint behind it. */
export function useRetirePaneSurfaceHandoffs(
  paneSurfaceHandoffs: { current: Map<string, PaneSurfaceSnapshot> },
  conversationLeaves: readonly ConversationSurface[],
  retireHandoffs: () => void
): void {
  const preparingLeafIds = new Set(conversationLeaves.filter((entry) => entry.preparing).map((entry) => entry.leaf.id));
  const retiringEntries = [...paneSurfaceHandoffs.current].filter(
    ([leafId, surface]) =>
      !(preparingLeafIds.has(leafId) && !isConversationSelection(paneActiveSelection(surface.leaf)))
  );
  const retiringKey = retiringEntries.map(([leafId, surface]) => `${leafId}\0${surface.key}`).join('\x01');
  // biome-ignore lint/correctness/useExhaustiveDependencies: retiringKey is the content signature of retiringEntries
  useLayoutEffect(() => {
    if (!retiringKey) return undefined;
    const retiring = new Map(retiringEntries);
    const frame = window.requestAnimationFrame(() => {
      let changed = false;
      for (const [leafId, surface] of retiring) {
        if (paneSurfaceHandoffs.current.get(leafId)?.key !== surface.key) continue;
        paneSurfaceHandoffs.current.delete(leafId);
        changed = true;
      }
      if (changed) retireHandoffs();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [retiringKey]);
}

/** A session tab shown in a pane, newest first in the recency list. */
type RecentSelection = { leafId: string; selectionKey: string };

function conversationSurfaceFor(leaf: PaneLeaf, handoff: boolean): ConversationSurface[] {
  const active = paneActiveSelection(leaf);
  return isConversationSelection(active)
    ? [
        {
          leaf,
          active,
          selectionKey: navigationKey(active),
          handoff,
          parked: false,
          retained: false,
          warm: false,
          owner: '',
        },
      ]
    : [];
}

function collectConversationLeaves(
  workspace: Pick<ReturnType<typeof usePaneWorkspace>, 'leaves' | 'restorePending'>,
  handoffs: Iterable<PaneSurfaceSnapshot>,
  previousOwners: readonly ConversationOwner[],
  recentSelections: readonly RecentSelection[],
  retainLimit: number
): { conversationLeaves: ConversationSurface[]; recent: RecentSelection[] | null } {
  let nextRecent: RecentSelection[] | null = null;
  const conversationLeaves: ConversationSurface[] = workspace.restorePending
    ? []
    : workspace.leaves
        .flatMap((leaf) => conversationSurfaceFor(leaf, false))
        .concat([...handoffs].flatMap((surface) => conversationSurfaceFor(surface.leaf, true)));
  const representedConversationLeaves = new Set(conversationLeaves.map((entry) => entry.leaf.id));
  for (const owner of previousOwners) {
    if (representedConversationLeaves.has(owner.leafId)) continue;
    const leaf = workspace.leaves.find(
      (candidate) =>
        !representedConversationLeaves.has(candidate.id) &&
        parksConversationBehindSelection(paneActiveSelection(candidate)) &&
        candidate.tabs.some((selection) => navigationKey(selection) === owner.selectionKey)
    );
    if (!leaf) continue;
    const selection = leaf.tabs.find((candidate) => navigationKey(candidate) === owner.selectionKey);
    if (!isConversationSelection(selection)) continue;
    conversationLeaves.push({
      leaf,
      active: selection,
      selectionKey: owner.selectionKey,
      handoff: false,
      parked: true,
      retained: false,
      warm: false,
      owner: '',
    });
    representedConversationLeaves.add(leaf.id);
  }
  if (retainLimit > 0 && !workspace.restorePending) {
    const recent: RecentSelection[] = conversationLeaves
      .filter((entry) => !entry.handoff)
      .map((entry) => ({ leafId: entry.leaf.id, selectionKey: entry.selectionKey }));
    const represented = new Set(conversationLeaves.map((entry) => entry.selectionKey));
    let budget = retainLimit;
    for (const { leafId, selectionKey } of recentSelections) {
      if (budget <= 0) break;
      if (represented.has(selectionKey)) continue;
      const leaf = workspace.leaves.find((candidate) => candidate.id === leafId);
      const selection = leaf?.tabs.find((tab) => navigationKey(tab) === selectionKey);
      if (!leaf || selection?.kind !== 'session') continue;
      budget -= 1;
      represented.add(selectionKey);
      recent.push({ leafId, selectionKey });
      conversationLeaves.push({
        leaf,
        active: selection,
        selectionKey,
        handoff: false,
        parked: false,
        retained: true,
        warm: true,
        owner: '',
      });
    }
    nextRecent = recent;
  }
  return { conversationLeaves, recent: nextRecent };
}

/** Gives every surface the owner key of the owner it moved from, else of its
 *  pane's previous owner, else a fresh one. */
function assignConversationOwners(
  conversationLeaves: ConversationSurface[],
  previousOwners: readonly ConversationOwner[],
  nextOwnerKey: () => string,
  /** The pane's previous owner may show the selection that took its place; absent: any may (no handoff between
   *  conversations: the owner switches sessions itself). */
  inherits?: (owner: string) => boolean
): void {
  const usedOwnerKeys = new Set<string>();
  // The owner that showed the selection in the same pane first: two panes on one session each keep their own (its
  // scroll offset and its reader's place are that pane's). Then one that moved with its tab from another pane.
  const sameOwner = (entry: ConversationSurface, samePane: boolean) =>
    previousOwners.find(
      (owner) =>
        owner.selectionKey === entry.selectionKey &&
        !usedOwnerKeys.has(owner.key) &&
        (!samePane || owner.leafId === entry.leaf.id)
    );
  const claims = new Map<ConversationSurface, ConversationOwner>();
  for (const samePane of [true, false]) {
    for (const entry of conversationLeaves) {
      if (claims.has(entry)) continue;
      const owner = sameOwner(entry, samePane);
      if (!owner) continue;
      claims.set(entry, owner);
      usedOwnerKeys.add(owner.key);
    }
  }
  usedOwnerKeys.clear();
  for (const entry of conversationLeaves) {
    const movedOwner = claims.get(entry);
    if (!movedOwner) continue;
    entry.owner = movedOwner.key;
    // An owner that has painted this selection while retained stays warm
    // for as long as it keeps the selection.
    entry.warm = entry.retained || movedOwner.retained || movedOwner.warm;
    usedOwnerKeys.add(movedOwner.key);
  }
  for (const entry of conversationLeaves) {
    if (entry.owner) continue;
    const paneOwner = previousOwners.find(
      (owner) => owner.leafId === entry.leaf.id && !usedOwnerKeys.has(owner.key) && (inherits?.(owner.key) ?? true)
    );
    entry.owner = paneOwner?.key ?? nextOwnerKey();
    usedOwnerKeys.add(entry.owner);
  }
}

/**
 * Resolves the stable Conversation owner key per visible pane so a moved
 * active tab keeps its owner and ordinary tab switches never remount it.
 *
 * `retainLimit` > 0 also keeps that many recently shown session tabs mounted
 * as their own retained owners, one budget across every pane: switching back
 * to one is a visibility flip instead of a full transcript render. A retained tab that is closed or
 * pushed out of the budget gives its owner back to the next session opened
 * in its pane.
 */
export function usePaneConversationOwners(
  workspace: Pick<ReturnType<typeof usePaneWorkspace>, 'leaves' | 'restorePending'>,
  paneSurfaceHandoffs: { current: Map<string, PaneSurfaceSnapshot> },
  retainLimit = 0,
  /** A pane keeps showing the conversation it showed until the one it switches to can be shown: every session has an
   *  owner of its own, and the pane hands over between two of them (pane-presentation.ts). */
  handsOver = false
) {
  /** The owner each pane presents, and the surface it was presented as. */
  const presented = useRef(new Map<string, { owner: string; surface: ConversationSurface }>());
  const visits = useRef(new Map<string, number>());
  const preparingOwners = useRef(new Set<string>());
  /** Owners whose draft sent its first prompt: the session that makes is theirs. */
  const keptOwners = useRef(new Set<string>());
  const shownLeaves = useRef<ConversationSurface[]>([]);
  const conversationOwnerSequence = useRef(0);
  const conversationOwners = useRef<ConversationOwner[]>([]);
  const recentSelections = useRef<RecentSelection[]>([]);
  const [, setReleases] = useState(0);
  const releaseGates = useRef(new Map<string, { gate: ConversationReleaseGate; stop: () => void }>());
  const pendingReleases = useRef(new Set<string>());
  const releaseFinished = useRef(() => {});
  releaseFinished.current = () => {
    if (pendingReleases.current.size === 0) return;
    const released = new Set<string>();
    for (const owner of conversationOwners.current) {
      if (!owner.retained || !pendingReleases.current.has(owner.selectionKey)) continue;
      if (releaseGates.current.get(owner.key)?.gate.mayRelease() === false) continue;
      released.add(owner.selectionKey);
      pendingReleases.current.delete(owner.selectionKey);
    }
    if (released.size === 0) return;
    recentSelections.current = recentSelections.current.filter((entry) => !released.has(entry.selectionKey));
    setReleases((count) => count + 1);
  };
  useEffect(
    () =>
      registerIdleReclaim(() => {
        for (const owner of conversationOwners.current) {
          if (owner.retained) pendingReleases.current.add(owner.selectionKey);
        }
        releaseFinished.current();
      }),
    []
  );
  useEffect(
    () => () => {
      for (const { stop } of releaseGates.current.values()) stop();
      releaseGates.current.clear();
    },
    []
  );
  /** The gate the conversation under `owner` answers through. */
  const releaseGateFor = (owner: string): ConversationReleaseGate => {
    let entry = releaseGates.current.get(owner);
    if (!entry) {
      const gate = createConversationReleaseGate();
      entry = { gate, stop: gate.subscribe(() => releaseFinished.current()) };
      releaseGates.current.set(owner, entry);
    }
    return entry.gate;
  };
  const { conversationLeaves, recent } = collectConversationLeaves(
    workspace,
    paneSurfaceHandoffs.current.values(),
    conversationOwners.current,
    recentSelections.current,
    retainLimit
  );
  if (recent) recentSelections.current = recent;
  assignConversationOwners(
    conversationLeaves,
    conversationOwners.current,
    () => `pane-conversation-owner-${++conversationOwnerSequence.current}`,
    handsOver ? (owner) => keptOwners.current.has(owner) : undefined
  );
  const preparingNow = new Set<string>();
  const activeConversationLeafIds = new Set(
    workspace.leaves.filter((leaf) => isConversationSelection(paneActiveSelection(leaf))).map((leaf) => leaf.id)
  );
  for (const leafId of [...presented.current.keys()]) {
    if (!activeConversationLeafIds.has(leafId)) presented.current.delete(leafId);
  }
  for (const entry of conversationLeaves.filter((candidate) => !candidate.retained && !candidate.handoff)) {
    // A parked conversation sits behind a non-conversation tab and must never
    // be recorded as presented or promoted back to visible for a later switch.
    if (entry.parked) continue;
    const surfaceHandoff = paneSurfaceHandoffs.current.get(entry.leaf.id);
    const hasNonConversationHandoff =
      surfaceHandoff !== undefined && !isConversationSelection(paneActiveSelection(surfaceHandoff.leaf));
    const shown = presented.current.get(entry.leaf.id);
    const mounted = shown !== undefined && conversationOwners.current.some((owner) => owner.key === shown.owner);
    // The owner the pane showed went with its tab to another pane and draws there: this pane has nothing to keep on
    // screen meanwhile.
    const moved =
      shown !== undefined &&
      conversationLeaves.some((candidate) => candidate.owner === shown.owner && candidate.leaf.id !== entry.leaf.id);
    const hasOutgoingConversation = shown !== undefined && mounted && !moved;
    if (!handsOver || shown?.owner === entry.owner || (!hasOutgoingConversation && !hasNonConversationHandoff)) {
      presented.current.set(entry.leaf.id, { owner: entry.owner, surface: entry });
      continue;
    }
    entry.preparing = true;
    preparingNow.add(entry.owner);
    if (!preparingOwners.current.has(entry.owner)) {
      visits.current.set(entry.owner, (visits.current.get(entry.owner) ?? 0) + 1);
    }
    // When an open file or utility surface covers the pane during handover,
    // keep any previously parked conversation retained instead of painting it underneath.
    if (hasNonConversationHandoff || !hasOutgoingConversation) continue;
    const outgoing = conversationLeaves.find((candidate) => candidate.owner === shown.owner);
    if (outgoing) {
      outgoing.retained = false;
      outgoing.outgoing = true;
    } else {
      // No longer a tab of its pane: it stays only until the pane hands over.
      conversationLeaves.push({
        ...shown.surface,
        owner: shown.owner,
        handoff: false,
        parked: false,
        retained: false,
        preparing: false,
        outgoing: true,
      });
    }
  }
  preparingOwners.current = preparingNow;
  for (const entry of conversationLeaves) entry.visit = visits.current.get(entry.owner) ?? 0;
  shownLeaves.current = conversationLeaves;
  conversationOwners.current = conversationLeaves.map((entry) => ({
    key: entry.owner,
    leafId: entry.leaf.id,
    selectionKey: entry.selectionKey,
    warm: entry.warm,
    retained: entry.retained,
  }));
  const retainedNow = new Set(conversationLeaves.filter((entry) => entry.retained).map((entry) => entry.selectionKey));
  for (const selectionKey of pendingReleases.current) {
    if (!retainedNow.has(selectionKey)) pendingReleases.current.delete(selectionKey);
  }
  const ownerKeys = new Set(conversationLeaves.map((entry) => entry.owner));
  for (const [owner, { stop }] of releaseGates.current) {
    if (ownerKeys.has(owner)) continue;
    stop();
    releaseGates.current.delete(owner);
  }
  for (const owner of [...visits.current.keys()]) if (!ownerKeys.has(owner)) visits.current.delete(owner);
  for (const owner of [...keptOwners.current]) if (!ownerKeys.has(owner)) keptOwners.current.delete(owner);
  /** The conversation under `owner` can be shown: its pane presents it. */
  const presentOwner = (owner: string): void => {
    const entry = shownLeaves.current.find((candidate) => candidate.owner === owner && candidate.preparing);
    if (!entry) return;
    presented.current.set(entry.leaf.id, { owner, surface: entry });
    setReleases((count) => count + 1);
  };
  const keepOwner = (owner: string): void => void keptOwners.current.add(owner);
  return { conversationLeaves, releaseGateFor, presentOwner, keepOwner };
}
