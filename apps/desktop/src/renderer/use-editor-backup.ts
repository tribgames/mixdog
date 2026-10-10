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
}: {
  api: typeof window.mixdogDesktop;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  readModel(): import('monaco-editor').editor.ITextModel | null;
  savedText: { current: string };
  savedDiskText: { current: string };
  skipUnmountBackup: { current: boolean };
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

  const scheduleBackup = useCallback(
    (content: string) => {
      if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
      backupTimer.current = window.setTimeout(() => {
        backupTimer.current = null;
        void writeBackupNow(content).catch(() => undefined);
      }, 500);
    },
    [writeBackupNow]
  );

  useEffect(
    () => () => {
      if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
      const model = readModel();
      if (model && !skipUnmountBackup.current && model.getValue() !== savedText.current) {
        void writeBackupNow(model.getValue()).catch(() => undefined);
      }
    },
    [readModel, savedText, skipUnmountBackup, writeBackupNow]
  );

  return { backupTimer, writeBackupNow, deleteBackup, scheduleBackup };
}
