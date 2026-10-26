/** Whether a failure is the page itself leaving: the guest was destroyed, it
 *  moved off `url` (when given), or CDP said the document it was talking to
 *  went away (settle.ts DOCUMENT_REPLACED). These are the expected races of a
 *  flow that reads or drives a page while it navigates; anything else is a
 *  real failure and is reported. */
import type { WebContents } from 'electron';

import { DOCUMENT_REPLACED } from './settle';

/** A ref the last snapshot no longer has or whose element is gone: what
 *  snapshot-ref-calls.ts callAccessibilityRef throws for such a ref. */
export const STALE_REF = /is stale or (?:unknown|detached); take a fresh snapshot first/;

export function pageLeft(error: unknown, guest: WebContents, url?: string): boolean {
  if (guest.isDestroyed()) return true;
  if (url !== undefined && guest.getURL() !== url) return true;
  return DOCUMENT_REPLACED.test(error instanceof Error ? error.message : String(error));
}
