import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Snapshot } from "./desktop-types";
import { t } from "./i18n";
import { ProgressSpinner } from "./ProgressSpinner";
import { ScmPathText } from "./ScmPathText";
import { ScmStatusIcon, scmStatusKind } from "./ScmStatusIcon";
import {
  buildSessionDiffRows,
  type SessionDiffResult,
  type SessionDiffRow,
} from "./session-diff-model";
import { fetchSessionDiff, peekSessionDiff } from "./session-diff-cache";
import {
  defaultSessionLaneStore,
  useSessionLane,
} from "./session-lane-store";

function activityKey(snapshot: Snapshot | null): string {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const last = items.at(-1);
  return [
    items.length,
    String(last?.id || ""),
    String(last?.completedAt || last?.completedCount || ""),
    snapshot?.busy ? "1" : "0",
    snapshot?.commandBusy ? "1" : "0",
  ].join(":");
}

function sessionDiffSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  return activityKey(left) === activityKey(right);
}

/** Every state renders inside the same flex-column frame, so an empty, loading
 *  or failed pane centres its message on both axes exactly like the other
 *  dock panes (user: 비어있을때 문구는 상하정렬). */
function SessionDiffFrame({ children }: { children: ReactNode }) {
  return <section className="session-diff-pane" aria-label={t("Session diff")}>
    {children}
  </section>;
}

/** One changed file in the Source Control Changes row grammar — dim directory
 *  + bright name + trailing status glyph, nothing else (user: 소스 컨트롤
 *  목록엔 +- 안 나오는데 세션 디프엔 나온다든지 이상해). A click opens the
 *  file in the dock's left diff column, exactly as a Source Control row does;
 *  the open file's row reads as the selected row. */
function SessionDiffFileRow({ row, open, onOpen }: {
  row: SessionDiffRow;
  open: boolean;
  onOpen(): void;
}) {
  const slash = row.path.lastIndexOf("/");
  const fileName = slash >= 0 ? row.path.slice(slash + 1) : row.path;
  const oldSlash = row.oldPath.lastIndexOf("/");
  const oldFileName = row.oldPath
    ? oldSlash >= 0 ? row.oldPath.slice(oldSlash + 1) : row.oldPath
    : "";
  const displayName = row.oldPath && row.oldPath !== row.path
    ? `${oldFileName} → ${fileName}`
    : fileName;
  const kind = scmStatusKind(row.status);
  return <li role="none">
    <div className="dock-scm-file session-diff-file" role="treeitem"
      aria-selected={open} data-selected={open || undefined}>
      <button type="button" className="dock-scm-file-main" title={row.path}
        data-status={kind}
        aria-label={t("Open changes {{path}}", { path: row.path })}
        onClick={onOpen}>
        <ScmPathText path={row.path} name={displayName} />
      </button>
      <ScmStatusIcon kind={kind} className="dock-scm-file-state" />
    </div>
  </li>;
}

export function SessionDiffPane({
  sessionId,
  active,
  openRel = "",
  onOpenDiff,
}: {
  sessionId: string;
  active: boolean;
  /** The file this session currently shows in the dock's diff column. */
  openRel?: string;
  /** Opens (or replaces) the session's file in the dock's diff column. */
  onOpenDiff?(rel: string): void;
}) {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    sessionDiffSnapshotsEqual,
    active,
  );
  const revision = activityKey(lane);
  const busy = Boolean(lane?.busy || lane?.commandBusy);
  // A revisited session paints its cached rows instantly while the refresh
  // below revalidates behind them.
  const [result, setResult] = useState<SessionDiffResult | null>(
    () => peekSessionDiff(sessionId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    request.current += 1;
    setResult(peekSessionDiff(sessionId));
    setError("");
  }, [sessionId]);
  const refresh = useCallback(async (force = true) => {
    if (!active || !sessionId) return;
    const current = ++request.current;
    if (!peekSessionDiff(sessionId)) setLoading(true);
    setError("");
    try {
      const next = await fetchSessionDiff(sessionId, { force });
      if (request.current !== current) return;
      setResult(next);
    } catch (reason) {
      if (request.current !== current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request.current === current) setLoading(false);
    }
  }, [active, sessionId]);
  useEffect(() => {
    if (!active || !sessionId) return;
    void refresh(true);
    // The lane revision changes only at meaningful session boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, revision, sessionId]);
  useEffect(() => {
    if (!active || !sessionId || !busy) return undefined;
    const timer = window.setInterval(() => void refresh(true), 4_000);
    return () => window.clearInterval(timer);
  }, [active, busy, refresh, sessionId]);
  const rows = useMemo(() => buildSessionDiffRows(result), [result]);
  const additions = rows.reduce((total, row) => total + row.additions, 0);
  const deletions = rows.reduce((total, row) => total + row.deletions, 0);

  if (!sessionId) {
    return <SessionDiffFrame>
      <p className="utility-dock-empty">{t("Open a session to view its diff.")}</p>
    </SessionDiffFrame>;
  }
  if (loading && !result) {
    return <SessionDiffFrame>
      <div className="session-diff-loading" role="status">
        <ProgressSpinner size={20} aria-hidden="true" />
        <span>{t("Loading session diff…")}</span>
      </div>
    </SessionDiffFrame>;
  }
  if (error) {
    return <SessionDiffFrame>
      <div className="session-diff-state" role="alert">
        <span>{error}</span>
        <button type="button" onClick={() => void refresh(true)}>{t("Retry")}</button>
      </div>
    </SessionDiffFrame>;
  }
  if (result?.supported === false) {
    return <SessionDiffFrame>
      <p className="utility-dock-empty">{t("Session diff is unavailable.")}</p>
    </SessionDiffFrame>;
  }
  return <SessionDiffFrame>
    {/* The same 29px band Source Control heads its Changes list with: the
        count (and the session's +/− totals — the rows carry none) on the left
        text axis, the icon actions clustered at the right. Unified/Split live
        on the diff column itself, not here. */}
    <div className="session-diff-header">
      <span className="session-diff-summary">
        <span>{rows.length === 1
          ? t("1 file changed")
          : t("{{count}} files changed", { count: rows.length })}</span>
        {(additions > 0 || deletions > 0) && <span className="diff-stats">
          {additions > 0 && <i>+{additions}</i>}
          {deletions > 0 && <em>-{deletions}</em>}
        </span>}
      </span>
      <span className="dock-scm-list-actions session-diff-actions">
        <button type="button" aria-label={t("Refresh")} title={t("Refresh")}
          data-tooltip={t("Refresh")}
          disabled={loading} onClick={() => void refresh(true)}>
          {loading
            ? <ProgressSpinner size={14} aria-hidden="true" />
            : <RefreshCw size={14} aria-hidden="true" />}
        </button>
      </span>
    </div>
    {result?.patchTruncated && <p className="session-diff-notice">
      {t("The session diff was truncated.")}
    </p>}
    {rows.length === 0
      ? <p className="utility-dock-empty">{t("No changes from this session.")}</p>
      : <ul className="session-diff-files" role="tree">
        {rows.map((row) => <SessionDiffFileRow key={row.path} row={row}
          open={openRel === row.path}
          onOpen={() => onOpenDiff?.(row.path)} />)}
      </ul>}
  </SessionDiffFrame>;
}

