import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { RecordValue } from './desktop-types';
import { absolutePathsForDragPayload, localFilesFromPaths } from './file-drag';
import {
  attachmentFromFile,
  attachmentPolicyError,
  isSupportedComposerImagePath,
  UnsupportedComposerFileError,
} from './composer-attachments';
import { MAX_COMPOSER_ATTACHMENTS, type ComposerAttachment } from './composer-support';
import { insertComposerToken, takeRejectedComposerSubmissionRecoveries } from './composer-draft';
import { absolutePathTokens, projectMentionTokens, restoreAttachmentsFromRecord } from './composer-attachment-restore';
import { useComposerFileDrop } from './use-composer-file-drop';

/** Insert a token at the caret, keep the draft mirror current, restore focus
 *  behind the caret and leave any history walk. */
function useCaretTokenInsert({
  draftRef,
  setDraft,
  textarea,
  historyNavigation,
}: {
  draftRef: RefObject<string>;
  setDraft: Dispatch<SetStateAction<string>>;
  textarea: RefObject<HTMLTextAreaElement | null>;
  historyNavigation: RefObject<{ index: number; seed: string }>;
}) {
  return useCallback(
    (token: string) => {
      const element = textarea.current;
      setDraft((current) => {
        const { next, caret } = insertComposerToken(current, element?.selectionStart, element?.selectionEnd, token);
        draftRef.current = next;
        window.setTimeout(() => {
          textarea.current?.focus();
          textarea.current?.setSelectionRange(caret, caret);
        }, 0);
        return next;
      });
      historyNavigation.current = { index: -1, seed: '' };
    },
    [draftRef, historyNavigation, setDraft, textarea]
  );
}

export function useComposerAttachments({
  draftRef,
  setDraft,
  textarea,
  historyNavigation,
  transitioningRef,
  projectScope,
  recoveryScope,
  submissionRecoveryVersion,
  dropTargetRef,
}: {
  draftRef: RefObject<string>;
  setDraft: Dispatch<SetStateAction<string>>;
  textarea: RefObject<HTMLTextAreaElement | null>;
  historyNavigation: RefObject<{ index: number; seed: string }>;
  transitioningRef: RefObject<boolean>;
  projectScope: string;
  recoveryScope: string;
  submissionRecoveryVersion: number;
  dropTargetRef: RefObject<HTMLElement | null>;
}) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const attachmentSequence = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const insertTokenAtCaret = useCaretTokenInsert({ draftRef, setDraft, textarea, historyNavigation });

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const replaceAttachments = useCallback((next: ComposerAttachment[]) => {
    for (const attachment of next) {
      attachmentSequence.current = Math.max(attachmentSequence.current, attachment.id + 1);
    }
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const insertAttachment = useCallback(
    (attachment: ComposerAttachment) => {
      const currentAttachments = attachmentsRef.current;
      const policyError = attachmentPolicyError(currentAttachments, attachment);
      if (policyError) {
        setAttachmentError(policyError);
        return false;
      }
      replaceAttachments([...currentAttachments, attachment]);
      if (!attachment.token || attachment.chipOnly === true) {
        window.setTimeout(() => {
          textarea.current?.focus();
        }, 0);
        historyNavigation.current = { index: -1, seed: '' };
        return true;
      }
      insertTokenAtCaret(attachment.token);
      return true;
    },
    [historyNavigation, insertTokenAtCaret, replaceAttachments, textarea]
  );

  const clearAttachments = useCallback(() => {
    replaceAttachments([]);
  }, [replaceAttachments]);

  const removeAttachments = useCallback(
    (ids: Set<number>) => {
      if (ids.size === 0) return;
      const next = attachmentsRef.current.filter((attachment) => !ids.has(attachment.id));
      replaceAttachments(next);
    },
    [replaceAttachments]
  );

  const removeAttachment = useCallback(
    (attachment: ComposerAttachment) => {
      removeAttachments(new Set([attachment.id]));
      if (attachment.token) {
        setDraft((current) => {
          const next = current.replace(attachment.token, '').replace(/ {2,}/g, ' ');
          draftRef.current = next;
          return next;
        });
      }
    },
    [draftRef, removeAttachments, setDraft]
  );

  const insertProjectMentions = useCallback(
    (paths: string[]) => {
      const mentions = projectMentionTokens(paths);
      if (mentions.length) insertTokenAtCaret(mentions.join(' '));
    },
    [insertTokenAtCaret]
  );

  const insertAbsolutePaths = useCallback(
    (paths: string[]) => {
      const tokens = absolutePathTokens(paths);
      if (tokens.length) insertTokenAtCaret(tokens.join(' '));
    },
    [insertTokenAtCaret]
  );

  const attachFiles = useCallback(
    async (files: FileList | File[], sourcePaths?: ReadonlyMap<File, string>) => {
      if (transitioningRef.current) return;
      setAttachmentError('');
      const fallbackPaths: string[] = [];
      for (const file of Array.from(files)) {
        if (transitioningRef.current) return;
        try {
          if (attachmentsRef.current.length >= MAX_COMPOSER_ATTACHMENTS) {
            throw new Error(`Attach up to ${MAX_COMPOSER_ATTACHMENTS} items at a time.`);
          }
          const attachment = await attachmentFromFile(file, {
            id: attachmentSequence.current++,
            cancelled: () => transitioningRef.current,
          });
          if (!attachment) return;
          if (insertAttachment(attachment)) continue;
        } catch (reason) {
          if (transitioningRef.current) return;
          if (!(reason instanceof UnsupportedComposerFileError)) {
            setAttachmentError(reason instanceof Error ? reason.message : String(reason));
          }
        }
        // Native selections retain their OS path; materialized internal drops
        // need the source path carried separately from their in-memory File.
        const path = sourcePaths?.get(file) || window.mixdogDesktop?.folderPathForFile?.(file);
        if (path) {
          fallbackPaths.push(path);
        } else {
          setAttachmentError((current) => `${current} ${file.name || 'Pasted file'}: local file path is unavailable.`);
        }
      }
      insertAbsolutePaths(fallbackPaths);
    },
    [insertAbsolutePaths, insertAttachment, transitioningRef]
  );

  const attachLocalPaths = useCallback(
    async (paths: string[]) => {
      if (transitioningRef.current) return;
      setAttachmentError('');
      const loaded = await localFilesFromPaths(window.mixdogDesktop, paths);
      if (transitioningRef.current) return;
      if (loaded.files.length) await attachFiles(loaded.files, loaded.sourcePaths);
      if (transitioningRef.current) return;
      insertAbsolutePaths([...loaded.directories.map((entry) => entry.absolutePath), ...loaded.unattachedPaths]);
      if (loaded.errors.length) {
        setAttachmentError((current) => [...loaded.errors, current].filter(Boolean).join('\n'));
      }
    },
    [attachFiles, insertAbsolutePaths, transitioningRef]
  );

  const attachProjectPaths = useCallback(
    async (projectPath: string, paths: string[]) => {
      const imagePaths = paths.filter(isSupportedComposerImagePath);
      insertProjectMentions(paths.filter((path) => !isSupportedComposerImagePath(path)));
      if (!imagePaths.length) return;
      await attachLocalPaths(
        absolutePathsForDragPayload({
          kind: 'project',
          projectPath,
          paths: imagePaths,
        })
      );
    },
    [attachLocalPaths, insertProjectMentions]
  );

  const { draggingFiles, setDraggingFiles } = useComposerFileDrop({
    dropTargetRef,
    transitioningRef,
    projectScope,
    attachFiles,
    attachLocalPaths,
    attachProjectPaths,
    insertAbsolutePaths,
  });

  const restoredAttachments = useCallback(
    (value: RecordValue, restoredText: string) =>
      restoreAttachmentsFromRecord(value, restoredText, {
        reservedIds: new Set(attachmentsRef.current.map((attachment) => attachment.id)),
        sequence: attachmentSequence,
      }),
    []
  );

  const mergeRestoredAttachments = useCallback(
    (restored: ComposerAttachment[], restoredText: string) => {
      if (!restored.length) return restoredText;
      const next = [...attachmentsRef.current];
      let nextText = restoredText;
      let firstError = '';
      for (const attachment of restored) {
        const index = next.findIndex((entry) => entry.id === attachment.id && entry.kind === attachment.kind);
        if (index >= 0) {
          next[index] = attachment;
          continue;
        }
        const policyError = attachmentPolicyError(next, attachment);
        if (policyError) {
          firstError ||= policyError;
          nextText = nextText.replace(attachment.token, '').replace(/ {2,}/g, ' ').trim();
          continue;
        }
        next.push(attachment);
      }
      if (firstError) setAttachmentError(firstError);
      replaceAttachments(next);
      return nextText;
    },
    [replaceAttachments]
  );

  useLayoutEffect(() => {
    const recoveries = takeRejectedComposerSubmissionRecoveries(recoveryScope);
    if (!recoveries.length) return;
    const restoredTexts = recoveries.map((recovery) => mergeRestoredAttachments(recovery.attachments, recovery.text));
    setDraft((current) => {
      const next = [...restoredTexts, current].filter(Boolean).join('\n');
      draftRef.current = next;
      return next;
    });
    historyNavigation.current = { index: -1, seed: '' };
  }, [draftRef, historyNavigation, mergeRestoredAttachments, recoveryScope, setDraft, submissionRecoveryVersion]);

  const resetAttachments = useCallback(() => {
    replaceAttachments([]);
    setAttachmentError('');
    setDraggingFiles(false);
  }, [replaceAttachments, setDraggingFiles]);

  return {
    attachments,
    attachmentsRef,
    attachmentError,
    setAttachmentError,
    draggingFiles,
    setDraggingFiles,
    attachmentSequence,
    fileInput,
    insertAttachment,
    clearAttachments,
    removeAttachments,
    removeAttachment,
    replaceAttachments,
    attachFiles,
    restoredAttachments,
    mergeRestoredAttachments,
    resetAttachments,
  };
}
