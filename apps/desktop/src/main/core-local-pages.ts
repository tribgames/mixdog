// Client of the core page server: the main process asks the core for page URLs
// and revokes a closed owner's pages there. Page serving itself lives in the core.
import { putBlobRef } from './core-blob-ref';
import { MAX_INLINE_RESULT_BYTES } from './host/browser-engine/blob-upload';
import { LocalAccessDeniedError } from './local-access-denied';
import type { ProtocolConnection } from './protocol/connection';

export interface PageOwner {
  id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface CoreLocalPages {
  url(root: string, rel: string, access?: { accessToken?: string; ownerId?: string; owner?: PageOwner }): Promise<string>;
  /** An in-memory page (visualize): `index.html` is required; the lease is revoked with its owner as url()'s is. */
  virtual(
    files: Record<string, { type: string; body: Buffer }>,
    access?: { ownerId?: string; owner?: PageOwner }
  ): Promise<string>;
  /** The mime of a web asset `file` the page server serves from under `root` ('' when it would not): the core's page policy. */
  assetType(root: string, file: string, dataRoot?: string): Promise<string>;
  origin(): Promise<string>;
  refresh(): Promise<string>;
  revokeOwner(ownerId: string): Promise<void>;
}

type Invoke = <T>(name: string, args: unknown[]) => Promise<T>;

/** Fallback owner id for a bare webContents; callers that have the window's stable id pass it as ownerId. */
export function ownerIdOf(owner: { id: number }): string {
  return `wc:${owner.id}`;
}

const blobCore = (core: Pick<ProtocolConnection, 'call'> | undefined): Pick<ProtocolConnection, 'call'> => {
  if (!core) throw new Error('A page file too large for one request needs the core connection to upload it.');
  return core;
};

export function createCoreLocalPages(invoke: Invoke, core?: Pick<ProtocolConnection, 'call'>): CoreLocalPages {
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

  // The owner's id, watched so its pages are revoked in the core when it closes.
  const ownerFor = (access: { ownerId?: string; owner?: PageOwner }): string | undefined => {
    const { owner } = access;
    if (owner?.isDestroyed()) throw new LocalAccessDeniedError('The preview owner is closed.');
    const ownerId = access.ownerId || (owner ? ownerIdOf(owner) : undefined);
    if (owner && ownerId && !watched.has(owner)) {
      watched.add(owner);
      owner.once('destroyed', () => void sendRevoke(ownerId));
    }
    return ownerId;
  };

  return {
    async url(root, rel, access = {}) {
      const ownerId = ownerFor(access);
      // An empty token is no grant (the core reads any accessToken as a one-file grant), as main treated it.
      return invoke<string>('localPageUrlIn', [root, rel, access.accessToken || undefined, ownerId]);
    },
    async virtual(files, access = {}) {
      const ownerId = ownerFor(access);
      // The page is always one virtual lease. A request over the core's inbound frame closes the connection, so the files
      // that do not fit (a chart's ECharts, a diagram's Mermaid, an export's images) are uploaded with `blob/put` and named
      // by `{$blobRef, as:'base64'}`, which the core expands to the file's bytes before the lease is made; the lease owns
      // what it received.
      let inline = 0;
      const list = [];
      for (const [path, file] of Object.entries(files)) {
        const base64Length = Math.ceil(file.body.byteLength / 3) * 4;
        const fits = inline + base64Length + path.length + file.type.length <= MAX_INLINE_RESULT_BYTES / 2;
        if (fits) inline += base64Length + path.length + file.type.length;
        list.push({
          path,
          dataBase64: fits ? file.body.toString('base64') : await putBlobRef(blobCore(core), file.body, 'base64'),
          type: file.type,
        });
      }
      return invoke<string>('localPageVirtualIn', [list, ownerId]);
    },
    async assetType(root, file, dataRoot) {
      return invoke<string>('localPageAssetType', [root, file, dataRoot]);
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
