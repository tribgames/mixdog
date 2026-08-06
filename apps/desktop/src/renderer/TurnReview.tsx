import { Check, FileDiff, RotateCcw, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n";
import { GitDiffBody } from "./ReviewPane";
import { findPatch, PATCH_CACHE_LIMIT } from "./TranscriptView";
import { REVIEW_DIFF_STYLE_KEY, type TranscriptItem } from "./desktop-types";
import { parseUnifiedDiff } from "./renderer-logic.mjs";


// "Review Changes": the headline is one authoritative turn-start → current
// worktree diff. Exact worker apply_patch diffs remain attribution metadata and
// are only added to totals in the non-Git fallback.
type TurnReviewPatchPart = ReturnType<typeof parseUnifiedDiff>[number];
type TurnReviewFile = {
  path: string;
  oldPath?: string | null;
  status?: string;
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
};
type TurnReviewSummary = {
  files: Map<string, {
    additions: number;
    deletions: number;
    lineStats: boolean;
    status: string;
    binary: boolean;
    parts: ReturnType<typeof parseUnifiedDiff>;
  }>;
  additions: number;
  deletions: number;
  hasLineStats: boolean;
};
type AgentTurnReview = {
  sessionId: string;
  agent: string | null;
  tag: string | null;
  patch: string;
};
const turnReviewPatchCache = new Map<string, Array<{
  name: string;
  additions: number;
  deletions: number;
  lineStats: boolean;
  status: string;
  binary: boolean;
  part: TurnReviewPatchPart;
}>>();
const TURN_REVIEW_PATCH_CACHE_MAX_CHARS = 4 * 1024 * 1024;
const TURN_REVIEW_PATCH_CACHE_ENTRY_MAX_CHARS = 512 * 1024;

// Last known worker-review result per turn scope. The floating bar consumes no
// transcript layout, while the cache still avoids repeating patch parsing and
// lets a revisited turn show its known review immediately.
const AGENT_REVIEW_CACHE_LIMIT = 32;
const AGENT_REVIEW_SCOPE_MAX_CHARS = 4 * 1024 * 1024;
const AGENT_REVIEW_CACHE_MAX_CHARS = 8 * 1024 * 1024;
const agentReviewCache = new Map<string, AgentTurnReview[]>();
const leadReviewCache = new Map<string, string | null>();
const leadReviewFilesCache = new Map<string, TurnReviewFile[]>();
const leadReviewSnapshotKindCache = new Map<string, string>();
function reviewChars(reviews: AgentTurnReview[], leadPatch: string | null): number {
  return (leadPatch?.length || 0) + reviews.reduce((total, review) => total + review.patch.length, 0);
}
function retainedReviewChars(): number {
  let total = 0;
  for (const [scopeKey, reviews] of agentReviewCache) {
    total += reviewChars(reviews, leadReviewCache.get(scopeKey) ?? null);
  }
  return total;
}
function rememberAgentReviews(
  scopeKey: string,
  reviews: AgentTurnReview[],
  leadPatch: string | null,
  files: TurnReviewFile[],
  snapshotKind: string,
): void {
  agentReviewCache.delete(scopeKey);
  leadReviewCache.delete(scopeKey);
  leadReviewFilesCache.delete(scopeKey);
  leadReviewSnapshotKindCache.delete(scopeKey);
  if (reviewChars(reviews, leadPatch) > AGENT_REVIEW_SCOPE_MAX_CHARS) return;
  agentReviewCache.set(scopeKey, reviews);
  leadReviewCache.set(scopeKey, leadPatch);
  leadReviewFilesCache.set(scopeKey, files);
  leadReviewSnapshotKindCache.set(scopeKey, snapshotKind);
  while (
    agentReviewCache.size > AGENT_REVIEW_CACHE_LIMIT
    || retainedReviewChars() > AGENT_REVIEW_CACHE_MAX_CHARS
  ) {
    const oldest = agentReviewCache.keys().next().value;
    if (oldest === undefined) break;
    agentReviewCache.delete(oldest);
    leadReviewCache.delete(oldest);
    leadReviewFilesCache.delete(oldest);
    leadReviewSnapshotKindCache.delete(oldest);
  }
}

function patchMetadataStatus(patch: string): string {
  if (/^Binary files /m.test(patch)) return "binary";
  if (/^rename from /m.test(patch) || /^rename to /m.test(patch)) return "R";
  if (/^new file mode /m.test(patch)) return "A";
  if (/^deleted file mode /m.test(patch)) return "D";
  if (/^(old mode|new mode) /m.test(patch)) return "T";
  return "";
}

function analyzeTurnReviewPatch(patch: string) {
  const cached = turnReviewPatchCache.get(patch);
  if (cached) {
    turnReviewPatchCache.delete(patch);
    turnReviewPatchCache.set(patch, cached);
    return cached;
  }
  const analyzed = parseUnifiedDiff(patch).flatMap((part) => {
    const name = String(part.newFile?.fileName || "");
    if (!name) return [];
    let additions = 0;
    let deletions = 0;
    for (const line of part.hunks.join("\n").split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    const status = patchMetadataStatus(String(part.patch || ""));
    // A bare `diff --git` header is not a file change. It used to survive as
    // an empty parsed part and rendered the misleading “+0 -0” row.
    if (additions === 0 && deletions === 0 && !status) return [];
    return [{
      name,
      additions,
      deletions,
      lineStats: additions + deletions > 0,
      status,
      binary: status === "binary",
      part,
    }];
  });
  if (patch.length <= TURN_REVIEW_PATCH_CACHE_ENTRY_MAX_CHARS) {
    turnReviewPatchCache.set(patch, analyzed);
    let retainedChars = [...turnReviewPatchCache.keys()]
      .reduce((total, value) => total + value.length, 0);
    while (
      turnReviewPatchCache.size > PATCH_CACHE_LIMIT
      || retainedChars > TURN_REVIEW_PATCH_CACHE_MAX_CHARS
    ) {
      const oldest = turnReviewPatchCache.keys().next().value;
      if (oldest === undefined) break;
      retainedChars -= oldest.length;
      turnReviewPatchCache.delete(oldest);
    }
  }
  return analyzed;
}

function summarizeTurnReviewPatch(patch: string): TurnReviewSummary {
  const files: TurnReviewSummary["files"] = new Map();
  if (patch) {
    try {
      for (const analyzed of analyzeTurnReviewPatch(patch)) {
        const entry = files.get(analyzed.name) || {
          additions: 0,
          deletions: 0,
          lineStats: false,
          status: "",
          binary: false,
          parts: [],
        };
        entry.additions += analyzed.additions;
        entry.deletions += analyzed.deletions;
        entry.lineStats ||= analyzed.lineStats;
        entry.status ||= analyzed.status;
        entry.binary ||= analyzed.binary;
        entry.parts.push(analyzed.part);
        files.set(analyzed.name, entry);
      }
    } catch { /* malformed/non-diff payload — skip */ }
  }
  let additions = 0;
  let deletions = 0;
  let hasLineStats = false;
  for (const entry of files.values()) {
    additions += entry.additions;
    deletions += entry.deletions;
    hasLineStats ||= entry.lineStats;
  }
  return { files, additions, deletions, hasLineStats };
}

function summarizeAuthoritativeTurnReview(filesInput: TurnReviewFile[], patch: string): TurnReviewSummary {
  const parsed = summarizeTurnReviewPatch(patch);
  const files: TurnReviewSummary["files"] = new Map();
  for (const row of filesInput) {
    const name = String(row?.path || "");
    if (!name) continue;
    const parsedEntry = parsed.files.get(name) || (
      row.oldPath ? parsed.files.get(String(row.oldPath)) : undefined
    );
    const additions = typeof row.additions === "number" ? row.additions : 0;
    const deletions = typeof row.deletions === "number" ? row.deletions : 0;
    files.set(name, {
      additions,
      deletions,
      lineStats: additions + deletions > 0,
      status: String(row.status || parsedEntry?.status || "M"),
      binary: row.binary === true || parsedEntry?.binary === true,
      parts: parsedEntry?.parts || [],
    });
  }
  let additions = 0;
  let deletions = 0;
  let hasLineStats = false;
  for (const entry of files.values()) {
    additions += entry.additions;
    deletions += entry.deletions;
    hasLineStats ||= entry.lineStats;
  }
  return { files, additions, deletions, hasLineStats };
}

function mergeTurnReviewSummaries(summaries: TurnReviewSummary[]): TurnReviewSummary {
  const files: TurnReviewSummary["files"] = new Map();
  let additions = 0;
  let deletions = 0;
  for (const summary of summaries) {
    additions += summary.additions;
    deletions += summary.deletions;
    for (const [name, entry] of summary.files) {
      const merged = files.get(name) || {
        additions: 0,
        deletions: 0,
        lineStats: false,
        status: "",
        binary: false,
        parts: [],
      };
      merged.additions += entry.additions;
      merged.deletions += entry.deletions;
      merged.lineStats ||= entry.lineStats;
      merged.status ||= entry.status;
      merged.binary ||= entry.binary;
      merged.parts.push(...entry.parts);
      files.set(name, merged);
    }
  }
  return {
    files,
    additions,
    deletions,
    hasLineStats: summaries.some((summary) => summary.hasLineStats),
  };
}

function statusLabel(entry: TurnReviewSummary["files"] extends Map<string, infer T> ? T : never): string {
  if (entry.binary) return t("Binary");
  if (entry.status === "R") return t("Renamed");
  if (entry.status === "C") return t("Copied");
  if (entry.status === "A") return t("Added");
  if (entry.status === "D") return t("Deleted");
  if (entry.status === "T") return t("Metadata");
  return entry.lineStats ? "" : t("Changed");
}

// Single-quoted so the capability-inventory source scan counts this surface.
const TURN_REVIEW_CAPABILITY = 'getTurnReviewDiff';

export const TurnReviewBar = memo(function TurnReviewBar({ items, cwd, sessionId }: {
  items: TranscriptItem[];
  cwd?: string;
  sessionId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openFile, setOpenFile] = useState("");
  const [confirmFile, setConfirmFile] = useState("");
  const [reverted, setReverted] = useState<string[]>([]);
  // An expanded review closes on the first pointer press OUTSIDE its own box.
  // Presses inside (rows, revert, diff style) keep it open, so the disclosure
  // never collapses under its own controls.
  const barElement = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!expanded) return undefined;
    const closeOnOutsidePointer = (event: Event) => {
      const element = barElement.current;
      const target = event.target as Node | null;
      if (!element || (target && element.contains(target))) return;
      setExpanded(false);
      setOpenFile("");
      setConfirmFile("");
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [expanded]);
  const turnScopeKey = useMemo(() => {
    let lastUser = -1;
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index]?.kind === "user") { lastUser = index; break; }
    }
    const turnId = lastUser >= 0 ? String(items[lastUser]?.id ?? lastUser) : "none";
    return `${String(sessionId || "draft")}:${turnId}`;
  }, [items, sessionId]);
  const activeScope = useRef(turnScopeKey);
  activeScope.current = turnScopeKey;
  const [agentReviewState, setAgentReviewState] = useState<{
    scopeKey: string;
    reviews: AgentTurnReview[];
    leadPatch: string | null;
    files: TurnReviewFile[];
    snapshotKind: string;
  }>(() => ({
    scopeKey: turnScopeKey,
    reviews: agentReviewCache.get(turnScopeKey) || [],
    leadPatch: leadReviewCache.get(turnScopeKey) ?? null,
    files: leadReviewFilesCache.get(turnScopeKey) || [],
    snapshotKind: leadReviewSnapshotKindCache.get(turnScopeKey) || "",
  }));
  // Keying the read as well as the write prevents a one-frame stale bar before
  // effects run when the user switches sessions or opens New task.
  const agentReviews = agentReviewState.scopeKey === turnScopeKey
    ? agentReviewState.reviews
    : (agentReviewCache.get(turnScopeKey) || []);
  const authoritativeLeadPatch = agentReviewState.scopeKey === turnScopeKey
    ? agentReviewState.leadPatch
    : (leadReviewCache.get(turnScopeKey) ?? null);
  const authoritativeLeadFiles = agentReviewState.scopeKey === turnScopeKey
    ? agentReviewState.files
    : (leadReviewFilesCache.get(turnScopeKey) || []);
  const authoritativeSnapshotKind = agentReviewState.scopeKey === turnScopeKey
    ? agentReviewState.snapshotKind
    : (leadReviewSnapshotKindCache.get(turnScopeKey) || "");
  const authoritativeWorktreeSnapshot = authoritativeSnapshotKind === "worktree";
  const capabilityFailures = useRef(0);
  const capabilityRequestInFlight = useRef(false);
  const lastAgentReviewSignature = useRef<string | null>(null);
  useEffect(() => {
    capabilityFailures.current = 0;
    capabilityRequestInFlight.current = false;
    lastAgentReviewSignature.current = null;
    setExpanded(false);
    setOpenFile("");
    setConfirmFile("");
    setReverted([]);
  }, [turnScopeKey]);
  // Only probe once the transcript shows turn activity: a fresh/empty session
  // has no child review and passive mounts must not fire capability calls.
  const hasTurnActivity = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index]?.kind === "user") return false;
      if (items[index]) return true;
    }
    return false;
  }, [items]);
  const refreshAgentReviews = useCallback(async () => {
    const api = window.mixdogDesktop as {
      invokeCapability?: (request: {
        capability: string;
        args: unknown[];
        sessionId?: string;
      }) => Promise<{ value?: unknown }>;
    } | undefined;
    if (!sessionId || !api?.invokeCapability || capabilityFailures.current >= 3) return;
    if (capabilityRequestInFlight.current || document.visibilityState === "hidden") return;
    const requestedScope = turnScopeKey;
    capabilityRequestInFlight.current = true;
    try {
      // This bar belongs to the pane's session. During a tab switch the host's
      // focused view can already point elsewhere, so omitting this address
      // mixed another turn's diff into the bar and could hit a stale view.
      const result = await api.invokeCapability({
        capability: TURN_REVIEW_CAPABILITY,
        args: [],
        sessionId,
      });
      const value = (result?.value ?? null) as {
        supported?: boolean;
        authoritative?: boolean;
        snapshotKind?: unknown;
        patch?: unknown;
        files?: Array<{
          path?: unknown;
          oldPath?: unknown;
          status?: unknown;
          additions?: unknown;
          deletions?: unknown;
          binary?: unknown;
        }>;
        agents?: Array<{
          sessionId?: unknown;
          agent?: unknown;
          tag?: unknown;
          patch?: unknown;
        }>;
      } | null;
      if (!value || value.supported === false) {
        capabilityFailures.current += 1;
        return;
      }
      capabilityFailures.current = 0;
      const leadPatch = value.authoritative === true
        ? (typeof value.patch === "string" ? value.patch : "")
        : null;
      const snapshotKind = value.authoritative === true ? String(value.snapshotKind || "") : "";
      const files = (value.authoritative === true && Array.isArray(value.files) ? value.files : []).flatMap((row) => {
        const path = String(row?.path || "");
        if (!path) return [];
        return [{
          path,
          oldPath: row?.oldPath ? String(row.oldPath) : null,
          status: row?.status ? String(row.status) : "M",
          additions: typeof row?.additions === "number" ? row.additions : null,
          deletions: typeof row?.deletions === "number" ? row.deletions : null,
          binary: row?.binary === true,
        }];
      });
      const reviews = (Array.isArray(value.agents) ? value.agents : []).flatMap((review) => {
        const childSessionId = String(review?.sessionId || "");
        const patch = typeof review?.patch === "string" ? review.patch : "";
        if (!childSessionId || !patch) return [];
        return [{
          sessionId: childSessionId,
          agent: review?.agent ? String(review.agent) : null,
          tag: review?.tag ? String(review.tag) : null,
          patch,
        }];
      });
      const signature = JSON.stringify([leadPatch, files, snapshotKind, reviews]);
      rememberAgentReviews(requestedScope, reviews, leadPatch, files, snapshotKind);
      if (lastAgentReviewSignature.current === signature) return;
      lastAgentReviewSignature.current = signature;
      if (activeScope.current === requestedScope) {
        setAgentReviewState({
          scopeKey: requestedScope,
          reviews,
          leadPatch,
          files,
          snapshotKind,
        });
      }
    } catch {
      capabilityFailures.current += 1;
    } finally {
      capabilityRequestInFlight.current = false;
    }
  }, [sessionId, turnScopeKey]);
  // Refresh on turn boundaries, not every streaming transcript publication.
  // The idle poll catches a worker completion that lands without another Lead
  // transcript item; unchanged review signatures avoid redundant state writes.
  const turnBoundaryKey = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!item) continue;
      if (item.kind === "turndone" || item.kind === "statusdone" || item.kind === "tool") {
        return `${String(item.id ?? index)}:${String(item.completedAt ?? item.completedCount ?? "")}`;
      }
    }
    return "";
  }, [items]);
  useEffect(() => {
    if (hasTurnActivity) void refreshAgentReviews();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- turnBoundaryKey stands in for items
  }, [refreshAgentReviews, hasTurnActivity, turnBoundaryKey]);
  useEffect(() => {
    if (!hasTurnActivity && agentReviews.length === 0) return undefined;
    const timer = window.setInterval(() => { void refreshAgentReviews(); }, 6_000);
    return () => window.clearInterval(timer);
  }, [refreshAgentReviews, hasTurnActivity, agentReviews.length]);
  // Shares the Review pane's persisted diff-style preference (user request:
  // the expanded bar renders real diffs, so it needs the same Unified/Split
  // control).
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(() => {
    try { return window.localStorage.getItem(REVIEW_DIFF_STYLE_KEY) === "split" ? "split" : "unified"; }
    catch { return "unified"; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(REVIEW_DIFF_STYLE_KEY, diffStyle); } catch { /* persistence only */ }
  }, [diffStyle]);
  const transcriptSummary = useMemo(() => {
    let lastUser = -1;
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index]?.kind === "user") { lastUser = index; break; }
    }
    const patches: string[] = [];
    let latestUiDiff: string | null = null;
    for (let index = lastUser + 1; index < items.length; index++) {
      const item = items[index];
      if (!item || item.kind !== "tool") continue;
      if (Object.hasOwn(item, "uiDiff")) {
        latestUiDiff = typeof item.uiDiff === "string" ? item.uiDiff : "";
        continue;
      }
      const count = Math.max(1, Number(item.count || 1));
      const failed = item.isError === true || Number(item.errorCount || 0) >= count;
      if (failed) continue;
      const patch = findPatch(item);
      if (typeof patch !== "string" || !patch) continue;
      patches.push(patch);
    }
    // The completed tool item is published in the same frame as the mutation
    // and therefore beats the polled capability snapshot during rapid,
    // same-card edits. An explicit empty uiDiff is authoritative too: it means
    // the latest apply_patch restored the turn baseline.
    if (authoritativeWorktreeSnapshot) {
      return summarizeAuthoritativeTurnReview(
        authoritativeLeadFiles,
        authoritativeLeadPatch || "",
      );
    }
    return summarizeTurnReviewPatch(latestUiDiff ?? authoritativeLeadPatch ?? patches.join("\n"));
  }, [
    authoritativeLeadFiles,
    authoritativeLeadPatch,
    authoritativeWorktreeSnapshot,
    items,
  ]);
  const agentSources = useMemo(() => agentReviews.flatMap((review, index) => {
    const reviewSummary = summarizeTurnReviewPatch(review.patch);
    if (reviewSummary.files.size === 0) return [];
    const label = review.tag && review.agent && review.tag !== review.agent
      ? `${review.tag} · ${review.agent}`
      : (review.tag || review.agent || "Agent");
    return [{
      key: `${review.sessionId}:${index}`,
      label,
      summary: reviewSummary,
    }];
  }), [agentReviews]);
  const agentSummary = useMemo(
    () => mergeTurnReviewSummaries(agentSources.map((source) => source.summary)),
    [agentSources],
  );
  const summary = useMemo(
    () => authoritativeWorktreeSnapshot
      ? transcriptSummary
      : mergeTurnReviewSummaries([transcriptSummary, agentSummary]),
    [transcriptSummary, agentSummary, authoritativeWorktreeSnapshot],
  );
  const sources = useMemo(() => [
    ...(transcriptSummary.files.size > 0
      ? [{
        key: authoritativeWorktreeSnapshot ? "turn" : "lead",
        label: authoritativeWorktreeSnapshot ? "Turn" : "Lead",
        summary: transcriptSummary,
      }]
      : []),
    ...agentSources,
  ], [transcriptSummary, agentSources, authoritativeWorktreeSnapshot]);
  if (summary.files.size === 0) return null;
  return (
    <section ref={barElement} className="turn-review-bar" aria-label={t("Files changed this turn")}
      data-expanded={expanded ? "true" : "false"}>
      <div className="turn-review-head">
        <button type="button" className="turn-review-summary" aria-expanded={expanded}
          onClick={() => setExpanded((value) => {
            const next = !value;
            // Collapsing also closes any open inline diff/confirm so reopening
            // starts from the tidy list, not a tall stale diff.
            if (!next) { setOpenFile(""); setConfirmFile(""); }
            return next;
          })}>
          <FileDiff size={14} aria-hidden="true" />
          <strong>{summary.files.size === 1 ? t("1 file changed") : t("{{count}} files changed", { count: summary.files.size })}</strong>
          {/* The counters belong to the TITLE, not to the (now removed)
              expander side of the row. */}
          {summary.hasLineStats && (
            <span className="diff-stats"><i>+{summary.additions}</i><em>-{summary.deletions}</em></span>
          )}
          {agentSources.length > 0 && <span className="turn-review-attribution">
            {authoritativeWorktreeSnapshot
              ? t("Agents {{agents}} attributed", { agents: agentSummary.files.size })
              : t("Lead {{lead}} · Agents {{agents}}", {
                lead: transcriptSummary.files.size,
                agents: agentSummary.files.size,
              })}
          </span>}
        </button>
        {expanded && <div className="review-style-toggle turn-review-style" role="radiogroup"
          aria-label={t("Diff style")}>
          <button type="button" aria-pressed={diffStyle === "unified"}
            onClick={() => setDiffStyle("unified")}>{t("Unified")}</button>
          <button type="button" aria-pressed={diffStyle === "split"}
            onClick={() => setDiffStyle("split")}>{t("Split")}</button>
        </div>}
      </div>
      <div className="turn-review-collapse" inert={!expanded} aria-hidden={!expanded}>
        <div className="turn-review-collapse-inner">
          <ul className="turn-review-files">
        {sources.flatMap((source) => {
          const sourceHeader = (
            <li key={`${source.key}:source`} className="turn-review-source">
              <strong>{t(source.label)}</strong>
              <span>{source.summary.files.size === 1 ? t("1 file") : t("{{count}} files", { count: source.summary.files.size })}</span>
              {source.summary.hasLineStats && (
                <span className="diff-stats">
                  <i>+{source.summary.additions}</i><em>-{source.summary.deletions}</em>
                </span>
              )}
            </li>
          );
          const rows = [...source.summary.files.entries()].map(([name, entry]) => {
          // Tool patches sometimes carry ABSOLUTE paths; display and revert
          // use the project-relative form (git confinement expects it).
          const normalizedCwd = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
          const normalizedName = name.replace(/\\/g, "/");
          const rel = normalizedCwd && normalizedName.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)
            ? normalizedName.slice(normalizedCwd.length + 1)
            : normalizedName;
          const rowKey = `${source.key}:${name}`;
          const isReverted = reverted.includes(name);
          const confirming = confirmFile === name;
          return (
          <li key={rowKey} data-open={openFile === rowKey ? "true" : "false"}
            data-reverted={isReverted ? "true" : "false"}>
            <button type="button" className="turn-review-file" aria-expanded={openFile === rowKey}
              onClick={() => setOpenFile((current) => current === rowKey ? "" : rowKey)}>
              <code>{rel}</code>
              {statusLabel(entry) && <span className="turn-review-status">{statusLabel(entry)}</span>}
              {entry.lineStats && (
                <span className="diff-stats"><i>+{entry.additions}</i><em>-{entry.deletions}</em></span>
              )}
            </button>
            {Boolean(cwd) && authoritativeWorktreeSnapshot && source.key === "turn" && !isReverted && (confirming ? (
              <span className="turn-review-confirm" role="group"
                aria-label={t("Confirm reverting {{file}} to the start of this turn", { file: rel })}>
                <button type="button" className="turn-review-revert"
                  aria-label={t("Cancel revert")} data-tooltip={t("Cancel")}
                  onClick={() => setConfirmFile("")}>
                  <X size={12} />
                </button>
                <button type="button" className="turn-review-revert danger"
                  aria-label={t("Confirm revert of {{file}}", { file: rel })} data-tooltip={t("Revert to turn start")}
                  onClick={() => {
                    setConfirmFile("");
                    void window.mixdogDesktop.invokeCapability?.({
                      capability: "revertTurnReviewFile",
                      args: [rel],
                      sessionId,
                    })
                      .then(async () => {
                        setReverted((current) => [...current, name]);
                        await refreshAgentReviews();
                      })
                      .catch(() => {});
                  }}>
                  <Check size={12} />
                </button>
              </span>
            ) : (
              <button type="button" className="turn-review-revert"
                aria-label={t("Revert {{file}}", { file: rel })} data-tooltip={t("Revert file to turn start")}
                onClick={() => setConfirmFile(name)}>
                <RotateCcw size={12} />
              </button>
            ))}
            {openFile === rowKey && <div className="turn-review-diff">
              {entry.parts.length > 0
                ? entry.parts.map((file, index) => (
                  <GitDiffBody key={`${rowKey}:${index}`} file={file} mode={diffStyle} />
                ))
                : <span className="turn-review-status">{t("Diff detail unavailable")}</span>}
            </div>}
          </li>
          );
          });
          return [sourceHeader, ...rows];
        })}
          </ul>
        </div>
      </div>
    </section>
  );
});
