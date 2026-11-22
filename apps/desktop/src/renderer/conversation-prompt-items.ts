import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { carriedFirsts } from './list-carry';
import { asRecord } from './text-format';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { recognisedSlashToken } from '../../../../src/tui/app/slash-commands.mjs';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { transcriptSourceFields } from '../shared/core-src/runtime/shared/transcript-metadata.mjs';

export type PendingPromptItem = TranscriptItem & {
  id: string | number;
  kind: 'user';
  text: string;
  pending: boolean;
  accepted: boolean;
  submittedAt: number;
  queuedBehindTurn?: boolean;
  /** A message sent behind a running turn that could not be sent: what
   *  "Send again" submits (same id, so a late arrival is not posted twice). */
  retry?: { content: DesktopPromptContent; options?: DesktopSubmitOptions };
  /** The session runtime's queue entry this message waits as. */
  queueEntry?: unknown;
  /** Submitted from this pane, not (or no longer) in the session runtime's
   *  queue, its row not landed yet. */
  steerLocal?: boolean;
};

/** The bubble text of a prompt sent from this pane. Attachments are never
 *  spelled out as placeholder words: an image draws from the row's `images`
 *  (`pendingPromptImages`), and a file part becomes the `[PDF #n: name]` /
 *  `[File #n: name]` token the row folds into its file chip. */
export function desktopPromptDisplayText(content: DesktopPromptContent, options?: DesktopSubmitOptions): string {
  const explicit = String(options?.displayText || '').trim();
  if (explicit) return explicit;
  if (typeof content === 'string') return content.trim();
  let files = 0;
  const text = content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image') return '';
      files += 1;
      const name = part.filename || 'attachment';
      const pdf = part.mimeType === 'application/pdf' || /\.pdf$/i.test(name);
      return `[${pdf ? 'PDF' : 'File'} #${files}: ${name}]`;
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  if (text) return text;
  return content.some((part) => part.type === 'image') ? '' : t('Attached prompt');
}

const hasImages = (item: { images?: unknown } | undefined) => Array.isArray(item?.images) && item.images.length > 0;

export function pendingPromptImages(options?: DesktopSubmitOptions): NonNullable<TranscriptItem['images']> {
  return Object.values(options?.pastedImages || {}).map((image) => ({
    id: image.id,
    name: image.filename || 'Image',
    mimeType: image.mediaType,
    bytes: Number(image.sizeBytes) || String(image.content || '').length,
  }));
}

const NO_PENDING_PROMPTS: PendingPromptItem[] = [];

/** Where each id first stands among a list's items, and among its prompts alone: carried on from the list a frame made
 *  it from (list-carry.ts), so a list is read from the rows it did not keep. */
export const itemPlacesById = carriedFirsts((item: TranscriptItem) =>
  item?.id === undefined || item.id === null ? undefined : String(item.id)
);
const promptPlacesById = carriedFirsts((item: TranscriptItem) =>
  item?.kind === 'user' && item.id !== undefined && item.id !== null ? String(item.id) : undefined
);

/** The prompts sent from this pane still waiting for their rows. A prompt's
 *  own row carries its submission id (the core's `clientSubmissionId`, which
 *  protocol-client `userRow` makes the row's id, for a turn it started and
 *  for one that took it from the queue; a room posts the row under it): only
 *  that row releases the bubble, never another surface's row. */
export function pendingPromptTranscriptItems(
  optimistic: PendingPromptItem[],
  settled: TranscriptItem[]
): PendingPromptItem[] {
  // No prompt waits: the settled rows are not read.
  if (optimistic.length === 0) return NO_PENDING_PROMPTS;
  const settledIds = itemPlacesById(settled);
  const byId = new Map<string, PendingPromptItem>();
  for (const item of optimistic) {
    if (item?.id === undefined || item.id === null) continue;
    // An image-only message has no words; its thumbnails are the bubble.
    if (!String(item.text || '').trim() && !hasImages(item)) continue;
    byId.set(String(item.id), item);
  }
  const rows: PendingPromptItem[] = [];
  const ordered = [...byId.values()].sort((left, right) => left.submittedAt - right.submittedAt);
  for (const item of ordered) {
    // A message that could not be sent has no durable row to wait for: it
    // stays until it is sent again or cancelled.
    if (item.steer === 'failed') {
      rows.push(item);
      continue;
    }
    if (settledIds.has(String(item.id))) continue;
    rows.push({ ...item, pending: true });
  }
  return rows;
}

/** Whether the runtime holds this queued text for after the turn: a slash
 *  command never steers a running turn (the runtime's own rule). */
function heldForTurnEnd(text: string, entry: Record<string, unknown> | null): boolean {
  return entry?.skipSlashCommands !== true && recognisedSlashToken(text) !== null;
}

/**
 * The messages sent while a turn runs that the model has not read yet, in
 * order: the session runtime's queue (whatever surface typed them), then this
 * pane's submits the runtime has not published yet; a published entry
 * replaces its local twin by id. Each shows as a user bubble at the end of the
 * transcript until its durable row lands.
 */
export function steerPromptItems(sessionQueue: readonly unknown[], pending: readonly PendingPromptItem[]) {
  const local = new Map(pending.filter((item) => item.queuedBehindTurn).map((item) => [String(item.id), item]));
  const rows: PendingPromptItem[] = [];
  for (const entry of sessionQueue) {
    const record = asRecord(entry);
    const id = String(record?.id ?? '').trim();
    if (!record || !id) continue;
    const twin = local.get(id);
    local.delete(id);
    const text = String(record.displayText || record.text || twin?.text || '').trim();
    const images = Array.isArray(record.images) && record.images.length ? record.images : twin?.images;
    if (!text && !images?.length) continue;
    const enqueuedAt = Number(record.submittedAt);
    const submittedAt = Number.isFinite(enqueuedAt) && enqueuedAt > 0 ? enqueuedAt : (twin?.submittedAt ?? 0);
    rows.push({
      id,
      kind: 'user',
      text,
      pending: true,
      accepted: true,
      submittedAt,
      // A chat lays the waiting bubble out with its time line, as its durable row will be (agent-chat-place.ts).
      ...(submittedAt > 0 ? { at: submittedAt } : {}),
      queuedBehindTurn: true,
      steer: heldForTurnEnd(text, record) ? 'held' : 'pending',
      queueEntry: entry,
      // The projection already carries the entry's sender/device/sending bot
      // as row fields; a queued bot message wears its tag like a delivered one.
      ...transcriptSourceFields(record),
      ...(images?.length ? { images: images as NonNullable<TranscriptItem['images']> } : {}),
    });
  }
  for (const item of local.values()) {
    rows.push({
      ...item,
      steer: item.steer ?? (heldForTurnEnd(item.text, null) ? 'held' : 'pending'),
      steerLocal: true,
    });
  }
  return rows;
}

export function promptWaitsBehindActiveTurn(draftMode: boolean, snapshot: Pick<Snapshot, 'busy' | 'queued'>): boolean {
  // A new thread's first prompt belongs to the new thread, never to the
  // active or queued state of the previously viewed
  // session. Existing sessions still expose follow-ups through the queue.
  return !draftMode && (Boolean(snapshot.busy) || (Array.isArray(snapshot.queued) && snapshot.queued.length > 0));
}

export function unsettledQueueEntries(queued: unknown, settled: readonly TranscriptItem[]): unknown[] {
  if (!Array.isArray(queued) || queued.length === 0) return [];
  const settledUserIds = promptPlacesById(settled);
  if (settledUserIds.size === 0) return queued;
  // One owner per submission: once the durable user row exists, it wins over
  // a delayed queue projection carrying the same id. Text is deliberately not
  // compared because identical follow-ups with distinct ids are valid.
  return queued.filter((entry) => {
    const id = asRecord(entry)?.id;
    return id === undefined || id === null || !settledUserIds.has(String(id));
  });
}
