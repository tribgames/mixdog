// A paired browser acts on the transcript it was last SHOWN. When another
// device has sent a prompt the browser has not received yet, its own send would
// silently queue behind work it never saw, so the host refuses it with a clear
// message and re-sends the current transcript instead.

interface TranscriptRowLike {
  id?: unknown;
  kind?: unknown;
  device?: unknown;
  finalAssistantId?: unknown;
}

/** `held`: the rows this connection was last sent (null when it holds none);
 *  `latest`: the session's current rows. Stale means the latest rows hold a
 *  user prompt, from a device other than `device`, that `held` lacks. A
 *  phone's window starts at its first held row (remote-transcript-window.ts):
 *  history above it it has not paged in is not news. */
export function viewIsStale(
  held: readonly unknown[] | null | undefined,
  latest: readonly unknown[] | null | undefined,
  device: string
): boolean {
  if (!held || !latest) return false;
  const known = new Set<unknown>();
  for (const row of held as readonly TranscriptRowLike[]) {
    if (row?.id !== undefined && row.id !== null) known.add(row.id);
  }
  const first = (held as readonly TranscriptRowLike[])[0];
  const rows = latest as readonly TranscriptRowLike[];
  let from = first?.id == null ? -1 : rows.findIndex((row) => row?.id === first.id);
  if (from < 0 && first?.kind === 'turndone' && typeof first.finalAssistantId === 'string' && first.finalAssistantId) {
    // Live and restored completions can have different display IDs. Scan
    // from their shared final reply, not from a later row across an unseen gap.
    const isReply = (row: TranscriptRowLike) => row?.kind === 'assistant' && row.id === first.finalAssistantId;
    const at = rows.findIndex(isReply);
    if (at >= 0 && !rows.slice(at + 1).some(isReply) &&
        rows.slice(at + 1).some((row) => row?.kind === 'turndone' && row.finalAssistantId === first.finalAssistantId)) {
      from = at;
    }
  }
  return rows
    .slice(Math.max(0, from))
    .some(
      (row) =>
        row?.kind === 'user' &&
        row.id !== undefined &&
        row.id !== null &&
        !known.has(row.id) &&
        typeof row.device === 'string' &&
        row.device !== '' &&
        row.device !== device
    );
}
