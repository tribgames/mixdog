/**
 * Constants and small helpers the Computer Use host modules share: capture
 * budgets, the pixel-usability thresholds, the data directory, and the two
 * timing utilities. They live here so the capture engine never has to import
 * the host back, and nothing here touches Electron: pure observation code can
 * import these constants inside a plain Node test.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Line marker the resident PowerShell host prefixes on every response line. */
export const RESPONSE_MARKER = '@@MIXCU@@';

/** JPEG quality a capture encodes at unless the command asks for another. */
export const DEFAULT_SCREENSHOT_QUALITY = 55;

export const DEFAULT_SCREENSHOT_MAX_WIDTH = 1280;

export const MIN_SCREENSHOT_MAX_WIDTH = 256;

export const MAX_SCREENSHOT_MAX_WIDTH = 3840;

export const DEFAULT_CAPTURE_AFTER_DELAY_MS = 150;

export const MAX_CAPTURE_AFTER_DELAY_MS = 2_000;

export const DEFAULT_CAPTURE_MAX_ELEMENTS = 80;

export const DEFAULT_OCR_MAX_WORDS = 300;

export const MAX_OCR_WORDS = 1_000;

export const SCREENSHOT_SAMPLE_LIMIT = 4_096;

/** Widest window border plus rounded corner a capture can carry as chrome. */
export const SCREENSHOT_CHROME_MARGIN = 8;

export const SCREENSHOT_NEAR_BLACK_CHANNEL = 4;

export const SCREENSHOT_NEAR_WHITE_CHANNEL = 251;

export const SCREENSHOT_UNUSABLE_RATIO = 0.995;

export const OWNED_CAPTURE_TIMEOUT_MS = 750;

export const DESKTOP_CAPTURE_TIMEOUT_MS = 2_000;

/** Sampled points that must still show the exact window before a direct screen
 *  grab can stand in for a composited window capture. */
export const NATIVE_CAPTURE_VISIBLE_SAMPLES = 5;

export function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(2));
}

/** Where the host publishes its script, its discovery file, and run history. */
export function mixdogDataDirectory(): string {
  return process.env.MIXDOG_DATA_DIR
    || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
