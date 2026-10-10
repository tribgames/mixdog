import { useLayoutEffect, useRef, useState } from 'react';
import type { NavigationSelection, WorkspaceSelection } from './nav-types';
import { paneActiveSelection, type PaneLeaf } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
import { navigationKey } from './text-format';

type ConversationOwner = {
  key: string;
  leafId: string;
  selectionKey: string;
};

export type ConversationSurface = {
  leaf: PaneLeaf;
  selectionKey: string;
  active: Extract<NavigationSelection, { kind: 'session' | 'new' }>;
  handoff: boolean;
  parked: boolean;
};

export type PaneSurfaceSnapshot = {
  key: string;
  leaf: PaneLeaf;
};

function paneSurfaceKey(leaf: PaneLeaf): string {
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

function usesPersistentUtilityPortal(selection: WorkspaceSelection | null): boolean {
  return (
    selection?.kind === 'studio' ||
    selection?.kind === 'terminal' ||
    selection?.kind === 'browser' ||
    selection?.kind === 'diff' ||
    selection?.kind === 'pull-request'
  );
}

function retainSurfaceForOneFrame(previousLeaf: PaneLeaf, currentLeaf: PaneLeaf): boolean {
  const previous = paneActiveSelection(previousLeaf);
  // Only an open tab may bridge a switch. A closed tab must leave in this commit.
  if (!previous || !currentLeaf.tabs.some((tab) => navigationKey(tab) === navigationKey(previous))) return false;
  // A utility destination needs its physical portal slot in the same commit.
  // Holding the outgoing layer suppresses that slot; a missed retirement frame
  // then leaves a newly opened Studio mounted nowhere and the pane stays blank.
  if (usesPersistentUtilityPortal(paneActiveSelection(currentLeaf))) return false;
  return isConversationSelection(previous) || parksConversationBehindSelection(previous);
}

/**
 * Tracks each leaf's previous surface so an outgoing selection can paint for
 * exactly one more frame (inert, above the incoming conversation).
 */
export function usePaneSurfaceHandoffs(leaves: readonly PaneLeaf[]) {
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
  const paneSurfaceHandoffKey = [...paneSurfaceHandoffs.current]
    .map(([leafId, surface]) => `${leafId}\0${surface.key}`)
    .join('\x01');
  useLayoutEffect(() => {
    if (!paneSurfaceHandoffKey) return undefined;
    const retiring = new Map(paneSurfaceHandoffs.current);
    const frame = window.requestAnimationFrame(() => {
      let changed = false;
      for (const [leafId, surface] of retiring) {
        if (paneSurfaceHandoffs.current.get(leafId)?.key !== surface.key) continue;
        paneSurfaceHandoffs.current.delete(leafId);
        changed = true;
      }
      if (changed) setSurfaceHandoffRevision((value) => value + 1);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [paneSurfaceHandoffKey]);
  return { currentPaneSurfaces, paneSurfaceHandoffs };
}

/**
 * Resolves the stable Conversation owner key per visible pane so a moved
 * active tab keeps its owner and ordinary tab switches never remount it.
 */
export function usePaneConversationOwners(
  workspace: Pick<ReturnType<typeof usePaneWorkspace>, 'leaves' | 'restorePending'>,
  paneSurfaceHandoffs: { current: Map<string, PaneSurfaceSnapshot> }
) {
  const conversationOwnerSequence = useRef(0);
  const conversationOwners = useRef<ConversationOwner[]>([]);
  const conversationSurfaceFor = (leaf: PaneLeaf, handoff: boolean): ConversationSurface[] => {
    const active = paneActiveSelection(leaf);
    return isConversationSelection(active)
      ? [{ leaf, active, selectionKey: navigationKey(active), handoff, parked: false }]
      : [];
  };
  const conversationLeaves: ConversationSurface[] = workspace.restorePending
    ? []
    : workspace.leaves
        .flatMap((leaf) => conversationSurfaceFor(leaf, false))
        .concat(
          [...paneSurfaceHandoffs.current.values()].flatMap((surface) => conversationSurfaceFor(surface.leaf, true))
        );
  const previousConversationOwners = conversationOwners.current;
  const representedConversationLeaves = new Set(conversationLeaves.map((entry) => entry.leaf.id));
  for (const owner of previousConversationOwners) {
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
    });
    representedConversationLeaves.add(leaf.id);
  }
  const ownerByLeaf = new Map<string, string>();
  const usedOwnerKeys = new Set<string>();
  for (const entry of conversationLeaves) {
    const movedOwner = previousConversationOwners.find(
      (owner) => owner.selectionKey === entry.selectionKey && !usedOwnerKeys.has(owner.key)
    );
    if (!movedOwner) continue;
    ownerByLeaf.set(entry.leaf.id, movedOwner.key);
    usedOwnerKeys.add(movedOwner.key);
  }
  for (const entry of conversationLeaves) {
    if (ownerByLeaf.has(entry.leaf.id)) continue;
    const paneOwner = previousConversationOwners.find(
      (owner) => owner.leafId === entry.leaf.id && !usedOwnerKeys.has(owner.key)
    );
    const ownerKey = paneOwner?.key ?? `pane-conversation-owner-${++conversationOwnerSequence.current}`;
    ownerByLeaf.set(entry.leaf.id, ownerKey);
    usedOwnerKeys.add(ownerKey);
  }
  conversationOwners.current = conversationLeaves.map((entry) => ({
    key: ownerByLeaf.get(entry.leaf.id)!,
    leafId: entry.leaf.id,
    selectionKey: entry.selectionKey,
  }));
  return { conversationLeaves, ownerByLeaf };
}
