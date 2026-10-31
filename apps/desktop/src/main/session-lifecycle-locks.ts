// One queue per session for the actions that change what a session is or
// whether it runs (archive, restore, favorite, delete, turn starts): the
// auto-retention pass reads slowly outside it, then takes it only to confirm
// that no lifecycle action ran since (`version`) and to act, so a turn start
// never waits on the pass's reads.
import { AsyncLocalStorage } from 'node:async_hooks';

interface SessionQueue {
  tail: Promise<void>;
  holder: symbol | null;
  /** Callers queued behind the holder. */
  waiting: number;
}

export class SessionLifecycleLocks {
  private readonly queues = new Map<string, SessionQueue>();
  /** Lifecycle actions completed per session: a reader that saw one value
   *  and sees it again under the lock knows no action ran in between. */
  private readonly versions = new Map<string, number>();
  /** The locks the current async chain holds, so a nested action on the same
   *  session (the pass archiving through the manual path) does not wait on
   *  itself. A token only counts while its holder still holds the lock. */
  private readonly held = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();

  async run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const held = this.held.getStore();
    const existing = this.queues.get(sessionId);
    const token = held?.get(sessionId);
    if (token && existing?.holder === token) return task();
    const queue = existing ?? { tail: Promise.resolve(), holder: null, waiting: 0 };
    this.queues.set(sessionId, queue);
    const previous = queue.tail;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.tail = mine;
    queue.waiting += 1;
    await previous;
    queue.waiting -= 1;
    const holder = Symbol(sessionId);
    queue.holder = holder;
    try {
      return await this.held.run(new Map([...(held ?? []), [sessionId, holder]]), task);
    } finally {
      queue.holder = null;
      this.versions.set(sessionId, (this.versions.get(sessionId) ?? 0) + 1);
      release();
      if (queue.tail === mine && this.queues.get(sessionId) === queue) this.queues.delete(sessionId);
    }
  }

  /** How many lifecycle actions on `sessionId` have finished (or failed). */
  version(sessionId: string): number {
    return this.versions.get(sessionId) ?? 0;
  }

  /** Another lifecycle action is queued for `sessionId` behind its holder. */
  contended(sessionId: string): boolean {
    return (this.queues.get(sessionId)?.waiting ?? 0) > 0;
  }
}
