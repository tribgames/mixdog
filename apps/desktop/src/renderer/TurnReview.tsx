import { Check, FileDiff, RotateCcw, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitDiffBody } from "./ReviewPane";
import { findPatch, PATCH_CACHE_LIMIT } from "./TranscriptView";
import { REVIEW_DIFF_STYLE_KEY, type TranscriptItem } from "./desktop-types";
import { parseUnifiedDiff } from "./renderer-logic.mjs";


// "Review Changes": Codex-compatible collection with Mixdog attribution.
// Lead apply_patch diffs come from the current transcript turn. Successful
// worker apply_patch diffs stay attached to each worker and are queried through
// getTurnReviewDiff, then displayed under the owning Lead turn.
type TurnReviewPatchPart = ReturnType<typeof parseUnifiedDiff>[number];
type TurnReviewSummary = {
  files: Map<string, {
    additions: number;
    deletions: number;
    parts: ReturnType<typeof parseUnifiedDiff>;
  }>;
  additions: number;
  deletions: number;
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
  part: TurnReviewPatchPart;
}>>();

// Last known worker-review result per turn scope. The floating bar consumes no
// transcript layout, while the cache still avoids repeating patch parsing and
// lets a revisited turn show its known review immediately.
const AGENT_REVIEW_CACHE_LIMIT = 32;
const agentReviewCache = new Map<string, AgentTurnReview[]>();
function rememberAgentReviews(scopeKey: string, reviews: AgentTurnReview[]): void {
  agentReviewCache.delete(scopeKey);
  agentReviewCache.set(scopeKey, reviews);
  while (agentReviewCache.size > AGENT_REVIEW_CACHE_LIMIT) {
    const oldest = agentReviewCache.keys().next().value;
    if (oldest === undefined) break;
    agentReviewCache.delete(oldest);
  }
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
    return [{ name, additions, deletions, part }];
  });
  turnReviewPatchCache.set(patch, analyzed);
  if (turnReviewPatchCache.size > PATCH_CACHE_LIMIT) {
    turnReviewPatchCache.delete(turnReviewPatchCache.keys().next().value as string);
  }
  return analyzed;
}

function summarizeTurnReviewPatch(patch: string): TurnReviewSummary {
  const files: TurnReviewSummary["files"] = new Map();
  if (patch) {
    try {
      for (const analyzed of analyzeTurnReviewPatch(patch)) {
        const entry = files.get(analyzed.name) || { additions: 0, deletions: 0, parts: [] };
        entry.additions += analyzed.additions;
        entry.deletions += analyzed.deletions;
        entry.parts.push(analyzed.part);
        files.set(analyzed.name, entry);
      }
    } catch { /* malformed/non-diff payload — skip */ }
  }
  let additions = 0;
  let deletions = 0;
  for (const entry of files.values()) {
    additions += entry.additions;
    deletions += entry.deletions;
  }
  return { files, additions, deletions };
}

function mergeTurnReviewSummaries(summaries: TurnReviewSummary[]): TurnReviewSummary {
  const files: TurnReviewSummary["files"] = new Map();
  let additions = 0;
  let deletions = 0;
  for (const summary of summaries) {
    additions += summary.additions;
    deletions += summary.deletions;
    for (const [name, entry] of summary.files) {
      const merged = files.get(name) || { additions: 0, deletions: 0, parts: [] };
      merged.additions += entry.additions;
      merged.deletions += entry.deletions;
      merged.parts.push(...entry.parts);
      files.set(name, merged);
    }
  }
  return { files, additions, deletions };
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
  }>(() => ({
    scopeKey: turnScopeKey,
    reviews: agentReviewCache.get(turnScopeKey) || [],
  }));
  // Keying the read as well as the write prevents a one-frame stale bar before
  // effects run when the user switches sessions or opens New task.
  const agentReviews = agentReviewState.scopeKey === turnScopeKey
    ? agentReviewState.reviews
    : (agentReviewCache.get(turnScopeKey) || []);
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
      invokeCapability?: (request: { capability: string; args: unknown[] }) => Promise<{ value?: unknown }>;
    } | undefined;
    if (!sessionId || !api?.invokeCapability || capabilityFailures.current >= 3) return;
    if (capabilityRequestInFlight.current || document.visibilityState === "hidden") return;
    const requestedScope = turnScopeKey;
    capabilityRequestInFlight.current = true;
    try {
      const result = await api.invokeCapability({ capability: TURN_REVIEW_CAPABILITY, args: [] });
      const value = (result?.value ?? null) as {
        supported?: boolean;
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
      const signature = JSON.stringify(reviews);
      rememberAgentReviews(requestedScope, reviews);
      if (lastAgentReviewSignature.current === signature) return;
      lastAgentReviewSignature.current = signature;
      if (activeScope.current === requestedScope) {
        setAgentReviewState({
          scopeKey: requestedScope,
          reviews,
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
    for (let index = lastUser + 1; index < items.length; index++) {
      const item = items[index];
      if (!item || item.kind !== "tool") continue;
      const patch = findPatch(item);
      if (typeof patch !== "string" || !patch) continue;
      patches.push(patch);
    }
    return summarizeTurnReviewPatch(patches.join("\n"));
  }, [items]);
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
    () => mergeTurnReviewSummaries([transcriptSummary, agentSummary]),
    [transcriptSummary, agentSummary],
  );
  const sources = useMemo(() => [
    ...(transcriptSummary.files.size > 0
      ? [{ key: "lead", label: "Lead", summary: transcriptSummary }]
      : []),
    ...agentSources,
  ], [transcriptSummary, agentSources]);
  if (summary.files.size === 0) return null;
  return (
    <section ref={barElement} className="turn-review-bar" aria-label="Files changed this turn"
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
          <strong>{summary.files.size} file{summary.files.size === 1 ? "" : "s"} changed</strong>
          {/* The counters belong to the TITLE, not to the (now removed)
              expander side of the row. */}
          <span className="diff-stats"><i>+{summary.additions}</i><em>-{summary.deletions}</em></span>
          {agentSources.length > 0 && <span className="turn-review-attribution">
            Lead {transcriptSummary.files.size} · Agents {agentSummary.files.size}
          </span>}
        </button>
        {expanded && <div className="review-style-toggle turn-review-style" role="radiogroup"
          aria-label="Diff style">
          <button type="button" aria-pressed={diffStyle === "unified"}
            onClick={() => setDiffStyle("unified")}>Unified</button>
          <button type="button" aria-pressed={diffStyle === "split"}
            onClick={() => setDiffStyle("split")}>Split</button>
        </div>}
      </div>
      <div className="turn-review-collapse" inert={!expanded} aria-hidden={!expanded}>
        <div className="turn-review-collapse-inner">
          <ul className="turn-review-files">
        {sources.flatMap((source) => {
          const sourceHeader = (
            <li key={`${source.key}:source`} className="turn-review-source">
              <strong>{source.label}</strong>
              <span>{source.summary.files.size} file{source.summary.files.size === 1 ? "" : "s"}</span>
              <span className="diff-stats">
                <i>+{source.summary.additions}</i><em>-{source.summary.deletions}</em>
              </span>
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
              <span className="diff-stats"><i>+{entry.additions}</i><em>-{entry.deletions}</em></span>
            </button>
            {Boolean(cwd) && !isReverted && (confirming ? (
              <span className="turn-review-confirm" role="group"
                aria-label={`Confirm reverting ${rel} (discards ALL working-tree changes in the file)`}>
                <button type="button" className="turn-review-revert"
                  aria-label="Cancel revert" data-tooltip="Cancel"
                  onClick={() => setConfirmFile("")}>
                  <X size={12} />
                </button>
                <button type="button" className="turn-review-revert danger"
                  aria-label={`Confirm revert of ${rel}`} data-tooltip="Revert to HEAD"
                  onClick={() => {
                    setConfirmFile("");
                    void window.mixdogDesktop.gitRevert?.(cwd as string, rel, false)
                      .then(() => setReverted((current) => [...current, name]))
                      .catch(() => {});
                  }}>
                  <Check size={12} />
                </button>
              </span>
            ) : (
              <button type="button" className="turn-review-revert"
                aria-label={`Revert ${rel}`} data-tooltip="Revert file (working tree → HEAD)"
                onClick={() => setConfirmFile(name)}>
                <RotateCcw size={12} />
              </button>
            ))}
            {openFile === rowKey && <div className="turn-review-diff">
              {entry.parts.map((file, index) => (
                <GitDiffBody key={`${rowKey}:${index}`} file={file} mode={diffStyle} />
              ))}
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
