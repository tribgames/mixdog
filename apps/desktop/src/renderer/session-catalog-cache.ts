import type { DesktopSessionSummary } from "../shared/contract";

export const SESSION_CATALOG_STORAGE_KEY = "mixdog.desktop-session-catalog.v1";
const SESSION_CATALOG_LIMIT = 500;

export interface CachedSessionCatalog {
  version: 1;
  updatedAt: number;
  rows: DesktopSessionSummary[];
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cachedSessionRow(value: unknown): DesktopSessionSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const preview = text(row.preview, 1_024);
  const title = text(row.title, 1_024) || preview;
  const classification: DesktopSessionSummary["classification"] =
    row.classification === "project" ? "project" : "task";
  const projectPath = text(row.projectPath, 32_768);
  const sourceType = row.sourceType === "schedule" || row.sourceType === "webhook"
    ? row.sourceType
    : undefined;
  const sourceName = text(row.sourceName, 1_024);
  const sourceDelivery = row.sourceDelivery === "app"
    || row.sourceDelivery === "channel"
    || row.sourceDelivery === "both"
    ? row.sourceDelivery
    : undefined;
  const activityAt = finiteNumber(row.activityAt, Number.NaN);

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
    ...(sourceType ? { sourceType } : {}),
    ...(sourceName ? { sourceName } : {}),
    ...(sourceDelivery ? { sourceDelivery } : {}),
  };
}

export function normalizeCachedSessionCatalog(value: unknown): CachedSessionCatalog {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    const stored = JSON.parse(window.localStorage.getItem(SESSION_CATALOG_STORAGE_KEY) || "null");
    return normalizeCachedSessionCatalog(stored).rows;
  } catch {
    return [];
  }
}

export function writeCachedSessionCatalog(rows: DesktopSessionSummary[]): void {
  const catalog = normalizeCachedSessionCatalog({
    version: 1,
    updatedAt: Date.now(),
    rows,
  });
  try {
    window.localStorage.setItem(SESSION_CATALOG_STORAGE_KEY, JSON.stringify(catalog));
  } catch {
    // The authoritative live catalog remains usable when storage is unavailable.
  }
}

let pendingCatalogRows: DesktopSessionSummary[] | null = null;
let pendingCatalogTimer: number | undefined;

/** Keep live sidebar publication immediate while coalescing the synchronous
 * JSON/localStorage persistence that is only used for the next app startup. */
export function scheduleCachedSessionCatalogWrite(rows: DesktopSessionSummary[]): void {
  pendingCatalogRows = rows;
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
  if (pending) writeCachedSessionCatalog(pending);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushCachedSessionCatalogWrite);
}
