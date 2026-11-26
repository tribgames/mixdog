import type { ComposerAttachment } from './composer-support';
import { enforceRendererCacheBudget, registerBudgetedCache } from './renderer-cache-budget';
import { sha256Hex } from './sha256';

let submissionSequence = 0;
let recoverySequence = 0;

type ComposerSubmissionRecovery = {
  id: string;
  scope: string;
  text: string;
  attachments: ComposerAttachment[];
};

type StoredComposerSubmissionRecovery = ComposerSubmissionRecovery & {
  rejected: boolean;
  sequence: number;
};

const composerSubmissionRecoveries = new Map<string, StoredComposerSubmissionRecovery>();

export function retainComposerSubmissionRecovery(recovery: ComposerSubmissionRecovery): void {
  composerSubmissionRecoveries.set(recovery.id, {
    ...recovery,
    attachments: [...recovery.attachments],
    rejected: false,
    sequence: ++recoverySequence,
  });
}

export function rejectComposerSubmissionRecovery(id: string): void {
  const recovery = composerSubmissionRecoveries.get(id);
  if (recovery) recovery.rejected = true;
}

export function resolveComposerSubmissionRecovery(id: string): void {
  composerSubmissionRecoveries.delete(id);
}

export function takeRejectedComposerSubmissionRecoveries(scope: string): ComposerSubmissionRecovery[] {
  const recoveries = [...composerSubmissionRecoveries.values()]
    .filter((recovery) => recovery.rejected && recovery.scope === scope)
    .sort((left, right) => left.sequence - right.sequence);
  for (const recovery of recoveries) composerSubmissionRecoveries.delete(recovery.id);
  return recoveries.map(({ id, scope: recoveryScope, text, attachments }) => ({
    id,
    scope: recoveryScope,
    text,
    attachments: [...attachments],
  }));
}

/** A composer identity that belongs to a freshly opened New Task pane.
 *  Pressing New task mints a distinct draft identity, and a fresh draft
 *  ALWAYS opens clean, never carrying the previous pane's text and
 *  attachments. */
export function composerScopeOpensFreshDraft(nextScope: string): boolean {
  return nextScope.startsWith('draft:');
}

/** In-flight text per composer identity. Switching tabs swaps the identity
 *  scope on ONE mounted composer, so the text typed in a tab is parked here
 *  and handed back when that tab is shown again. Empty text drops the entry. */
const composerDraftsByScope = new Map<string, string>();

const PERSISTED_DRAFTS_KEY = 'mixdog.composer-drafts';
const PERSISTED_DRAFTS_LIMIT = 50;
let persistedDraftsLoaded = false;

function loadPersistedDrafts(): void {
  if (persistedDraftsLoaded) return;
  persistedDraftsLoaded = true;
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(PERSISTED_DRAFTS_KEY) ?? '[]');
    if (!Array.isArray(stored)) return;
    for (const entry of stored) {
      if (
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string' &&
        !composerDraftsByScope.has(entry[0])
      ) {
        composerDraftsByScope.set(entry[0], entry[1]);
      }
    }
  } catch {
    /* unreadable storage: start with the in-memory stash only */
  }
}

/** Writes every parked draft to storage, newest last, bounded. */
export function persistComposerDrafts(): void {
  loadPersistedDrafts();
  try {
    globalThis.localStorage?.setItem(
      PERSISTED_DRAFTS_KEY,
      JSON.stringify([...composerDraftsByScope].slice(-PERSISTED_DRAFTS_LIMIT))
    );
  } catch {
    /* storage full or blocked: the in-memory stash still serves tab switches */
  }
}

const forgottenComposerScopes = new Set<string>();
const FORGOTTEN_SCOPES_LIMIT = 500;

export function stashComposerDraft(scope: string, text: string): void {
  loadPersistedDrafts();
  composerDraftsByScope.delete(scope);
  if (forgottenComposerScopes.has(scope)) return;
  if (text.trim()) composerDraftsByScope.set(scope, text);
}

export function stashedComposerDraft(scope: string): string {
  loadPersistedDrafts();
  return composerDraftsByScope.get(scope) ?? '';
}

/** Text that was sent or cleared, or that a draft held when it became a session,
 *  stays parked nowhere. Storage is rewritten now: a restart may come before any hide. */
export function dropComposerDraft(scope: string): void {
  loadPersistedDrafts();
  if (composerDraftsByScope.delete(scope)) persistComposerDrafts();
}

const composerAttachmentsByScope = new Map<string, ComposerAttachment[]>();
const composerAttachmentCharsByScope = new Map<string, number>();
let parkedAttachmentChars = 0;
const PARKED_ATTACHMENT_SCOPES_LIMIT = 20;

function measureComposerAttachments(scope: string, attachments: readonly ComposerAttachment[]): number {
  let total = scope.length;
  for (const attachment of attachments) {
    total +=
      attachment.data.length +
      attachment.name.length +
      attachment.mimeType.length +
      (attachment.token?.length ?? 0) +
      (attachment.metadataText?.length ?? 0) +
      (attachment.originalRef?.length ?? 0) +
      (attachment.originalMimeType?.length ?? 0);
  }
  return total;
}

function dropParkedAttachments(scope: string): void {
  const chars = composerAttachmentCharsByScope.get(scope) ?? 0;
  composerAttachmentCharsByScope.delete(scope);
  parkedAttachmentChars -= chars;
  composerAttachmentsByScope.delete(scope);
}

registerBudgetedCache({
  name: 'composer-parked-attachments',
  chars: () => parkedAttachmentChars,
  pinned: () => parkedAttachmentChars,
  trim: () => {},
});

export function stashComposerAttachments(scope: string, attachments: readonly ComposerAttachment[]): void {
  dropParkedAttachments(scope);
  if (!attachments.length || forgottenComposerScopes.has(scope)) return;
  const copy = [...attachments];
  const chars = measureComposerAttachments(scope, copy);
  composerAttachmentsByScope.set(scope, copy);
  composerAttachmentCharsByScope.set(scope, chars);
  parkedAttachmentChars += chars;
  while (composerAttachmentsByScope.size > PARKED_ATTACHMENT_SCOPES_LIMIT) {
    dropParkedAttachments(composerAttachmentsByScope.keys().next().value as string);
  }
  enforceRendererCacheBudget();
}

/** Hands the parked chips back once; the live composer owns them again. */
export function takeStashedComposerAttachments(scope: string): ComposerAttachment[] {
  const parked = composerAttachmentsByScope.get(scope) ?? [];
  dropParkedAttachments(scope);
  return parked;
}

/** Room members tagged with `@` per composer identity, parked the same way
 *  so returning to an agent room keeps who answers the unsent message. */
const composerTagsByScope = new Map<string, string[]>();
const composerTagCharsByScope = new Map<string, number>();
let parkedTagChars = 0;

function measureComposerTags(scope: string, memberIds: readonly string[]): number {
  let total = scope.length;
  for (const id of memberIds) total += id.length;
  return total;
}

function dropParkedTags(scope: string): void {
  const chars = composerTagCharsByScope.get(scope) ?? 0;
  composerTagCharsByScope.delete(scope);
  parkedTagChars -= chars;
  composerTagsByScope.delete(scope);
}

registerBudgetedCache({
  name: 'composer-parked-tags',
  chars: () => parkedTagChars,
  pinned: () => parkedTagChars,
  trim: () => {},
});

export function stashComposerTags(scope: string, memberIds: readonly string[]): void {
  dropParkedTags(scope);
  if (!memberIds.length || forgottenComposerScopes.has(scope)) return;
  const copy = [...memberIds];
  const chars = measureComposerTags(scope, copy);
  composerTagsByScope.set(scope, copy);
  composerTagCharsByScope.set(scope, chars);
  parkedTagChars += chars;
  enforceRendererCacheBudget();
}

/** The prompt hand-backs each session's composer applied, by session id, one id per source because their lifetimes differ:
 *  `offer` is the session state's offer last seen as applied (the state's one current offer, all it can replay on a revisit
 *  or reconnect; the next offer replaces it), `reply` the id last applied from a Stop reply (the next reply replaces it).
 *  An id equal to either was applied. The session's deletion drops both (forgetComposerScope). */
export const appliedPromptRestores = new Map<string, { offer?: string; reply?: string }>();
const appliedPromptRestoreSubmissionIds = new WeakMap<
  typeof appliedPromptRestores,
  Map<string, { offer?: string[]; reply?: string[] }>
>();

/** Records which local submission ids backed an applied restore so its dedup entry leaves once none of those ids remain in `ownSubmissionIds`. */
export function noteAppliedPromptRestoreIds(
  sessionId: string,
  slot: 'offer' | 'reply',
  ids: readonly string[],
  applied: typeof appliedPromptRestores = appliedPromptRestores
): void {
  if (!ids.length) return;
  let bySession = appliedPromptRestoreSubmissionIds.get(applied);
  if (!bySession) {
    bySession = new Map();
    appliedPromptRestoreSubmissionIds.set(applied, bySession);
  }
  const current = bySession.get(sessionId) ?? {};
  bySession.set(sessionId, { ...current, [slot]: [...ids] });
}

function pruneAppliedPromptRestores(): void {
  const bySession = appliedPromptRestoreSubmissionIds.get(appliedPromptRestores);
  if (!bySession?.size) return;
  for (const [sessionId, tracked] of [...bySession]) {
    const entry = appliedPromptRestores.get(sessionId);
    if (!entry) {
      bySession.delete(sessionId);
      continue;
    }
    const nextEntry = { ...entry };
    const nextTracked = { ...tracked };
    let changed = false;
    if (tracked.offer && !tracked.offer.some(wasSubmittedHere)) {
      delete nextEntry.offer;
      delete nextTracked.offer;
      changed = true;
    }
    if (tracked.reply && !tracked.reply.some(wasSubmittedHere)) {
      delete nextEntry.reply;
      delete nextTracked.reply;
      changed = true;
    }
    if (!changed) continue;
    if (!nextEntry.offer && !nextEntry.reply) {
      appliedPromptRestores.delete(sessionId);
      bySession.delete(sessionId);
    } else {
      appliedPromptRestores.set(sessionId, nextEntry);
      if (!nextTracked.offer && !nextTracked.reply) bySession.delete(sessionId);
      else bySession.set(sessionId, nextTracked);
    }
  }
}

/** A conversation whose deletion the host CONFIRMED never comes back: drop
 *  everything parked for it. Call it only from the delete action — a session
 *  merely missing from a catalog push may reappear with its parked content. */
export function forgetComposerScope(scope: string): void {
  if (!scope) return;
  loadPersistedDrafts();
  composerDraftsByScope.delete(scope);
  dropParkedAttachments(scope);
  dropParkedTags(scope);
  appliedPromptRestores.delete(scope);
  appliedPromptRestoreSubmissionIds.get(appliedPromptRestores)?.delete(scope);
  forgottenComposerScopes.add(scope);
  if (forgottenComposerScopes.size > FORGOTTEN_SCOPES_LIMIT) {
    forgottenComposerScopes.delete(forgottenComposerScopes.values().next().value as string);
  }
}

export function takeStashedComposerTags(scope: string): string[] {
  const parked = composerTagsByScope.get(scope) ?? [];
  dropParkedTags(scope);
  return parked;
}

/** Mounted composers that hold text or attachments, by identity. With the
 *  stashes above it answers whether a New Task tab is still untouched. */
const composerScopesWithContent = new Set<string>();

export function noteComposerContent(scope: string, hasContent: boolean): void {
  if (hasContent) composerScopesWithContent.add(scope);
  else composerScopesWithContent.delete(scope);
}

export function composerScopeHasContent(scope: string): boolean {
  return (
    composerScopesWithContent.has(scope) ||
    Boolean(stashedComposerDraft(scope).trim()) ||
    composerAttachmentsByScope.has(scope)
  );
}

export function composerDraftAfterScopeChange({
  currentDraft,
  liveDomDraft,
  typingLive,
  stashedDraft = '',
  sameConversation = false,
}: {
  currentDraft: string;
  liveDomDraft: string;
  typingLive: boolean;
  /** Text the target tab parked when the user left it; it wins because the
   *  user is RETURNING to that tab, not opening a new one. */
  stashedDraft?: string;
  /** The identity moved within one conversation: a New Task draft became its
   *  session. Any other move opens another conversation, which never shows
   *  the text of the one left, focused, typed live or loaded or not. */
  sameConversation?: boolean;
}): string {
  if (stashedDraft.trim()) return stashedDraft;
  if (!sameConversation) return '';
  return typingLive ? liveDomDraft : currentDraft;
}

const promotedDraftSessions = new Map<string, string>();
// The same record, kept for the side docks: the composer spends its own.
const draftSessions = new Map<string, string>();
const PROMOTED_DRAFT_LIMIT = 64;

function remember(record: Map<string, string>, scope: string, sessionId: string): void {
  record.delete(scope);
  record.set(scope, sessionId);
  if (record.size > PROMOTED_DRAFT_LIMIT) record.delete(record.keys().next().value as string);
}

export function noteDraftPromotion(draftId: string, sessionId: string): void {
  if (!sessionId) return;
  const scope = `draft:${draftId || 'default'}`;
  dropComposerDraft(scope);
  remember(promotedDraftSessions, scope, sessionId);
  remember(draftSessions, scope, sessionId);
}

/** The session the draft `scope` (`draft:<id>`) became on its first message; '' for none. */
export function sessionOfPromotedDraft(scope: string): string {
  return draftSessions.get(scope) ?? '';
}

/** The promotions one pass over the side docks reads (draft scope to session). A promotion has landed once the
 *  draft's tab is gone and its session's tab stands (`tabbed`): it ends with this reading, so a draft opened later
 *  under the same scope is not that session's. */
export function takeLandedDraftPromotions(tabbed: (owner: string) => boolean): ReadonlyMap<string, string> {
  const read = new Map(draftSessions);
  for (const [scope, sessionId] of read) {
    if (!tabbed(scope) && tabbed(sessionId)) draftSessions.delete(scope);
  }
  return read;
}

/** Whether `nextScope` is the session `previousScope`'s draft became. The
 *  record is spent on the match, so a revisited draft cannot reuse it. */
export function takeDraftPromotion(previousScope: string, nextScope: string): boolean {
  if (promotedDraftSessions.get(previousScope) !== nextScope) return false;
  promotedDraftSessions.delete(previousScope);
  return true;
}

/** Whether the chips on screen stay with the composer across a scope change.
 *  Like the in-flight text, chips parked by the target tab win and a fresh New
 *  Task opens clean. Unlike the text, focus is no signal: a tab switch from a
 *  focused composer must park them, so only the session a draft was promoted
 *  into (`promotingDraft`, see takeDraftPromotion) takes its chips along. */
export function composerAttachmentsCarryOver({
  freshDraft,
  promotingDraft,
  parkedCount,
}: {
  freshDraft: boolean;
  promotingDraft: boolean;
  parkedCount: number;
}): boolean {
  return parkedCount === 0 && !freshDraft && promotingDraft;
}

// Submissions THIS device minted. Another device cancelling a turn hands the
// prompt back through the session state; only the device that sent it applies it.
const ownSubmissionIds = new Set<string>();
const OWN_SUBMISSION_LIMIT = 128;

export function nextComposerSubmissionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const id = `desktop-submit-${uuid || `${Date.now()}-${++submissionSequence}`}`;
  ownSubmissionIds.add(id);
  if (ownSubmissionIds.size > OWN_SUBMISSION_LIMIT) {
    ownSubmissionIds.delete(ownSubmissionIds.values().next().value as string);
    pruneAppliedPromptRestores();
  }
  return id;
}

export function wasSubmittedHere(id: string): boolean {
  return ownSubmissionIds.has(id);
}

/** Prompt text handed back to the composer of the device that sent it: it is
 *  placed beside whatever is already typed there, never replacing it. */
export function draftWithRestoredPrompt(current: string, restored: string): string {
  return [restored, current].filter(Boolean).join('\n');
}

/** The chip with the SHA-256 of its data started: the same chip when its
 *  digest is already for this data, so a digest is worked out once per chip
 *  (copies made by renumbering or folding keep it). */
export function withContentDigest(attachment: ComposerAttachment): ComposerAttachment {
  if (attachment.contentDigest?.of === attachment.data) return attachment;
  return { ...attachment, contentDigest: { of: attachment.data, sha256: sha256Hex(attachment.data) } };
}

function contentDigest(attachment: ComposerAttachment): Promise<string> {
  return attachment.contentDigest?.of === attachment.data
    ? attachment.contentDigest.sha256
    : sha256Hex(attachment.data);
}

/**
 * Identity of a send's content for "Send again": the same message resent
 * keeps its submission id, so a send that failed ambiguously (it may have
 * arrived) is never posted twice, and a changed one never takes the old id.
 * Chip ids are not part of it — a restored chip may be renumbered — so each
 * attachment token in the text stands as its place in the attachment list,
 * and each attachment as what it holds: its SHA-256 and length (awaited when
 * the chip's digest is still being worked out).
 */
export async function submissionRetryKey(
  texts: readonly string[],
  attachments: readonly ComposerAttachment[]
): Promise<string> {
  return retryKeyOf(texts, attachments, await Promise.all(attachments.map(contentDigest)));
}

/** `submissionRetryKey` of a send without attachments: it waits on no digest, so it is known at once. */
export function textRetryKey(texts: readonly string[]): string {
  return retryKeyOf(texts, [], []);
}

function retryKeyOf(
  texts: readonly string[],
  attachments: readonly ComposerAttachment[],
  digests: readonly string[]
): string {
  const places = new Map<string, number>();
  attachments.forEach((attachment, place) => {
    if (attachment.token && !places.has(attachment.token)) places.set(attachment.token, place);
  });
  const pattern = places.size
    ? new RegExp([...places.keys()].map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null;
  return JSON.stringify([
    pattern ? texts.map((text) => text.replace(pattern, (token) => `\u0000${places.get(token)}\u0000`)) : texts,
    attachments.map((attachment, place) => [
      attachment.kind,
      attachment.name,
      attachment.mimeType,
      attachment.source ?? '',
      attachment.metadataText ?? '',
      attachment.data.length,
      digests[place],
    ]),
  ]);
}

export function insertComposerToken(
  current: string,
  rawStart: number | undefined,
  rawEnd: number | undefined,
  token: string
): { next: string; caret: number } {
  const start = Math.max(0, Math.min(rawStart ?? current.length, current.length));
  const end = Math.max(start, Math.min(rawEnd ?? start, current.length));
  const before = current.slice(0, start);
  const after = current.slice(end);
  const leading = before && !/\s$/.test(before) ? ' ' : '';
  const trailing = ' ';
  const inserted = `${leading}${token}${trailing}`;
  return {
    next: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
