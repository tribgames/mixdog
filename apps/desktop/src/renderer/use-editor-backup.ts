// Crash-recovery backup of unsaved editor text: debounced writes, a serialized
// write/delete queue, and a final write when the pane unmounts dirty.
import { useCallback, useEffect, useRef } from 'react';

export function useEditorBackup({
  api,
  projectPath,
  relPath,
  accessToken,
  readModel,
  savedText,
  savedDiskText,
  skipUnmountBackup,
  heldText,
}: {
  api: typeof window.mixdogDesktop;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  readModel(): import('monaco-editor').editor.ITextModel | null;
  savedText: { current: string };
  savedDiskText: { current: string };
  skipUnmountBackup: { current: boolean };
  /** While Rich holds an edit the model lacks: the file text with it, which
   *  is what a backup must keep (null when it cannot be produced). */
  heldText?: { current: (() => string | null) | null };
}) {
  const backupTimer = useRef<number | null>(null);
  const backupQueue = useRef<Promise<void>>(Promise.resolve());

  const enqueueBackup = useCallback((operation: () => Promise<unknown>): Promise<void> => {
    const run = backupQueue.current
      .catch(() => undefined)
      .then(operation)
      .then(() => undefined);
    backupQueue.current = run.catch(() => undefined);
    return run;
  }, []);

  const writeBackupNow = useCallback(
    (content: string): Promise<void> => {
      const writer = api?.writeEditorBackup;
      if (!writer) return Promise.resolve();
      return enqueueBackup(() => writer(projectPath, relPath, content, savedDiskText.current, accessToken));
    },
    [accessToken, api, enqueueBackup, projectPath, relPath, savedDiskText]
  );

  const deleteBackup = useCallback((): Promise<void> => {
    if (backupTimer.current !== null) {
      window.clearTimeout(backupTimer.current);
      backupTimer.current = null;
    }
    const remover = api?.deleteEditorBackup;
    if (!remover) return Promise.resolve();
    return enqueueBackup(() => remover(projectPath, relPath, accessToken));
  }, [accessToken, api, enqueueBackup, projectPath, relPath]);

  /** Writes `content` (read when the write happens, if a function; null
   *  writes nothing) after a short pause. */
  const scheduleBackup = useCallback(
    (content: string | (() => string | null)) => {
      if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
      backupTimer.current = window.setTimeout(() => {
        backupTimer.current = null;
        const text = typeof content === 'function' ? content() : content;
        if (text !== null) void writeBackupNow(text).catch(() => undefined);
      }, 500);
    },
    [writeBackupNow]
  );

  useEffect(
    () => () => {
      if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
      if (skipUnmountBackup.current) return;
      const model = readModel();
      const held = heldText?.current ? (heldText.current() ?? model?.getValue() ?? null) : null;
      if (held !== null) void writeBackupNow(held).catch(() => undefined);
      else if (model && model.getValue() !== savedText.current) {
        void writeBackupNow(model.getValue()).catch(() => undefined);
      }
    },
    [heldText, readModel, savedText, skipUnmountBackup, writeBackupNow]
  );

  return { backupTimer, writeBackupNow, deleteBackup, scheduleBackup };
}
