import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  DesktopAbortOptions,
  DesktopPastedText,
  DesktopPromptAttachment,
  DesktopPromptContent,
  DesktopRendererComposerActionDiagnostic,
  DesktopSubmitOptions,
} from "../shared/contract";
import { reportComposerAction } from "./composer-diagnostics";
import type { RecordValue } from "./desktop-types";
import { asRecord } from "./text-format";
import {
  hasSendablePromptContent,
  shouldBlockPromptSubmit,
} from "./renderer-logic.mjs";
import { registerImagePreview } from "./transcript-metrics";
import {
  MAX_SUBMIT_TEXT_LENGTH,
  type ComposerAttachment,
} from "./composer-support";
import {
  nextComposerSubmissionId,
  rejectComposerSubmissionRecovery,
  resolveComposerSubmissionRecovery,
  retainComposerSubmissionRecovery,
  submissionRetryKey,
} from "./composer-draft";

export function useComposerSubmission({
  turnBusy,
  commandBusy,
  draftMode,
  queued,
  recoveryScope,
  textarea,
  draftRef,
  attachmentsRef,
  transitioningRef,
  composingRef,
  submittingRef,
  submissionRetryRef,
  mountedRef,
  historyNavigation,
  setDraft,
  setSubmitting,
  setSubmissionRecoveryVersion,
  clearNotice,
  setAttachmentError,
  removeAttachments,
  mergeRestoredAttachments,
  restoredAttachments,
  executeSlash,
  rememberPrompt,
  submit,
  abort,
  onQueuedRestored,
}: {
  turnBusy: boolean;
  commandBusy: boolean;
  draftMode?: boolean;
  queued?: unknown[];
  recoveryScope: string;
  textarea: RefObject<HTMLTextAreaElement | null>;
  draftRef: RefObject<string>;
  attachmentsRef: RefObject<ComposerAttachment[]>;
  transitioningRef: RefObject<boolean>;
  composingRef: RefObject<boolean>;
  submittingRef: RefObject<boolean>;
  submissionRetryRef: RefObject<{ key: string; id: string } | null>;
  mountedRef: RefObject<boolean>;
  historyNavigation: RefObject<{ index: number; seed: string }>;
  setDraft: Dispatch<SetStateAction<string>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  setSubmissionRecoveryVersion: Dispatch<SetStateAction<number>>;
  clearNotice(): void;
  setAttachmentError(message: string): void;
  removeAttachments(ids: Set<number>): void;
  mergeRestoredAttachments(restored: ComposerAttachment[], restoredText: string): string;
  restoredAttachments(value: RecordValue, restoredText: string): {
    attachments: ComposerAttachment[];
    text: string;
  };
  executeSlash(raw: string): Promise<boolean>;
  rememberPrompt(value: string, submittedAttachments?: ComposerAttachment[]): void;
  submit(content: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<unknown>;
  abort(options?: DesktopAbortOptions): Promise<unknown>;
  onQueuedRestored?(ids: string[]): void;
}) {
  const send = useCallback(async (
    slashOverride = "",
    source: DesktopRendererComposerActionDiagnostic["source"] = "form-submit",
  ) => {
    const submittedDraft = textarea.current?.value ?? draftRef.current;
    const submittedAttachments = [...attachmentsRef.current];
    const text = (slashOverride || submittedDraft).trim();
    const serializedSubmit = Boolean(draftMode || text.startsWith("/"));
    if (!hasSendablePromptContent({ text, attachments: submittedAttachments })
      || transitioningRef.current || shouldBlockPromptSubmit({
      submitting: submittingRef.current,
      draftMode,
      slashCommand: text.startsWith("/"),
    })) return;
    reportComposerAction({
      kind: "composer-action",
      action: "submit",
      source,
      turnBusy,
      queueCount: Array.isArray(queued) ? queued.length : 0,
      draftLength: text.length,
      composing: composingRef.current,
      uptimeMs: performance.now(),
    });
    if (serializedSubmit) {
      submittingRef.current = true;
      setSubmitting(true);
    }
    try {
      clearNotice();
      if (text.startsWith("/")) {
        if (commandBusy) {
          setAttachmentError("Wait for the current command to finish. Your command is still in the editor.");
          return;
        }
        setDraft((current) => current === submittedDraft ? "" : current);
        removeAttachments(new Set(submittedAttachments.map((attachment) => attachment.id)));
        historyNavigation.current = { index: -1, seed: "" };
        const accepted = await executeSlash(text);
        if (!accepted) {
          setDraft((current) => current ? current : submittedDraft);
          mergeRestoredAttachments(submittedAttachments, submittedDraft);
        } else {
          rememberPrompt(text);
        }
        return;
      }
      setAttachmentError("");
      const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4)
        - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
      const chipOnlyTextTokens = submittedAttachments
        .filter((attachment) => attachment.chipOnly === true && attachment.token
          && !submittedDraft.includes(attachment.token))
        .map((attachment) => attachment.token);
      const expandedText = chipOnlyTextTokens.length
        ? [submittedDraft.trim(), ...chipOnlyTextTokens].filter(Boolean).join("\n")
        : submittedDraft;
      const used = submittedAttachments.filter(
        (attachment) => expandedText.includes(attachment.token),
      );
      const pastedImages: Record<string, DesktopPromptAttachment> = {};
      const pastedTexts: Record<string, DesktopPastedText> = {};
      for (const attachment of used) {
        if (attachment.kind === "text") {
          pastedTexts[String(attachment.id)] = {
            id: attachment.id,
            text: attachment.data,
            filename: attachment.name,
            mimeType: attachment.mimeType,
            source: attachment.source || "file",
          };
        } else if (attachment.kind === "image") {
          pastedImages[String(attachment.id)] = {
            id: attachment.id,
            type: "image",
            sizeBytes: base64Bytes(attachment.data),
            mediaType: attachment.mimeType,
            filename: attachment.name,
            ...(attachment.metadataText ? { metadataText: attachment.metadataText } : {}),
          };
        }
      }
      const imageAttachments = used.filter((attachment) => attachment.kind === "image");
      const pdfAttachments = used.filter((attachment) => attachment.kind === "pdf");
      for (const attachment of imageAttachments) {
        registerImagePreview(
          attachment.id,
          base64Bytes(attachment.data),
          `data:${attachment.mimeType};base64,${attachment.data}`,
        );
      }
      if (expandedText.length > MAX_SUBMIT_TEXT_LENGTH) {
        setAttachmentError(
          "This prompt is too large to send. Remove or shorten an inline text attachment.",
        );
        return;
      }
      const content: DesktopPromptContent = imageAttachments.length || pdfAttachments.length
        ? [
          ...(expandedText ? [{ type: "text" as const, text: expandedText }] : []),
          ...imageAttachments.flatMap((attachment) => [
            ...(attachment.metadataText
              ? [{ type: "text" as const, text: attachment.metadataText }]
              : []),
            {
              type: "image" as const,
              data: attachment.data,
              mimeType: attachment.mimeType,
            },
          ]),
          ...pdfAttachments.map((attachment) => ({
            type: "file" as const,
            data: attachment.data,
            mimeType: attachment.mimeType,
            filename: attachment.name,
          })),
        ]
        : expandedText;
      const committedAttachments = [...used];
      const retryKey = submissionRetryKey(expandedText, committedAttachments);
      const submittedDisplayText = expandedText.trim();
      const priorRetry = submissionRetryRef.current;
      const submissionId = priorRetry?.key === retryKey
        ? priorRetry.id
        : nextComposerSubmissionId();
      retainComposerSubmissionRecovery({
        id: submissionId,
        scope: recoveryScope,
        text: submittedDraft,
        attachments: committedAttachments,
      });
      setDraft((current) => current === submittedDraft ? "" : current);
      removeAttachments(new Set(committedAttachments.map((attachment) => attachment.id)));
      historyNavigation.current = { index: -1, seed: "" };
      const restoreSubmitted = () => {
        rejectComposerSubmissionRecovery(submissionId);
        if (mountedRef.current) setSubmissionRecoveryVersion((current) => current + 1);
      };
      let accepted: unknown;
      try {
        accepted = await submit(content, {
          id: submissionId,
          ...(submittedDisplayText ? { displayText: submittedDisplayText } : {}),
          ...(Object.keys(pastedImages).length ? { pastedImages } : {}),
          ...(Object.keys(pastedTexts).length ? { pastedTexts } : {}),
        });
      } catch (error) {
        submissionRetryRef.current = { key: retryKey, id: submissionId };
        restoreSubmitted();
        throw error;
      }
      if (accepted === true) {
        resolveComposerSubmissionRecovery(submissionId);
        if (submissionRetryRef.current?.id === submissionId) submissionRetryRef.current = null;
        rememberPrompt(expandedText, committedAttachments);
      } else {
        submissionRetryRef.current = { key: retryKey, id: submissionId };
        restoreSubmitted();
      }
    } finally {
      if (serializedSubmit) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }, [
    attachmentsRef,
    clearNotice,
    commandBusy,
    composingRef,
    draftMode,
    draftRef,
    executeSlash,
    historyNavigation,
    mergeRestoredAttachments,
    mountedRef,
    queued,
    recoveryScope,
    rememberPrompt,
    removeAttachments,
    setAttachmentError,
    setDraft,
    setSubmissionRecoveryVersion,
    setSubmitting,
    submissionRetryRef,
    submit,
    submittingRef,
    textarea,
    transitioningRef,
    turnBusy,
  ]);

  const stop = useCallback(async (preserveDraft = false, submissionId = "") => {
    const restorePrompt = submissionId ? !preserveDraft : false;
    const result = asRecord(await abort({
      restorePrompt,
      ...(submissionId ? { submissionId } : {}),
    }));
    if (submissionId && (result?.aborted === true || result?.restoreText)) {
      const restoredIds = Array.isArray(result.restoredSubmissionIds)
        ? result.restoredSubmissionIds.map(String).filter(Boolean)
        : [submissionId];
      onQueuedRestored?.(restoredIds.length ? restoredIds : [submissionId]);
    }
    if (result?.restoreText) {
      const restoredText = String(result.restoreText);
      const restored = restoredAttachments(result, restoredText);
      const acceptedText = mergeRestoredAttachments(restored.attachments, restored.text);
      setDraft((current) => {
        const next = [acceptedText, current].filter(Boolean).join("\n");
        draftRef.current = next;
        return next;
      });
      window.setTimeout(() => textarea.current?.focus(), 0);
    }
  }, [
    abort,
    draftRef,
    mergeRestoredAttachments,
    onQueuedRestored,
    restoredAttachments,
    setDraft,
    textarea,
  ]);

  return { send, stop };
}
