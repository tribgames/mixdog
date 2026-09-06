import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { writeSecretFile } from './secret-file';

type Phase = 'reserved' | 'configured' | 'accepted';
interface Receipt { signature: string; sessionId: string; phase: Phase }
export interface NewTaskRequest {
  readonly sessionId: string;
  readonly phase: Phase;
  commit(phase: Phase): Promise<void>;
}

/** One small durable receipt per logical creation, without prompt contents or
 * snapshots. Active work is bounded in memory. Ambiguous failures keep the
 * same reserved session address, including across daemon/app replacement. */
export class NewTaskRequests {
  private readonly active = new Map<string, { signature: string; promise: Promise<unknown> }>();
  constructor(private readonly root: string) {}

  run<T>(id: string, input: unknown, execute: (request: NewTaskRequest) => Promise<T>): Promise<T> {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const key = hash(id);
    const signature = hash(JSON.stringify(input, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
        : value));
    const existing = this.active.get(key);
    if (existing) {
      if (existing.signature !== signature) return Promise.reject(new Error('Submission id was reused for different content.'));
      return existing.promise as Promise<T>;
    }
    if (this.active.size >= 128) return Promise.reject(new Error('Too many new task requests are in progress.'));
    const path = join(this.root, 'new-task-receipts', `${key}.json`);
    const promise = (async () => {
      let receipt: Receipt;
      try {
        const file = await open(path, 'r');
        try {
          if ((await file.stat()).size > 4096) throw new Error('New task receipt is too large.');
          receipt = JSON.parse(await file.readFile('utf8')) as Receipt;
        } finally { await file.close(); }
        if (receipt.signature !== signature) throw new Error('Submission id was reused for different content.');
        if (!/^[A-Za-z0-9_-]+$/.test(receipt.sessionId)
          || !['reserved', 'configured', 'accepted'].includes(receipt.phase)) {
          throw new Error('New task receipt is invalid.');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        receipt = { signature, sessionId: `sess_desktop_${key}`, phase: 'reserved' };
        await writeSecretFile(path, JSON.stringify(receipt));
      }
      return execute({
        get sessionId() { return receipt.sessionId; },
        get phase() { return receipt.phase; },
        async commit(phase) {
          const next = { ...receipt, phase };
          await writeSecretFile(path, JSON.stringify(next));
          receipt = next;
        },
      });
    })();
    this.active.set(key, { signature, promise });
    void promise.finally(() => { this.active.delete(key); }).catch(() => undefined);
    return promise;
  }
}
