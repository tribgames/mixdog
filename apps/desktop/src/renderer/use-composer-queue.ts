import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type {
  DesktopAbortOptions,
  DesktopCapability,
  DesktopRendererComposerActionDiagnostic,
} from "../shared/contract";
import { reportComposerAction } from "./composer-diagnostics";
import type { RecordValue } from "./desktop-types";
import { asRecord } from "./text-format";
import type { ComposerAttachment } from "./composer-support";
import {
  mergeQueuedRestoreDraft,
  queuedRestorePrefix,
  queuedRestoreProjection,
  replaceQueuedRestorePrefix,
} from "../../../../src/tui/components/prompt-input/restore-policy.mjs";

export function useComposerQueue({
  queued,
  hiddenQueueIds,
  pendingSubmissionIds,
  draftMode,
  turnBusy,
  draftRef,
  setDraft,
  textarea,
  composingRef,
  historyNavigation,
  invokeCapability,
  abort,
  restoredAttachments,
  mergeRestoredAttachments,
  showNotice,
  onQueuedRestored,
  scope,
}: {
  queued?: unknown[];
  hiddenQueueIds?: Array<string | number>;
  pendingSubmissionIds?: Array<string | number>;
  draftMode?: boolean;
  turnBusy: boolean;
  draftRef: RefObject<string>;
  setDraft(value: string): void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  composingRef: RefObject<boolean>;
  historyNavigation: RefObject<{ index: number; seed: string }>;
  invokeCapability<T>(capability: DesktopCapability, args?: unknown[]): Promise<T | undefined>;
  abort(options?: DesktopAbortOptions): Promise<unknown>;
  restoredAttachments(value: RecordValue, restoredText: string): {
    attachments: ComposerAttachment[];
    text: string;
  };
  mergeRestoredAttachments(restored: ComposerAttachment[], restoredText: string): string;
  showNotice(message: string): void;
  onQueuedRestored?(ids: string[]): void;
  scope: string;
}) {
  const [restoring, setRestoring] = useState(false);
  const [locallyHiddenQueueIds, setLocallyHiddenQueueIds] = useState<string[]>([]);
  const queueRestoreInFlightRef = useRef(false);
  const restoredQueueProjectionRef = useRef("");
  const queuedProjectionKey = Array.isArray(queued)
    ? queued.map((entry, index) => {
      const item = asRecord(entry);
      return String(item?.id ?? `${index}:${item?.text ?? item?.displayText ?? ""}`);
    }).join("\n")
    : "";

  useEffect(() => {
    const liveIds = new Set((Array.isArray(queued) ? queued : [])
      .map((entry) => asRecord(entry)?.id)
      .filter((id) => id !== undefined && id !== null)
      .map(String));
    setLocallyHiddenQueueIds((current) => {
      const next = current.filter((id) => liveIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [queued, queuedProjectionKey]);

  const hasRestorableQueuedMessages = useCallback(
    () => Boolean(queuedProjectionKey)
      && restoredQueueProjectionRef.current !== queuedProjectionKey,
    [queuedProjectionKey],
  );

  const pendingSubmissionId = !draftMode && Array.isArray(pendingSubmissionIds)
    ? String(pendingSubmissionIds[pendingSubmissionIds.length - 1] || "").trim()
    : "";

  const restoreQueue = useCallback(async (
    queuedId = "",
    source: DesktopRendererComposerActionDiagnostic["source"] = "queue-row",
  ) => {
    if (restoring || queueRestoreInFlightRef.current) return undefined;
    reportComposerAction({
      kind: "composer-action",
      action: "restore-queue",
      source,
      turnBusy,
      queueCount: Array.isArray(queued) ? queued.length : 0,
      draftLength: draftRef.current.length,
      composing: composingRef.current,
      uptimeMs: performance.now(),
      ...(queuedId ? { targeted: true } : {}),
    });
    const projection = queuedRestoreProjection(queued, queuedId);
    const requestedIds = projection.ids;
    const before = {
      value: draftRef.current,
      cursor: textarea.current?.selectionStart ?? draftRef.current.length,
      selectionAnchor: null,
    };
    const optimistic = mergeQueuedRestoreDraft(projection.text, before);
    const optimisticPrefix = queuedRestorePrefix(projection.text, before.value);
    if (requestedIds.length) {
      setLocallyHiddenQueueIds((current) => [
        ...current,
        ...requestedIds.filter((id: string) => !current.includes(id)),
      ]);
    }
    if (optimisticPrefix) {
      draftRef.current = optimistic.value;
      setDraft(optimistic.value);
      historyNavigation.current = { index: -1, seed: "" };
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(optimistic.cursor, optimistic.cursor);
      }, 0);
    }
    const revealRequested = () => {
      if (!requestedIds.length) return;
      const ids = new Set(requestedIds);
      setLocallyHiddenQueueIds((current) => current.filter((id) => !ids.has(id)));
    };
    const reconcile = (authoritativeText = "") => {
      const current = draftRef.current;
      const currentCursor = textarea.current?.selectionStart ?? current.length;
      const authoritativePrefix = queuedRestorePrefix(authoritativeText, before.value);
      const next = replaceQueuedRestorePrefix(optimisticPrefix, authoritativePrefix, {
        value: current,
        cursor: currentCursor,
        selectionAnchor: null,
      });
      if (!next.replaced) return false;
      draftRef.current = next.value;
      setDraft(next.value);
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(next.cursor, next.cursor);
      }, 0);
      return true;
    };
    queueRestoreInFlightRef.current = true;
    setRestoring(true);
    try {
      const args = queuedId ? ["", queuedId] : [""];
      const value = await invokeCapability<RecordValue>("restoreQueued", args);
      if (!value) {
        reconcile("");
        revealRequested();
        return value;
      }
      const restored = restoredAttachments(value, String(value.text || ""));
      const queuedText = mergeRestoredAttachments(restored.attachments, restored.text);
      const restoredCount = Number(value.count);
      const restoredAnything = Number.isFinite(restoredCount)
        ? restoredCount > 0
        : Boolean(queuedText || restored.attachments.length);
      if (!restoredAnything) {
        reconcile("");
        revealRequested();
        showNotice("No queued messages to restore");
        return value;
      }
      const restoredIds = Array.isArray(value.ids)
        ? value.ids.map(String).filter(Boolean)
        : requestedIds;
      restoredQueueProjectionRef.current = queuedProjectionKey;
      reconcile(queuedText);
      historyNavigation.current = { index: -1, seed: "" };
      onQueuedRestored?.(restoredIds);
      return value;
    } finally {
      queueRestoreInFlightRef.current = false;
      setRestoring(false);
    }
  }, [
    composingRef,
    draftRef,
    historyNavigation,
    invokeCapability,
    mergeRestoredAttachments,
    onQueuedRestored,
    queued,
    queuedProjectionKey,
    restoredAttachments,
    restoring,
    setDraft,
    showNotice,
    textarea,
    turnBusy,
  ]);

  const discardQueued = useCallback(async (queuedId: string) => {
    if (restoring || queueRestoreInFlightRef.current || !queuedId) return;
    setLocallyHiddenQueueIds((current) =>
      current.includes(queuedId) ? current : [...current, queuedId]);
    queueRestoreInFlightRef.current = true;
    setRestoring(true);
    try {
      const value = await invokeCapability<RecordValue>("restoreQueued", ["", queuedId]);
      if (value === undefined) {
        setLocallyHiddenQueueIds((current) => current.filter((id) => id !== queuedId));
        return;
      }
      const removedIds = Array.isArray(value.ids)
        ? value.ids.map(String).filter(Boolean)
        : [queuedId];
      onQueuedRestored?.(removedIds.length ? removedIds : [queuedId]);
    } finally {
      queueRestoreInFlightRef.current = false;
      setRestoring(false);
    }
  }, [invokeCapability, onQueuedRestored, restoring]);

  const steerQueuedNow = useCallback(async (queuedId: string) => {
    if (restoring || queueRestoreInFlightRef.current || !queuedId) return;
    setLocallyHiddenQueueIds((current) =>
      current.includes(queuedId) ? current : [...current, queuedId]);
    queueRestoreInFlightRef.current = true;
    setRestoring(true);
    try {
      const value = await invokeCapability<RecordValue>("prioritizeQueued", [queuedId]);
      if (!value || Number(value.count) < 1) {
        setLocallyHiddenQueueIds((current) => current.filter((id) => id !== queuedId));
        return;
      }
      const promotedIds = Array.isArray(value.ids)
        ? value.ids.map(String).filter(Boolean)
        : [queuedId];
      onQueuedRestored?.(promotedIds.length ? promotedIds : [queuedId]);
      if (turnBusy) await abort({ restorePrompt: false });
    } finally {
      queueRestoreInFlightRef.current = false;
      setRestoring(false);
    }
  }, [abort, invokeCapability, onQueuedRestored, restoring, turnBusy]);

  const resetQueueState = useCallback(() => {
    queueRestoreInFlightRef.current = false;
    setRestoring(false);
  }, []);
  useEffect(() => {
    resetQueueState();
  }, [resetQueueState, scope]);

  const hiddenQueueIdSet = new Set([
    ...(hiddenQueueIds || []).map(String),
    ...locallyHiddenQueueIds,
  ]);
  const visibleQueued = Array.isArray(queued)
    ? queued.filter((item) => {
      const id = asRecord(item)?.id;
      return id === undefined || id === null || !hiddenQueueIdSet.has(String(id));
    })
    : [];

  return {
    restoring,
    setRestoring,
    pendingSubmissionId,
    visibleQueued,
    hasRestorableQueuedMessages,
    restoreQueue,
    discardQueued,
    steerQueuedNow,
    resetQueueState,
  };
}
