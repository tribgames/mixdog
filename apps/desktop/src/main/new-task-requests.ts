import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJsonText, writeFileAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
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
  /** Set by reset: the attempt was refused before anything was sent, so the
   * submission id may be resent with other content. */
  refused?: true;
}
export interface NewTaskRequest {
  readonly sessionId: string;
  readonly phase: Phase;
  commit(phase: 'configured' | 'accepted'): Promise<void>;
  /** Back to `reserved` on a fresh session address, marked refused, for an
   * attempt that failed before anything that could have been accepted was
   * sent: the old reservation is destroyed unclaimed, so a resend must not
   * resume it. */
  reset(): Promise<void>;
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
 * and to the session address — and that address is normally derived from the
 * id (only a refusal reset or a changed-content retry uses a random one), so a
 * reservation lost to a power cut replays onto the same session anyway; a lost
 * `configured` only re-applies the same draft. An atomic rename is enough for
 * both (a process crash never loses it). `accepted` is what
 * recovery answers from without resubmitting, so it is fsynced together with
 * its folder entry before acceptance is reported; so are a refusal (it frees
 * the id for other content) and the write that clears one before the next
 * attempt may send: a power cut must never bring a cleared refusal back. */
async function writeReceipt(path: string, receipt: Receipt, durable = receipt.phase === 'accepted'): Promise<void> {
  await secureReceiptFolder(dirname(path));
  await receiptWrites(path, () =>
    writeFileAtomicAsync(path, JSON.stringify(receipt), durable ? { fsyncDir: true } : { fsync: false })
  );
}

const freshSessionId = () => `sess_desktop_${randomBytes(32).toString('hex')}`;

const RECEIPT_MAX_BYTES = 4096;
const PHASES: readonly string[] = ['reserved', 'configured', 'accepted'];

/** The stored receipt, or null when there is none. A file that is no receipt
 * — empty or NUL-filled after a crash, truncated, oversized, or of another
 * shape — binds nothing: the id's session address normally derives from the id
 * itself, so the replay reserves it again and the idempotent submission goes
 * on (a random address from a refusal reset or changed-content retry lives
 * only in the receipt, so losing that receipt falls back to the derived one). Only
 * an I/O error fails the read. */
async function readReceipt(path: string): Promise<Receipt | null> {
  let text: string;
  try {
    const file = await open(path, 'r');
    try {
      if ((await file.stat()).size > RECEIPT_MAX_BYTES) return null;
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: Partial<Receipt> | null;
  try {
    parsed = parseJsonText(text) as Partial<Receipt> | null;
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed.signature !== 'string' ||
    !isSessionId(parsed.sessionId) ||
    !PHASES.includes(parsed.phase as string)
  ) {
    return null;
  }
  return parsed as Receipt;
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
      await secureReceiptFolder(dirname(path));
      const stored = await readReceipt(path);
      // Only a recorded refusal (reset) frees the id for other content, such
      // as a resend with changed draft settings. Any other receipt, a
      // `reserved` one left by an interrupted attempt included, keeps it.
      const refused = stored?.refused === true;
      if (stored && stored.signature !== signature && !refused)
        throw new Error('Submission id was reused for different content.');
      // The next attempt runs unmarked again: once it may have configured or
      // sent, it is not replaceable. The same content resumes the refusal's
      // address; other content starts on a fresh one, so nothing the refused
      // address may hold (draft settings only overwrite what a draft sets)
      // carries over.
      let receipt: Receipt =
        stored && !refused
          ? stored
          : {
              signature,
              sessionId: !stored
                ? `sess_desktop_${key}`
                : stored.signature === signature
                  ? stored.sessionId
                  : freshSessionId(),
              phase: 'reserved',
            };
      if (receipt !== stored) await writeReceipt(path, receipt, refused);
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
        async reset() {
          const next: Receipt = { signature, sessionId: freshSessionId(), phase: 'reserved', refused: true };
          await writeReceipt(path, next, true);
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
