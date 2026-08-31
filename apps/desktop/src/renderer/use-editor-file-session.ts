import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type {
  DesktopEditorSettings,
  DesktopTextFileEncoding,
} from "../shared/contract";
import {
  documentPreviewFormatForPath,
  filePreviewTypeForPath,
} from "../shared/file-preview";
import {
  normalizeEditorModelText,
  resolveEditorBackup,
  takeEditorFileLoad,
  type EditorFileLoad,
} from "./editor-file-loader";
import {
  mergeDocumentPreviewPages,
  type DocumentPreview,
} from "./editor-document-model";
import {
  type EditorFileHandle,
  type EditorRecovery,
  type FilePreview,
} from "./editor-pane-model";
import { reportEditorLoadStage } from "./renderer-load-metrics";

type EditorInstance = import("monaco-editor").editor.IStandaloneCodeEditor;

export function useEditorFileSession({
  editorRef,
  projectPath,
  relPath,
  accessToken,
  active,
  editorSettings,
  notifyReady,
  onDirty,
  onSaveHandle,
  syncLspRef,
}: {
  editorRef: RefObject<EditorInstance | null>;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  active: boolean;
  editorSettings: DesktopEditorSettings;
  notifyReady(): void;
  onDirty(dirty: boolean): void;
  onSaveHandle?(handle: EditorFileHandle | null): void;
  syncLspRef: RefObject<(kind?: "change" | "save") => Promise<boolean>>;
}) {
  const api = window.mixdogDesktop;
  const [load, setLoad] = useState<EditorFileLoad | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [documentPreview, setDocumentPreview] = useState<DocumentPreview | null>(null);
  const [documentError, setDocumentError] = useState("");
  const [documentPagesLoading, setDocumentPagesLoading] = useState(false);
  const documentPagesInFlight = useRef(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [revertError, setRevertError] = useState("");
  const [recovery, setRecovery] = useState<EditorRecovery | null>(null);
  const [diffTick, setDiffTick] = useState(0);
  const savedMtime = useRef(0);
  const savedDiskText = useRef("");
  const savedText = useRef("");
  const loadedRef = useRef(false);
  const savingRef = useRef(false);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const backupTimer = useRef<number | null>(null);
  const backupQueue = useRef<Promise<void>>(Promise.resolve());
  const skipUnmountBackup = useRef(false);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSaveHandleRef = useRef(onSaveHandle);
  onSaveHandleRef.current = onSaveHandle;

  const markDirty = useCallback((next: boolean) => {
    setDirty(next);
    onDirtyRef.current(next);
  }, []);

  const enqueueBackup = useCallback((operation: () => Promise<unknown>): Promise<void> => {
    const run = backupQueue.current.catch(() => undefined).then(operation).then(() => undefined);
    backupQueue.current = run.catch(() => undefined);
    return run;
  }, []);

  const writeBackupNow = useCallback((content: string): Promise<void> => {
    if (!api?.writeEditorBackup) return Promise.resolve();
    return enqueueBackup(() => api.writeEditorBackup!(
      projectPath,
      relPath,
      content,
      savedDiskText.current,
      accessToken,
    ));
  }, [accessToken, api, enqueueBackup, projectPath, relPath]);

  const deleteBackup = useCallback((): Promise<void> => {
    if (backupTimer.current !== null) {
      window.clearTimeout(backupTimer.current);
      backupTimer.current = null;
    }
    if (!api?.deleteEditorBackup) return Promise.resolve();
    return enqueueBackup(() => api.deleteEditorBackup!(
      projectPath,
      relPath,
      accessToken,
    ));
  }, [accessToken, api, enqueueBackup, projectPath, relPath]);

  const scheduleBackup = useCallback((content: string) => {
    if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
    backupTimer.current = window.setTimeout(() => {
      backupTimer.current = null;
      void writeBackupNow(content).catch(() => undefined);
    }, 500);
  }, [writeBackupNow]);

  useEffect(() => () => {
    if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
    const model = editorRef.current?.getModel();
    if (model && !skipUnmountBackup.current && model.getValue() !== savedText.current) {
      void writeBackupNow(model.getValue()).catch(() => undefined);
    }
  }, [editorRef, writeBackupNow]);

  // The ordinary text/binary read, extracted so a document whose conversion
  // fails still lands on the binary notice — with its "open in the default
  // app" escape — instead of a dead-end error screen.
  const readFileContents = useCallback(() => {
    if (!api?.readProjectFile) {
      setError("Desktop file access is unavailable.");
      return;
    }
    void takeEditorFileLoad(
      api,
      projectPath,
      relPath,
      accessToken,
      !loadedRef.current,
      true,
    )
      .then(({ file: result, backup }) => {
        const resolution = resolveEditorBackup(result.content, backup);
        const content = resolution.content;
        let nextRecovery: EditorRecovery | null = null;
        if (!result.binary && !result.tooLarge) {
          nextRecovery = resolution.recovery;
          if (resolution.discardBackup) {
            void deleteBackup().catch(() => undefined);
          }
        }
        loadedRef.current = true;
        savedMtime.current = result.mtimeMs;
        savedDiskText.current = result.content;
        savedText.current = resolution.savedContent;
        setLoad({ ...result, content });
        setRecovery(nextRecovery);
        setDiskChanged(false);
        const model = editorRef.current?.getModel();
        if (model && model.getValue() !== content) model.setValue(content);
        markDirty(content !== resolution.savedContent);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        if (loadedRef.current) setDiskChanged(true);
      });
  }, [accessToken, api, deleteBackup, editorRef, markDirty, projectPath, relPath]);

  const reload = useCallback(() => {
    setError("");
    setSaveError("");
    setRevertError("");
    setPreviewError("");
    setPreviewLoaded(false);
    setPreview(null);
    setDocumentPreview(null);
    setDocumentError("");
    if (filePreviewTypeForPath(relPath) && api?.previewProjectFile) {
      void api.previewProjectFile(projectPath, relPath, accessToken)
        .then((result) => {
          loadedRef.current = true;
          savedMtime.current = result.mtimeMs;
          savedDiskText.current = "";
          savedText.current = "";
          setPreview(result);
          setLoad({
            content: "",
            mtimeMs: result.mtimeMs,
            binary: true,
            tooLarge: false,
            encoding: "utf8",
          });
          setRecovery(null);
          setDiskChanged(false);
          markDirty(false);
        })
        .catch((reason) => {
          setLoad(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      return;
    }
    // Office documents have no native viewer. Electron shows the converted
    // PDF through the surface it already has; a paired phone cannot open that
    // file at all, so it takes the same conversion as page images.
    const documentFormat = documentPreviewFormatForPath(relPath);
    const documentFailed = (reason: unknown): void => {
      setDocumentError(reason instanceof Error ? reason.message : String(reason));
      readFileContents();
    };
    const documentOpened = (result: { mtimeMs: number }): void => {
      loadedRef.current = true;
      savedMtime.current = result.mtimeMs;
      savedDiskText.current = "";
      savedText.current = "";
      setLoad({
        content: "",
        mtimeMs: result.mtimeMs,
        binary: true,
        tooLarge: false,
        encoding: "utf8",
      });
      setRecovery(null);
      setDiskChanged(false);
      markDirty(false);
    };
    if (documentFormat && api?.previewDocumentFile) {
      void api.previewDocumentFile(projectPath, relPath, accessToken)
        .then((result) => {
          setPreview({
            url: result.url,
            kind: "pdf",
            mime: result.mime,
            mtimeMs: result.mtimeMs,
            size: result.size,
          });
          documentOpened(result);
        })
        .catch(documentFailed);
      return;
    }
    if (documentFormat && api?.previewDocumentPages) {
      void api.previewDocumentPages(projectPath, relPath, accessToken, { pages: [1] })
        .then((result) => {
          setDocumentPreview({
            format: result.format,
            mtimeMs: result.mtimeMs,
            size: result.size,
            pageCount: result.pageCount,
            pages: result.pages,
          });
          documentOpened(result);
        })
        .catch(documentFailed);
      return;
    }
    readFileContents();
  }, [accessToken, api, markDirty, projectPath, readFileContents, relPath]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if ((error && !load)
      || (load && !preview && !documentPreview && (load.binary || load.tooLarge))) {
      reportEditorLoadStage(projectPath, relPath, accessToken, "fallback-ready", "", true);
      notifyReady();
    }
  }, [accessToken, error, load, notifyReady, preview, projectPath, relPath]);

  const saveNow = useCallback(async (encoding?: DesktopTextFileEncoding): Promise<boolean> => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const writer = api?.writeProjectFile;
    if (!editor || !model || !writer) return false;
    if (!encoding && model.getValue() === savedText.current) return true;
    if (editorSettings.formatOnSave) {
      try {
        await editor.getAction("editor.action.formatDocument")?.run();
      } catch (reason) {
        setSaveError(`Format on save failed: ${reason instanceof Error ? reason.message : String(reason)}`);
        return false;
      }
    }
    const content = model.getValue();
    const expectedContent = savedDiskText.current;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    setRevertError("");
    try {
      const result = await writer(
        projectPath,
        relPath,
        content,
        expectedContent,
        accessToken,
        encoding,
      );
      savedMtime.current = result?.mtimeMs ?? Date.now();
      savedDiskText.current = content;
      savedText.current = content;
      setRecovery(null);
      setDiskChanged(false);
      setError("");
      if (encoding) {
        setLoad((current) => current ? { ...current, encoding } : current);
      }
      const currentContent = editorRef.current?.getModel()?.getValue() ?? content;
      const changedAfterSave = currentContent !== content;
      markDirty(changedAfterSave);
      setDiffTick((tick) => tick + 1);
      if (backupTimer.current !== null) {
        window.clearTimeout(backupTimer.current);
        backupTimer.current = null;
      }
      if (changedAfterSave) await writeBackupNow(currentContent).catch(() => undefined);
      else await deleteBackup().catch(() => undefined);
      void syncLspRef.current("save");
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setSaveError(message);
      if (/changed on disk|ENOENT|no such file|cannot find/i.test(message)) setDiskChanged(true);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [accessToken, api, deleteBackup, editorRef, editorSettings.formatOnSave, markDirty,
    projectPath, relPath, syncLspRef, writeBackupNow]);

  const save = useCallback((encoding?: DesktopTextFileEncoding): Promise<boolean> => {
    const queued = saveQueue.current.catch(() => false).then(() => saveNow(encoding));
    saveQueue.current = queued;
    return queued;
  }, [saveNow]);
  const saveRef = useRef<() => Promise<boolean>>(save);
  saveRef.current = save;

  const discard = useCallback(async (): Promise<void> => {
    skipUnmountBackup.current = true;
    await deleteBackup();
  }, [deleteBackup]);

  useEffect(() => {
    const handle: EditorFileHandle = {
      save: () => saveRef.current(),
      discard,
    };
    onSaveHandleRef.current?.(handle);
    return () => onSaveHandleRef.current?.(null);
  }, [discard]);

  useEffect(() => {
    if (!active || !load || load.binary || load.tooLarge) return undefined;
    const timer = window.setInterval(() => {
      if (document.body.dataset.tabDragging) return;
      void api?.statProjectFile?.(projectPath, relPath, accessToken).then((info) => {
        if (!info || info.mtimeMs <= savedMtime.current) return;
        const model = editorRef.current?.getModel();
        const isDirty = model ? model.getValue() !== savedText.current : false;
        if (isDirty) setDiskChanged(true);
        else reload();
      }).catch((reason) => {
        if (!editorRef.current?.getModel()) return;
        setDiskChanged(true);
        setSaveError(reason instanceof Error ? reason.message : "File was deleted or renamed on disk.");
      });
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [accessToken, active, api, editorRef, load, projectPath, relPath, reload]);

  const revertFromDisk = useCallback(async (): Promise<boolean> => {
    const reader = api?.readProjectFile;
    const model = editorRef.current?.getModel();
    if (!reader || !model || reverting || savingRef.current) return false;
    setReverting(true);
    setRevertError("");
    try {
      const result = await reader(projectPath, relPath, accessToken);
      if (result.binary || result.tooLarge) {
        throw new Error("The disk version can no longer be safely edited as text.");
      }
      const content = normalizeEditorModelText(result.content);
      savedMtime.current = result.mtimeMs;
      savedDiskText.current = result.content;
      savedText.current = content;
      setLoad({ ...result, content });
      setRecovery(null);
      setDiskChanged(false);
      setError("");
      setSaveError("");
      model.setValue(content);
      markDirty(false);
      setDiffTick((tick) => tick + 1);
      await deleteBackup().catch(() => undefined);
      editorRef.current?.focus();
      return true;
    } catch (reason) {
      setRevertError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setReverting(false);
    }
  }, [accessToken, api, deleteBackup, editorRef, markDirty, projectPath, relPath, reverting]);

  const restoreConflictingBackup = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model || !recovery) return;
    model.setValue(recovery.content);
    setRecovery({ ...recovery, restored: true });
    markDirty(true);
    scheduleBackup(recovery.content);
    editorRef.current?.focus();
  }, [editorRef, markDirty, recovery, scheduleBackup]);

  const discardPendingBackup = useCallback(() => {
    setRecovery(null);
    void deleteBackup().catch(() => undefined);
  }, [deleteBackup]);

  const keepEdits = useCallback(() => {
    const model = editorRef.current?.getModel();
    const reader = api?.readProjectFile;
    if (!model || !reader) return;
    setSaveError("");
    void reader(projectPath, relPath, accessToken)
      .then((result) => {
        if (result.binary || result.tooLarge) {
          throw new Error("The disk version can no longer be safely edited as text.");
        }
        const savedContent = normalizeEditorModelText(result.content);
        const currentContent = model.getValue();
        savedMtime.current = result.mtimeMs;
        savedDiskText.current = result.content;
        savedText.current = savedContent;
        setDiskChanged(false);
        setError("");
        const changed = currentContent !== savedContent;
        markDirty(changed);
        if (changed) void writeBackupNow(currentContent).catch(() => undefined);
        else void deleteBackup().catch(() => undefined);
      })
      .catch((reason) => {
        setDiskChanged(true);
        setSaveError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [accessToken, api, deleteBackup, editorRef, markDirty, projectPath, relPath, writeBackupNow]);

  const onEditorChange = useCallback((value: string | undefined) => {
    const content = String(value ?? "");
    const changed = content !== savedText.current;
    skipUnmountBackup.current = false;
    setRevertError("");
    markDirty(changed);
    if (changed) scheduleBackup(content);
    else {
      setRecovery(null);
      void deleteBackup().catch(() => undefined);
    }
  }, [deleteBackup, markDirty, scheduleBackup]);

  // Page images arrive as the viewer scrolls. One request at a time: the
  // conversion is shared, but each page is its own rasterization and a phone
  // gains nothing from three of them racing down the same link.
  const loadDocumentPages = useCallback((pages: number[]) => {
    const reader = api?.previewDocumentPages;
    if (!reader || pages.length === 0 || documentPagesInFlight.current) return;
    documentPagesInFlight.current = true;
    setDocumentPagesLoading(true);
    void reader(projectPath, relPath, accessToken, { pages })
      .then((result) => {
        setDocumentPreview((current) => (
          current ? mergeDocumentPreviewPages(current, result) : current
        ));
      })
      .catch((reason) => {
        setDocumentError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        documentPagesInFlight.current = false;
        setDocumentPagesLoading(false);
      });
  }, [accessToken, api, projectPath, relPath]);

  const completePreview = useCallback(() => {
    setPreviewLoaded(true);
    notifyReady();
  }, [notifyReady]);

  const failPreview = useCallback(() => {
    setPreviewLoaded(true);
    setPreviewError("This file could not be displayed in the built-in viewer.");
    notifyReady();
  }, [notifyReady]);

  return {
    load,
    preview,
    previewLoaded,
    previewError,
    documentPreview,
    documentError,
    documentPagesLoading,
    loadDocumentPages,
    error,
    dirty,
    saving,
    reverting,
    diskChanged,
    saveError,
    setSaveError,
    revertError,
    recovery,
    diffTick,
    savedText,
    markDirty,
    reload,
    save,
    saveRef,
    revertFromDisk,
    restoreConflictingBackup,
    discardPendingBackup,
    keepEdits,
    onEditorChange,
    completePreview,
    failPreview,
  };
}
