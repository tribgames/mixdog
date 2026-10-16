import { createHash } from 'node:crypto';
import { chmod, mkdir, open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import { enforceOwnerOnlyDirectoryWin32Async } from '../../../../src/runtime/shared/file-permissions.mjs';
import { createKeyedSerialQueue } from '../../../../src/runtime/shared/keyed-serial-queue.mjs';
import { isSessionId } from './desktop-state';

// `configured` records that the draft was applied, so a replay goes straight
// to the idempotent submission even if the draft can no longer be applied.
type Phase = 'reserved' | 'configured' | 'accepted';
interface Receipt {
  signature: string;
  sessionId: string;
  phase: Phase;
}
export interface NewTaskRequest {
  readonly sessionId: string;
  readonly phase: Phase;
  commit(phase: 'configured' | 'accepted'): Promise<void>;
}

// The receipts folder is made owner-only ONCE per process, before any receipt
// in it is read: its whole DACL is replaced (grants to anyone else, explicit or
// inherited, are dropped), files already inside are reset to inherit only that
// grant, and every file created later inherits it — so a receipt write is a
// plain atomic write with no ACL process. Secured again whenever the folder is
// gone or was replaced by a different one (its identity changed).
const securedFolders = new Map<string, { identity: string | null; pending: Promise<void> | null }>();
const receiptWrites = createKeyedSerialQueue();

function folderIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

async function secureReceiptFolder(folder: string): Promise<void> {
  let state = securedFolders.get(folder);
  if (!state) {
    state = { identity: null, pending: null };
    securedFolders.set(folder, state);
  }
  const current = await stat(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current && state.identity === folderIdentity(current)) return;
  const owned = state;
  owned.pending ??= (async () => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') await enforceOwnerOnlyDirectoryWin32Async(folder);
    else await chmod(folder, 0o700);
    owned.identity = folderIdentity(await stat(folder));
  })().finally(() => {
    owned.pending = null;
  });
  await owned.pending;
}

/** Durability per phase. `reserved` only binds the submission id to its content
 * and to the session address — and that address is derived from the id, so a
 * reservation lost to a power cut replays onto the same session anyway; a lost
 * `configured` only re-applies the same draft. An atomic rename is enough for
 * both (a process crash never loses it). `accepted` is what
 * recovery answers from without resubmitting, so it is fsynced together with
 * its folder entry before acceptance is reported. */
async function writeReceipt(path: string, receipt: Receipt): Promise<void> {
  await secureReceiptFolder(dirname(path));
  const durable = receipt.phase === 'accepted';
  await receiptWrites(path, () =>
    writeFileAtomicAsync(path, JSON.stringify(receipt), durable ? { fsyncDir: true } : { fsync: false })
  );
}

/** One small receipt per logical creation, without prompt contents or
 * snapshots. Active work is bounded in memory. Ambiguous failures keep the
 * same reserved session address, including across daemon/app replacement. */
export class NewTaskRequests {
  private readonly active = new Map<string, { signature: string; promise: Promise<unknown> }>();
  constructor(private readonly root: string) {}

  /** Start securing the receipts folder in the background (desktop service
   * startup), so the first submission only joins it if it is still running.
   * A failure here is not final: the next receipt access secures again and
   * rejects (fails closed) if that fails too. */
  prepare(): Promise<void> {
    return secureReceiptFolder(join(this.root, 'new-task-receipts')).catch(() => undefined);
  }

  run<T>(id: string, input: unknown, execute: (request: NewTaskRequest) => Promise<T>): Promise<T> {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const key = hash(id);
    const signature = hash(
      JSON.stringify(input, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]])
            )
          : value
      )
    );
    const existing = this.active.get(key);
    if (existing) {
      if (existing.signature !== signature)
        return Promise.reject(new Error('Submission id was reused for different content.'));
      return existing.promise as Promise<T>;
    }
    if (this.active.size >= 128) return Promise.reject(new Error('Too many new task requests are in progress.'));
    const path = join(this.root, 'new-task-receipts', `${key}.json`);
    const promise = (async () => {
      let receipt: Receipt;
      await secureReceiptFolder(dirname(path));
      try {
        const file = await open(path, 'r');
        try {
          if ((await file.stat()).size > 4096) throw new Error('New task receipt is too large.');
          receipt = JSON.parse(await file.readFile('utf8')) as Receipt;
        } finally {
          await file.close();
        }
        if (receipt.signature !== signature) throw new Error('Submission id was reused for different content.');
        if (!isSessionId(receipt.sessionId) || !['reserved', 'configured', 'accepted'].includes(receipt.phase)) {
          throw new Error('New task receipt is invalid.');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        receipt = { signature, sessionId: `sess_desktop_${key}`, phase: 'reserved' };
        await writeReceipt(path, receipt);
      }
      return execute({
        get sessionId() {
          return receipt.sessionId;
        },
        get phase() {
          return receipt.phase;
        },
        async commit(phase) {
          const next = { ...receipt, phase };
          await writeReceipt(path, next);
          receipt = next;
        },
      });
    })();
    this.active.set(key, { signature, promise });
    void promise
      .finally(() => {
        this.active.delete(key);
      })
      .catch(() => undefined);
    return promise;
  }
}
