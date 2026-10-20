/** Page identity across restarts, so a transcript card keeps the screenshot,
 *  icon and title it had before the app closed. Sealed with the OS keychain
 *  like the session cookies: a screenshot shows what a signed-in page showed.
 *  Writes are coalesced; nothing is written until the saved copy is back. */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';
import { safeStorageDecrypt, safeStorageEncrypt } from './browser-session-store';
import type { BrowserPageIdentityStore } from './page-identity';

const FILE_NAME = 'page-identity.bin';
const SAVE_DELAY_MS = 10_000;

export function createBrowserPageIdentityFile(host: {
  store: Pick<BrowserPageIdentityStore, 'snapshot' | 'restore'>;
  directory: string;
  encrypt?(text: string): Promise<Buffer | null>;
  decrypt?(data: Buffer): Promise<string | null>;
  saveDelayMs?: number;
}) {
  const encrypt = host.encrypt || safeStorageEncrypt;
  const decrypt = host.decrypt || safeStorageDecrypt;
  const file = join(host.directory, FILE_NAME);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let saving: Promise<void> = Promise.resolve();

  async function load(): Promise<string[]> {
    let sealed: Buffer;
    try {
      sealed = await readFile(file);
    } catch {
      return [];
    }
    const text = await decrypt(sealed).catch(() => null);
    try {
      if (text) return host.store.restore(JSON.parse(text));
    } catch {
      /* unreadable: discarded below */
    }
    await rm(file, { force: true }).catch(() => undefined);
    return [];
  }

  /** Origins the saved copy filled in, once it is back. */
  const loaded = load();

  /** Write the current snapshot now (pending changes only). */
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    saving = saving
      .catch(() => undefined)
      .then(async () => {
        await loaded.catch(() => undefined);
        if (!dirty) return;
        dirty = false;
        const sealed = await encrypt(JSON.stringify(host.store.snapshot()));
        if (!sealed) return;
        await writeFileAtomicAsync(file, sealed, { secret: true });
      });
    return saving;
  }

  /** Something changed: write it with whatever else changes shortly after. */
  function schedule(): void {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => void flush().catch(() => undefined), host.saveDelayMs ?? SAVE_DELAY_MS);
    timer.unref?.();
  }

  return { loaded, schedule, flush, file };
}
