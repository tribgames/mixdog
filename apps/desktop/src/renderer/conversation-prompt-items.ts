import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { asRecord } from './text-format';

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
};

export function settledUserRowCount(items: readonly TranscriptItem[]): number {
  let count = 0;
  for (const item of items) if (item?.kind === 'user') count += 1;
  return count;
}

export function desktopPromptDisplayText(content: DesktopPromptContent, options?: DesktopSubmitOptions): string {
  const explicit = String(options?.displayText || '').trim();
  if (explicit) return explicit;
  if (typeof content === 'string') return content.trim();
  return (
    content
      .map((part) => {
        if (part.type === 'text') return part.text;
        if (part.type === 'image') return '[Image]';
        return `[File: ${part.filename || 'attachment'}]`;
      })
      .filter(Boolean)
      .join('\n')
      .trim() || t('Attached prompt')
  );
}

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
    if (item?.id === undefined || item.id === null || !String(item.text || '').trim()) continue;
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
  // Durable user rows already claimed by an earlier optimistic prompt: this
  // prompt's own row is the (baseline + claimed + 1)-th user row.
  let claimed = 0;
  for (const item of ordered) {
    if (settledIds.has(String(item.id))) {
      claimed += 1;
      continue;
    }
    // Id-agnostic safety net: a runtime that renames the submission id still
    // releases the twin once its ordinal user row exists, so a lost id can
    // never strand a permanent ghost bubble.
    const baseline = Number(item.settledUserBaseline);
    if (Number.isFinite(baseline) && settledUsers >= baseline + claimed + 1) {
      claimed += 1;
      continue;
    }
    rows.push({ ...item, pending: true });
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
