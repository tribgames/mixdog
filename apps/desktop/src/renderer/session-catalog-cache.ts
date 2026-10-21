import { normalizeRoutineProvenance } from '../../../../src/runtime/agent/orchestrator/session/routine-result.mjs';
import type { DesktopAgentRoomSummary, DesktopSessionSummary } from '../shared/contract';
import { cleanIncomingTail } from '../shared/incoming-tail';
import { catalogStorageKey, catalogStorageScope } from './catalog-storage-scope';
import { deleteSessionImagePreviews } from './image-preview-store';
import { contentLocalStorage } from './remote-conversation-privacy';

const SESSION_CATALOG_STORAGE_KEY = 'mixdog.desktop-session-catalog.v1';
const SESSION_CATALOG_LIMIT = 500;

interface CachedSessionCatalog {
  version: 1;
  updatedAt: number;
  rows: DesktopSessionSummary[];
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cachedSessionRow(value: unknown): DesktopSessionSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const preview = text(row.preview, 1_024);
  const title = text(row.title, 1_024) || preview;
  const classification: DesktopSessionSummary['classification'] = row.classification === 'project' ? 'project' : 'task';
  const projectPath = text(row.projectPath, 32_768);
  const sourceType = row.sourceType === 'schedule' || row.sourceType === 'webhook' ? row.sourceType : undefined;
  const sourceName = text(row.sourceName, 1_024);
  const activityAt = finiteNumber(row.activityAt, Number.NaN);
  const createdAt = finiteNumber(row.createdAt, Number.NaN);
  const inheritedFrom = text(row.inheritedFromSessionId, 256);
  const agentHome = text(row.agentHome, 256);
  const taskAgent = text(row.taskAgent, 256);
  const agentRoom = cachedAgentRoom(row.agentRoom);
  const lastMessagePreview = text(row.lastMessagePreview, 1_024);
  const lastMessageRoutine = normalizeRoutineProvenance(row.lastMessageRoutine);
  const incomingTail = cleanIncomingTail(row.incomingTail);

  return {
    id,
    preview,
    title,
    updatedAt: finiteNumber(row.updatedAt),
    ...(Number.isFinite(activityAt) ? { activityAt } : {}),
    messageCount: Math.max(0, Math.floor(finiteNumber(row.messageCount))),
    cwd: text(row.cwd, 32_768),
    classification,
    projectPath: projectPath || null,
    // Live-process facts are never durable startup truth. A stale cache must
    // not show a dead worker as still running.
    ...(row.archived === true ? { archived: true } : {}),
    ...(row.favorite === true ? { favorite: true } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(sourceName ? { sourceName } : {}),
    ...(Number.isFinite(createdAt) && createdAt > 0 ? { createdAt } : {}),
    ...(inheritedFrom ? { inheritedFromSessionId: inheritedFrom } : {}),
    ...(agentHome ? { agentHome } : {}),
    ...(agentHome && row.agentDeleted === true ? { agentDeleted: true } : {}),
    ...(taskAgent ? { taskAgent } : {}),
    ...(agentRoom ? { agentRoom } : {}),
    ...(lastMessagePreview ? { lastMessagePreview } : {}),
    ...(lastMessagePreview && lastMessageRoutine ? { lastMessageRoutine } : {}),
    ...(incomingTail ? { incomingTail } : {}),
  };
}

/** A group room's catalog stamp, without its live `running` flag. */
function cachedAgentRoom(value: unknown): DesktopAgentRoomSummary | null {
  if (!value || typeof value !== 'object') return null;
  const room = value as Record<string, unknown>;
  const id = text(room.id, 64);
  const name = text(room.name, 256);
  const members = Array.isArray(room.members)
    ? room.members.filter((member): member is string => typeof member === 'string').slice(0, 6)
    : [];
  if (!id || !name || !members.length) return null;
  const lastSpeaker = text(room.lastSpeaker, 256);
  return {
    id,
    name,
    members,
    maxRounds: Math.floor(finiteNumber(room.maxRounds, 3)),
    maxMessages: Math.floor(finiteNumber(room.maxMessages, 8)),
    shareTools: room.shareTools === true,
    ...(lastSpeaker ? { lastSpeaker } : {}),
  };
}

function normalizeCachedSessionCatalog(value: unknown): CachedSessionCatalog {
  const record =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (record?.version !== 1) return { version: 1, updatedAt: 0, rows: [] };
  const rows: DesktopSessionSummary[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(record.rows) ? record.rows : []) {
    const row = cachedSessionRow(raw);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= SESSION_CATALOG_LIMIT) break;
  }
  return {
    version: 1,
    updatedAt: finiteNumber(record.updatedAt),
    rows,
  };
}

export function readCachedSessionCatalog(): DesktopSessionSummary[] {
  try {
    const stored = JSON.parse(contentLocalStorage().getItem(catalogStorageKey(SESSION_CATALOG_STORAGE_KEY)) || 'null');
    return normalizeCachedSessionCatalog(stored).rows;
  } catch {
    return [];
  }
}

export function writeCachedSessionCatalog(rows: DesktopSessionSummary[], scope = catalogStorageScope()): void {
  const catalog = normalizeCachedSessionCatalog({
    version: 1,
    updatedAt: Date.now(),
    rows,
  });
  try {
    contentLocalStorage().setItem(catalogStorageKey(SESSION_CATALOG_STORAGE_KEY, scope), JSON.stringify(catalog));
  } catch {
    // The authoritative live catalog remains usable when storage is unavailable.
  }
}

/** An authoritative catalog (an exact store scan) no longer lists sessions the
 *  previous one did: they were deleted somewhere (another window, the phone, a
 *  sweep), so their on-device image previews go. `keep` are ids that are only
 *  absent because the renderer has not seen them durably yet. A session merely
 *  missing from a partial list must not be passed here. */
export function purgeRemovedSessionPreviews(
  previous: readonly DesktopSessionSummary[],
  next: readonly DesktopSessionSummary[],
  keep: ReadonlySet<string> = new Set()
): void {
  const present = new Set(next.map((row) => row.id));
  for (const row of previous) {
    if (!present.has(row.id) && !keep.has(row.id)) deleteSessionImagePreviews(row.id);
  }
}

let pendingCatalogRows: { rows: DesktopSessionSummary[]; scope: string } | null = null;
let pendingCatalogTimer: number | undefined;

/** Keep live sidebar publication immediate while coalescing the synchronous
 * JSON/localStorage persistence that is only used for the next app startup. */
export function scheduleCachedSessionCatalogWrite(rows: DesktopSessionSummary[]): void {
  pendingCatalogRows = { rows, scope: catalogStorageScope() };
  if (pendingCatalogTimer !== undefined) return;
  pendingCatalogTimer = window.setTimeout(flushCachedSessionCatalogWrite, 1_000);
}

/** Commit the latest coalesced catalog before a renderer navigation/exit. */
export function flushCachedSessionCatalogWrite(): void {
  if (pendingCatalogTimer !== undefined) {
    window.clearTimeout(pendingCatalogTimer);
    pendingCatalogTimer = undefined;
  }
  const pending = pendingCatalogRows;
  pendingCatalogRows = null;
  if (pending) writeCachedSessionCatalog(pending.rows, pending.scope);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushCachedSessionCatalogWrite);
}
