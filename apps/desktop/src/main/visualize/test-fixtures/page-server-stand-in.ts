// The core page server (native/core/crates/mixdog-workspace/src/pageserver) is the one page server; the visualize
// tests run without a core, so coreLocalPages() is given these answers instead: a lease URL of the server's shape and
// the asset mime by extension, hidden segments refused below the page's own folder chain.
import { randomBytes } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, sep } from 'node:path';

const WEB_ASSETS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'map', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'woff2', 'woff', 'ttf', 'otf', 'mp4',
  'webm', 'mp3', 'wav',
]);
const DATA_ASSETS = new Set(['json', 'csv', 'txt', 'md', 'xml', 'pdf', 'bin']);

const within = (base: string, file: string): boolean => {
  const rel = relative(base, file);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** The mime of a servable asset `file` under `root` ('' when it would not be served). */
export function pageAssetType(root: string, file: string, dataRoot: string = root): string {
  if (!within(root, file)) return '';
  let base = dataRoot;
  while (!within(base, file) && base !== root) base = dirname(base);
  if (relative(base, file).split(sep).some((part) => part.startsWith('.'))) return '';
  const extension = extname(file).slice(1).toLowerCase();
  return WEB_ASSETS.has(extension) || (DATA_ASSETS.has(extension) && within(dataRoot, file))
    ? `application/x-${extension}`
    : '';
}

/** A lease URL as the core page server makes it: a loopback origin, a 32-hex token, the page's relative path. */
export const localPageUrl = (_root: string, rel: string): string =>
  `http://127.0.0.1:4321/${randomBytes(16).toString('hex')}/${rel}`;
