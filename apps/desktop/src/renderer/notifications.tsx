import React, {
  Component,
  lazy,
  Suspense,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  FileDiff,
  Folder,
  GitCompare,
  Layers3,
  LoaderCircle,
  Mic,
  ArrowUp,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { MxIcon } from "./MxIcon";
import { ContextBody } from "./CommandSurface";
import { createPortal } from "react-dom";
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import type {
  DesktopCapability,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopPromptAttachment,
  DesktopPromptContent,
  DesktopProjectSummary,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  DesktopUpdaterState,
  EngineSnapshot,
} from "../shared/contract";
import {
  approvalInstanceKey,
  draftAfterSubmission,
  followAfterScroll,
  isApprovalDismissKey,
  isScrollIntentKey,
  mergeTranscript,
  normalizeApplyPatch,
  parseUnifiedDiff,
  reconcileTurnFailures,
  shouldNavigatePromptHistory,
  toolInputRows,
  transcriptTurnKeys,
} from "./renderer-logic.mjs";
import type { TurnFailureModel } from "./renderer-logic.mjs";
import {
  DesktopTitlebar,
  ProjectSwitcher,
  SessionSidebar,
  type NavigationSelection,
  type WorkspaceTab,
} from "./navigation";
import {
  applyDesktopTheme,
  applyDesktopThemePreference,
  clearDesktopThemePreference,
  getDesktopThemePreference,
} from "./desktop-theme";
import { resolveContextUsage } from "./context-usage";
import { OpenSelect } from "./OpenSelect";
import { ModelPicker } from "./ModelPicker";
import { modelDisplayName } from "./provider-display";
import { readCachedModelCatalog, writeCachedModelCatalog } from "./model-catalog-cache";
import { TooltipLayer } from "./TooltipLayer";
import { acquireModalLayer } from "./modal-layer";
import {
  SLASH_COMMANDS,
  type CommandSurface as CommandSurfaceName,
  type SettingsSection,
} from "./slash-commands";
import { promptTitle, sessionSummaryTitle } from "../shared/session-title.mjs";
// The desktop transcript deliberately consumes the same semantic tool labels,
// categories, and result summaries as the terminal UI. Keeping this import at
// the shared formatter boundary prevents the renderer from inventing a second
// (and inevitably divergent) tool vocabulary.
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, formatAggregateHeader, formatToolSurface, summarizeToolResult } from "../../../../src/runtime/shared/tool-surface.mjs";

import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { imagePreviewCache, imagePreviewKey, registerImagePreview, lastVisibleTranscriptItemIndex, estimatedTranscriptRowHeight, TRANSCRIPT_VIRTUALIZE_THRESHOLD, TRANSCRIPT_VIRTUAL_OVERSCAN } from "./transcript-metrics";
import { DiffView, TerminalPane } from "./lazy-widgets";
import { LiveWorkStatus, ContextUsageIndicator, LiveActivity, TextShimmer, CompletionStatus, completionTone, CopyControl, MarkdownResponse, preloadMarkdownBody, transcriptItemSignature, messageMetadata, TranscriptRow, ToolCard, DiffBoundary, CodeDiff, findPatch, toolIcon, toolResultText, isHookApprovalDenialToolItem, shouldSuppressFullyFailedToolItem, boundedTextOf } from "./TranscriptView";
import { ApprovalCard } from "./ApprovalCard";
import { TurnReviewBar } from "./TurnReview";
import { UtilityDock, type UtilityDockTab, clampDockWidth, readDockState, DOCK_STATE_KEY } from "./UtilityDock";
import { ReviewPane } from "./ReviewPane";
import { Composer, ProjectContextSelector, PROJECT_CONTEXT_LOCAL, PROJECT_CONTEXT_OPEN, WorkflowSelect, ModelSelector, queuedFollowupPreview, readPromptHistory, promptHistoryStorageKey } from "./Composer";


export function DesktopUpdateDialog({ version, onCancel, onConfirm }: {
  version: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const layer = acquireModalLayer(shell ? [shell] : []);
    layer.attachSurface(surfaceRef.current);
    cancelRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || []);
      if (!controls.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? controls.length - 1 : current - 1)
        : (current < 0 || current === controls.length - 1 ? 0 : current + 1);
      event.preventDefault();
      controls[next]?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      layer.release();
      prior?.focus({ preventScroll: true });
    };
  }, [onCancel]);

  return createPortal(<div ref={surfaceRef} className="settings-confirm-layer"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
    <section ref={dialogRef} className="settings-confirm-dialog desktop-update-dialog"
      role="alertdialog" aria-modal="true" aria-labelledby="desktop-update-title"
      aria-describedby="desktop-update-description" tabIndex={-1}
      data-desktop-update-dialog>
      <header>
        <h3 id="desktop-update-title">Install Mixdog {version}?</h3>
        <button type="button" aria-label="Close update confirmation" onClick={onCancel}>
          <X aria-hidden="true" size={15} />
        </button>
      </header>
      <p id="desktop-update-description">
        Mixdog will close while the update is installed, then reopen automatically.
      </p>
      <footer>
        <button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" onClick={onConfirm}>Install and restart</button>
      </footer>
    </section>
  </div>, document.body);
}

export function DesktopToastRegion({ bridgeError, toasts, onDismissBridgeError }: {
  bridgeError: string;
  toasts: Toast[];
  onDismissBridgeError: () => void;
}) {
  const [placement, setPlacement] = useState<{
    right: number;
    top: number;
    width: number;
    maxHeight: number;
  }>({
    right: 16,
    top: 54,
    width: 320,
    maxHeight: 400,
  });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [dismissedErrorSignatures, setDismissedErrorSignatures] = useState<Set<string>>(() => new Set());
  const [retainedErrors, setRetainedErrors] = useState<Array<{
    key: string;
    signature: string;
    text: string;
    tone: string;
    bridge: boolean;
  }>>([]);
  const sourceEntries = toasts.map((toast, index) => {
    const text = String(toast.text || toast.message || '').trim();
    const tone = String(toast.tone || 'info').toLowerCase();
    return {
      key: String(toast.id ?? `${toast.tone || 'info'}:${toast.text || toast.message || ''}:${index}`),
      signature: `${tone}:${text}`,
      text,
      tone,
      bridge: false,
    };
  }).filter((entry) => entry.text);
  const sourceErrors = sourceEntries.filter((entry) => entry.tone === 'error');
  const sourceErrorToken = sourceErrors.map((entry) => entry.signature).join('\u0000');
  useEffect(() => {
    const active = new Set(sourceErrors.map((entry) => entry.signature));
    setDismissedErrorSignatures((current) => {
      const next = new Set([...current].filter((signature) => active.has(signature)));
      return next.size === current.size ? current : next;
    });
    setRetainedErrors((current) => {
      let next = current;
      for (const entry of sourceErrors) {
        if (dismissedErrorSignatures.has(entry.signature)) continue;
        next = [...next.filter((retained) => retained.signature !== entry.signature), entry];
      }
      return next.slice(-5);
    });
  }, [sourceErrorToken]);
  const currentErrors = retainedErrors
    .filter((entry) => !dismissedErrorSignatures.has(entry.signature));
  const candidates = [
    ...(bridgeError ? [{
      key: `bridge:${bridgeError}`,
      signature: `bridge:${bridgeError}`,
      text: bridgeError,
      tone: 'error',
      bridge: true,
    }] : []),
    ...sourceEntries.filter((entry) => entry.tone !== 'error'),
    ...currentErrors.slice(-5),
  ];
  const sourceKeys = candidates.map((entry) => entry.key).join('\u0000');
  const entries = candidates.filter((entry) => !dismissed.has(entry.key)).slice(-5);
  const expiringKeys = entries
    .filter((entry) => !entry.bridge && entry.tone !== 'error')
    .map((entry) => entry.key)
    .join('\u0000');
  useEffect(() => {
    const active = new Set(sourceKeys ? sourceKeys.split('\u0000') : []);
    setDismissed((current) => {
      const next = new Set([...current].filter((key) => active.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [sourceKeys]);
  useEffect(() => {
    if (!expiringKeys) return;
    const keys = expiringKeys.split('\u0000');
    const timer = window.setTimeout(() => {
      setDismissed((current) => new Set([...current, ...keys]));
    }, 6500);
    return () => window.clearTimeout(timer);
  }, [expiringKeys]);
  useLayoutEffect(() => {
    const measure = () => {
      const workspace = document.querySelector('.workspace');
      if (!(workspace instanceof HTMLElement)) return;
      const sheet = workspace.getBoundingClientRect();
      if (!sheet.width || !sheet.height) return;
      const margin = 16;
      const width = Math.min(320, Math.max(0, sheet.width - margin * 2));
      const right = Math.max(margin, window.innerWidth - sheet.right + margin);
      // Desktop and mobile share one predictable top-right notification
      // anchor; the workspace top already includes the native safe area.
      const top = Math.max(margin, sheet.top + margin);
      const maxHeight = Math.max(0, sheet.bottom - top - margin);
      setPlacement((current) => current.right === right && current.top === top
        && current.width === width && current.maxHeight === maxHeight
        ? current : { right, top, width, maxHeight });
    };
    measure();
    window.addEventListener('resize', measure);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const workspace = document.querySelector('.workspace');
    if (resizeObserver && workspace instanceof HTMLElement) resizeObserver.observe(workspace);
    return () => {
      window.removeEventListener('resize', measure);
      resizeObserver?.disconnect();
    };
  }, []);
  if (!entries.length) return null;
  return createPortal(<section className="mx-toast-region" aria-label="Notifications" aria-live="polite"
    data-count={entries.length} style={placement}>
    {entries.map((entry) => {
      const title = entry.tone === 'error' ? 'Something went wrong'
        : entry.tone === 'success' ? 'Completed'
          : entry.tone === 'warn' || entry.tone === 'warning' ? 'Attention' : 'Mixdog';
      const dismissEntry = () => {
        if (entry.tone === 'error' && !entry.bridge) {
          setRetainedErrors((current) => current.filter((retained) => retained.signature !== entry.signature));
          setDismissedErrorSignatures((current) => new Set(current).add(entry.signature));
        } else {
          setDismissed((current) => new Set(current).add(entry.key));
        }
        if (entry.bridge) onDismissBridgeError();
      };
      // Tapping anywhere on the toast dismisses it — the 16px X is a poor
      // touch target and stuck toasts read as "won't go away" on phones.
      return <article className="mx-toast" data-tone={entry.tone} key={entry.key}
        role={entry.tone === 'error' ? 'alert' : 'status'} onClick={dismissEntry}>
        {entry.tone === 'error' ? <ShieldAlert size={16} />
          : entry.tone === 'success' ? <Check size={16} /> : <Sparkles size={16} />}
        <span className="mx-toast-copy"><b>{title}</b><span>{entry.text}</span></span>
        <button type="button" className="mx-toast-close" aria-label="Dismiss notification"
          onClick={dismissEntry}><X size={16} /></button>
      </article>;
    })}
  </section>, document.body);
}

export function InlineErrors({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return <div className="inline-error" role="alert" aria-live="assertive">
    <ShieldAlert size={14} />
    <span>{messages.map((message, index) => <span key={`${message}-${index}`}>{message}</span>)}</span>
  </div>;
}
