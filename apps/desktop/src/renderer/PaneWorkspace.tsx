import type React from 'react';
import { memo, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useScreenSessions, useVisibleSessions } from './use-visible-sessions';
import { DESKTOP_PET_SESSION_ID, DesktopPetPublisher, useDesktopPetSessionIds } from './desktop-pet-publisher';
import { t } from './i18n';
import { useMobileRemoteSurface } from './mobile-surface';
import { DownloadSessionContext } from './project-file-download';
import { PaneKeyContext } from './pane-key-context';
import { SurfaceActiveContext } from './surface-activity';
import { ConversationReleaseContext } from './conversation-release';
import { registerComposerPresenter } from './composer-text-inbox';
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
import { PersistentPanePortal } from './PaneSurfaceGate';
import type { NavigationSelection, WorkspaceSelection } from './nav-types';
import {
  paneActiveSessionIds,
  paneActiveSelection,
  paneLeavesInVisualOrder,
  paneScreenSessionIds,
  type PaneLeaf,
} from './pane-layout';
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

const RETAINED_CONVERSATIONS = 2;

const RetainedConversation = memo(
  function RetainedConversation({ children }: { retained: boolean; children: React.ReactNode }) {
    return <>{children}</>;
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

type PaneSurfaceProps = Pick<
  Parameters<typeof PaneWorkspace>[0],
  'workspace' | 'onFocusSelection' | 'renderActive' | 'renderFileEditors' | 'renderUtilityTabs'
>;

/** One pane's surface layer: file editors and utility tabs, then the active surface or a click-to-focus placeholder. */
function renderPaneSurface(
  { workspace, onFocusSelection, renderActive, renderFileEditors, renderUtilityTabs }: PaneSurfaceProps,
  surfaceLeaf: PaneLeaf,
  focused: boolean,
  handoff: boolean
) {
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
}

type ConversationLeaves = ReturnType<typeof usePaneConversationOwners>['conversationLeaves'];

/** Registers how Settings → compose reaches the pane conversation that should take the text. */
function useComposerPresenter(
  conversationLeaves: ConversationLeaves,
  focusedLeafId: string,
  workspace: ReturnType<typeof usePaneWorkspace>,
  onFocusSelection: (selection: WorkspaceSelection) => void
) {
  const presentComposer = useRef<() => void>(() => {});
  presentComposer.current = () => {
    const candidates = conversationLeaves.filter((entry) => !entry.retained && !entry.handoff);
    const target =
      candidates.find((entry) => entry.leaf.id === focusedLeafId) ??
      candidates.find((entry) => !entry.parked) ??
      candidates[0];
    if (!target) return; // No conversation yet: the text waits for the first one.
    if (target.parked) workspace.activateTab(target.leaf.id, target.selectionKey);
    else if (target.leaf.id !== focusedLeafId) workspace.focusLeaf(target.leaf.id);
    else return;
    onFocusSelection(target.active);
  };
  useLayoutEffect(() => registerComposerPresenter(() => presentComposer.current()), []);
}

/** The conversation a pane's surfaces download as, remembered per pane. */
function usePaneDownloadSession(): (leaf: PaneLeaf) => string {
  const downloadOwners = useRef(new Map<string, string>());
  const downloadSessionOf = (leaf: PaneLeaf): string => {
    const active = paneActiveSelection(leaf);
    if (active?.kind === 'session') downloadOwners.current.set(leaf.id, active.id);
    const owner = downloadOwners.current.get(leaf.id);
    if (owner) return owner;
    return leaf.tabs.find((tab) => tab.kind === 'session')?.id ?? '';
  };
  return downloadSessionOf;
}
export function PaneWorkspace({
  workspace,
  dockSessionIds = [],
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
  /** Sessions a pane's side panel shows (an Agents sub-agent beside its
   *  chat): live on every surface, the phone included, like a pane's own. */
  dockSessionIds?: readonly string[];
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
  /** Problems: the file editor's own bottom sub-panel — docked under the pane
   *  surface stack while the pane's active tab is a file. */
  renderProblems?: (leaf: PaneLeaf, focused: boolean) => React.ReactNode;
  /** Navigate App's interactive surface when another pane takes focus. */
  onFocusSelection: (selection: WorkspaceSelection) => void;
  /** Opens native/internal file drops in the pane they were dropped onto. */
  onOpenDroppedPaths?: (leafId: string, paths: string[]) => void | Promise<void>;
}): React.JSX.Element {
  useLayoutEffect(() => defaultSessionLaneStore.start(), []);
  const mobileSurface = useMobileRemoteSurface();
  const paneSessionIds = mobileSurface
    ? paneScreenSessionIds(workspace.leaves, workspace.focusedLeafId, true)
    : paneActiveSessionIds(workspace.leaves, workspace.focusedLeafId);
  const singlePaneMode = useSinglePaneMode(workspace.layout);
  const petSessionIds = useDesktopPetSessionIds();
  const visibleSessionIds = mobileSurface
    ? [...new Set([...paneSessionIds, ...dockSessionIds])]
    : [...new Set([...paneSessionIds, ...dockSessionIds, ...petSessionIds])];
  useVisibleSessions(visibleSessionIds);
  // On screen: every pane of a split, only the focused one of a carousel.
  useScreenSessions(paneScreenSessionIds(workspace.leaves, workspace.focusedLeafId, singlePaneMode));
  usePaneSelectionFence();
  const fileDropPropsFor = usePaneFileDrop(onOpenDroppedPaths);
  const dropPreview = usePaneDropPreview(workspace, onFocusSelection);
  let overlay: ReturnType<typeof createPortal> | null = null;
  if (dropPreview) {
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
  const { conversationLeaves, releaseGateFor } = usePaneConversationOwners(
    workspace,
    paneSurfaceHandoffs,
    RETAINED_CONVERSATIONS
  );
  useComposerPresenter(conversationLeaves, focusedLeafId, workspace, onFocusSelection);
  let conversationPortals: React.ReactNode[] = [];
  if (renderConversation) {
    conversationPortals = conversationLeaves.map(({ leaf, active, handoff, parked, retained, warm, owner }) => {
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
          {/* Only an on-screen conversation owns anything live: a retained or
              parked one is inert, but inert stops no window listener, mic or
              timer. The context reaches past the frozen RetainedConversation,
              so every owner below releases what it holds the moment it hides. */}
          <SurfaceActiveContext.Provider value={!parked && !retained}>
            <ConversationReleaseContext.Provider value={releaseGateFor(owner)}>
              <RetainedConversation retained={retained}>
                <PaneKeyContext.Provider value={leaf.id}>
                  {renderConversation(
                    active,
                    focused && !handoff && !parked && !retained,
                    focusPane,
                    leaf.id,
                    warm,
                    !parked && !retained
                  )}
                </PaneKeyContext.Provider>
              </RetainedConversation>
            </ConversationReleaseContext.Provider>
          </SurfaceActiveContext.Provider>
        </PersistentPanePortal>
      );
    });
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
  const outgoingSurfaceFor = (leaf: PaneLeaf) => {
    const handoff = visualSurfaceHandoffFor(leaf.id);
    return handoff && handoff.key !== currentPaneSurfaces.get(leaf.id)!.key ? handoff : null;
  };
  const paneSurfaceProps = { workspace, onFocusSelection, renderActive, renderFileEditors, renderUtilityTabs };
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
          {renderPaneSurface(paneSurfaceProps, surface.leaf, focused, Boolean(outgoing))}
        </div>
        {conversationEntry && conversationSlot(leaf.id, conversationEntry.parked)}
      </div>
    );
  };
  const downloadSessionOf = usePaneDownloadSession();
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
