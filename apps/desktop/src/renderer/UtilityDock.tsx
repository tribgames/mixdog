import React, { Component, Suspense, lazy, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Code2, Command, FileDiff, Folder, GitCompare, Layers3, LoaderCircle, Mic, PanelLeft, PanelRight, Plus, RotateCcw, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import { MxIcon } from "./MxIcon";
import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { approvalInstanceKey, draftAfterSubmission, followAfterScroll, isApprovalDismissKey, isScrollIntentKey, mergeTranscript, normalizeApplyPatch, parseUnifiedDiff, reconcileTurnFailures, shouldNavigatePromptHistory, toolInputRows, transcriptTurnKeys } from "./renderer-logic.mjs";
import { DiffView, TerminalPane } from "./lazy-widgets";
import { ContextBody } from "./CommandSurface";
import { TERMINAL_AGENT_STATUS, timeMs, formatWorkElapsed, formatTokenCount, findPatch } from "./TranscriptView";

export const DOCK_STATE_KEY = 'mixdog.desktop-utility-dock.v1';
export type UtilityDockTab = 'agents' | 'terminal';
export function clampDockWidth(value: number): number {
  return Math.min(560, Math.max(300, Math.round(Number.isFinite(value) ? value : 380)));
}
export function readDockState(): { open: boolean; tab: UtilityDockTab; width: number } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DOCK_STATE_KEY) || '{}') as Record<string, unknown>;
    return {
      open: raw.open === true,
      tab: raw.tab === 'terminal' ? raw.tab : 'agents',
      width: clampDockWidth(Number(raw.width)),
    };
  } catch {
    return { open: false, tab: 'agents', width: 380 };
  }
}


// ── Right utility dock (Cursor-style side panel) ─────────────────────────
// Changes: session-wide file edits (every tool patch), expandable per file.
// Context: the live context surface (same body as the modal), polled while
// the tab is visible.
interface SessionFileChange {
  name: string;
  additions: number;
  deletions: number;
  patches: string[];
}
interface DockAgentRow {
  key: string;
  name: string;
  status: string;
  detail: string;
  startedAt: number;
  done: boolean;
  failed: boolean;
  readArgs: RecordValue | null;
}
// Reused-session workers can surface without a startedAt (round-2 spawns);
// anchor their elapsed timer to first sight so the dock shows a ticking
// duration instead of the literal word "running".
const agentRowFirstSeen = new Map<string, number>();
function dockAgentRows(snapshot: Snapshot): DockAgentRow[] {
  const workers = Array.isArray(snapshot.agentWorkers) ? snapshot.agentWorkers : [];
  const jobs = Array.isArray(snapshot.agentJobs) ? snapshot.agentJobs : [];
  // The dock lists CURRENT spawns only (user decision): terminal runs drop
  // off, and a spawn reported both as a worker AND a job merges into ONE row
  // (task id → tag → name identity) so nothing shows twice.
  const rows = new Map<string, DockAgentRow>();
  [...workers, ...jobs].forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) return;
    const name = String(record.tag || record.agent || record.name || record.role || record.id || "agent").trim() || "agent";
    const status = String(record.stage || record.status || "running").trim() || "running";
    const startedAt = timeMs(record.startedAt || record.startTime || record.createdAt);
    const done = TERMINAL_AGENT_STATUS.test(status);
    if (done) return;
    const failed = /error|fail|killed|timeout|cancel/i.test(status);
    const detail = String(record.task || record.description || record.summary || record.model || "").trim();
    const tag = String(record.tag || "").trim();
    const taskId = String(record.task_id || record.taskId || record.jobId || "").trim();
    const readArgs: RecordValue | null = taskId
      ? { type: "read", task_id: taskId }
      : tag ? { type: "read", tag } : null;
    // Tag FIRST: one spawn often reports as a tagged worker AND a task-id
    // job; the tag is the stable spawn handle, so both collapse into it.
    const identity = tag || taskId || `${name}-${String(record.id ?? index)}`;
    const existing = rows.get(identity);
    if (!existing) {
      rows.set(identity, { key: identity, name, status, detail, startedAt, done, failed, readArgs });
      return;
    }
    rows.set(identity, {
      ...existing,
      detail: existing.detail || detail,
      startedAt: existing.startedAt || startedAt,
      failed: existing.failed || failed,
      readArgs: existing.readArgs || readArgs,
    });
  });
  const result = [...rows.values()];
  for (const row of result) {
    if (!row.startedAt) {
      const seen = agentRowFirstSeen.get(row.key) ?? Date.now();
      agentRowFirstSeen.set(row.key, seen);
      row.startedAt = seen;
    }
  }
  for (const key of agentRowFirstSeen.keys()) {
    if (!rows.has(key)) agentRowFirstSeen.delete(key);
  }
  return result.sort((left, right) => left.startedAt - right.startedAt);
}
function sessionFileChanges(items: TranscriptItem[]): SessionFileChange[] {
  const files = new Map<string, SessionFileChange>();
  for (const item of items) {
    if (item?.kind !== "tool") continue;
    const patch = findPatch(item);
    if (!patch) continue;
    try {
      for (const file of parseUnifiedDiff(patch)) {
        const name = file.newFile.fileName || file.oldFile?.fileName || "unknown file";
        const entry = files.get(name) || { name, additions: 0, deletions: 0, patches: [] };
        const body = file.hunks.join("\n").split("\n");
        entry.additions += body.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
        entry.deletions += body.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
        if (!entry.patches.includes(patch)) entry.patches.push(patch);
        files.set(name, entry);
      }
    } catch { /* non-diff payload — skip */ }
  }
  return [...files.values()];
}

export function UtilityDock({ open, width, tab, onTab, onResize, items, snapshot }: {
  open: boolean;
  width: number;
  tab: UtilityDockTab;
  onTab(tab: UtilityDockTab): void;
  onResize(width: number): void;
  items: TranscriptItem[];
  snapshot: Snapshot;
}) {
  // Elapsed readouts for running agents tick once a second while visible.
  const [agentClock, setAgentClock] = useState(() => Date.now());
  useEffect(() => {
    if (tab !== "agents") return undefined;
    const timer = window.setInterval(() => setAgentClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [tab]);
  const agents = useMemo(() => dockAgentRows(snapshot), [snapshot.agentWorkers, snapshot.agentJobs]);
  // Agent output viewer: click a row →
  // fetch its rendered output via the SILENT agentControl read; refresh every
  // 3s while the run is still live.
  const [agentView, setAgentView] = useState<DockAgentRow | null>(null);
  const [agentOutput, setAgentOutput] = useState<string>("");
  useEffect(() => {
    if (tab !== "agents" && agentView) setAgentView(null);
  }, [tab, agentView]);
  useEffect(() => {
    if (!agentView?.readArgs) return undefined;
    let live = true;
    const load = () => void window.mixdogDesktop.invokeCapability?.({
      capability: 'agentControl',
      args: [agentView.readArgs, { silent: true }],
    }).then((result) => {
      if (live) setAgentOutput(String(result?.value ?? "").trim() || "No output yet.");
    }).catch((reason) => {
      if (live) setAgentOutput(`Error: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
    setAgentOutput("Loading…");
    load();
    const timer = agentView.done ? 0 : window.setInterval(load, 3_000);
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [agentView]);
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent) => onResize(startWidth + (startX - moveEvent.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <aside className={`utility-dock${open ? "" : " closing"}`}
    style={{ width: open ? width : 0, flexBasis: open ? width : 0 }} aria-label="Utility panel">
    <div className="utility-dock-resize" role="separator" aria-orientation="vertical"
      aria-label="Resize utility panel" onPointerDown={startResize} />
    <nav className="utility-dock-tabs" aria-label="Utility panel tabs">
      <button type="button" className={tab === "agents" ? "active" : ""}
        onClick={() => onTab("agents")}>Agents</button>
      <button type="button" className={tab === "terminal" ? "active" : ""}
        onClick={() => onTab("terminal")}>Terminal</button>
    </nav>
    <div className="utility-dock-body" data-tab={tab}>
      {tab === "agents" && agentView && (
        <div className="dock-agent-view">
          <header>
            <button type="button" className="dock-agent-back" onClick={() => setAgentView(null)}
              aria-label="Back to agent list"><ChevronRight size={14} style={{ transform: "rotate(180deg)" }} /></button>
            <b>{agentView.name}</b>
            <span data-state={agentView.failed ? "failed" : agentView.done ? "done" : "running"}>
              {agentView.status}
            </span>
          </header>
          <pre>{agentOutput}</pre>
        </div>
      )}
      {tab === "agents" && !agentView && (agents.length
        ? <div className="dock-agent-list" role="list">
          {agents.map((agent) => <button type="button" className="dock-agent-row" role="listitem" key={agent.key}
            data-state={agent.failed ? "failed" : agent.done ? "done" : "running"}
            disabled={!agent.readArgs}
            onClick={() => agent.readArgs && setAgentView(agent)}>
            <i aria-hidden="true" />
            <div className="dock-agent-copy">
              <b>{agent.name}</b>
              {agent.detail && <small title={agent.detail}>{agent.detail}</small>}
            </div>
            <span>{agent.done || !agent.startedAt ? agent.status : formatWorkElapsed(agentClock - agent.startedAt)}</span>
          </button>)}
        </div>
        : <p className="utility-dock-empty">No agent activity in this session yet.</p>)}
      {tab === "terminal" && <Suspense fallback={null}>
        <TerminalPane cwd={String(snapshot.currentProject || snapshot.project || "") || null} />
      </Suspense>}
    </div>
  </aside>;
}
