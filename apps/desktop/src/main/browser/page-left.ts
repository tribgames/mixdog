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
