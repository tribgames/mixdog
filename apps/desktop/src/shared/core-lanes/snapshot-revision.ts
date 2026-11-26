const originRevisions = new WeakMap<object, number>();
let nextSnapshotRevision = 0;

/** Monotonic authoritative snapshot revision bound to a fold's `origin`
 *  (`thread/snapshot`), bumped explicitly when a reconnect replay completes
 *  over an existing fold. */
export function snapshotRevisionFor(origin: object | undefined): number | undefined {
  if (!origin) return undefined;
  let revision = originRevisions.get(origin);
  if (revision === undefined) {
    revision = ++nextSnapshotRevision;
    originRevisions.set(origin, revision);
  }
  return revision;
}

export function advanceSnapshotRevision(origin: object | undefined): number {
  const revision = ++nextSnapshotRevision;
  if (origin) originRevisions.set(origin, revision);
  return revision;
}
