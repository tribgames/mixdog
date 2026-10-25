// Download a lazy module's built files ahead of time WITHOUT evaluating them.
// `modulepreload` fetches and compiles a module off the main thread; the code
// runs only on its first import(). The file lists come from the build
// (scripts/chunk-prefetch.ts); the dev server has none, so nothing is fetched there.
import { chunkFiles } from 'virtual:mixdog-chunk-prefetch';

export type ChunkPrefetchName = 'diff' | 'terminal' | 'browser' | 'visualize' | 'editor' | 'settings';

const requested = new Set<string>();

function preloadLink(file: string): Promise<void> | null {
  if (requested.has(file)) return null;
  requested.add(file);
  const link = document.createElement('link');
  if (file.endsWith('.css')) {
    // Into the HTTP cache only: a `preload` the page does not apply within
    // seconds is reported as a wasted preload, and the pane may open much later.
    link.rel = 'prefetch';
    link.setAttribute('as', 'style');
  } else {
    link.rel = 'modulepreload';
  }
  // Module requests are CORS-mode, same-origin credentials: a preload must
  // match them to be reused by the later import().
  link.crossOrigin = '';
  link.href = `./${file}`;
  return new Promise<void>((done) => {
    link.onload = () => done();
    link.onerror = () => done();
    document.head.append(link);
  });
}

/** Fetches every file `name`'s first import needs; resolves once each landed
 *  (or failed: the later import retries the request itself). */
export function fetchChunkGraph(
  name: ChunkPrefetchName,
  files: Readonly<Record<string, readonly string[]>> = chunkFiles
): Promise<void> {
  const pending = (files[name] ?? []).flatMap((file) => preloadLink(file) ?? []);
  return Promise.all(pending).then(() => undefined);
}
