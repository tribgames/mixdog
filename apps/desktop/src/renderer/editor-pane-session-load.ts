import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { documentPreviewFormatForPath, filePreviewTypeForPath } from '../shared/file-preview';
import {
  normalizeEditorModelText,
  resolveEditorBackup,
  takeEditorFileLoad,
  type EditorFileLoad,
} from './editor-file-loader';
import { documentPreviewFromResult, type DocumentPreview } from './editor-document-model';
import type { EditorRecovery, FilePreview } from './editor-pane-model';
import {
  documentPreviewError,
  fileAccessError,
  isDocumentPasswordRequired,
  isDocumentWrongPassword,
  isOfficePreviewUnavailable,
} from './editor-pane-session-errors';
import type { DocumentPasswordPrompt } from './use-editor-document-pages';
import { useMediaSessionEpoch } from './remote-file-preview';
import { reportEditorLoadStage } from './renderer-load-metrics';
import { t } from './i18n';

/** Opening and reloading the file: the plain text read, the image/media
 *  preview and the document page preview, plus the load-ready notifications.
 *  The state they fill stays with the file session, which also writes it on
 *  save and revert. */
export function useEditorSessionLoad({
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
  setDocumentOfficeMissing,
  setDocumentPassword,
}: {
  api: typeof window.mixdogDesktop;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  notifyReady(): void;
  readModel: () => import('monaco-editor').editor.ITextModel | null;
  markDirty: (next: boolean) => void;
  deleteBackup: () => Promise<unknown>;
  loadedRef: RefObject<boolean>;
  readOnlyRef: RefObject<boolean>;
  savedMtime: RefObject<number>;
  savedDiskText: RefObject<string>;
  savedText: RefObject<string>;
  load: EditorFileLoad | null;
  preview: FilePreview | null;
  documentPreview: DocumentPreview | null;
  error: string;
  setLoad: Dispatch<SetStateAction<EditorFileLoad | null>>;
  setError: (message: string) => void;
  setSaveError: (message: string) => void;
  setRevertError: (message: string) => void;
  setPreview: (preview: FilePreview | null) => void;
  setPreviewLoaded: (loaded: boolean) => void;
  setPreviewError: (message: string) => void;
  setRecovery: (recovery: EditorRecovery | null) => void;
  setDiskChanged: (changed: boolean) => void;
  setContentRevision: Dispatch<SetStateAction<number>>;
  resetDocument: () => number;
  documentGeneration: RefObject<number>;
  setDocumentPreview: (preview: DocumentPreview | null) => void;
  setDocumentError: (message: string) => void;
  setDocumentOfficeMissing: (missing: boolean) => void;
  setDocumentPassword: (prompt: DocumentPasswordPrompt | null) => void;
}) {
  // The ordinary text/binary read, extracted so a document whose conversion
  // fails still lands on the binary notice — with its "open in the default
  // app" escape — instead of a dead-end error screen.
  const readFileContents = useCallback(() => {
    if (!api?.readProjectFile) {
      setError(t('Desktop file access is unavailable.'));
      return;
    }
    void takeEditorFileLoad(api, projectPath, relPath, accessToken, !loadedRef.current, true)
      .then(({ file: result, backup }) => {
        readOnlyRef.current = Boolean(result.readOnly);
        // A read-only file has no save path, so a stale backup never applies.
        // The baseline is normalized like Monaco's model text, or mixed line
        // endings would make the file dirty on mount.
        const normalized = normalizeEditorModelText(result.content);
        const resolution = result.readOnly
          ? { content: normalized, savedContent: normalized, recovery: null, discardBackup: false }
          : resolveEditorBackup(result.content, backup);
        const content = resolution.content;
        let nextRecovery: EditorRecovery | null = null;
        if (!result.binary && !result.tooLarge && !result.readOnly) {
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
        const model = readModel();
        if (model && model.getValue() !== content) model.setValue(content);
        markDirty(content !== resolution.savedContent);
        setContentRevision((revision) => revision + 1);
      })
      .catch((reason) => {
        setError(fileAccessError(reason));
        if (loadedRef.current) setDiskChanged(true);
      });
  }, [
    accessToken,
    api,
    deleteBackup,
    readModel,
    markDirty,
    projectPath,
    relPath,
    loadedRef,
    readOnlyRef,
    savedMtime,
    savedDiskText,
    savedText,
    setLoad,
    setError,
    setRecovery,
    setDiskChanged,
    setContentRevision,
  ]);

  const previewOpened = useCallback(
    (result: { mtimeMs: number }): void => {
      loadedRef.current = true;
      savedMtime.current = result.mtimeMs;
      savedDiskText.current = '';
      savedText.current = '';
      setLoad({
        content: '',
        mtimeMs: result.mtimeMs,
        binary: true,
        tooLarge: false,
        encoding: 'utf8',
      });
      setRecovery(null);
      setDiskChanged(false);
      markDirty(false);
    },
    [loadedRef, markDirty, savedDiskText, savedMtime, savedText, setDiskChanged, setLoad, setRecovery]
  );

  // Bumped by every password try and by Cancel: only the latest try may open
  // the preview or change the question.
  const passwordAttempt = useRef(0);
  /** Re-requests the protected document's first page with `password`. The
   *  password lives only in this call; a wrong one keeps the question open. */
  const unlockDocument = useCallback(
    (password: string) => {
      const reader = api?.previewDocumentPages;
      if (!reader || !password) return;
      const generation = documentGeneration.current;
      const attempt = ++passwordAttempt.current;
      const current = () => generation === documentGeneration.current && attempt === passwordAttempt.current;
      setDocumentPassword({ wrong: false, busy: true });
      void reader(projectPath, relPath, accessToken, { pages: [1], password })
        .then((result) => {
          if (!current()) return;
          setDocumentPassword(null);
          setDocumentError('');
          setDocumentPreview(documentPreviewFromResult(result));
          previewOpened(result);
        })
        .catch((reason) => {
          if (!current()) return;
          if (isDocumentWrongPassword(reason)) {
            setDocumentPassword({ wrong: true, busy: false });
            return;
          }
          setDocumentPassword(isDocumentPasswordRequired(reason) ? { wrong: false, busy: false } : null);
          setDocumentError(documentPreviewError(reason));
          setDocumentOfficeMissing(isOfficePreviewUnavailable(reason));
        });
    },
    [
      accessToken,
      api,
      documentGeneration,
      previewOpened,
      projectPath,
      relPath,
      setDocumentError,
      setDocumentOfficeMissing,
      setDocumentPassword,
      setDocumentPreview,
    ]
  );
  /** Closes the question; the pane keeps the "password-protected" notice. */
  const cancelDocumentPassword = useCallback(() => {
    passwordAttempt.current += 1;
    setDocumentPassword(null);
  }, [setDocumentPassword]);

  const reload = useCallback(() => {
    setError('');
    setSaveError('');
    setRevertError('');
    setPreviewError('');
    setPreviewLoaded(false);
    setPreview(null);
    passwordAttempt.current += 1;
    const generation = resetDocument();
    // PDFs go through the page viewer below (our scroller, scrollbars and
    // zoom) instead of the browser's PDF viewer; without that API the binary
    // notice offers "Open in default app".
    const nativeKind = filePreviewTypeForPath(relPath)?.kind;
    if (nativeKind && nativeKind !== 'pdf' && api?.previewProjectFile) {
      // SVG is also text: its source loads alongside the image preview so the
      // Preview/Source toggle switches views without a reload.
      const svg = /\.svg$/i.test(relPath);
      if (svg) readFileContents();
      void api
        .previewProjectFile(projectPath, relPath, accessToken)
        .then((result) => {
          setPreview(result);
          if (!svg) previewOpened(result);
        })
        .catch((reason) => {
          if (svg) return;
          setLoad(null);
          setError(fileAccessError(reason));
        });
      return;
    }
    // Documents render as in-app pages on desktop and remote alike. A failed
    // conversion keeps the binary notice with its manual "Open in default
    // app" escape; opening or restoring a tab never launches an OS program.
    const documentFormat = nativeKind === 'pdf' ? 'pdf' : documentPreviewFormatForPath(relPath);
    const documentFailed = (reason: unknown): void => {
      setDocumentError(documentPreviewError(reason));
      setDocumentOfficeMissing(isOfficePreviewUnavailable(reason));
      setDocumentPassword(isDocumentPasswordRequired(reason) ? { wrong: false, busy: false } : null);
      readFileContents();
    };
    if (documentFormat && api?.previewDocumentPages) {
      void api
        .previewDocumentPages(projectPath, relPath, accessToken, { pages: [1] })
        .then((result) => {
          if (generation !== documentGeneration.current) return;
          setDocumentPreview(documentPreviewFromResult(result));
          previewOpened(result);
        })
        .catch((reason) => {
          if (generation === documentGeneration.current) documentFailed(reason);
        });
      return;
    }
    readFileContents();
  }, [
    accessToken,
    api,
    documentGeneration,
    previewOpened,
    projectPath,
    readFileContents,
    relPath,
    resetDocument,
    setDocumentError,
    setDocumentOfficeMissing,
    setDocumentPassword,
    setDocumentPreview,
    setLoad,
    setError,
    setSaveError,
    setRevertError,
    setPreview,
    setPreviewLoaded,
    setPreviewError,
  ]);

  useEffect(() => {
    reload();
  }, [reload]);
  // A new media session (reconnect) kills a streamed preview's URL: fetch the
  // URL again and swap only the preview. The text model and dirty state (an
  // editable SVG's unsaved source) are never touched.
  const mediaSession = useMediaSessionEpoch();
  const shownMediaSession = useRef(mediaSession);
  const previewShown = useRef(false);
  previewShown.current = preview !== null;
  useEffect(() => {
    if (shownMediaSession.current === mediaSession) return;
    shownMediaSession.current = mediaSession;
    if (!previewShown.current || !api?.previewProjectFile) return;
    void api
      .previewProjectFile(projectPath, relPath, accessToken)
      .then(setPreview)
      .catch(() => undefined);
  }, [mediaSession, api, projectPath, relPath, accessToken, setPreview]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: documentPreview is read but deliberately not a trigger - reload() clears it while the previous binary load is still present, and re-running then would announce the binary fallback before the new document opens.
  useEffect(() => {
    if ((error && !load) || (load && !preview && !documentPreview && (load.binary || load.tooLarge))) {
      reportEditorLoadStage(projectPath, relPath, accessToken, 'fallback-ready', '', true);
      notifyReady();
    }
  }, [accessToken, error, load, notifyReady, preview, projectPath, relPath]);

  return { reload, unlockDocument, cancelDocumentPassword };
}
