/**
 * The recorded title, icon and thumbnail per site: the store, its sealed file,
 * background page previews, and batched change notices to the display client.
 */
import type { Session } from 'electron';
import { createBrowserPageIdentityStore } from './page-identity';
import { readBrowserPagePreview } from './page-identity-capture';
import { createBrowserPageIdentityFile } from './page-identity-file';
import { createBrowserPagePreviews } from './page-preview';

export function createBrowserHostPageIdentity(options: {
  partitionSession: Session;
  directory: string;
  announce: (origin: string) => void;
}) {
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
  const store = createBrowserPageIdentityStore({
    onChange: (origin) => {
      announceChange(origin);
      file.schedule();
    },
  });
  const file = createBrowserPageIdentityFile({ store, directory: options.directory });
  void file.loaded.then((origins) => origins.forEach(announceChange));
  const previews = createBrowserPagePreviews({
    ready: file.loaded,
    lookup: (url) => store.lookup(url),
    read: (url) => readBrowserPagePreview(options.partitionSession, url, store.lookup(url)),
    record: (url, patch) => store.update(url, patch),
  });
  return { store, file, previews };
}
