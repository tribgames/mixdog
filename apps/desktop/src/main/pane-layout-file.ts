// Chromium recreates a missing Local Storage database, losing the renderer's layout copy; this file survives.
import { readFileSync } from 'node:fs';

import { writeFileAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';

export const PANE_LAYOUT_FILE = 'pane-layout.json';

export interface PaneLayoutFile {
  /** The text last written, or null when there is none. */
  read(): string | null;
  /** Replaces the file's content; a burst of calls writes only the latest. */
  write(layout: string): void;
}

type FileFailure = (stage: 'read' | 'write', error: unknown) => void;

// Writes of every file run one after another, so the quit sequence has one
// promise to wait for.
let writes: Promise<void> = Promise.resolve();

/** Settles once every write requested so far has landed or failed. */
export function flushPaneLayoutFiles(): Promise<void> {
  return writes;
}

export function createPaneLayoutFile(filePath: string, onFailure: FileFailure): PaneLayoutFile {
  let pending: string | null = null;
  return {
    read() {
      try {
        return readFileSync(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onFailure('read', error);
        return null;
      }
    },
    write(layout) {
      const queued = pending !== null;
      pending = layout;
      // A write already waiting its turn takes the latest text.
      if (queued) return;
      writes = writes.then(async () => {
        const latest = pending as string;
        pending = null;
        try {
          await writeFileAtomicAsync(filePath, latest);
        } catch (error) {
          onFailure('write', error);
        }
      });
    },
  };
}
