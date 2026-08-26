import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { type RecordValue } from "./desktop-types";
import {
  absolutePathsForDragPayload,
  dataTransferHasPathPayload,
  localFilesFromPaths,
  readFileDragPayload,
} from "./file-drag";
import {
  attachmentFromFile,
  attachmentPolicyError,
  isSupportedComposerImagePath,
} from "./composer-attachments";
import {
  MAX_COMPOSER_ATTACHMENTS,
  type ComposerAttachment,
} from "./composer-support";
import {
  insertComposerToken,
  takeRejectedComposerSubmissionRecoveries,
} from "./composer-draft";
import { asRecord } from "./text-format";

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
  const [attachmentError, setAttachmentError] = useState("");
  const [draggingFiles, setDraggingFiles] = useState(false);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const attachmentSequence = useRef(1);
  const fileInput = useRef<HTMLInputElement>(null);

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

  const insertAttachment = useCallback((attachment: ComposerAttachment) => {
    const currentAttachments = attachmentsRef.current;
    const policyError = attachmentPolicyError(currentAttachments, attachment);
    if (policyError) {
      setAttachmentError(policyError);
      return false;
    }
    const nextAttachments = [...currentAttachments, attachment];
    replaceAttachments(nextAttachments);
    const element = textarea.current;
    if (!attachment.token || attachment.chipOnly === true) {
      window.setTimeout(() => { textarea.current?.focus(); }, 0);
      historyNavigation.current = { index: -1, seed: "" };
      return true;
    }
    setDraft((current) => {
      const { next, caret } = insertComposerToken(
        current,
        element?.selectionStart,
        element?.selectionEnd,
        attachment.token,
      );
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(caret, caret);
      }, 0);
      draftRef.current = next;
      return next;
    });
    historyNavigation.current = { index: -1, seed: "" };
    return true;
  }, [draftRef, historyNavigation, replaceAttachments, setDraft, textarea]);

  const clearAttachments = useCallback(() => {
    replaceAttachments([]);
  }, [replaceAttachments]);

  const removeAttachments = useCallback((ids: Set<number>) => {
    if (ids.size === 0) return;
    const next = attachmentsRef.current.filter((attachment) => !ids.has(attachment.id));
    replaceAttachments(next);
  }, [replaceAttachments]);

  const removeAttachment = useCallback((attachment: ComposerAttachment) => {
    removeAttachments(new Set([attachment.id]));
    if (attachment.token) {
      setDraft((current) => {
        const next = current.replace(attachment.token, "").replace(/ {2,}/g, " ");
        draftRef.current = next;
        return next;
      });
    }
  }, [draftRef, removeAttachments, setDraft]);

  const attachFiles = useCallback(async (files: FileList | File[]) => {
    if (transitioningRef.current) return;
    setAttachmentError("");
    const available = Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachmentsRef.current.length);
    if (available === 0) {
      setAttachmentError(`Attach up to ${MAX_COMPOSER_ATTACHMENTS} items at a time.`);
      return;
    }
    const incoming = Array.from(files);
    if (incoming.length > available) {
      setAttachmentError(`Only the first ${available} item${available === 1 ? "" : "s"} fit; remove an attachment to add more.`);
    }
    for (const file of incoming.slice(0, available)) {
      if (transitioningRef.current) return;
      try {
        const attachment = await attachmentFromFile(file, {
          id: attachmentSequence.current++,
          cancelled: () => transitioningRef.current,
        });
        if (!attachment) return;
        insertAttachment(attachment);
      } catch (reason) {
        setAttachmentError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, [insertAttachment, transitioningRef]);

  const insertProjectMentions = useCallback((paths: string[]) => {
    const mentions = paths
      .map((path) => path.replace(/\\/g, "/").replace(/^\/+/, "").trim())
      .filter((path) => path && !path.split("/").includes("..") && !/^[a-z]:/i.test(path))
      .map((path) => `@${path}`);
    if (!mentions.length) return;
    const element = textarea.current;
    setDraft((current) => {
      const { next, caret } = insertComposerToken(
        current,
        element?.selectionStart,
        element?.selectionEnd,
        mentions.join(" "),
      );
      draftRef.current = next;
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(caret, caret);
      }, 0);
      return next;
    });
    historyNavigation.current = { index: -1, seed: "" };
  }, [draftRef, historyNavigation, setDraft, textarea]);

  const insertAbsolutePaths = useCallback((paths: string[]) => {
    const tokens = paths
      .map((path) => String(path || "").trim())
      .filter(Boolean)
      .map((path) => /\s/.test(path) ? `"${path}"` : path);
    if (!tokens.length) return;
    const element = textarea.current;
    setDraft((current) => {
      const { next, caret } = insertComposerToken(
        current,
        element?.selectionStart,
        element?.selectionEnd,
        tokens.join(" "),
      );
      draftRef.current = next;
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(caret, caret);
      }, 0);
      return next;
    });
    historyNavigation.current = { index: -1, seed: "" };
  }, [draftRef, historyNavigation, setDraft, textarea]);

  const attachLocalPaths = useCallback(async (paths: string[]) => {
    const loaded = await localFilesFromPaths(window.mixdogDesktop, paths);
    if (loaded.directories.length) {
      insertAbsolutePaths(loaded.directories.map((entry) => entry.absolutePath));
    }
    if (loaded.errors.length) setAttachmentError(loaded.errors[0]);
    if (loaded.files.length) await attachFiles(loaded.files);
  }, [attachFiles, insertAbsolutePaths]);

  const attachProjectPaths = useCallback(async (projectPath: string, paths: string[]) => {
    const imagePaths = paths.filter(isSupportedComposerImagePath);
    insertProjectMentions(paths.filter((path) => !isSupportedComposerImagePath(path)));
    if (!imagePaths.length) return;
    await attachLocalPaths(absolutePathsForDragPayload({
      kind: "project",
      projectPath,
      paths: imagePaths,
    }));
  }, [attachLocalPaths, insertProjectMentions]);

  useEffect(() => {
    const target = dropTargetRef.current;
    if (!target) return;
    const containsType = (event: DragEvent, type: string) =>
      Array.from(event.dataTransfer?.types ?? []).includes(type);
    const containsFiles = (event: DragEvent) => containsType(event, "Files");
    const containsPaths = (event: DragEvent) => Boolean(
      event.dataTransfer && dataTransferHasPathPayload(event.dataTransfer),
    );
    const containsInput = (event: DragEvent) => containsFiles(event) || containsPaths(event);
    const clearDraggingFiles = () => setDraggingFiles(false);
    const onDragEnter = (event: DragEvent) => {
      if (!containsInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (transitioningRef.current) return;
      setDraggingFiles(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!containsInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = transitioningRef.current ? "none" : "copy";
      }
      if (!transitioningRef.current) setDraggingFiles(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget && target.contains(event.relatedTarget as Node)) return;
      clearDraggingFiles();
    };
    const onWindowDragOver = (event: DragEvent) => {
      if (!containsInput(event)) return;
      if (event.target instanceof Node && target.contains(event.target)) return;
      clearDraggingFiles();
    };
    const onDrop = (event: DragEvent) => {
      if (!containsInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clearDraggingFiles();
      if (transitioningRef.current || !event.dataTransfer) return;
      const payload = readFileDragPayload(event.dataTransfer);
      if (payload) {
        if (payload.kind === "project") {
          const source = payload.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase();
          const targetProject = projectScope.replace(/[\\/]+/g, "/").toLocaleLowerCase();
          if (source && targetProject && source === targetProject) {
            void attachProjectPaths(payload.projectPath, payload.paths);
            return;
          }
        }
        void attachLocalPaths(absolutePathsForDragPayload(payload));
        return;
      }
      const itemFiles = Array.from(event.dataTransfer.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      void attachFiles(itemFiles.length ? itemFiles : event.dataTransfer.files);
    };
    target.addEventListener("dragenter", onDragEnter);
    target.addEventListener("dragover", onDragOver);
    target.addEventListener("dragleave", onDragLeave);
    target.addEventListener("drop", onDrop);
    window.addEventListener("dragover", onWindowDragOver, true);
    window.addEventListener("drop", clearDraggingFiles, true);
    window.addEventListener("dragend", clearDraggingFiles, true);
    window.addEventListener("blur", clearDraggingFiles);
    return () => {
      target.removeEventListener("dragenter", onDragEnter);
      target.removeEventListener("dragover", onDragOver);
      target.removeEventListener("dragleave", onDragLeave);
      target.removeEventListener("drop", onDrop);
      window.removeEventListener("dragover", onWindowDragOver, true);
      window.removeEventListener("drop", clearDraggingFiles, true);
      window.removeEventListener("dragend", clearDraggingFiles, true);
      window.removeEventListener("blur", clearDraggingFiles);
    };
  }, [attachFiles, attachLocalPaths, attachProjectPaths, dropTargetRef, projectScope, transitioningRef]);

  const restoredAttachments = useCallback((value: RecordValue, restoredText: string): {
    attachments: ComposerAttachment[];
    text: string;
  } => {
    const restored: ComposerAttachment[] = [];
    const reserved = new Set(attachmentsRef.current.map((attachment) => attachment.id));
    let textValue = restoredText;
    const uniqueId = (rawId: number) => {
      let id = rawId > 0 ? rawId : attachmentSequence.current;
      while (reserved.has(id)) id = Math.max(id + 1, attachmentSequence.current++);
      reserved.add(id);
      attachmentSequence.current = Math.max(attachmentSequence.current, id + 1);
      return id;
    };
    for (const [key, raw] of Object.entries(asRecord(value.pastedImages) || {})) {
      const image = asRecord(raw);
      if (!image || typeof image.content !== "string") continue;
      const rawId = Number(image.id || key) || 0;
      const name = String(image.filename || `Image ${rawId || attachmentSequence.current}`);
      const namedToken = `[Image #${rawId}: ${name}]`;
      const plainToken = `[Image #${rawId}]`;
      const sourceToken = textValue.includes(namedToken) ? namedToken : textValue.includes(plainToken) ? plainToken : "";
      if (sourceToken) {
        textValue = textValue.replace(sourceToken, " ").replace(/ {2,}/g, " ")
          .split("\n").map((line) => line.trim()).join("\n").trim();
      }
      restored.push({
        id: uniqueId(rawId),
        name,
        kind: "image",
        mimeType: String(image.mediaType || "image/png"),
        data: image.content,
        token: "",
        ...(typeof image.metadataText === "string" && image.metadataText
          ? { metadataText: image.metadataText }
          : {}),
      });
    }
    for (const [key, raw] of Object.entries(asRecord(value.pastedTexts) || {})) {
      const text = asRecord(raw);
      if (!text || typeof text.text !== "string") continue;
      const rawId = Number(text.id || key) || 0;
      const pastedMatch = textValue.match(new RegExp(`\\[Pasted text #${rawId}(?: \\+\\d+ lines)?\\]`));
      const fileMatch = textValue.match(new RegExp(`\\[File #${rawId}(?:: [^\\]\\r\\n]+)?\\]`));
      const source = text.source === "file" || (!pastedMatch && Boolean(fileMatch)) ? "file" : "paste";
      const match = source === "file" ? fileMatch : pastedMatch;
      if (!match) continue;
      const id = uniqueId(rawId);
      const token = id === rawId ? match[0] : match[0].replace(`#${rawId}`, `#${id}`);
      if (token !== match[0]) textValue = textValue.replace(match[0], token);
      restored.push({
        id,
        name: String(text.filename || (source === "file" ? `File ${id}` : `Pasted text ${id}`)),
        kind: "text",
        mimeType: String(text.mimeType || "text/plain"),
        data: text.text,
        token,
        source,
      });
    }
    return { attachments: restored, text: textValue };
  }, []);

  const mergeRestoredAttachments = useCallback((restored: ComposerAttachment[], restoredText: string) => {
    if (!restored.length) return restoredText;
    const next = [...attachmentsRef.current];
    let nextText = restoredText;
    let firstError = "";
    for (const attachment of restored) {
      const index = next.findIndex((entry) => entry.id === attachment.id && entry.kind === attachment.kind);
      if (index >= 0) {
        next[index] = attachment;
        continue;
      }
      const policyError = attachmentPolicyError(next, attachment);
      if (policyError) {
        firstError ||= policyError;
        nextText = nextText.replace(attachment.token, "").replace(/ {2,}/g, " ").trim();
        continue;
      }
      next.push(attachment);
    }
    if (firstError) setAttachmentError(firstError);
    replaceAttachments(next);
    return nextText;
  }, [replaceAttachments]);

  useLayoutEffect(() => {
    const recoveries = takeRejectedComposerSubmissionRecoveries(recoveryScope);
    if (!recoveries.length) return;
    const restoredTexts = recoveries.map((recovery) =>
      mergeRestoredAttachments(recovery.attachments, recovery.text));
    setDraft((current) => {
      const next = [...restoredTexts, current].filter(Boolean).join("\n");
      draftRef.current = next;
      return next;
    });
    historyNavigation.current = { index: -1, seed: "" };
  }, [draftRef, historyNavigation, mergeRestoredAttachments, recoveryScope,
    setDraft, submissionRecoveryVersion]);

  const resetAttachments = useCallback(() => {
    replaceAttachments([]);
    setAttachmentError("");
    setDraggingFiles(false);
  }, [replaceAttachments]);

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
