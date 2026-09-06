import { access, copyFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { callMicrosoftOffice } from '../com/com-adapter.mjs';
import { closeSession } from '../core/office-actions.mjs';
import { documentSessionKey, documentSessions, sessions } from '../core/office-core.mjs';

export async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function throwIfAuthoringCancelled(signal, result = null) {
  if (!signal?.aborted && result?.cancelled !== true) return;
  const error = new Error(result?.error || 'Office authoring was cancelled');
  error.name = 'AbortError';
  throw error;
}

// Re-authoring replaces the deck, so a session still holding the previous
// file has to let go first; nothing in it is worth saving because the script
// is the source of truth.
export async function releaseExistingSession(target, signal) {
  throwIfAuthoringCancelled(signal);
  const existingId = documentSessions.get(documentSessionKey(target));
  const existing = existingId ? sessions.get(existingId) : null;
  if (!existing) return null;
  await closeSession(existing, { save: false, signal }).catch(() => {});
  throwIfAuthoringCancelled(signal);
  sessions.delete(existing.id);
  if (documentSessions.get(documentSessionKey(target)) === existing.id) {
    documentSessions.delete(documentSessionKey(target));
  }
  return existing.id;
}

// Quitting PowerPoint and starting it again costs about five seconds of every repeat cycle, and the
// authoring loop pays it on each pass. A deck we authored ourselves, held in a hidden process nobody
// else touches, can keep that process and swap only the document. Anything attached, visible, or mid
// transaction belongs to someone else and is closed the old way.
export function reusableAuthoredSession(target, mode = 'auto') {
  if (!['auto', 'background'].includes(mode)) return null;
  const existingId = documentSessions.get(documentSessionKey(target));
  const existing = existingId ? sessions.get(existingId) : null;
  if (!existing || existing.transaction) return null;
  const reusable = existing.authored === true
    && existing.backend === 'microsoft-office-com'
    && existing.format === 'pptx'
    && existing.mode === 'background'
    && existing.ownership === 'owned'
    && existing.visible !== true;
  return reusable ? existing : null;
}

// The script writes beside the target, not over it, so a failed script leaves both the file on disk
// and the open session holding the previous deck untouched.
export function stagingTarget(target) {
  return join(dirname(target), `.${basename(target, extname(target))}.authoring${extname(target)}`);
}

export async function swapAuthoredDocument(session, source, signal, {
  callOffice = callMicrosoftOffice,
} = {}) {
  throwIfAuthoringCancelled(signal);
  const result = await callOffice({
    action: 'reload_document',
    session: session.id,
    format: session.format,
    mode: session.mode,
    path: session.target,
    source,
  }, { signal });
  // Cancellation is not a recoverable swap failure: falling through would copy the staged deck
  // over the target after the user asked us to stop.
  if (!result.ok || result.cancelled === true) {
    throwIfAuthoringCancelled(signal, result);
    return false;
  }
  // A different document stands behind the same session now, so every cached reading of the old one
  // goes and the render token stops matching until the new deck is rendered.
  session.snapshotVersion = Number(session.snapshotVersion || 0) + 1;
  session.snapshotCache = null;
  session.renderCache = null;
  session.designState = {
    renderedVersion: null,
    semanticCount: 0,
    requiresVisualReview: session.designState?.requiresVisualReview === true,
    slidePlans: [],
    compositions: [],
  };
  for (const key of ['appPid', 'windowHwnd', 'documentId', 'backgroundIsolation']) {
    if (result[key] !== undefined) session[key] = result[key];
  }
  session.openedAt = new Date().toISOString();
  // A successful response means the replacement already happened. Keep its identity/cache version
  // accurate even if cancellation raced with the response; do not pretend the old deck survived.
  throwIfAuthoringCancelled(signal);
  return true;
}

// When the swap fails the deck still has to land on the target; the host may already have moved it.
export async function landStagedDeck(staging, target, signal = null) {
  throwIfAuthoringCancelled(signal);
  if (staging === target || !await exists(staging)) return;
  throwIfAuthoringCancelled(signal);
  await copyFile(staging, target);
  await rm(staging, { force: true }).catch(() => {});
}
