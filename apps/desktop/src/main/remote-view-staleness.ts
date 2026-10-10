// A paired browser acts on the transcript it was last SHOWN. When another
// device has sent a prompt the browser has not received yet, its own send would
// silently queue behind work it never saw, so the host refuses it with a clear
// message and re-sends the current transcript instead.

interface TranscriptRowLike {
  id?: unknown;
  kind?: unknown;
  device?: unknown;
}

/** `held`: the rows this connection was last sent (null when it holds none);
 *  `latest`: the session's current rows. Stale means the latest rows hold a
 *  user prompt, from a device other than `device`, that `held` lacks. */
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
  return (latest as readonly TranscriptRowLike[]).some(
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
