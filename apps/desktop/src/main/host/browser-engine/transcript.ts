/**
 * The engine transcript tap: with MIXDOG_BROWSER_TRANSCRIPT naming a
 * directory, every engine host call is appended to `engine-<pid>.jsonl` there
 * as `{dir, method, params, result | error, t}`. It exists only in a
 * development or test build (`devBuild`: the desktop runs unpackaged, or the
 * test-hooks build flag is set) and is off in a packaged app whatever the
 * variable says. The registry masks the secrets known to the page before it
 * hands an entry over; the tap additionally redacts credential shapes.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { redactBrowserText } from '../../browser/redaction';

export interface TranscriptEntry {
  /** `in` is the core's request, `out` the host's answer. */
  dir: 'in' | 'out';
  method: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface TranscriptTap {
  record(entry: TranscriptEntry): void;
}

export function createTranscriptTap(options: {
  /** The value of MIXDOG_BROWSER_TRANSCRIPT. */
  dir: string | undefined;
  devBuild: boolean;
  now?: () => number;
}): TranscriptTap | undefined {
  const { dir, devBuild, now = Date.now } = options;
  if (!devBuild || !dir) return undefined;
  const file = join(dir, `engine-${process.pid}.jsonl`);
  let failed = false;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    failed = true;
    console.error('[browser-engine] transcript directory unusable, the tap is off:', (error as Error).message);
  }
  return {
    record(entry) {
      if (failed) return;
      try {
        appendFileSync(file, `${redactBrowserText(JSON.stringify({ ...entry, t: now() }))}\n`);
      } catch (error) {
        failed = true;
        console.error('[browser-engine] transcript write failed, the tap is off:', (error as Error).message);
      }
    },
  };
}
