import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { DesktopEditorSettings, DesktopTextFileEncoding } from '../shared/contract';
import { normalizeEditorModelText, type EditorFileLoad } from './editor-file-loader';
import type { EditorFileHandle, EditorRecovery, FilePreview } from './editor-pane-model';
import { errorMessage, fileAccessError } from './editor-pane-session-errors';
import { useEditorDiskWatch } from './editor-pane-session-disk-watch';
import { useEditorSessionLoad } from './editor-pane-session-load';
import { t } from './i18n';
import { useEditorBackup } from './use-editor-backup';
import { useEditorDocumentPages, useEditorPreviewPoll } from './use-editor-document-pages';

type EditorInstance = import('monaco-editor').editor.IStandaloneCodeEditor;

const heldSaveError = () =>
  t('Rich holds an edit that is not in the file yet. Resolve or discard it in the Rich editor before saving.');

export function useEditorFileSession({
  editorRef,
  modelRef,
  formatDocument,
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
  modelRef?: RefObject<import('monaco-editor').editor.ITextModel | null>;
  formatDocument?(): Promise<void>;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  active: boolean;
  editorSettings: DesktopEditorSettings;
  notifyReady(): void;
  onDirty(dirty: boolean): void;
  /** `null` releases `released`: only the handle this pane registered. */
  onSaveHandle?(handle: EditorFileHandle | null, released?: EditorFileHandle): void;
  syncLspRef: RefObject<(kind?: 'change' | 'save') => Promise<boolean>>;
}) {
  const api = window.mixdogDesktop;
  const readModel = useCallback(
    () => editorRef.current?.getModel() ?? modelRef?.current ?? null,
    [editorRef, modelRef]
  );
  const [load, setLoad] = useState<EditorFileLoad | null>(null);
  // Bumped whenever a reload, revert or backup restore replaces the model
  // text, even when the loaded string is unchanged (edit then revert).
  const [contentRevision, setContentRevision] = useState(0);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const {
    documentPreview,
    setDocumentPreview,
    documentError,
    setDocumentError,
    documentPagesLoading,
    documentPageErrors,
    documentGeneration,
    resetDocument,
    loadDocumentPages,
    documentPreviewRef,
    documentPagesInFlight,
    documentWidth,
    documentSettling,
  } = useEditorDocumentPages({ api, projectPath, relPath, accessToken });
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [revertError, setRevertError] = useState('');
  const [recovery, setRecovery] = useState<EditorRecovery | null>(null);
  const [diffTick, setDiffTick] = useState(0);
  const savedMtime = useRef(0);
  const savedDiskText = useRef('');
  const savedText = useRef('');
  const loadedRef = useRef(false);
  const savingRef = useRef(false);
  const readOnlyRef = useRef(false);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const skipUnmountBackup = useRef(false);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSaveHandleRef = useRef(onSaveHandle);
  onSaveHandleRef.current = onSaveHandle;

  // An edit Rich holds is not in the model, yet leaving would lose it: it
  // keeps the file dirty, so every close path asks first, and blocks saving.
  const richHeldRef = useRef(false);
  // While held: the file text with the held edit, which backups keep
  // instead of the model's (so quitting cannot lose it).
  const richHeldText = useRef<(() => string | null) | null>(null);
  // While held: the disk text the held edit was based on. Its backup keeps
  // this as the expected content, never a newer disk version, so recovery
  // after an outside change reports the conflict.
  const richHeldDiskText = useRef<string | null>(null);
  const markDirty = useCallback((next: boolean) => {
    const effective = next || richHeldRef.current;
    setDirty(effective);
    onDirtyRef.current(effective);
  }, []);

  const { backupTimer, writeBackupNow, deleteBackup, scheduleBackup } = useEditorBackup({
    api,
    projectPath,
    relPath,
    accessToken,
    readModel,
    savedText,
    savedDiskText,
    skipUnmountBackup,
    heldText: richHeldText,
    heldDiskText: richHeldDiskText,
  });
  /** What a backup keeps while Rich holds an edit. */
  const heldBackupText = useCallback(() => richHeldText.current?.() ?? readModel()?.getValue() ?? null, [readModel]);
  const heldBackupBase = useCallback(() => richHeldDiskText.current ?? undefined, []);
  // Bumped by an explicit discard and on unmount: backup work started
  // before then (with an older generation) must not write afterwards.
  const backupGeneration = useRef(0);
  useEffect(
    () => () => {
      backupGeneration.current++;
    },
    []
  );
  /** Brings the backup in line with the model (`modelText` when it differs
   *  from the saved text, null when clean), for work that started at
   *  `generation`. A held edit is never left without its backup: held state
   *  is re-checked after each await, and while held the held text is
   *  written instead of deleting. Nothing is written once a discard or
   *  unmount has followed `generation`. */
  const settleBackup = useCallback(
    async (modelText: string | null, generation: number): Promise<void> => {
      if (generation !== backupGeneration.current) return;
      if (!richHeldRef.current) {
        if (modelText !== null) await writeBackupNow(modelText);
        else await deleteBackup();
        if (generation !== backupGeneration.current || !richHeldRef.current) return;
      }
      const held = heldBackupText();
      if (held !== null) await writeBackupNow(held, heldBackupBase());
    },
    [deleteBackup, heldBackupBase, heldBackupText, writeBackupNow]
  );

  const reload = useEditorSessionLoad({
    api,
    projectPath,
    relPath,
    accessToken,
    notifyReady,
    readModel,
    markDirty,
    deleteBackup,
    loadedRef,
    readOnlyRef,
    savedMtime,
    savedDiskText,
    savedText,
    load,
    preview,
    documentPreview,
    error,
    setLoad,
    setError,
    setSaveError,
    setRevertError,
    setPreview,
    setPreviewLoaded,
    setPreviewError,
    setRecovery,
    setDiskChanged,
    setContentRevision,
    resetDocument,
    documentGeneration,
    setDocumentPreview,
    setDocumentError,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge, re-read each render and kept as a dependency so a re-installed bridge re-creates this callback.
  const saveNow = useCallback(
    async (encoding?: DesktopTextFileEncoding): Promise<boolean> => {
      const editor = editorRef.current;
      const model = readModel();
      const writer = api?.writeProjectFile;
      const generation = backupGeneration.current;
      if (richHeldRef.current) {
        setSaveError(heldSaveError());
        return false;
      }
      if (!model || !writer || readOnlyRef.current) return false;
      if (!encoding && model.getValue() === savedText.current) return true;
      if (editorSettings.formatOnSave) {
        try {
          if (formatDocument) await formatDocument();
          else await editor?.getAction('editor.action.formatDocument')?.run();
        } catch (reason) {
          setSaveError(t('Format on save failed: {{value0}}', { value0: errorMessage(reason) }));
          return false;
        }
        if (richHeldRef.current) {
          setSaveError(heldSaveError());
          return false;
        }
      }
      const content = model.getValue();
      const expectedContent = savedDiskText.current;
      savingRef.current = true;
      setSaving(true);
      setSaveError('');
      setRevertError('');
      try {
        const result = await writer(projectPath, relPath, content, expectedContent, accessToken, encoding);
        savedMtime.current = result?.mtimeMs ?? Date.now();
        savedDiskText.current = content;
        savedText.current = content;
        setRecovery(null);
        setDiskChanged(false);
        setError('');
        if (encoding) {
          setLoad((current) => (current ? { ...current, encoding } : current));
        }
        const currentContent = readModel()?.getValue() ?? content;
        const changedAfterSave = currentContent !== content;
        markDirty(changedAfterSave);
        setDiffTick((tick) => tick + 1);
        if (backupTimer.current !== null) {
          window.clearTimeout(backupTimer.current);
          backupTimer.current = null;
        }
        await settleBackup(changedAfterSave ? currentContent : null, generation).catch(() => undefined);
        void syncLspRef.current('save');
        // An edit held during the write is still not in the file.
        if (richHeldRef.current) {
          markDirty(true);
          setSaveError(heldSaveError());
          return false;
        }
        return true;
      } catch (reason) {
        setSaveError(fileAccessError(reason));
        if (/changed on disk|ENOENT|no such file|cannot find/i.test(errorMessage(reason))) setDiskChanged(true);
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [
      accessToken,
      api,
      backupTimer,
      editorRef,
      readModel,
      formatDocument,
      editorSettings.formatOnSave,
      markDirty,
      projectPath,
      relPath,
      settleBackup,
      syncLspRef,
    ]
  );

  const save = useCallback(
    (encoding?: DesktopTextFileEncoding): Promise<boolean> => {
      const queued = saveQueue.current.catch(() => false).then(() => saveNow(encoding));
      saveQueue.current = queued;
      return queued;
    },
    [saveNow]
  );
  const saveRef = useRef<() => Promise<boolean>>(save);
  saveRef.current = save;

  const discard = useCallback(async (): Promise<void> => {
    skipUnmountBackup.current = true;
    backupGeneration.current++;
    await deleteBackup();
  }, [deleteBackup]);

  useEffect(() => {
    const handle: EditorFileHandle = {
      save: () => saveRef.current(),
      discard,
    };
    onSaveHandleRef.current?.(handle);
    return () => onSaveHandleRef.current?.(null, handle);
  }, [discard]);

  useEditorDiskWatch({
    api,
    projectPath,
    relPath,
    accessToken,
    active,
    load,
    readModel,
    savedMtime,
    savedText,
    held: richHeldRef,
    reload,
    setDiskChanged,
    setSaveError,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge, re-read each render and kept as a dependency so a re-installed bridge re-creates this callback.
  const revertFromDisk = useCallback(async (): Promise<boolean> => {
    const reader = api?.readProjectFile;
    const model = readModel();
    const generation = backupGeneration.current;
    if (!reader || !model || reverting || savingRef.current) return false;
    setReverting(true);
    setRevertError('');
    try {
      const result = await reader(projectPath, relPath, accessToken);
      if (result.binary || result.tooLarge || result.readOnly) {
        // Do not discard a writable buffer for a disk version we cannot save.
        setDiskChanged(true);
        throw new Error(t('The disk version can no longer be safely edited as text.'));
      }
      const content = normalizeEditorModelText(result.content);
      savedMtime.current = result.mtimeMs;
      savedDiskText.current = result.content;
      savedText.current = content;
      setLoad({ ...result, content });
      setRecovery(null);
      setDiskChanged(false);
      setError('');
      setSaveError('');
      model.setValue(content);
      markDirty(false);
      setContentRevision((revision) => revision + 1);
      setDiffTick((tick) => tick + 1);
      // A held edit survives the revert (Rich keeps it), and so does its backup.
      if (backupTimer.current !== null) {
        window.clearTimeout(backupTimer.current);
        backupTimer.current = null;
      }
      await settleBackup(null, generation).catch(() => undefined);
      editorRef.current?.focus();
      return true;
    } catch (reason) {
      setRevertError(errorMessage(reason));
      return false;
    } finally {
      setReverting(false);
    }
  }, [accessToken, api, backupTimer, editorRef, readModel, markDirty, projectPath, relPath, reverting, settleBackup]);

  const restoreConflictingBackup = useCallback(() => {
    const model = readModel();
    if (!model || !recovery) return;
    model.setValue(recovery.content);
    setRecovery({ ...recovery, restored: true });
    setContentRevision((revision) => revision + 1);
    markDirty(true);
    scheduleBackup(recovery.content);
    editorRef.current?.focus();
  }, [editorRef, readModel, markDirty, recovery, scheduleBackup]);

  const discardPendingBackup = useCallback(() => {
    setRecovery(null);
    void deleteBackup().catch(() => undefined);
  }, [deleteBackup]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge, re-read each render and kept as a dependency so a re-installed bridge re-creates this callback.
  const keepEdits = useCallback(() => {
    const model = readModel();
    const reader = api?.readProjectFile;
    if (!model || !reader) return;
    const generation = backupGeneration.current;
    setSaveError('');
    void reader(projectPath, relPath, accessToken)
      .then((result) => {
        if (result.binary || result.tooLarge || result.readOnly) {
          // Keep the original save baseline and the user's dirty buffer.
          throw new Error(t('The disk version can no longer be safely edited as text.'));
        }
        const savedContent = normalizeEditorModelText(result.content);
        const currentContent = model.getValue();
        savedMtime.current = result.mtimeMs;
        savedDiskText.current = result.content;
        savedText.current = savedContent;
        setDiskChanged(false);
        setError('');
        const changed = currentContent !== savedContent;
        markDirty(changed);
        void settleBackup(changed ? currentContent : null, generation).catch(() => undefined);
      })
      .catch((reason) => {
        setDiskChanged(true);
        setSaveError(fileAccessError(reason));
      });
  }, [accessToken, api, readModel, markDirty, projectPath, relPath, settleBackup]);

  /** Rich reports whether it holds an edit the model does not have, and
   *  how to read the file text with it. A held edit is backed up like any
   *  unsaved edit; once released, the backup follows the model again. */
  const setRichHeld = useCallback(
    (held: boolean, heldText?: () => string | null) => {
      const wasHeld = richHeldRef.current;
      if (!held && !wasHeld) return;
      richHeldRef.current = held;
      richHeldText.current = held ? (heldText ?? null) : null;
      if (!held) richHeldDiskText.current = null;
      else if (!wasHeld) richHeldDiskText.current = savedDiskText.current;
      const model = readModel();
      const changed = model ? model.getValue() !== savedText.current : false;
      markDirty(changed);
      if (held) {
        skipUnmountBackup.current = false;
        scheduleBackup(heldBackupText, heldBackupBase);
      } else if (changed && model) scheduleBackup(model.getValue());
      else void deleteBackup().catch(() => undefined);
    },
    [deleteBackup, heldBackupBase, heldBackupText, markDirty, readModel, scheduleBackup]
  );

  const onEditorChange = useCallback(
    (value: string | undefined) => {
      const content = String(value ?? '');
      const changed = content !== savedText.current;
      skipUnmountBackup.current = false;
      setRevertError('');
      markDirty(changed);
      if (richHeldRef.current) scheduleBackup(heldBackupText, heldBackupBase);
      else if (changed) scheduleBackup(content);
      else {
        setRecovery(null);
        void deleteBackup().catch(() => undefined);
      }
    },
    [deleteBackup, heldBackupBase, heldBackupText, markDirty, scheduleBackup]
  );

  // Previews are binary loads, which the text watch above skips.
  useEditorPreviewPoll({
    api,
    projectPath,
    relPath,
    accessToken,
    active,
    previewWatched: Boolean(documentPreview || (preview && load?.binary)),
    savedMtime,
    reload,
    loadDocumentPages,
    documentPreviewRef,
    documentPagesInFlight,
    documentWidth,
    documentSettling,
  });

  const completePreview = useCallback(() => {
    setPreviewLoaded(true);
    setPreviewError('');
    notifyReady();
  }, [notifyReady]);

  const failPreview = useCallback(() => {
    setPreviewLoaded(true);
    setPreviewError(t('This file could not be displayed in the built-in viewer.'));
    notifyReady();
  }, [notifyReady]);

  return {
    load,
    contentRevision,
    preview,
    previewLoaded,
    previewError,
    documentPreview,
    documentError,
    documentPageErrors,
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
    setRichHeld,
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
