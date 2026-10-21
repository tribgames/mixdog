import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { asRecord } from './text-format';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { recognisedSlashToken } from '../../../../src/tui/app/slash-commands.mjs';
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { transcriptSourceFields } from '../../../../src/runtime/shared/transcript-metadata.mjs';

export type PendingPromptItem = TranscriptItem & {
  id: string | number;
  kind: 'user';
  text: string;
  pending: boolean;
  accepted: boolean;
  submittedAt: number;
  queuedBehindTurn?: boolean;
  /** User rows already settled in this session when the prompt was sent. The
   *  durable row is the (baseline + 1)-th user row, which releases this
   *  optimistic twin even if the runtime normalized its id. */
  settledUserBaseline?: number;
  /** A message sent behind a running turn that could not be sent: what
   *  "Send again" submits (same id, so a late arrival is not posted twice). */
  retry?: { content: DesktopPromptContent; options?: DesktopSubmitOptions };
  /** The session runtime's queue entry this message waits as. */
  queueEntry?: unknown;
  /** Submitted from this pane, not yet in the session runtime's queue. */
  steerLocal?: boolean;
};

export function settledUserRowCount(items: readonly TranscriptItem[]): number {
  let count = 0;
  // A group room's user row arrives live as a notice carrying `room.kind:
  // 'user'` (agent-room-delivery.mjs); it is that prompt's durable row too.
  for (const item of items) if (item?.kind === 'user' || item?.room?.kind === 'user') count += 1;
  return count;
}

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

export function pendingPromptTranscriptItems(
  optimistic: PendingPromptItem[],
  settled: TranscriptItem[]
): PendingPromptItem[] {
  const settledIds = new Set(
    settled
      .map((item) => item?.id)
      .filter((id) => id !== undefined && id !== null)
      .map(String)
  );
  const settledUsers = settledUserRowCount(settled);
  const byId = new Map<string, PendingPromptItem>();
  for (const item of optimistic) {
    if (item?.id === undefined || item.id === null) continue;
    // An image-only message has no words; its thumbnails are the bubble.
    if (!String(item.text || '').trim() && !hasImages(item)) continue;
    byId.set(String(item.id), item);
  }
  // Host acknowledgement is NOT settlement. Releasing on the RPC result took
  // the bubble back out of the thread for the whole ack -> publication window
  // (measured 77ms to 4s on the daemon-hosted session runtime): the bottom-pinned
  // timeline lost the prompt's height, snapped back, then snapped forward
  // again when the durable row arrived — the double kick the reader sees as
  // one big jerk (user: 프롬프트 입력 들어갈 때 스크롤이 크게 투둑 튄다).
  // The optimistic row is therefore held until its OWN durable row lands.
  const rows: PendingPromptItem[] = [];
  const ordered = [...byId.values()].sort((left, right) => left.submittedAt - right.submittedAt);
  // The last durable user row (by ordinal) an earlier optimistic prompt
  // claimed. This prompt's own row is the next one past both that claim and
  // its submit-time baseline — not their sum: a prompt sent after the
  // previous one settled already counts that row in its baseline, and adding
  // the claim again kept every later renamed prompt (a group room's) standing
  // as a second bubble under its own row.
  let claimedThrough = 0;
  for (const item of ordered) {
    // A message that could not be sent has no durable row to wait for: it
    // stays until it is sent again or cancelled, and claims no ordinal.
    if (item.steer === 'failed') {
      rows.push(item);
      continue;
    }
    const baseline = Number(item.settledUserBaseline);
    const ordinal = Math.max(Number.isFinite(baseline) ? baseline : 0, claimedThrough) + 1;
    if (settledIds.has(String(item.id))) {
      claimedThrough = ordinal;
      continue;
    }
    // Id-agnostic safety net: a runtime that renames the submission id still
    // releases the twin once its ordinal user row exists, so a lost id can
    // never strand a permanent ghost bubble.
    if (Number.isFinite(baseline) && settledUsers >= ordinal) {
      claimedThrough = ordinal;
      continue;
    }
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
    const submittedAt = Number(record.submittedAt);
    rows.push({
      id,
      kind: 'user',
      text,
      pending: true,
      accepted: true,
      submittedAt: Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : (twin?.submittedAt ?? 0),
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
  const settledUserIds = new Set(
    settled
      .filter((item) => item?.kind === 'user' && item.id !== undefined && item.id !== null)
      .map((item) => String(item.id))
  );
  if (settledUserIds.size === 0) return queued;
  // One owner per submission: once the durable user row exists, it wins over
  // a delayed queue projection carrying the same id. Text is deliberately not
  // compared because identical follow-ups with distinct ids are valid.
  return queued.filter((entry) => {
    const id = asRecord(entry)?.id;
    return id === undefined || id === null || !settledUserIds.has(String(id));
  });
}
