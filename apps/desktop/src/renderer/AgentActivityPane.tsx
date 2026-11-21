import { Star } from 'lucide-react';
import type React from 'react';
import { createPortal } from 'react-dom';
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { InitialSurface } from './InitialSurface';
import { useScrollProgress } from './scroll-progress';
import { AGENT_GROUP_EXPANSION_EVENT, useHiddenAgentGroups } from './agent-group-visibility';
import { ScmContextMenu, type ScmContextMenuState, contextMenuRowProps } from './ScmContextMenu';
import { ConnectorsPill } from './connector-card';
import { beginBootSurface, reportBootSurfaceReady } from './boot-metrics';
import type { DesktopModelSelection, DesktopSessionSummary } from '../shared/contract';
import { sessionDisplayTitle } from './session-display-title';
import { t } from './i18n';
import { clearableAgentTreeRows, dismissFinishedAgentRows, useVisibleAgentPool } from './agent-dismiss';
import { useSessionDragSource } from './agent-row-parts';
import { agentChatTimeLabel } from './agent-chat-summary';
import { AgentRoomsSection, useAgentRoomRows } from './AgentRoomsSection';
import { AgentPaneHeaderActions } from './agent-pane-header-actions';
import { useNotificationSnapshot } from './notification-overrides';
import { type AgentContact, agentContacts } from './agent-contacts-model';
import { AgentAvatar } from './agent-avatar';
import { type AgentLeadRow, AgentLeadRows, agentLeadRows, retainWindowMs } from './agent-lead-rows';
import { SubtreeToggle, subAgentNodes, subAgentsNeedAttention, subtreeMenuItem, subtreeRowAttr } from './agent-subtree';
import { LeadAppearanceDialog } from './lead-appearance-dialog';
import {
  applyBotOrder,
  hiddenPaneGroups,
  PANE_GROUP_IDS,
  type PaneToggleId,
  type PaneSectionId,
  paneSectionOrder,
  pinnedLeadIds,
  retainChoice,
  setGroupHidden,
  setLeadPinned,
  setRetainChoice,
  useBotOrder,
} from './bot-order-store';
import { ArrangedSections } from './agent-section-order';
import { usePaneBotReorder } from './bot-reorder';
import { type AvatarMotionState, useNewMessagePulse } from './avatar-motion';
import { openAgentProfile } from './agent-panel-tab';
import { afterMenuClose, agentContactMenuItems, renameLeadSession } from './agent-profile-actions';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { draftModelSelectionFromSnapshot } from './draft-pane-prefs-store';
import { defaultSessionLaneStore } from './session-lane-store';
import { useSessionAttentionIndex } from './session-attention-index';
import { useSidebarHiddenBots } from './sidebar-hidden-bots-store';
import { useSidebarReferences } from './sidebar-reference-cache';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { MixyEmptyState, useMixyFirstPane } from './mixy-first';
import { isAgentChatSession } from './agent-chat-mode';
import { agentHomeSessionId } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { agentPoolStore } from './agent-activity-model';
import type { AgentActivityNode } from './agent-activity-model';

import {
  AgentActivityGroup,
  AgentActivityTree,
  type AgentActivitySessionGroup,
  AgentChatStatus,
  agentActivitySessionGroups,
  expandedAgentActivityIds,
  splitAgentHomeGroups,
  useAgentPoolCadence,
} from './agent-activity-groups';

export { AgentPoolRow, splitAgentHomeGroups, unreadBadgeLabel } from './agent-activity-groups';
export {
  agentActivityGroups,
  flattenAgentActivityNodes,
  liveAgentRows,
  preloadAgentPool,
} from './agent-activity-model';

// Loaded on "+" only: the Workflows editor graph stays out of every bundle
// that reaches this pane (the composer island among them).
const AgentCreateDialog = lazy(() =>
  import('./agent-create-dialog').then((module) => ({ default: module.AgentCreateDialog }))
);

/** One contact: an agent as a messenger row over its home thread — avatar
 *  (its mascot; Mixy's carries a star), display name,
 *  time, last-message preview and the one trailing status. */
function AgentContactRow({
  contact,
  selected,
  subNodes,
  subOpen = false,
  onToggleSub,
  onOpen,
  onOpenMenu,
  onProfile,
  reorderProps,
  onReorderKey,
}: {
  contact: AgentContact;
  /** Drop target and drag-state marks of the row (usePaneBotReorder). */
  reorderProps?: object;
  /** Alt+Arrow on the row moves the bot (not offered for Mixy). */
  onReorderKey?(event: React.KeyboardEvent<HTMLElement>): void;
  selected: boolean;
  /** The pool nodes under its home thread: any sub-agent gives the row a chevron. */
  subNodes?: readonly AgentActivityNode[];
  subOpen?: boolean;
  onToggleSub?(expanded: boolean): void;
  onOpen(contact: AgentContact): void;
  onOpenMenu(menu: ScmContextMenuState): void;
  onProfile(contact: AgentContact): void;
}) {
  const describedBy = useId();
  const { dragProps, clickSuppressed } = useSessionDragSource(
    contact.session?.id ?? '',
    contact.name,
    contact.mixy ? undefined : contact.agentId
  );
  useSidebarHiddenBots(); // re-render so the menu offers 사이드바에 표시 while hidden
  const subCount = subAgentNodes(contact.session?.id ?? '', subNodes).length;
  const hasSubAgents = subCount > 0;
  // An empty second line still says there are sub-agents.
  const preview = contact.preview || (hasSubAgents ? t('Sub-agents {{count}}', { count: subCount }) : '');
  // Subscribing loads the notification overrides with the row; the items are
  // built when the menu opens, from the store as it is then.
  useNotificationSnapshot();
  const buildItems = () => [
    ...(hasSubAgents && onToggleSub ? [subtreeMenuItem(subOpen, onToggleSub)] : []),
    ...agentContactMenuItems(contact, { onOpen, onProfile }),
    ...(hasSubAgents && subNodes
      ? [
          {
            id: 'clear-finished-agents',
            label: t('Clear finished'),
            disabled: clearableAgentTreeRows(subNodes).length === 0,
            onSelect: () => dismissFinishedAgentRows(clearableAgentTreeRows(subNodes)),
          },
        ]
      : []),
  ];
  // The face bobs while the agent works and bounces once on a new message.
  const arrived = useNewMessagePulse(contact.indicator?.kind === 'unread' ? contact.indicator.count : 0);
  let faceState: AvatarMotionState = contact.indicator?.kind === 'running' ? 'typing' : 'still';
  if (arrived) faceState = 'message';
  return (
    <li
      className={`agent-chat-row${selected ? ' selected' : ''}`}
      data-kind="contact"
      data-agent-contact={contact.agentId}
      data-drag-frame="row"
      data-agent-disabled={contact.disabled ? 'true' : undefined}
      {...subtreeRowAttr(hasSubAgents && Boolean(onToggleSub))}
      {...reorderProps}
      data-name-only={contact.preview || contact.indicator || contact.at > 0 ? undefined : 'true'}
      {...contextMenuRowProps((point) =>
        onOpenMenu({ label: t('Actions for {{title}}', { title: contact.name }), ...point, items: buildItems() })
      )}
    >
      {hasSubAgents && onToggleSub && (
        <SubtreeToggle
          expanded={subOpen}
          name={contact.name}
          onToggle={onToggleSub}
          dragProps={dragProps}
          clickSuppressed={clickSuppressed}
        />
      )}
      <button
        type="button"
        className="agent-chat-row-main"
        aria-current={selected ? 'page' : undefined}
        aria-haspopup="menu"
        aria-label={contact.name}
        aria-describedby={`${describedBy}-preview ${describedBy}-status`}
        {...dragProps}
        aria-keyshortcuts={onReorderKey ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        title={onReorderKey ? t('Drag or use Alt + arrow keys to reorder') : undefined}
        onKeyDown={onReorderKey}
        onClick={() => {
          if (!clickSuppressed()) onOpen(contact);
        }}
      >
        <span className="agent-chat-avatar">
          <AgentAvatar
            agentId={contact.agentId}
            avatar={contact.avatar}
            className="agent-contact-mascot"
            state={faceState}
            priority={2}
          />
          {contact.mixy && (
            <span className="agent-contact-badge" title={t('Representative bot')}>
              {/* A filled glyph: an outlined star blurs at badge size. */}
              <Star size={8} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              <span className="sr-only">{t('Representative bot')}</span>
            </span>
          )}
        </span>
        {/* KakaoTalk layout, a 2×2 grid: name | time, then the preview (up
            to two lines) | status. The right column is reserved, so the
            preview never runs under the time or the badge. A name-only row
            (no messages, no status) has only the name, centred on the face. */}
        <span className="agent-chat-body agent-contact-body">
          <b className="agent-chat-title">{contact.name}</b>
          {preview && (
            <span id={`${describedBy}-preview`} className="agent-chat-preview">
              {preview}
            </span>
          )}
          {/* The right column: time over the one status. Without a status it
              sits on the name line; with one the pair centres on the row. */}
          {(contact.at > 0 || contact.indicator) && (
            <span
              className="agent-contact-aside"
              data-has-status={contact.indicator ? 'true' : undefined}
              data-unread={contact.unread ? 'true' : undefined}
            >
              {contact.at > 0 && <time className="agent-chat-time">{agentChatTimeLabel(contact.at)}</time>}
              <AgentChatStatus
                indicator={contact.indicator}
                id={`${describedBy}-status`}
                attentionMark
                name={contact.name}
                approvals={contact.approvals}
                asking={contact.asking}
              />
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** The existing tree rows of one owner's sub-agents, under its messenger row.
 *  Open means the owner is in the expanded set; Arrow Left on a top
 *  sub-agent folds the owner again. */
function AgentSubtree({
  ownerId,
  nodes,
  session,
  expandedSessionIds,
  unreadSessionIds,
  setSessionExpanded,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
}: {
  ownerId: string;
  nodes: readonly AgentActivityNode[];
  session?: Pick<DesktopSessionSummary, 'provider'>;
  expandedSessionIds: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  setSessionExpanded(sessionId: string, expanded: boolean): void;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}): React.ReactElement {
  return (
    <AgentActivityTree
      group={{ ownerId, nodes: subAgentNodes(ownerId, nodes), session }}
      label={t('Sub-agents')}
      groupExpanded
      expandedSessionIds={expandedSessionIds}
      onSetExpanded={setSessionExpanded}
      unreadSessionIds={unreadSessionIds}
      onCollapseGroup={() => setSessionExpanded(ownerId, false)}
      onPrefetchSession={onPrefetchSession}
      onOpenLeadSession={onOpenLeadSession}
      onOpenSession={onOpenSession}
    />
  );
}

function useAgentSessionExpansion(
  allGroups: readonly AgentActivitySessionGroup[],
  hiddenOwnerIds: ReadonlySet<string>
) {
  const [expandedSessionIds, setExpandedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const setSessionExpanded = (sessionId: string, expanded: boolean): void =>
    setExpandedSessionIds((current) => {
      if (current.has(sessionId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  useEffect(() => {
    const setAllExpanded = (event: Event): void => {
      const expanded = (event as CustomEvent<boolean>).detail;
      setExpandedSessionIds(expanded ? expandedAgentActivityIds(allGroups, hiddenOwnerIds) : new Set());
    };
    window.addEventListener(AGENT_GROUP_EXPANSION_EVENT, setAllExpanded);
    return () => window.removeEventListener(AGENT_GROUP_EXPANSION_EVENT, setAllExpanded);
  }, [allGroups, hiddenOwnerIds]);
  const autoOpened = useRef<Set<string>>(new Set());
  useEffect(() => {
    const waiting = new Set(
      allGroups
        // Only owners drawn as a messenger row (Lead, bot home): the older
        // owner groups keep their own fold.
        .filter(
          (group) =>
            (group.session.agentHome || !isAgentChatSession(group.ownerId)) &&
            subAgentsNeedAttention(group.ownerId, group.nodes)
        )
        .map((group) => group.ownerId)
    );
    for (const id of [...autoOpened.current]) if (!waiting.has(id)) autoOpened.current.delete(id);
    const fresh = [...waiting].filter((id) => !autoOpened.current.has(id));
    if (!fresh.length) return;
    for (const id of fresh) autoOpened.current.add(id);
    setExpandedSessionIds((current) => new Set([...current, ...fresh]));
  }, [allGroups]);
  return { expandedSessionIds, setSessionExpanded };
}

type OpenAgentSession = (sessionId: string, title: string, ownerSessionId: string, replaceKey?: string) => void;

/** Open a contact's home thread; resolves its session id ('' when it could
 *  not be opened, which a toast reports). */
async function openAgentContact(contact: AgentContact, onOpenSession: OpenAgentSession | undefined): Promise<string> {
  try {
    // The host stamps a home thread with its agent; a contact without one
    // yet asks the host, which resolves (and on first open creates) it.
    const sessionId =
      contact.session?.id ?? (await window.mixdogDesktop?.openAgentHome?.(contact.agentId))?.sessionId ?? '';
    if (sessionId) onOpenSession?.(sessionId, contact.name, sessionId);
    return sessionId;
  } catch (error) {
    showDesktopToast(
      t('Could not open {{name}}: {{error}}', { name: contact.name, error: errorMessageText(error) }),
      'error'
    );
    return '';
  }
}

type SubtreeProps = Omit<Parameters<typeof AgentSubtree>[0], 'ownerId' | 'nodes' | 'session'>;

/** The bots section: Mixy pinned on top past a divider, the other bots in the
 *  user's order (reorderable), each with its home thread's sub-agents folded
 *  under it. */
function AgentBotsSection({
  divider,
  mixyEmpty,
  onCreateMixy,
  contacts,
  homeNodes,
  selectedSessionId,
  subtreeProps,
  onOpenContact,
  onOpenMenu,
}: {
  divider: boolean;
  mixyEmpty: boolean;
  onCreateMixy(): void;
  contacts: AgentContact[];
  homeNodes: ReadonlyMap<string, readonly AgentActivityNode[]>;
  selectedSessionId: string;
  subtreeProps: SubtreeProps;
  onOpenContact(contact: AgentContact): Promise<string>;
  onOpenMenu(menu: ScmContextMenuState): void;
}) {
  const { expandedSessionIds, setSessionExpanded } = subtreeProps;
  const botList = usePaneBotReorder(contacts);
  const pinnedDividerAt = contacts.findIndex((contact) => !contact.mixy);
  return (
    <>
      {divider && <hr className="agent-chat-divider" aria-hidden="true" />}
      {mixyEmpty && contacts.length === 0 && <MixyEmptyState onCreate={onCreateMixy} />}
      <ul className="agent-contact-list" aria-label={t('Bots')} {...botList.listProps}>
        {contacts.map((contact, index) => {
          const homeId = contact.session?.id ?? '';
          const subNodes = homeId ? homeNodes.get(homeId) : undefined;
          const subOpen = expandedSessionIds.has(homeId);
          return (
            <Fragment key={contact.agentId}>
              {index > 0 && index === pinnedDividerAt && <li className="agent-contact-divider" aria-hidden="true" />}
              <AgentContactRow
                contact={contact}
                reorderProps={botList.rowProps(contact)}
                onReorderKey={contact.mixy ? undefined : (event) => botList.onKeyDown(contact, event)}
                subNodes={subNodes}
                subOpen={subOpen}
                onToggleSub={(next) => setSessionExpanded(homeId, next)}
                // The deterministic id: an empty home thread has no catalog row yet.
                selected={Boolean(selectedSessionId) && agentHomeSessionId(contact.agentId) === selectedSessionId}
                onOpen={(row) => void onOpenContact(row)}
                onOpenMenu={onOpenMenu}
                onProfile={(row) => void onOpenContact(row).then((sessionId) => openAgentProfile(sessionId))}
              />
              {subOpen && subNodes && subAgentNodes(homeId, subNodes).length > 0 && (
                <li className="agent-subtree" data-agent-subtree={homeId}>
                  <AgentSubtree
                    ownerId={homeId}
                    nodes={subNodes}
                    session={contact.session ?? undefined}
                    {...subtreeProps}
                  />
                </li>
              )}
            </Fragment>
          );
        })}
      </ul>
    </>
  );
}

const CONTACT_REFERENCE_KEYS = ['agents'] as const;

/** The agent catalog behind the contacts, re-read whenever a turn settles: a
 *  chat (Mixy's setup tool) may just have created or deleted an agent. */
function useContactAgents(active: boolean, sessions: readonly DesktopSessionSummary[]): unknown {
  const { values, refresh } = useSidebarReferences(window.mixdogDesktop, CONTACT_REFERENCE_KEYS, active);
  const working = sessions.filter((session) => session.working).length;
  const workingRef = useRef(working);
  useEffect(() => {
    const settled = working < workingRef.current;
    workingRef.current = working;
    if (settled && active) void refresh({ force: true });
  }, [active, refresh, working]);
  return values.agents;
}

/** The context menu of a Lead row: sub-agent toggle, pin, rename, look, hide, clear. */
function leadMenuState(
  row: AgentLeadRow,
  point: { x: number; y: number },
  clearable: ReturnType<typeof clearableAgentTreeRows>,
  actions: {
    expandedSessionIds: ReadonlySet<string>;
    setSessionExpanded(sessionId: string, expanded: boolean): void;
    onRenameSession?(sessionId: string, title: string): Promise<unknown> | void;
    openLook(): void;
    hideGroup(ownerId: string): void;
  }
): ScmContextMenuState {
  const { expandedSessionIds, setSessionExpanded, onRenameSession, openLook, hideGroup } = actions;
  return {
    label: t('Actions for {{title}}', { title: row.title }),
    ...point,
    items: [
      ...(row.hasSubAgents
        ? [subtreeMenuItem(expandedSessionIds.has(row.sessionId), (next) => setSessionExpanded(row.sessionId, next))]
        : []),
      {
        id: row.pinned ? 'unpin-lead' : 'pin-lead',
        label: row.pinned ? t('Unpin') : t('Pin'),
        onSelect: () => setLeadPinned(row.sessionId, !row.pinned),
      },
      ...(onRenameSession
        ? [
            {
              id: 'rename-lead',
              label: t('Rename'),
              onSelect: afterMenuClose(() => void renameLeadSession(onRenameSession, row.sessionId, row.title)),
            },
          ]
        : []),
      { id: 'lead-appearance', label: t('Appearance'), onSelect: openLook },
      { id: 'hide-agent-group', label: t('Hide this group'), onSelect: () => hideGroup(row.sessionId) },
      {
        id: 'clear-finished-agents',
        label: t('Clear finished'),
        disabled: clearable.length === 0,
        onSelect: () => dismissFinishedAgentRows(clearable),
      },
    ],
  };
}

/** What each section of the agent page lists once the search and the user's hidden groups are applied. */
function selectAgentPaneRows({
  contacts,
  groups,
  sessions,
  needle,
  hidden,
  hiddenOwnerIds,
  mixyCreated,
  botOrder,
  needsUser,
}: {
  contacts: readonly AgentContact[];
  groups: ReturnType<typeof agentActivitySessionGroups>;
  sessions: readonly DesktopSessionSummary[];
  needle: string;
  hidden: ReadonlySet<PaneToggleId>;
  hiddenOwnerIds: ReadonlySet<string>;
  mixyCreated: boolean | null | undefined;
  botOrder: ReturnType<typeof useBotOrder>;
  needsUser: ReturnType<typeof useSessionAttentionIndex>['needsUser'];
}) {
  // Local search over what the rows show: names and preview lines.
  const matches = (...texts: Array<string | undefined>) =>
    !needle ||
    texts.some((value) =>
      String(value || '')
        .toLowerCase()
        .includes(needle)
    );
  const shownContacts = applyBotOrder(
    contacts
      .filter(
        (contact) =>
          // Mixy only once the host said she exists: unknown (not answered,
          // or a failed read) never offers a row that would create her chat.
          !(contact.mixy && mixyCreated !== true) &&
          !hidden.has(contact.mixy ? 'representative' : 'bots') &&
          matches(contact.name, contact.preview)
      )
      .sort((left, right) => Number(right.mixy) - Number(left.mixy) || right.at - left.at),
    botOrder
  );
  // The agent page lists agents and their chats only: an ordinary coding
  // session's work stays with that session (agent-created task sessions are
  // listed with the other sessions, not under their contact).
  const groupMatches = (group: (typeof groups)[number]): boolean =>
    !needle || matches(sessionDisplayTitle(group.session, ''), group.session.preview, group.session.lastMessagePreview);
  const visibleGroups = groups.filter(
    (group) => isAgentChatSession(group.ownerId) && !hiddenOwnerIds.has(group.ownerId) && groupMatches(group)
  );
  const leadSessionListed = (session: DesktopSessionSummary): boolean =>
    !isAgentChatSession(session.id) &&
    !session.archived &&
    !hiddenOwnerIds.has(session.id) &&
    (!needle || matches(sessionDisplayTitle(session, ''), session.preview, session.lastMessagePreview));
  const leadRows = agentLeadRows(
    groups.filter((group) => leadSessionListed(group.session)),
    needsUser,
    {
      retainMs: retainWindowMs(retainChoice(botOrder)),
      pinned: pinnedLeadIds(botOrder),
      sessions: sessions.filter(leadSessionListed),
    }
  );
  return { shownContacts, visibleGroups, leadRows };
}

export function AgentActivityPane({
  active,
  sessions,
  sessionsReady = true,
  selectedSessionId = '',
  headerActionSlot = null,
  unreadSessionIds,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenSession,
  onPeekSession,
  onRenameSession,
  readComposerModel,
}: {
  active: boolean;
  /** A sub-agent row's click: its conversation beside the chat (the side
   *  panel). Absent, the row opens it as a tab (`onOpenSession`). */
  onPeekSession?(sessionId: string, title: string, ownerSessionId: string): void;
  /** Renames a session: a Lead row's Rename (its session title). */
  onRenameSession?(sessionId: string, title: string): Promise<unknown> | void;
  /** The composer's current model, read when "+" opens a new agent. */
  readComposerModel?(): DesktopModelSelection | null;
  /** Retained for callers; the pane's actions show with or without a title. */
  showGroupActions?: boolean;
  sessions: readonly DesktopSessionSummary[];
  sessionsReady?: boolean;
  /** The focused tab's session (the session sidebar's selection). */
  selectedSessionId?: string;
  /** The dock header's action row: search and "+" render there. */
  headerActionSlot?: HTMLElement | null;
  /** Recent-list unread set: an idle row whose session is unseen reads as
   *  "완료" until the session is actually opened. */
  unreadSessionIds?: ReadonlySet<string>;
  onPrefetchSession?(sessionId: string): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string, replaceKey?: string): void;
}): React.ReactElement {
  // Showing this page never opens or switches a tab: only a row click does.
  const mixyFirst = useMixyFirstPane(active);
  const poolStore = useMemo(() => agentPoolStore(window.mixdogDesktop), []);
  // Rows the user cleared ("Clear finished") stay out of every group.
  const agents = useVisibleAgentPool(
    useSyncExternalStore(poolStore.subscribe, poolStore.getSnapshot, poolStore.getSnapshot)
  );
  const { hiddenOwnerIds, hideGroup } = useHiddenAgentGroups();
  const orderRef = useRef<Map<string, number>>(new Map());
  useAgentPoolCadence(poolStore);
  const allGroups = useMemo(() => agentActivitySessionGroups(agents, sessions, orderRef), [agents, sessions]);
  const { expandedSessionIds, setSessionExpanded } = useAgentSessionExpansion(allGroups, hiddenOwnerIds);
  // A home thread's work belongs to its contact row, not to the work sessions.
  const { groups, homeNodes } = useMemo(() => splitAgentHomeGroups(allGroups), [allGroups]);
  const contactAgents = useContactAgents(active, sessions);
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const [leadLookOpen, setLeadLookOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  // The new-agent dialog, open with the model it starts on.
  const [creating, setCreating] = useState<{ route: DesktopModelSelection | null } | null>(null);
  const needle = searching ? query.trim().toLowerCase() : '';
  // Sessions waiting on the user, a Lead's own approval or question included.
  const { needsUser, asking } = useSessionAttentionIndex();
  // The bot page lists every bot, a switched-off one too (shown as off).
  const contacts = useMemo(
    () =>
      agentContacts(contactAgents, sessions, homeNodes, unreadSessionIds, { includeDisabled: true, needsUser, asking }),
    [contactAgents, homeNodes, sessions, unreadSessionIds, needsUser, asking]
  );
  const openContact = (contact: AgentContact): Promise<string> => openAgentContact(contact, onOpenSession);

  const botOrder = useBotOrder();
  // A finished Lead's window ends on the clock, not on an event: the Lead rows
  // call this then, and the re-render rebuilds them without the expired one.
  const [, rebuildLeadRows] = useReducer((tick: number) => tick + 1, 0);
  const roomList = useAgentRoomRows(sessions, needle, unreadSessionIds);
  const loading = agents === null || (!sessionsReady && groups.length === 0);
  const pageRef = useRef<HTMLDivElement | null>(null);
  if (active) beginBootSurface('agent-activity', 'catalog');
  useEffect(() => {
    if (!loading) reportBootSurfaceReady('agent-activity', 'catalog');
  }, [loading]);
  useScrollProgress(pageRef, undefined, loading);
  if (loading)
    return (
      <div ref={pageRef} className="schedules-page agent-activity-page">
        <InitialSurface />
      </div>
    );
  const userHidden = hiddenPaneGroups(botOrder);
  const hidden: ReadonlySet<PaneToggleId> = needle ? new Set() : userHidden;
  const { shownContacts, visibleGroups, leadRows } = selectAgentPaneRows({
    contacts,
    groups,
    sessions,
    needle,
    hidden,
    hiddenOwnerIds,
    mixyCreated: mixyFirst.mixyCreated,
    botOrder,
    needsUser,
  });
  // The focused session's composer runs on its lane's model; a draft or the
  // engine snapshot answers otherwise.
  const composerRoute = () =>
    (selectedSessionId
      ? draftModelSelectionFromSnapshot(defaultSessionLaneStore.get(selectedSessionId) ?? EMPTY_SNAPSHOT)
      : null) ??
    readComposerModel?.() ??
    null;
  // Sub-agent rows (the trees under each Lead, bot and work session).
  const openSubAgent = onPeekSession ?? onOpenSession;
  const subtreeProps = {
    expandedSessionIds,
    unreadSessionIds,
    setSessionExpanded,
    onPrefetchSession,
    onOpenLeadSession,
    onOpenSession: openSubAgent,
  };
  const openLeadMenu = (row: AgentLeadRow, point: { x: number; y: number }): void => {
    const group = groups.find((entry) => entry.ownerId === row.sessionId);
    const clearable = group ? clearableAgentTreeRows(group.nodes) : [];
    setMenu(
      leadMenuState(row, point, clearable, {
        expandedSessionIds,
        setSessionExpanded,
        onRenameSession,
        openLook: () => setLeadLookOpen(true),
        hideGroup,
      })
    );
  };
  // Without a representative bot the page shows only its create prompt: no Leads.
  const shownLeadRows = mixyFirst.empty ? [] : leadRows;
  const workCount = visibleGroups.length;
  const present: Record<PaneSectionId, boolean> = {
    bots: shownContacts.length > 0 || (mixyFirst.empty && !hidden.has('representative')),
    rooms: roomList.rows.length > 0 && !hidden.has('rooms'),
    agents: (workCount > 0 || shownLeadRows.length > 0) && !hidden.has('agents'),
  };
  const allHidden = PANE_GROUP_IDS.every((id) => hidden.has(id));
  // The three sections below the pinned Mixy row, in the user's order (shared
  // with the bot order). A hairline sits above every present section that has
  // a present one before it, so empty sections leave no double or missing line.
  const arrangeSections = (blocks: Record<PaneSectionId, (divider: boolean) => React.ReactNode>) => (
    <ArrangedSections order={paneSectionOrder(botOrder)} present={present} blocks={blocks} />
  );
  // The Sessions header's action classes; "+" is rightmost, as on every
  // page: search, ⋯, +.
  const headerActions = (
    <AgentPaneHeaderActions
      searching={searching}
      mixyEmpty={mixyFirst.empty}
      onToggleSearch={() => {
        setSearching((value) => !value);
        setQuery('');
      }}
      hiddenGroups={userHidden}
      onToggleGroup={setGroupHidden}
      retain={retainChoice(botOrder)}
      onRetain={setRetainChoice}
      onCreateMixy={() => mixyFirst.openMixyDialog()}
      onNewAgent={() => setCreating({ route: composerRoute() })}
      onOpenSession={onOpenSession}
    />
  );
  return (
    <div ref={pageRef} className="schedules-page agent-activity-page">
      {headerActionSlot ? (
        createPortal(headerActions, headerActionSlot)
      ) : (
        <div className="agent-group-toolbar session-panel-header-actions">{headerActions}</div>
      )}
      {searching && (
        <input
          className="agent-pane-search"
          type="search"
          // biome-ignore lint/a11y/noAutofocus: the search button opens this field to type into
          autoFocus
          value={query}
          placeholder={t('Search')}
          aria-label={t('Search')}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearching(false);
          }}
        />
      )}
      {creating && (
        <Suspense fallback={null}>
          <AgentCreateDialog
            initialRoute={creating.route}
            onClose={() => setCreating(null)}
            onCreated={(sessionId, name) => onOpenSession?.(sessionId, name, sessionId)}
          />
        </Suspense>
      )}
      {mixyFirst.creatingMixy && (
        <Suspense fallback={null}>
          <AgentCreateDialog
            representative
            initialRoute={composerRoute()}
            onClose={() => mixyFirst.closeMixyDialog()}
            onCreated={(sessionId, name) => onOpenSession?.(sessionId, name, sessionId)}
          />
        </Suspense>
      )}
      {allHidden && (
        <p className="utility-dock-empty agent-activity-empty mx-empty-state">
          <span>{t('All groups are hidden')}</span>
        </p>
      )}
      {arrangeSections({
        bots: (divider) =>
          !(hidden.has('bots') && hidden.has('representative')) && (
            <AgentBotsSection
              divider={divider}
              mixyEmpty={mixyFirst.empty && !hidden.has('representative')}
              onCreateMixy={() => mixyFirst.openMixyDialog()}
              contacts={shownContacts}
              homeNodes={homeNodes}
              selectedSessionId={selectedSessionId}
              subtreeProps={subtreeProps}
              onOpenContact={openContact}
              onOpenMenu={setMenu}
            />
          ),
        rooms: (divider) =>
          !hidden.has('rooms') && (
            <AgentRoomsSection
              rows={roomList.rows}
              label={roomList.label}
              divider={divider}
              selectedSessionId={selectedSessionId}
              onOpenSession={onOpenSession}
            />
          ),
        // The agent sessions: the work-session groups and the Leads, one unnamed section.
        agents: (divider) =>
          !hidden.has('agents') && (
            <>
              {divider && workCount > 0 && <hr className="agent-chat-divider" aria-hidden="true" />}
              {/* Work sessions follow the contacts after a hairline, no heading. With
          contacts present, no work shows nothing at all; the centred empty
          state is only for a pane with neither. */}
              {visibleGroups.length === 0 && contacts.length === 0 && !mixyFirst.empty && (
                <p className="utility-dock-empty agent-activity-empty mx-empty-state">
                  <span>{t('No bots.')}</span>
                </p>
              )}
              {visibleGroups.map((group) => (
                <AgentActivityGroup
                  key={group.ownerId}
                  group={group}
                  expandedSessionIds={expandedSessionIds}
                  unreadSessionIds={unreadSessionIds}
                  setSessionExpanded={setSessionExpanded}
                  hideGroup={hideGroup}
                  onOpenMenu={setMenu}
                  onPrefetchSession={onPrefetchSession}
                  onOpenLeadSession={onOpenLeadSession}
                  onOpenSession={openSubAgent}
                />
              ))}
              {leadLookOpen && <LeadAppearanceDialog onClose={() => setLeadLookOpen(false)} />}
              {/* Without a representative bot the page shows only its create prompt. */}
              <AgentLeadRows
                rows={shownLeadRows}
                asking={asking}
                onExpire={rebuildLeadRows}
                divider={divider || workCount > 0}
                selectedSessionId={selectedSessionId}
                onOpen={(sessionId) => onOpenLeadSession?.(sessionId)}
                onOpenMenu={openLeadMenu}
                expandedIds={expandedSessionIds}
                onToggleExpanded={setSessionExpanded}
                renderSubtree={(sessionId) => {
                  const group = groups.find((entry) => entry.ownerId === sessionId);
                  return group ? (
                    <AgentSubtree ownerId={sessionId} nodes={group.nodes} session={group.session} {...subtreeProps} />
                  ) : null;
                }}
              />
            </>
          ),
      })}
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} />
      {/* The pane's foot, above 시작 가이드: opens Extensions → 커넥터. */}
      {!mixyFirst.empty && !userHidden.has('connectors') && <ConnectorsPill />}
    </div>
  );
}
