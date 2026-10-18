import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type {
  DesktopAbortOptions,
  DesktopPastedText,
  DesktopPromptAttachment,
  DesktopPromptContent,
  DesktopRendererComposerActionDiagnostic,
  DesktopSubmitOptions,
} from '../shared/contract';
import { reportComposerAction } from './composer-diagnostics';
import { skillTitle, withSelectedSkill } from './composer-skill';
import type { RecordValue } from './desktop-types';
import { asRecord } from './text-format';
import { hasSendablePromptContent, shouldBlockPromptSubmit } from './renderer-logic.mjs';
import { registerSentAttachments, sentAttachmentData } from './attachment-menu';
import { t } from './i18n';
import { recognisedSlashSpan } from './slash-commands';
import { registerImagePreview } from './transcript-metrics';
import { MAX_SUBMIT_TEXT_LENGTH, type ComposerAttachment } from './composer-support';
import {
  consumeVisualizeFeedback,
  visualizeFeedbackFor,
  visualizeFeedbackPending,
  visualizeFeedbackPrompt,
} from './visualize-feedback-store';
import {
  nextComposerSubmissionId,
  rejectComposerSubmissionRecovery,
  resolveComposerSubmissionRecovery,
  retainComposerSubmissionRecovery,
  submissionRetryKey,
} from './composer-draft';

function base64Bytes(data: string): number {
  let padding = 0;
  if (data.endsWith('==')) padding = 2;
  else if (data.endsWith('=')) padding = 1;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** Expands chip-only tokens, keeps the attachments the text references and
 *  builds the wire content plus the pasted-item side tables. */
export function buildSubmissionContent(submittedDraft: string, submittedAttachments: ComposerAttachment[]) {
  const chipOnlyTextTokens = submittedAttachments
    .filter(
      (attachment) => attachment.chipOnly === true && attachment.token && !submittedDraft.includes(attachment.token)
    )
    .map((attachment) => attachment.token);
  const expandedText = chipOnlyTextTokens.length
    ? [submittedDraft.trim(), ...chipOnlyTextTokens].filter(Boolean).join('\n')
    : submittedDraft;
  const used = submittedAttachments.filter((attachment) => expandedText.includes(attachment.token));
  const pastedImages: Record<string, DesktopPromptAttachment> = {};
  const pastedTexts: Record<string, DesktopPastedText> = {};
  for (const attachment of used) {
    if (attachment.kind === 'text') {
      pastedTexts[String(attachment.id)] = {
        id: attachment.id,
        text: attachment.data,
        filename: attachment.name,
        mimeType: attachment.mimeType,
        source: attachment.source || 'file',
      };
    } else if (attachment.kind === 'image') {
      pastedImages[String(attachment.id)] = {
        id: attachment.id,
        type: 'image',
        sizeBytes: base64Bytes(attachment.data),
        mediaType: attachment.mimeType,
        filename: attachment.name,
        ...(attachment.metadataText ? { metadataText: attachment.metadataText } : {}),
      };
    }
  }
  const imageAttachments = used.filter((attachment) => attachment.kind === 'image');
  const pdfAttachments = used.filter((attachment) => attachment.kind === 'pdf' || attachment.kind === 'office');
  const contentParts: Exclude<DesktopPromptContent, string> = [];
  if (expandedText) contentParts.push({ type: 'text', text: expandedText });
  for (const attachment of imageAttachments) {
    if (attachment.metadataText) contentParts.push({ type: 'text', text: attachment.metadataText });
    contentParts.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType });
  }
  for (const attachment of pdfAttachments) {
    contentParts.push({
      type: 'file',
      data: attachment.data,
      mimeType: attachment.mimeType,
      filename: attachment.name,
    });
  }
  const content: DesktopPromptContent = imageAttachments.length || pdfAttachments.length ? contentParts : expandedText;
  return { expandedText, used, pastedImages, pastedTexts, imageAttachments, content };
}

/** The visualize feedback block goes right after the user's own text. */
export function withFeedbackText(
  content: DesktopPromptContent,
  expandedText: string,
  text: string
): DesktopPromptContent {
  if (!text) return content;
  if (typeof content === 'string') return [content, text].filter(Boolean).join('\n\n');
  const parts = [...content];
  parts.splice(expandedText ? 1 : 0, 0, { type: 'text', text });
  return parts;
}

function attachmentDataUrl(attachment: ComposerAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

/** The content of a non-slash send: the draft and attachments with the
 *  session's visualize feedback folded in. */
function prepareMessageSubmission(
  submittedDraft: string,
  submittedAttachments: ComposerAttachment[],
  feedback: ReturnType<typeof visualizeFeedbackFor>,
  hasFeedback: boolean
) {
  // Crops become image attachments numbered past the composer's own.
  const visualizePrompt = hasFeedback
    ? visualizeFeedbackPrompt(
        feedback,
        submittedAttachments.reduce((max, attachment) => Math.max(max, attachment.id), 0) + 1
      )
    : null;
  const feedbackImages: ComposerAttachment[] = visualizePrompt?.images ?? [];
  const feedbackImageIds = new Set(feedbackImages.map((attachment) => attachment.id));
  const built = buildSubmissionContent(submittedDraft, [...submittedAttachments, ...feedbackImages]);
  const feedbackText = visualizePrompt?.text ?? '';
  return {
    expandedText: built.expandedText,
    pastedImages: built.pastedImages,
    pastedTexts: built.pastedTexts,
    imageAttachments: built.imageAttachments,
    content: withFeedbackText(built.content, built.expandedText, feedbackText),
    visualizePrompt,
    feedbackText,
    // The crops stay with the feedback store (kept there on a failed send),
    // never in the composer's own recovery or history.
    committedAttachments: built.used.filter((attachment) => !feedbackImageIds.has(attachment.id)),
  };
}

interface ComposerSubmissionOptions {
  turnBusy: boolean;
  commandBusy: boolean;
  draftMode?: boolean;
  queued?: unknown[];
  recoveryScope: string;
  textarea: RefObject<HTMLTextAreaElement | null>;
  draftRef: RefObject<string>;
  attachmentsRef: RefObject<ComposerAttachment[]>;
  /** Attachment loads still in flight for this composer. */
  pendingLoads: RefObject<number>;
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
  restoredAttachments(
    value: RecordValue,
    restoredText: string
  ): {
    attachments: ComposerAttachment[];
    text: string;
  };
  executeSlash(raw: string): Promise<boolean>;
  rememberPrompt(value: string, submittedAttachments?: ComposerAttachment[]): void;
  submit(content: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<unknown>;
  abort(options?: DesktopAbortOptions): Promise<unknown>;
  onQueuedRestored?(ids: string[]): void;
  selectedSkill?: string;
  onSkillSubmitted?(name: string): void;
  /** The pane's session: its queued visualize feedback rides with the send. */
  sessionId?: string;
}

export function useComposerSubmission({
  turnBusy,
  commandBusy,
  draftMode,
  queued,
  recoveryScope,
  textarea,
  draftRef,
  attachmentsRef,
  pendingLoads,
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
  selectedSkill = '',
  onSkillSubmitted,
  sessionId,
}: ComposerSubmissionOptions) {
  const send = useCallback(
    async (slashOverride = '', source: DesktopRendererComposerActionDiagnostic['source'] = 'form-submit') => {
      const submittedDraft = textarea.current?.value ?? draftRef.current;
      const submittedAttachments = [...attachmentsRef.current];
      const text = (slashOverride || submittedDraft).trim();
      const slashCommand = recognisedSlashSpan(text) !== null;
      // An attachment still reading would be left out of the message. Keep the
      // draft in place and say so; the user sends once the chip has landed.
      if (!slashCommand && pendingLoads.current > 0 && !transitioningRef.current) {
        setAttachmentError(t('Attachments are still loading. Send again once they finish.'));
        return;
      }
      // Pins and picks from the session's visualize panel ride along with a
      // message (never with a slash command), and alone make one sendable.
      const feedback = visualizeFeedbackFor(slashCommand ? undefined : sessionId);
      const hasFeedback = visualizeFeedbackPending(feedback);
      // Draft materialization and slash commands own the submit indicator;
      // only slash commands still serialize. Blocking a draft's follow-up here
      // just dropped it — the submit router joins the session the first submit
      // is minting instead of creating a second one.
      const showsSubmitProgress = Boolean(draftMode || slashCommand);
      if (
        (!hasFeedback && !hasSendablePromptContent({ text, attachments: submittedAttachments })) ||
        transitioningRef.current ||
        shouldBlockPromptSubmit({
          submitting: submittingRef.current,
          slashCommand,
        })
      )
        return;
      reportComposerAction({
        kind: 'composer-action',
        action: 'submit',
        source,
        turnBusy,
        queueCount: Array.isArray(queued) ? queued.length : 0,
        draftLength: text.length,
        composing: composingRef.current,
        uptimeMs: performance.now(),
      });
      if (showsSubmitProgress) {
        submittingRef.current = true;
        setSubmitting(true);
      }
      try {
        clearNotice();
        if (slashCommand) {
          if (commandBusy) {
            setAttachmentError('Wait for the current command to finish. Your command is still in the editor.');
            return;
          }
          setDraft((current) => (current === submittedDraft ? '' : current));
          removeAttachments(new Set(submittedAttachments.map((attachment) => attachment.id)));
          historyNavigation.current = { index: -1, seed: '' };
          const accepted = await executeSlash(text);
          if (!accepted) {
            setDraft((current) => (current ? current : submittedDraft));
            mergeRestoredAttachments(submittedAttachments, submittedDraft);
          } else {
            rememberPrompt(text);
          }
          return;
        }
        setAttachmentError('');
        const {
          expandedText,
          pastedImages,
          pastedTexts,
          imageAttachments,
          content,
          visualizePrompt,
          feedbackText,
          committedAttachments,
        } = prepareMessageSubmission(submittedDraft, submittedAttachments, feedback, hasFeedback);
        if (expandedText.length + feedbackText.length > MAX_SUBMIT_TEXT_LENGTH) {
          setAttachmentError('This prompt is too large to send. Remove or shorten an inline text attachment.');
          return;
        }
        const retryKey = submissionRetryKey(
          JSON.stringify(feedbackText ? [selectedSkill, expandedText, feedbackText] : [selectedSkill, expandedText]),
          committedAttachments
        );
        const submittedDisplayText = [
          [selectedSkill ? `[${skillTitle(selectedSkill)}]` : '', expandedText.trim()].filter(Boolean).join(' '),
          visualizePrompt?.display ?? '',
        ]
          .filter(Boolean)
          .join('\n');
        const priorRetry = submissionRetryRef.current;
        const submissionId = priorRetry?.key === retryKey ? priorRetry.id : nextComposerSubmissionId();
        // Keyed by this submission, unique across chats: attachment ids restart at 1.
        for (const attachment of imageAttachments) {
          registerImagePreview(
            submissionId,
            attachment.id,
            base64Bytes(attachment.data),
            attachmentDataUrl(attachment)
          );
        }
        retainComposerSubmissionRecovery({
          id: submissionId,
          scope: recoveryScope,
          text: submittedDraft,
          attachments: committedAttachments,
        });
        setDraft((current) => (current === submittedDraft ? '' : current));
        removeAttachments(new Set(committedAttachments.map((attachment) => attachment.id)));
        historyNavigation.current = { index: -1, seed: '' };
        const restoreSubmitted = () => {
          rejectComposerSubmissionRecovery(submissionId);
          if (mountedRef.current) setSubmissionRecoveryVersion((current) => current + 1);
        };
        let accepted: unknown;
        try {
          accepted = await submit(withSelectedSkill(content, selectedSkill), {
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
          // Sent: the chips go, and the pages drop their markers.
          if (hasFeedback && sessionId) consumeVisualizeFeedback(sessionId, feedback);
          registerSentAttachments(submissionId, sentAttachmentData(committedAttachments));
          if (selectedSkill) onSkillSubmitted?.(selectedSkill);
          resolveComposerSubmissionRecovery(submissionId);
          if (submissionRetryRef.current?.id === submissionId) submissionRetryRef.current = null;
          rememberPrompt(expandedText, committedAttachments);
        } else {
          // Refused: the draft comes back and the visualize chips stay; say
          // so, rather than leave an emptied composer and no message.
          submissionRetryRef.current = { key: retryKey, id: submissionId };
          restoreSubmitted();
          setAttachmentError(t('The message was not sent. It has been kept for retry.'));
        }
      } catch (error) {
        setAttachmentError(
          error instanceof Error && error.message
            ? error.message
            : 'The connection was interrupted. Your message has been kept for retry.'
        );
      } finally {
        if (showsSubmitProgress) {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    },
    [
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
      pendingLoads,
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
      selectedSkill,
      onSkillSubmitted,
      sessionId,
    ]
  );

  const stop = useCallback(
    async (preserveDraft = false, submissionId = '') => {
      const restorePrompt = submissionId ? !preserveDraft : false;
      const result = asRecord(
        await abort({
          restorePrompt,
          ...(submissionId ? { submissionId } : {}),
        })
      );
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
          const next = [acceptedText, current].filter(Boolean).join('\n');
          draftRef.current = next;
          return next;
        });
        window.setTimeout(() => textarea.current?.focus(), 0);
      }
    },
    [abort, draftRef, mergeRestoredAttachments, onQueuedRestored, restoredAttachments, setDraft, textarea]
  );

  return { send, stop };
}
