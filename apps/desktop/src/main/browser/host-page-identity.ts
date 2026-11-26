import { join } from 'node:path';
import type { Session } from 'electron';
import { createBrowserPageIdentityStore } from './page-identity';
import { readBrowserPagePreview } from './page-identity-capture';
import { createBrowserPageIdentityFile } from './page-identity-file';
import { createBrowserPagePreviews } from './page-preview';
import { createDiskPageThumbnailStorage } from './page-thumbnail-disk';

export function createBrowserHostPageIdentity(options: {
  partitionSession: Session | (() => Session);
  directory: string;
  announce: (origin: string) => void;
  encrypt?(text: string): Promise<Buffer | null>;
  decrypt?(data: Buffer): Promise<string | null>;
}) {
  const resolveSession = (): Session =>
    typeof options.partitionSession === 'function' ? options.partitionSession() : options.partitionSession;
  // One change notice per site and tick: a load reports title, icon and
  // thumbnail in quick succession.
  const changedOrigins = new Set<string>();
  const announceChange = (origin: string) => {
    if (!changedOrigins.size)
      setImmediate(() => {
        for (const changed of changedOrigins) options.announce(changed);
        changedOrigins.clear();
      });
    changedOrigins.add(origin);
  };
  const diskThumbnails = createDiskPageThumbnailStorage(join(options.directory, 'page-thumbnails'), {
    encrypt: options.encrypt,
    decrypt: options.decrypt,
    onWriteFailed: (key, url) => innerStore.dropThumbnail(key, url),
  });
  const innerStore = createBrowserPageIdentityStore({
    thumbnails: diskThumbnails,
    onChange: (origin) => {
      announceChange(origin);
      file.schedule();
    },
    onMigrated: () => {
      file.schedule();
    },
  });
  const file = createBrowserPageIdentityFile({
    store: innerStore,
    directory: options.directory,
    encrypt: options.encrypt,
    decrypt: options.decrypt,
    beforeFlush: () => diskThumbnails.settled(),
  });
  let loadStarted = false;
  const ensureLoaded = (): Promise<string[]> => {
    if (!loadStarted) {
      loadStarted = true;
      return file.ensureLoaded().then((origins) => {
        for (const origin of origins) announceChange(origin);
        return origins;
      });
    }
    return file.ensureLoaded();
  };
  const store: typeof innerStore = {
    update: (url, patch) => innerStore.update(url, patch),
    lookup: (url) => {
      void ensureLoaded();
      return innerStore.lookup(url);
    },
    snapshot: () => innerStore.snapshot(),
    restore: (saved) => innerStore.restore(saved),
    dropThumbnail: (key, url) => innerStore.dropThumbnail(key, url),
  };
  const rawPreviews = createBrowserPagePreviews({
    ready: ensureLoaded,
    lookup: (url) => innerStore.lookup(url),
    read: (url) => readBrowserPagePreview(resolveSession(), url, innerStore.lookup(url)),
    record: (url, patch) => innerStore.update(url, patch),
  });
  const dispose = (): void => {
    changedOrigins.clear();
    rawPreviews.dispose();
    diskThumbnails.dispose();
  };
  const previews: typeof rawPreviews = {
    request: rawPreviews.request,
    dispose,
  };
  return { store, file, previews, dispose };
}
