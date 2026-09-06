import type {
  DesktopModelSelection,
  DesktopSessionSummary,
  SessionSnapshot,
} from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";
import type { NavigationSelection } from "./navigation";
import type { PaneLeaf } from "./pane-layout";
import { navigationKey } from "./text-format";

type SessionSelection = Extract<NavigationSelection, { kind: "session" }>;

interface InheritanceTarget {
  inherit(sourceId: string, route: DesktopModelSelection): Promise<{
    sessionId: string;
    snapshot: SessionSnapshot;
  }>;
  leaves(): readonly PaneLeaf[];
  focusedLeafId(): string;
  sourceTitle(): string;
  refreshSessions(): Promise<DesktopSessionSummary[]>;
  readSession(sessionId: string): Promise<boolean>;
  snapshot(sessionId: string): SessionSnapshot;
  prepare(sessionId: string, snapshot: SessionSnapshot): void;
  replace(
    leafId: string,
    selection: SessionSelection,
    title: string,
    sourceKey: string,
    focused: boolean,
  ): void;
}

/** Prepare off-screen, then replace the addressed tab in one synchronous commit.
 * Never close/open: that would animate the strip and expose a cold transcript. */
export async function inheritSessionInPlace(
  sourceId: string,
  route: DesktopModelSelection,
  target: InheritanceTarget,
): Promise<void> {
  const sourceKey = navigationKey({ kind: "session", id: sourceId });
  const ownsSource = (leaf: PaneLeaf) =>
    leaf.tabs.some((tab) => navigationKey(tab) === sourceKey);
  const owner = target.leaves().find((leaf) =>
    leaf.id === target.focusedLeafId() && ownsSource(leaf))
    ?? target.leaves().find(ownsSource);
  if (!owner) throw new Error("The source session tab is no longer open.");
  const fallbackTitle = target.sourceTitle();

  const result = await target.inherit(sourceId, route);
  const sessionId = String(result?.sessionId || "").trim();
  if (!sessionId || sessionId === sourceId) {
    throw new Error("The inherited session was not created.");
  }
  let snapshot = result.snapshot;
  if (snapshot && String(snapshot.sessionId || "") !== sessionId) {
    throw new Error("The inherited session returned a mismatched session snapshot.");
  }
  if (!snapshot || !Array.isArray(snapshot.items)) {
    await target.readSession(sessionId);
    snapshot = target.snapshot(sessionId);
  }
  if (!snapshot || String(snapshot.sessionId || "") !== sessionId
    || !Array.isArray(snapshot.items)) {
    throw new Error("The inherited conversation is not ready. The original tab has been kept.");
  }
  // Catalog freshness is best-effort; a prepared transcript can still replace
  // the source using its returned title while a disconnected catalog recovers.
  const rows = await target.refreshSessions().catch(() => []);
  const row = rows.find((entry) => entry.id === sessionId);
  const title = String(snapshot.desktopSessionTitle || "").trim()
    || (row ? sessionSummaryTitle(row) : fallbackTitle)
    || "Untitled session";

  // Follow a tab moved to another pane, but never reopen a tab closed while
  // inheritance was running or steal focus from a newer selection.
  const leaf = target.leaves().find((entry) => entry.id === owner.id && ownsSource(entry))
    ?? target.leaves().find(ownsSource);
  if (!leaf) return;
  target.prepare(sessionId, snapshot);
  target.replace(
    leaf.id,
    { kind: "session", id: sessionId },
    title,
    sourceKey,
    leaf.id === target.focusedLeafId() && leaf.activeKey === sourceKey,
  );
}
