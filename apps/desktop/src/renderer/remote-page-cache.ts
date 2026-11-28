const REMOTE_PAGE_CACHE_LIMIT = 6;

/** Built remote HTML pages of one authenticated connection, keyed by tab,
 *  pane and the host's content identity, in use order. `scope` names the
 *  pairing (server, device, keys): another one drops every page, and none
 *  keeps nothing. Only page text is kept; a page's fetch always goes over
 *  the load that asked for it. */
export function createRemotePageCache(scope: () => string | null) {
  let owner: string | null = null;
  const pages = new Map<string, Promise<string>>();
  return {
    clear(): void {
      pages.clear();
    },
    /** The page for `key`, built once per connection; `build` says whether
     *  its result may be kept. */
    page(key: string, build: () => Promise<{ srcdoc: string; keep: boolean }>): Promise<string> {
      const current = scope();
      if (current !== owner) {
        pages.clear();
        owner = current;
      }
      if (current === null) return build().then((page) => page.srcdoc);
      const kept = pages.get(key);
      if (kept) {
        pages.delete(key);
        pages.set(key, kept);
        return kept;
      }
      const built = build();
      const srcdoc = built.then((page) => page.srcdoc);
      pages.set(key, srcdoc);
      while (pages.size > REMOTE_PAGE_CACHE_LIMIT) pages.delete(pages.keys().next().value as string);
      const drop = () => {
        if (pages.get(key) === srcdoc) pages.delete(key);
      };
      void built.then((page) => {
        if (!page.keep) drop();
      }, drop);
      return srcdoc;
    },
  };
}
export type RemotePageCache = ReturnType<typeof createRemotePageCache>;
