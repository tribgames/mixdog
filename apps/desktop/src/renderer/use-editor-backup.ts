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
  heldDiskText,
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
  /** The disk text the held edit was based on, which its backup must keep
   *  as the expected content (null while nothing is held). */
  heldDiskText?: { current: string | null };
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

  /** Writes `content` as based on `expectedContent` (default: the current
   *  disk baseline). */
  const writeBackupNow = useCallback(
    (content: string, expectedContent?: string): Promise<void> => {
      const writer = api?.writeEditorBackup;
      if (!writer) return Promise.resolve();
      const expected = expectedContent ?? savedDiskText.current;
      return enqueueBackup(() => writer(projectPath, relPath, content, expected, accessToken));
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
   *  writes nothing) after a short pause, as based on `expectedContent`
   *  (likewise read then; default: the current disk baseline). */
  const scheduleBackup = useCallback(
    (content: string | (() => string | null), expectedContent?: () => string | undefined) => {
      if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
      backupTimer.current = window.setTimeout(() => {
        backupTimer.current = null;
        const text = typeof content === 'function' ? content() : content;
        if (text !== null) void writeBackupNow(text, expectedContent?.()).catch(() => undefined);
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
      if (held !== null) void writeBackupNow(held, heldDiskText?.current ?? undefined).catch(() => undefined);
      else if (model && model.getValue() !== savedText.current) {
        void writeBackupNow(model.getValue()).catch(() => undefined);
      }
    },
    [heldDiskText, heldText, readModel, savedText, skipUnmountBackup, writeBackupNow]
  );

  return { backupTimer, writeBackupNow, deleteBackup, scheduleBackup };
}
