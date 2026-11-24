// Crash-recovery backup of unsaved editor text: debounced writes, a serialized
// write/delete queue, the pending write run at once when the page is hidden or
// unloaded or a quit asks for it, and a final write when the pane unmounts dirty.
import { useCallback, useEffect, useRef } from 'react';
import type { DesktopHostExtras } from '../shared/desktop-api-split';
import { localCoreLink, subscribeLocalCoreLink } from './local-core-link';

// Every editor's flush, each kept until the writes it queued have settled.
const editorBackupFlushes = new Set<() => Promise<void>>();

/** Starts every editor's pending backup write now; settles once all the
 *  backup writes they queued have, or once the window's core link is not
 *  open: a write it cannot carry would wait for a reconnect. */
export function flushEditorBackups(): Promise<void> {
  const writes = Promise.all([...editorBackupFlushes].map((flush) => flush()));
  return new Promise((resolve) => {
    const done = (): void => {
      stop();
      resolve();
    };
    const stop = subscribeLocalCoreLink(() => {
      if (localCoreLink() !== 'open') done();
    });
    if (localCoreLink() !== 'open') done();
    else void writes.then(done);
  });
}

// A quit (or an update install) asks the window for this before its core goes.
const flushHost = (globalThis as { mixdogDesktopHost?: Partial<Pick<DesktopHostExtras, 'onEditorBackupFlush'>> })
  .mixdogDesktopHost;
flushHost?.onEditorBackupFlush?.(flushEditorBackups);

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
  // The write the pending `backupTimer` runs.
  const pendingBackup = useRef<(() => void) | null>(null);
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
      const write = () => {
        backupTimer.current = null;
        const text = typeof content === 'function' ? content() : content;
        if (text !== null) void writeBackupNow(text, expectedContent?.()).catch(() => undefined);
      };
      pendingBackup.current = write;
      backupTimer.current = window.setTimeout(write, 500);
    },
    [writeBackupNow]
  );

  /** Runs the pending write now; settles once every write queued so far has. */
  const flush = useCallback((): Promise<void> => {
    if (backupTimer.current !== null) {
      window.clearTimeout(backupTimer.current);
      pendingBackup.current?.();
    }
    return backupQueue.current;
  }, []);

  // A quit hides the window and then tears it down, and a closing page
  // outlives no timer: the pending write starts while the page is still here.
  useEffect(() => {
    const unload = () => void flush();
    const hidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    window.addEventListener('pagehide', unload);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', unload);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [flush]);

  useEffect(() => {
    const entry = () => flush();
    editorBackupFlushes.add(entry);
    return () => {
      if (backupTimer.current !== null) window.clearTimeout(backupTimer.current);
      backupTimer.current = null;
      if (!skipUnmountBackup.current) {
        const model = readModel();
        const held = heldText?.current ? (heldText.current() ?? model?.getValue() ?? null) : null;
        if (held !== null) void writeBackupNow(held, heldDiskText?.current ?? undefined).catch(() => undefined);
        else if (model && model.getValue() !== savedText.current) {
          void writeBackupNow(model.getValue()).catch(() => undefined);
        }
      }
      // A quit still waits for the write this cleanup queued.
      void backupQueue.current.then(() => editorBackupFlushes.delete(entry));
    };
  }, [flush, heldDiskText, heldText, readModel, savedText, skipUnmountBackup, writeBackupNow]);

  return { backupTimer, writeBackupNow, deleteBackup, scheduleBackup };
}
