// Client of the core page server: the main process asks the core for page URLs
// and revokes a closed owner's pages there. Page serving itself lives in the core.
import { LocalAccessDeniedError } from './local-access-denied';

export interface PageOwner {
  id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface CoreLocalPages {
  url(root: string, rel: string, access?: { accessToken?: string; ownerId?: string; owner?: PageOwner }): Promise<string>;
  origin(): Promise<string>;
  refresh(): Promise<string>;
  revokeOwner(ownerId: string): Promise<void>;
}

type Invoke = <T>(name: string, args: unknown[]) => Promise<T>;

/** Fallback owner id for a bare webContents; callers that have the window's stable id pass it as ownerId. */
export function ownerIdOf(owner: { id: number }): string {
  return `wc:${owner.id}`;
}

export function createCoreLocalPages(invoke: Invoke): CoreLocalPages {
  const watched = new WeakSet<object>();
  const queued = new Set<string>();
  let cachedOrigin: Promise<string> | null = null;

  const sendRevoke = async (ownerId: string): Promise<void> => {
    try {
      await invoke<void>('localPageRevokeOwner', [ownerId]);
      queued.delete(ownerId);
    } catch {
      // The core link is down: the revoke is retried by the next refresh().
      queued.add(ownerId);
    }
  };

  return {
    async url(root, rel, access = {}) {
      const { owner, accessToken } = access;
      if (owner?.isDestroyed()) throw new LocalAccessDeniedError('The preview owner is closed.');
      const ownerId = access.ownerId ?? (owner ? ownerIdOf(owner) : '');
      if (owner && !watched.has(owner)) {
        watched.add(owner);
        owner.once('destroyed', () => void sendRevoke(ownerId));
      }
      return invoke<string>('localPageUrlIn', [root, rel, accessToken ?? '', ownerId]);
    },
    origin() {
      if (!cachedOrigin) {
        cachedOrigin = invoke<string>('localPageOrigin', []).catch((error) => {
          cachedOrigin = null;
          throw error;
        });
      }
      return cachedOrigin;
    },
    async refresh() {
      const fresh = invoke<string>('localPageOrigin', []);
      const origin = await fresh;
      cachedOrigin = Promise.resolve(origin);
      await Promise.all([...queued].map(sendRevoke));
      return origin;
    },
    async revokeOwner(ownerId) {
      await invoke<void>('localPageRevokeOwner', [ownerId]);
      queued.delete(ownerId);
    },
  };
}

let current: CoreLocalPages | null = null;

export function setCoreLocalPages(pages: CoreLocalPages | null): void {
  current = pages;
}

export function coreLocalPages(): CoreLocalPages {
  if (!current) throw new Error('The local page server is not connected.');
  return current;
}
