// The split-pane workspace surface. App mounts this once in place of the old
// single main pane: the FOCUSED leaf renders App's existing fully interactive
// surface (conversation / new-task / file editor) through renderActive, and
// every other session leaf streams live through PaneSessionView. Clicking a
// non-focused pane focuses it and asks App to navigate its interactive
// surface there, so today's single-focused-engine renderer keeps working
// while the lanes already deliver concurrent live output.

import type React from 'react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useScreenSessions, useVisibleSessions } from './use-visible-sessions';
import { DESKTOP_PET_SESSION_ID, DesktopPetPublisher, useDesktopPetSessionIds } from './desktop-pet-publisher';
import { t } from './i18n';
import { useMobileRemoteSurface } from './mobile-surface';
import { DownloadSessionContext } from './project-file-download';
import { PaneSplitLayout } from './PaneSplitLayout';
import {
  isConversationSelection,
  parksConversationBehindSelection,
  usePaneConversationOwners,
  usePaneSurfaceHandoffs,
} from './pane-surface-model';
import {
  usePaneDropPreview,
  usePaneFileDrop,
  usePaneSelectionFence,
  useSinglePaneMode,
} from './use-pane-workspace-interactions';
import { PersistentPanePortal, TranscriptSkeletonCover } from './PaneSurfaceGate';
import type { NavigationSelection, WorkspaceSelection } from './nav-types';
import { paneActiveSessionIds, paneActiveSelection, paneLeavesInVisualOrder, type PaneLeaf } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
import { defaultSessionLaneStore } from './session-lane-store';
import { browserTabTitle } from './text-format';
import type { DropPreview } from './pane-drop-intent';

export { resolvePaneDropIntent } from './pane-drop-intent';

function paneConversationSlotId(leafId: string): string {
  return `pane-conversation-slot-${leafId}`;
}

function selectionLabel(selection: WorkspaceSelection | null): string {
  if (!selection) return t('Empty pane');
  switch (selection.kind) {
    case 'new':
      return t('New task');
    case 'project':
      return selection.path;
    case 'session':
      return selection.id;
    case 'file':
      return selection.rel.split('/').at(-1) || selection.rel;
    case 'studio':
      return t('Studio');
    case 'terminal':
      return t('Terminal');
    case 'browser':
      return browserTabTitle(selection);
    case 'pull-request':
      return selection.title || t('Pull Request #{{number}}', { number: selection.number });
    case 'diff':
      return t('{{name}} (Diff)', { name: selection.rel.split('/').at(-1) || selection.rel });
  }
}

/** A phone renders exactly ONE leaf — the focused one — and pays the relay for
 *  every session it registers, so only that leaf's active session is mirrored
 *  (user: vps라 비용때문에). Every other leaf stays unregistered until it is
 *  focused. */
function mobileVisibleSessionIds(leaves: readonly PaneLeaf[], focusedLeafId: string): string[] {
  const leaf = leaves.find((entry) => entry.id === focusedLeafId) ?? leaves[0];
  const active = leaf ? paneActiveSelection(leaf) : null;
  return active?.kind === 'session' ? [active.id] : [];
}

/** Sessions a phone keeps mounted besides the shown one, so switching back
 *  to a recent session flips visibility instead of rendering its transcript
 *  again. Each costs one Conversation's DOM and row caches; the lanes stay
 *  unregistered with the host while retained. */
const MOBILE_RETAINED_CONVERSATIONS = 2;

/** A retained conversation is frozen: the app re-creates its props on every
 *  workspace render, and re-rendering an unpainted transcript is pure cost.
 *  Its own lane subscriptions still update it.
 *
 *  `deferMount`: a cold session on a phone paints its transcript skeleton in
 *  the opening frame and mounts the Conversation (rows, composer, dock) in the
 *  next one, so the tap answers at once. A session whose lane is already on
 *  the phone mounts at once: its rows paint in the opening commit instead of
 *  behind a skeleton frame. The gate follows the selection, not
 *  the owner: an owner handed from one session to a cold one closes it again,
 *  while a draft that became its session keeps its Conversation. */
const RetainedConversation = memo(
  function RetainedConversation({
    selectionKey,
    deferMount,
    children,
  }: {
    retained: boolean;
    selectionKey: string;
    deferMount: boolean;
    children: React.ReactNode;
  }) {
    const [gate, setGate] = useState({ selectionKey, deferred: deferMount, mounted: !deferMount });
    let current = gate;
    if (gate.selectionKey !== selectionKey && (deferMount || gate.deferred)) {
      current = { selectionKey, deferred: deferMount, mounted: !(deferMount && gate.deferred) };
      setGate(current);
    }
    const { mounted } = current;
    useEffect(() => {
      if (mounted) return undefined;
      const frame = window.requestAnimationFrame(() =>
        setGate((state) => (state.selectionKey === selectionKey ? { ...state, mounted: true } : state))
      );
      return () => window.cancelAnimationFrame(frame);
    }, [mounted, selectionKey]);
    return mounted ? children : <TranscriptSkeletonCover label={t('Loading conversation…')} />;
  },
  (previous, next) => previous.retained && next.retained
);

function dropZoneStyle(preview: DropPreview): React.CSSProperties {
  const { left, top, width, height } = preview.rect;
  switch (preview.zone) {
    case 'left':
      return { left, top, width: width / 2, height };
    case 'right':
      return { left: left + width / 2, top, width: width / 2, height };
    case 'top':
      return { left, top, width, height: height / 2 };
    case 'bottom':
      return { left, top: top + height / 2, width, height: height / 2 };
    // Center merge highlights the whole target group; a strip insertion caret
    // arrives with the bar (tab drop index) already as its rect.
    case 'center':
    case 'insert':
      return { left, top, width, height };
  }
}

export function PaneWorkspace({
  workspace,
  observedSessionIds = [],
  renderActive,
  renderStrip,
  renderConversation,
  renderFileEditors,
  renderUtilityTabs,
  renderSideDock,
  renderProblems,
  onFocusSelection,
  onOpenDroppedPaths,
}: {
  workspace: ReturnType<typeof usePaneWorkspace>;
  /** Additional live lanes required by non-editor surfaces such as Agents. */
  observedSessionIds?: readonly string[];
  /** App's non-chat surface for an empty/project/file focused leaf. */
  renderActive: (leaf: PaneLeaf) => React.ReactNode;
  /** Per-group tab strip. */
  renderStrip?: (leaf: PaneLeaf) => React.ReactNode;
  /** One permanently mounted chat surface per session/draft pane. Focus is a
   *  prop change only. `warm`: this surface already painted `selection` (a
   *  retained phone session), so no close handoff may present another. */
  renderConversation?: (
    selection: NavigationSelection,
    focused: boolean,
    focusPane: () => void,
    leafId: string,
    warm: boolean,
    /** On screen in its pane (not parked behind a file or utility tab, not a
     *  retained phone surface), focused or not. */
    visible: boolean
  ) => React.ReactNode;
  /** File editors stay mounted in their owning group while dirty. The active
   *  file renders in-place even when another pane has focus. */
  renderFileEditors?: (leaf: PaneLeaf, focused: boolean, focusPane: () => void) => React.ReactNode;
  /** Studio and terminal tabs stay mounted per group so their prompt,
   * gallery, terminal buffer, and PTY identity survive tab switches. */
  renderUtilityTabs?: (leaf: PaneLeaf, focused: boolean, focusPane: () => void) => React.ReactNode;
  /** Per-pane right dock: ONE side-tab unit (header + source control /
   *  browser / diff children) attached to the pane's right edge. */
  renderSideDock?: (leaf: PaneLeaf, focused: boolean) => React.ReactNode;
  /** Problems: the file editor's own bottom sub-panel (user: DIFF처럼
   *  스크립트에 종속) — docked under the pane surface stack while the
   *  pane's active tab is a file. */
  renderProblems?: (leaf: PaneLeaf, focused: boolean) => React.ReactNode;
  /** Navigate App's interactive surface when another pane takes focus. */
  onFocusSelection: (selection: WorkspaceSelection) => void;
  /** Opens native/internal file drops in the pane they were dropped onto. */
  onOpenDroppedPaths?: (leafId: string, paths: string[]) => void | Promise<void>;
}): React.JSX.Element {
  // Subscribe before the browser can paint the restored pane tree. main.tsx
  // starts this even earlier on a normal boot; this layout effect preserves
  // the same contract for tests, remote shells, and hot remounts.
  useLayoutEffect(() => defaultSessionLaneStore.start(), []);
  // A phone shows ONE tab at a time and pays for every mirrored session over
  // the relay, so restored background tabs stay unregistered until opened
  // (user: vps라 비용때문에). Wide surfaces keep every pane tab observable.
  const mobileSurface = useMobileRemoteSurface();
  const paneSessionIds = mobileSurface
    ? mobileVisibleSessionIds(workspace.leaves, workspace.focusedLeafId)
    : paneActiveSessionIds(workspace.leaves, workspace.focusedLeafId);
  // The Agents surface observes working background sessions even when none of
  // them owns an editor tab, so include those ids with every pane session.
  // Not on a phone: its Agents rows read the agent pool and roster, while
  // every observed lane mirrored a whole working transcript over the relay.
  const petSessionIds = useDesktopPetSessionIds();
  const visibleSessionIds = mobileSurface
    ? paneSessionIds
    : [...new Set([...paneSessionIds, ...observedSessionIds, ...petSessionIds])];
  useVisibleSessions(visibleSessionIds);
  useScreenSessions(paneSessionIds);
  usePaneSelectionFence();
  const fileDropPropsFor = usePaneFileDrop(onOpenDroppedPaths);
  const dropPreview = usePaneDropPreview(workspace, onFocusSelection);
  const singlePaneMode = useSinglePaneMode(workspace.layout);
  let overlay: ReturnType<typeof createPortal> | null = null;
  if (dropPreview) {
    // ONE drop overlay per editor group: the highlight glides between zones
    // INSIDE a pane but never slides across panes — the key remounts the
    // element when the pane (or surface kind) changes, so only intra-pane
    // moves animate.
    const insert = dropPreview.zone === 'insert';
    overlay = createPortal(
      <div
        key={`${dropPreview.leafId}:${insert ? 'strip' : 'area'}`}
        className={insert ? 'pane-drop-overlay pane-drop-insert' : 'pane-drop-overlay'}
        style={dropZoneStyle(dropPreview)}
      />,
      document.body
    );
  }
  const { focusedLeafId } = workspace;
  const multi = workspace.leaves.length > 1;
  const { currentPaneSurfaces, paneSurfaceHandoffs } = usePaneSurfaceHandoffs(workspace.leaves);
  const { conversationLeaves } = usePaneConversationOwners(
    workspace,
    paneSurfaceHandoffs,
    mobileSurface ? MOBILE_RETAINED_CONVERSATIONS : 0
  );
  // Conversation owns scroll, virtualizer, parsed Markdown and composer state.
  // Keep one stable owner per visible pane instead of keying it by the active
  // session. When an active tab/group moves to another leaf, match its prior
  // selection first so the same owner follows the move; ordinary tab switches
  // then fall back to the existing leaf owner and never remount Conversation.
  // A phone also keeps its last few sessions mounted (retained, unpainted).
  let conversationPortals: React.ReactNode[] = [];
  if (renderConversation) {
    conversationPortals = conversationLeaves.map(
      ({ leaf, active, selectionKey, handoff, parked, retained, warm, owner }) => {
        const focused = leaf.id === focusedLeafId;
        const focusPane = (): void => {
          workspace.focusLeaf(leaf.id);
          onFocusSelection(active);
        };
        return (
          <PersistentPanePortal
            key={owner}
            targetId={paneConversationSlotId(leaf.id)}
            owner={owner}
            className={`conversation-persistent-surface${handoff ? ' is-handoff' : ''}`}
            retained={retained}
          >
            <RetainedConversation
              retained={retained}
              selectionKey={selectionKey}
              deferMount={mobileSurface && active.kind === 'session' && defaultSessionLaneStore.get(active.id) === null}
            >
              {renderConversation(
                active,
                focused && !handoff && !parked && !retained,
                focusPane,
                leaf.id,
                warm,
                !parked && !retained
              )}
            </RetainedConversation>
          </PersistentPanePortal>
        );
      }
    );
  }
  // The desktop pet: a side chat with Mixy.
  if (!mobileSurface) {
    const focusedLeaf = workspace.leaves.find((leaf) => leaf.id === focusedLeafId);
    const focusedSelection = focusedLeaf ? paneActiveSelection(focusedLeaf) : null;
    conversationPortals.push(
      <DesktopPetPublisher
        key="desktop-pet"
        focusKey={focusedLeafId}
        mixyFocused={focusedSelection?.kind === 'session' && focusedSelection.id === DESKTOP_PET_SESSION_ID}
      />
    );
  }
  const conversationEntryByLeaf = new Map(
    conversationLeaves.filter((entry) => !entry.retained).map((entry) => [entry.leaf.id, entry])
  );
  const conversationSlot = (leafId: string, parked: boolean) => (
    <div
      id={paneConversationSlotId(leafId)}
      className="pane-conversation-slot"
      data-conversation-parked={parked ? 'true' : undefined}
      inert={parked ? true : undefined}
      aria-hidden={parked ? true : undefined}
    />
  );
  // Chat owns one fixed pane-sized paint layer. When Studio/file/terminal is
  // active it remains laid out and painted underneath the opaque utility
  // layer, so Chromium and TanStack never discard or recompute its geometry.
  const visualSurfaceHandoffFor = (leafId: string) => {
    const handoff = paneSurfaceHandoffs.current.get(leafId);
    const active = handoff ? paneActiveSelection(handoff.leaf) : null;
    return isConversationSelection(active) ? undefined : handoff;
  };
  // ONE surface layer per pane. Keying layers by the active selection
  // re-created the layer on every tab switch and remounted every open editor
  // in the pane: Monaco lost focus and undo history, reloads replayed
  // "restored" backups and the save handles were dropped. During a handoff
  // the SAME layer paints the outgoing selection for exactly one more frame
  // (inert, above the incoming conversation) instead of a fresh copy.
  const outgoingSurfaceFor = (leaf: PaneLeaf) => {
    const handoff = visualSurfaceHandoffFor(leaf.id);
    return handoff && handoff.key !== currentPaneSurfaces.get(leaf.id)!.key ? handoff : null;
  };
  const renderPaneSurface = (surfaceLeaf: PaneLeaf, focused: boolean, handoff: boolean) => {
    if (workspace.restorePending) {
      return (
        <div className="pane-placeholder" data-restoring="true" role="status">
          <span className="pane-placeholder-title">{t('Restoring layout…')}</span>
        </div>
      );
    }
    const active = paneActiveSelection(surfaceLeaf);
    const interactive = focused && !handoff;
    const focusPane = (): void => {
      if (handoff) return;
      workspace.focusLeaf(surfaceLeaf.id);
      if (active) onFocusSelection(active);
    };
    const fileEditors = renderFileEditors?.(surfaceLeaf, interactive, focusPane);
    // Utility portals stay mounted after first activation. Their slots live in
    // the pane's one layer, so a handoff frame keeps the last composed utility
    // frame in place and never duplicates a slot id.
    const utilityTabs = renderUtilityTabs?.(surfaceLeaf, interactive, focusPane);
    // Chat, editors and the utility tabs all render themselves: the mounted
    // layers below ARE the pane, so it needs no chrome of its own. A file tab
    // only qualifies while the host actually renders editors.
    if (
      isConversationSelection(active) ||
      (parksConversationBehindSelection(active) && (active?.kind !== 'file' || renderFileEditors))
    ) {
      return (
        <>
          {fileEditors}
          {utilityTabs}
        </>
      );
    }
    if (interactive) {
      return (
        <>
          {fileEditors}
          {utilityTabs}
          {renderActive(surfaceLeaf)}
        </>
      );
    }
    return (
      <>
        {fileEditors}
        {utilityTabs}
        {!handoff && (
          <button type="button" className="pane-placeholder" onClick={focusPane}>
            <span className="pane-placeholder-title">{selectionLabel(active)}</span>
            <span className="pane-placeholder-hint">{t('Click to work in this pane')}</span>
          </button>
        )}
      </>
    );
  };
  const renderPaneSurfaceStack = (leaf: PaneLeaf, focused: boolean) => {
    const conversationEntry = conversationEntryByLeaf.get(leaf.id);
    const outgoing = outgoingSurfaceFor(leaf);
    const surface = outgoing ?? currentPaneSurfaces.get(leaf.id)!;
    return (
      <div className="pane-surface-stack">
        <div
          className="pane-surface-handoff-layer"
          data-pane-surface-handoff={outgoing ? 'true' : 'false'}
          inert={outgoing ? true : undefined}
          aria-hidden={outgoing ? true : undefined}
        >
          {renderPaneSurface(surface.leaf, focused, Boolean(outgoing))}
        </div>
        {conversationEntry && conversationSlot(leaf.id, conversationEntry.parked)}
      </div>
    );
  };
  // Every cell layout stacks the same four parts: strip, surfaces, the file
  // editor's Problems panel and the pane's side dock.
  // The conversation a pane's editor, Explorer and Review surfaces download
  // as: the session the pane showed last, kept per pane while a file or
  // utility tab covers it.
  const downloadOwners = useRef(new Map<string, string>());
  const downloadSessionOf = (leaf: PaneLeaf): string => {
    const active = paneActiveSelection(leaf);
    if (active?.kind === 'session') downloadOwners.current.set(leaf.id, active.id);
    const owner = downloadOwners.current.get(leaf.id);
    if (owner) return owner;
    return leaf.tabs.find((tab) => tab.kind === 'session')?.id ?? '';
  };
  const paneCellBody = (leaf: PaneLeaf, focused: boolean) => (
    <DownloadSessionContext.Provider value={downloadSessionOf(leaf)}>
      {renderStrip?.(leaf)}
      {renderPaneSurfaceStack(leaf, focused)}
      {renderProblems?.(leaf, focused)}
      {/* Main-tab file footer (EditorPane portals into it): the sheet's last row. */}
      <div className="pane-footer-slot" />
      {renderSideDock?.(leaf, focused)}
    </DownloadSessionContext.Provider>
  );
  if (workspace.layout.type === 'leaf') {
    const leaf = workspace.layout;
    // A single pane still owns its tab strip (one editor group);
    // the cell stacks the strip above the classic interactive markup.
    return (
      <>
        <div className="pane-cell is-focused" data-pane-id={leaf.id} {...fileDropPropsFor(leaf.id)}>
          {paneCellBody(leaf, true)}
          {overlay}
        </div>
        {conversationPortals}
      </>
    );
  }
  if (singlePaneMode) {
    const ordered = paneLeavesInVisualOrder(workspace.layout);
    const activeIndex = Math.max(
      0,
      ordered.findIndex((leaf) => leaf.id === focusedLeafId)
    );
    return (
      <>
        <div className="pane-carousel">
          {ordered.map((leaf, index) => {
            const focused = index === activeIndex;
            return (
              <div
                key={leaf.id}
                className={`pane-cell pane-carousel-item${focused ? ' is-focused has-siblings' : ''}`}
                data-pane-id={leaf.id}
                {...fileDropPropsFor(leaf.id)}
                data-carousel-active={focused ? 'true' : 'false'}
                inert={focused ? undefined : true}
                aria-hidden={focused ? undefined : true}
              >
                {paneCellBody(leaf, focused)}
              </div>
            );
          })}
        </div>
        {conversationPortals}
        {overlay}
      </>
    );
  }
  return (
    <>
      <PaneSplitLayout
        node={workspace.layout}
        onRatioChange={workspace.setRatio}
        renderLeaf={(leaf) => {
          const focused = leaf.id === focusedLeafId;
          const cellClass = ['pane-cell', focused && 'is-focused', focused && multi && 'has-siblings']
            .filter(Boolean)
            .join(' ');
          return (
            <div className={cellClass} {...fileDropPropsFor(leaf.id)}>
              {paneCellBody(leaf, focused)}
            </div>
          );
        }}
      />
      {conversationPortals}
      {overlay}
    </>
  );
}
