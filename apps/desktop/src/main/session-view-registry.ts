/** All consumers share one daemon subscription. Serialize the UNION change,
 * not just each consumer's request: a late unsubscribe from a departed phone
 * must never detach a newly attached phone or a desktop pane. */
export class SessionViewRegistry {
  readonly visible = new Set<string>();
  readonly sources = new Map<string, Set<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  set(
    source: string,
    requested: string[],
    ensure: (id: string, alreadyVisible: boolean) => Promise<boolean>,
    release: (id: string) => Promise<unknown>,
  ): Promise<boolean> {
    const run = this.queue.catch(() => undefined).then(async () => {
      if (this.closed) return false;
      const prior = this.sources.get(source);
      const results = await Promise.allSettled(requested.map(async (id) => {
        if (this.visible.has(id) && prior?.has(id)) return id;
        return await ensure(id, this.visible.has(id)) ? id : null;
      }));
      const accepted = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        await Promise.allSettled(accepted.filter((id): id is string =>
          id !== null && !this.visible.has(id)).map(release));
        throw failure.reason;
      }
      if (this.closed) return false;
      const nextSource = new Set(accepted.filter((id): id is string => id !== null));
      if (nextSource.size) this.sources.set(source, nextSource);
      else this.sources.delete(source);
      const next = new Set([...this.sources.values()].flatMap((ids) => [...ids]));
      const removed = [...this.visible].filter((id) => !next.has(id));
      this.visible.clear();
      for (const id of next) this.visible.add(id);
      await Promise.all(removed.map(release));
      return true;
    });
    this.queue = run;
    return run;
  }

  close(): void {
    this.closed = true;
    this.visible.clear();
    this.sources.clear();
  }
}
