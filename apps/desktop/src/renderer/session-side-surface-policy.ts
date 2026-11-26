import { desktopAgentIdentity } from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import {
  PANE_DOCK_BROWSER_SURFACE,
  PANE_DOCK_DIFF_SURFACE,
  PANE_DOCK_FILE_SURFACE,
  PANE_DOCK_FILES_SURFACE,
  PANE_DOCK_TERMINAL_SURFACE,
  type PaneSideDockDiff,
  type PaneSideDockEntry,
  paneDockRestored,
  withPaneLocalOwner,
} from './pane-side-dock';
import { navigationKey } from './text-format';
import { sessionOfPromotedDraft } from './composer-draft';

export type SessionSideSurface = typeof PANE_DOCK_BROWSER_SURFACE | typeof PANE_DOCK_TERMINAL_SURFACE;

/** Another session's surface a session's dock shows: a child session's
 *  browser or terminal revealed in the conversation that owns it. */
export type SessionSurfaceSource = { sessionId: string; surface: SessionSideSurface };

/** The session whose `surface` the dock of `sessionId` shows: a child's when
 *  one was revealed there for that surface, else its own. */
export function sessionSurfaceSessionFor(
  sources: ReadonlyMap<string, SessionSurfaceSource>,
  sessionId: string,
  surface: SessionSideSurface
): string {
  const source = sources.get(sessionId);
  return source?.surface === surface ? source.sessionId : sessionId;
}

export const SESSION_DOCK_SURFACES_KEY = 'mixdog.desktop.session-dock-surfaces.v1';

/** An upgrade from the pane-keyed store: the sessions whose terminal it held
 *  open, read as the restored workspace shows them (the session each pane
 *  shows owns that pane's stored terminal). Closing wrote `open:false`, so a
 *  terminal closed on purpose stays closed. */
export function legacyTerminalSessions(
  owners: readonly { leafId: string; sessionId: string | null }[],
  entryFor: (leafId: string) => Pick<PaneSideDockEntry, 'open' | 'surface'>
): string[] {
  const sessions = new Set<string>();
  for (const { leafId, sessionId } of owners) {
    const entry = entryFor(leafId);
    if (sessionId && entry.open && entry.surface === PANE_DOCK_TERMINAL_SURFACE) sessions.add(sessionId);
  }
  return [...sessions];
}

type StoredSessionSurface = { surface: typeof PANE_DOCK_TERMINAL_SURFACE; source?: string };

/** What a reload brings back, keyed by the session that owns the dock: its
 *  terminal (its own, or the child's it shows). A browser is not restored:
 *  its pages do not survive a restart, and an empty panel would come back. */
export function storableSessionSurfaces(
  surfaces: ReadonlyMap<string, SessionSideSurface>,
  sources: ReadonlyMap<string, SessionSurfaceSource>
): Record<string, StoredSessionSurface> {
  const stored: Record<string, StoredSessionSurface> = {};
  for (const [sessionId, surface] of surfaces) {
    if (surface !== PANE_DOCK_TERMINAL_SURFACE) continue;
    const source = sources.get(sessionId);
    stored[sessionId] = source?.surface === surface ? { surface, source: source.sessionId } : { surface };
  }
  return stored;
}

/** The session surface maps a stored value restores; empty for anything else. */
export function restoredSessionSurfaces(value: unknown): {
  surfaces: Map<string, SessionSideSurface>;
  sources: Map<string, SessionSurfaceSource>;
} {
  const surfaces = new Map<string, SessionSideSurface>();
  const sources = new Map<string, SessionSurfaceSource>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { surfaces, sources };
  for (const [sessionId, entry] of Object.entries(value as Record<string, unknown>)) {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (!sessionId.trim() || record?.surface !== PANE_DOCK_TERMINAL_SURFACE) continue;
    surfaces.set(sessionId, PANE_DOCK_TERMINAL_SURFACE);
    const source = typeof record.source === 'string' ? record.source.trim() : '';
    if (source && source !== sessionId)
      sources.set(sessionId, { sessionId: source, surface: PANE_DOCK_TERMINAL_SURFACE });
  }
  return { surfaces, sources };
}

/** Immutable per-session map update: `null` removes the session's entry, and
 *  an unchanged value (per `same`) hands back the current map identity. */
function withSessionEntry<T>(
  current: ReadonlyMap<string, T>,
  sessionId: string,
  value: T | null,
  same: (existing: T, next: T) => boolean = Object.is
): ReadonlyMap<string, T> {
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId) return current;
  if (value === null) {
    if (!current.has(cleanSessionId)) return current;
    const next = new Map(current);
    next.delete(cleanSessionId);
    return next;
  }
  const existing = current.get(cleanSessionId);
  if (existing !== undefined && same(existing, value)) return current;
  const next = new Map(current);
  next.set(cleanSessionId, value);
  return next;
}

export function withSessionSideSurface(
  current: ReadonlyMap<string, SessionSideSurface>,
  sessionId: string,
  surface: SessionSideSurface | null
): ReadonlyMap<string, SessionSideSurface> {
  return withSessionEntry(current, sessionId, surface);
}

export function withSessionSurfaceSource(
  current: ReadonlyMap<string, SessionSurfaceSource>,
  sessionId: string,
  source: SessionSurfaceSource | null
): ReadonlyMap<string, SessionSurfaceSource> {
  return withSessionEntry(
    current,
    sessionId,
    source,
    (left, right) => left.sessionId === right.sessionId && left.surface === right.surface
  );
}

function sameNavigationTarget(left: PaneSideDockDiff, right: PaneSideDockDiff): boolean {
  return navigationKey(left) === navigationKey(right);
}

/** The Session Diff rows' open file, per session: it never enters the pane's
 *  own dock entry, so another session in the same pane sees the pane exactly
 *  as it was (closed stays closed) and the diff column returns with its
 *  session. */
export function withSessionDiff(
  current: ReadonlyMap<string, PaneSideDockDiff>,
  sessionId: string,
  diff: PaneSideDockDiff | null
): ReadonlyMap<string, PaneSideDockDiff> {
  return withSessionEntry(current, sessionId, diff, sameNavigationTarget);
}

/** Session-owned classic panel views: today only the Session Diff list. The
 *  browser and terminal ride `SessionSideSurface` above; the diff FILE rides
 *  `withSessionDiff`. The list is session-owned, never kept on the pane entry,
 *  so it cannot leak across sessions in the same pane. */
export type SessionSidePanelView = 'session-diff' | 'visualize' | 'routines' | 'room' | 'agent-session';

export const isSessionSidePanelView = (view: unknown): view is SessionSidePanelView =>
  view === 'session-diff' || view === 'visualize' || view === 'routines' || view === 'room' || view === 'agent-session';

/** The sub-agent session a chat's `agent-session` panel view shows (an Agents
 *  row opened beside the chat), with the row's title for its header. */
export type AgentSessionPanelTarget = { sessionId: string; title: string };

export function withAgentSessionPanel(
  current: ReadonlyMap<string, AgentSessionPanelTarget>,
  sessionId: string,
  target: AgentSessionPanelTarget | null
): ReadonlyMap<string, AgentSessionPanelTarget> {
  return withSessionEntry(
    current,
    sessionId,
    target,
    (left, right) => left.sessionId === right.sessionId && left.title === right.title
  );
}

/** Chat `hostSessionId`'s panel shows `target`: a sub-agent has one panel
 *  host, so any other chat showing it lets it go in the same update. */
export function withAgentSessionPanelHost(
  current: ReadonlyMap<string, AgentSessionPanelTarget>,
  hostSessionId: string,
  target: AgentSessionPanelTarget
): ReadonlyMap<string, AgentSessionPanelTarget> {
  let next = current;
  for (const [host, shown] of current) {
    if (host !== hostSessionId && shown.sessionId === target.sessionId) {
      next = withAgentSessionPanel(next, host, null);
    }
  }
  return withAgentSessionPanel(next, hostSessionId, target);
}

/** The panel targets a render may mount: never a sub-agent any pane holds as
 *  a tab (that tab is its one live mount). */
export function agentSessionPanelsShown(
  current: ReadonlyMap<string, AgentSessionPanelTarget>,
  tabSessionIds: ReadonlySet<string>
): ReadonlyMap<string, AgentSessionPanelTarget> {
  if (![...current.values()].some((target) => tabSessionIds.has(target.sessionId))) return current;
  return new Map([...current].filter(([, target]) => !tabSessionIds.has(target.sessionId)));
}

/** The `(scopeSessionId, tag)` identity of an open panel target's sub-agent
 *  session (`scopeSessionId` is `parentSessionId || ownerSessionId`, matching
 *  backend tag scope), remembered so a closed session removed from the pool
 *  can still follow a respawned session on the same tag. `pinned` is set when
 *  a historical `released: true` session was already superseded on first sight. */
export type AgentSessionPanelIdentity = {
  scopeSessionId: string;
  tag: string;
  at: number;
  pinned?: boolean;
};

function poolRowStamp(row: DesktopAgentPoolRow): number {
  const parse = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const text = String(value || '').trim();
    if (!text) return 0;
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  return parse(row.createdAt) || parse(row.startedAt) || 0;
}

function poolRowIdentity(row: DesktopAgentPoolRow): AgentSessionPanelIdentity | null {
  const sessionId = String(row.sessionId || '').trim();
  const parentSessionId = String(row.parentSessionId || '').trim();
  const ownerSessionId = String(row.ownerSessionId || '').trim();
  const scopeSessionId = (parentSessionId && parentSessionId !== sessionId ? parentSessionId : '') || ownerSessionId;
  const tag = desktopAgentIdentity(row);
  if (!sessionId || !scopeSessionId || !tag || sessionId === scopeSessionId) return null;
  if (
    String(row.agent || '')
      .trim()
      .toLowerCase() === 'lead'
  )
    return null;
  return { scopeSessionId, tag, at: poolRowStamp(row) };
}

function scopeTagKey(identity: Pick<AgentSessionPanelIdentity, 'scopeSessionId' | 'tag'>): string {
  return `${identity.scopeSessionId}\0${identity.tag}`;
}

function supersedes(oldAt: number, candidateAt: number): boolean {
  return !(oldAt > 0 && candidateAt > 0 && candidateAt < oldAt);
}

function latestLiveByScopeTag(
  pool: readonly DesktopAgentPoolRow[]
): Map<string, { row: DesktopAgentPoolRow; sessionId: string; at: number }> {
  const latest = new Map<string, { row: DesktopAgentPoolRow; sessionId: string; at: number }>();
  for (const row of pool) {
    if (row.released === true) continue;
    const sessionId = String(row.sessionId || '').trim();
    if (!sessionId) continue;
    const identity = poolRowIdentity(row);
    if (!identity) continue;
    const key = scopeTagKey(identity);
    const existing = latest.get(key);
    if (!existing || (identity.at > 0 ? identity.at >= existing.at : existing.at === 0)) {
      latest.set(key, { row, sessionId, at: identity.at });
    }
  }
  return latest;
}

function agentPanelTargetTitle(row: DesktopAgentPoolRow, fallback: string): string {
  const tag = String(row.tag || '').trim();
  const sessionTitle = String(row.title || '').trim();
  if (tag && tag.toLowerCase() !== sessionTitle.toLowerCase()) {
    return [sessionTitle, tag].filter(Boolean).join(' · ');
  }
  return sessionTitle || tag || fallback;
}

/** Records the `(scopeSessionId, tag, at)` of any open panel target present in
 *  `pool`. A target first observed while already `released: true` and already
 *  superseded by a newer live session on the same `(scopeSessionId, tag)` is
 *  marked `pinned: true` so explicitly opening a historical row stays on it. */
export function recordAgentSessionPanelIdentities(
  identities: Map<string, AgentSessionPanelIdentity>,
  panels: ReadonlyMap<string, AgentSessionPanelTarget>,
  pool: readonly DesktopAgentPoolRow[]
): void {
  if (panels.size === 0 || pool.length === 0) return;
  const targets = new Set([...panels.values()].map((target) => target.sessionId));
  let latestByTag: Map<string, { row: DesktopAgentPoolRow; sessionId: string; at: number }> | null = null;
  for (const row of pool) {
    const sessionId = String(row.sessionId || '').trim();
    if (!sessionId || !targets.has(sessionId)) continue;
    const identity = poolRowIdentity(row);
    if (!identity) continue;
    const prior = identities.get(sessionId);
    if (!prior) {
      let pinned = false;
      if (row.released === true) {
        latestByTag ??= latestLiveByScopeTag(pool);
        const replacement = latestByTag.get(scopeTagKey(identity));
        pinned = Boolean(replacement && replacement.sessionId !== sessionId && supersedes(identity.at, replacement.at));
      }
      identities.set(sessionId, pinned ? { ...identity, pinned: true } : identity);
    } else if (identity.at > 0 && (prior.at === 0 || identity.at < prior.at)) {
      identities.set(sessionId, { ...prior, at: identity.at });
    }
  }
}

/** Updates any open `agent-session` panel whose target session was closed
 *  (`released: true` or removed from the pool after its `(scopeSessionId, tag)`
 *  was observed) and superseded by a newer non-released session for the same
 *  `(scopeSessionId, tag)` not already hosted in another panel or open as a
 *  tab. Explicitly opened historical sessions (`pinned: true`) stay put. */
export function supersededAgentSessionPanels(
  current: ReadonlyMap<string, AgentSessionPanelTarget>,
  pool: readonly DesktopAgentPoolRow[],
  identities: ReadonlyMap<string, AgentSessionPanelIdentity>,
  claimedSessionIds?: ReadonlySet<string>
): ReadonlyMap<string, AgentSessionPanelTarget> {
  if (current.size === 0 || pool.length === 0) return current;
  const bySession = new Map<string, DesktopAgentPoolRow>();
  for (const row of pool) {
    const sessionId = String(row.sessionId || '').trim();
    if (sessionId) bySession.set(sessionId, row);
  }
  const latestByTag = latestLiveByScopeTag(pool);
  const claimed = new Set<string>(claimedSessionIds);
  for (const target of current.values()) claimed.add(target.sessionId);
  let next = current;
  for (const [host, target] of current) {
    const remembered = identities.get(target.sessionId);
    if (remembered?.pinned) continue;
    const oldRow = bySession.get(target.sessionId);
    if (oldRow && oldRow.released !== true) continue;
    const rowIdentity = oldRow ? poolRowIdentity(oldRow) : null;
    const identity =
      rowIdentity && remembered
        ? {
            ...rowIdentity,
            at:
              rowIdentity.at > 0 && remembered.at > 0
                ? Math.min(rowIdentity.at, remembered.at)
                : rowIdentity.at || remembered.at,
          }
        : (rowIdentity ?? remembered ?? null);
    if (!identity) continue;
    const replacement = latestByTag.get(scopeTagKey(identity));
    if (!replacement || replacement.sessionId === target.sessionId) continue;
    if (!supersedes(identity.at, replacement.at)) continue;
    // One host per sub-agent session: never steal a session already hosted elsewhere or open in a tab.
    if (claimed.has(replacement.sessionId)) continue;
    claimed.delete(target.sessionId);
    claimed.add(replacement.sessionId);
    next = withAgentSessionPanel(next, host, {
      sessionId: replacement.sessionId,
      title: agentPanelTargetTitle(replacement.row, target.title),
    });
  }
  return next;
}

/** `view` when the tab's own right-side groups (paneRightGroupsFor) hold it,
 *  else null: a view remembered for another session kind (Routines off a
 *  home thread, the room panel off a room) is neither stored nor shown, so
 *  the dock never falls back to an unrelated first view. */
export function sessionPanelViewIn(
  groups: readonly (readonly string[])[],
  view: SessionSidePanelView | null | undefined
): SessionSidePanelView | null {
  return view && groups.some((group) => group.includes(view)) ? view : null;
}

export function withSessionPanelView(
  current: ReadonlyMap<string, SessionSidePanelView>,
  sessionId: string,
  view: SessionSidePanelView | null
): ReadonlyMap<string, SessionSidePanelView> {
  return withSessionEntry(current, sessionId, view);
}

/** Whether the tab with owner key `viewer` owns file tabs owned by
 *  `entryOwner`: its own, unowned ones, or its New Task draft's once the draft
 *  became it (the dock re-owns them a commit later; until then they are not
 *  another tab's, so their editors are never released). */
export function paneDockOwnedBy(entryOwner: string | undefined, viewer: string): boolean {
  return !entryOwner || entryOwner === viewer || (Boolean(viewer) && sessionOfPromotedDraft(entryOwner) === viewer);
}

/** The pane entry as the tab with owner key `owner` (paneDockOwnerOf) sees
 *  it: file tabs, a Files tree or a git diff in front belong to the session
 *  or draft they were brought up beside (`owner`). Any other tab of the pane
 *  — another session, a bot chat, a draft — sees the dock as if closed; the
 *  owner gets its own back as it was, held ones included. */
export function paneDockEntryForSession(entry: PaneSideDockEntry, owner: string): PaneSideDockEntry {
  const restored = paneDockRestored(entry, owner);
  if (restored !== entry || paneDockOwnedBy(entry.owner, owner)) return restored;
  // Any other tab sees the owner's file tabs, Files tree and diff held (kept
  // mounted, never in its strip) and the front parked for it (a pane-level
  // view another tab opened), else the dock closed.
  return withPaneLocalOwner(entry, owner);
}

/**
 * Session-owned surfaces override the pane's remembered panel only for their
 * own session. A pane-local (git) diff stays in front of its own session
 * until it closes; a session's own diff rides in front of that session only.
 * `panelViewInFront`: the session's panel view was opened after its
 * browser/terminal (an agent's visualize open), so it shows while the
 * browser/terminal stays behind it — the latest explicit open wins.
 */
export function sessionSideDockEntryForSession(
  entry: PaneSideDockEntry,
  sessionId: string,
  surface: SessionSideSurface | null,
  sessionDiff: PaneSideDockDiff | null = null,
  sessionPanelView: SessionSidePanelView | null = null,
  panelViewInFront = false,
  /** The tab's owner key (paneDockOwnerOf): a draft's differs from its ''. */
  owner = sessionId
): PaneSideDockEntry {
  // A session diff persisted into the pane entry by an older build belongs to
  // no pane: drop it so the session map below is the only owner.
  const base = paneDockEntryForSession(
    entry.surface === PANE_DOCK_DIFF_SURFACE && entry.diff?.source === 'session'
      ? { ...entry, surface: '', diff: null }
      : entry,
    owner
  );
  if (sessionId && sessionDiff) {
    if (
      base.open &&
      base.surface === PANE_DOCK_DIFF_SURFACE &&
      base.diff &&
      navigationKey(base.diff) === navigationKey(sessionDiff)
    )
      return base;
    return { ...base, open: true, surface: PANE_DOCK_DIFF_SURFACE, diff: sessionDiff };
  }
  if (
    base.surface === PANE_DOCK_DIFF_SURFACE ||
    base.surface === PANE_DOCK_FILE_SURFACE ||
    base.surface === PANE_DOCK_FILES_SURFACE
  )
    return base;
  if (sessionId && surface && !(sessionPanelView && panelViewInFront)) {
    if (base.open && base.surface === surface) return base;
    return { ...base, open: true, surface };
  }
  // A session-owned panel view (the Session Diff list) rides only its own
  // session, exactly like the browser/terminal surfaces above: switching
  // back restores it even when the pane's remembered view moved on.
  if (sessionId && sessionPanelView) {
    if (base.open && base.surface === '' && base.view === sessionPanelView) return base;
    return { ...base, open: true, surface: '', view: sessionPanelView };
  }
  if (base.surface !== PANE_DOCK_BROWSER_SURFACE && base.surface !== PANE_DOCK_TERMINAL_SURFACE) {
    // A session-owned view never leaks across sessions: a pane showing
    // Session Diff for one session folds for a session that never opened it,
    // and for a pane with no session behind it (a New Task draft).
    if (isSessionSidePanelView(base.view)) {
      if (!base.open && base.surface === '') return base;
      return { ...base, open: false, surface: '' };
    }
    return base;
  }
  return { ...base, open: false, surface: '' };
}
