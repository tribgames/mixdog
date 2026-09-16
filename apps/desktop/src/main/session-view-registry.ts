/** Consumers share one daemon subscription per session. Record intent before
 * loading and serialize only operations on the SAME session: a slow retired
 * pane must not block the next tab, and a late release must not detach a new viewer. */
export class SessionViewRegistry {
  readonly visible = new Set<string>();
  readonly sources = new Map<string, Set<string>>();
  private readonly attached = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private closed = false;

  private updateVisible(): void {
    this.visible.clear();
    for (const ids of this.sources.values()) {
      for (const id of ids) this.visible.add(id);
    }
  }

  set(
    source: string,
    requested: string[],
    ensure: (id: string, alreadyVisible: boolean) => Promise<boolean>,
    release: (id: string) => Promise<unknown>
  ): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const prior = this.sources.get(source);
    const next = new Set(requested);
    if (next.size) this.sources.set(source, next);
    else this.sources.delete(source);
    this.updateVisible();
    const jobs = [...new Set([...requested, ...(prior ?? [])])].map((id) => {
      const run = (this.queues.get(id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          if (this.closed) return;
          if (this.sources.get(source) === next && next.has(id)) {
            const accepted = await ensure(id, this.attached.has(id));
            if (this.closed) return;
            if (accepted) this.attached.add(id);
            else if (this.sources.get(source) === next) {
              next.delete(id);
              if (!next.size) this.sources.delete(source);
              this.updateVisible();
            }
          }
          // Re-check CURRENT intent after every await. A superseded successful
          // subscription must be released, never adopted by the retired source.
          if (!this.visible.has(id) && this.attached.has(id)) {
            await release(id);
            this.attached.delete(id);
          }
        });
      this.queues.set(id, run);
      const settled = () => {
        if (this.queues.get(id) === run) this.queues.delete(id);
      };
      void run.then(settled, settled);
      return run;
    });
    return Promise.allSettled(jobs).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      return !this.closed;
    });
  }

  close(): void {
    this.closed = true;
    this.visible.clear();
    this.sources.clear();
    this.attached.clear();
    this.queues.clear();
  }
}
