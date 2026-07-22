import React, { Component, Suspense, lazy, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Code2, Command, FileDiff, Folder, GitCompare, Layers3, LoaderCircle, Mic, PanelLeft, PanelRight, Plus, RotateCcw, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import { OcIcon } from "./OcIcon";
import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { approvalInstanceKey, draftAfterSubmission, followAfterScroll, isApprovalDismissKey, isScrollIntentKey, mergeTranscript, normalizeApplyPatch, parseUnifiedDiff, reconcileTurnFailures, shouldNavigatePromptHistory, toolInputRows, transcriptTurnKeys } from "./renderer-logic.mjs";

export function ApprovalCard({ approval, resolve }: {
  approval: Approval;
  resolve: (approved: boolean) => Promise<unknown>;
}) {
  const [resolving, setResolving] = useState(false);
  const [approvalError, setApprovalError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const resolvingRef = useRef(false);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const decide = useCallback(async (approved: boolean) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setApprovalError("");
    setResolving(true);
    try {
      const accepted = await resolveRef.current(approved);
      if (accepted === true) return;
      setApprovalError("Mixdog could not record this decision. Please try again.");
      resolvingRef.current = false;
      setResolving(false);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason || "");
      setApprovalError(detail
        ? `Mixdog could not record this decision: ${detail}`
        : "Mixdog could not record this decision. Please try again.");
      resolvingRef.current = false;
      setResolving(false);
    }
  }, []);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || []);
    (focusable()[0] || dialog.current)?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)) return;
      const shortcut = event.key.toLowerCase();
      if (shortcut === "a" || shortcut === "y" || shortcut === "d" || shortcut === "n") {
        event.preventDefault();
        event.stopPropagation();
        void decide(shortcut === "a" || shortcut === "y");
        return;
      }
      if (isApprovalDismissKey(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        void decide(false);
        return;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previousFocus?.focus();
    };
  }, [decide]);
  // Inline approval: the request renders in the
  // transcript flow with a warning ring instead of a modal overlay, so the
  // user can keep reading and typing while deciding.
  return (
    <article ref={dialog} className="approval-card approval-card--inline" role="group"
      aria-labelledby="approval-title" aria-describedby="approval-description"
      >
      <div className="approval-heading"><span><ShieldAlert size={19} /></span>
        <div><b id="approval-title">Tool approval required</b>
          <small>{String(approval.name || "Tool")} wants to run</small></div>
      </div>
      <p id="approval-description">{approval.reason || "Review this tool request before continuing."}</p>
      <dl>
        {approval.cwd && <><dt>Folder</dt><dd>{approval.cwd}</dd></>}
        {approval.args != null && <><dt>Arguments</dt><dd><code>{textOf(approval.args)}</code></dd></>}
      </dl>
      {approvalError && <p className="approval-error" role="alert" aria-live="assertive">
        {approvalError}
      </p>}
      <div className="approval-actions">
        <button disabled={resolving} onClick={() => void decide(false)}><X size={15} /> Deny</button>
        <button disabled={resolving} className="allow" onClick={() => void decide(true)}>
          <Check size={15} /> Allow once</button>
      </div>
    </article>
  );
}

