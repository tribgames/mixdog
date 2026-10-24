/**
 * What one visualize version keeps: a tab's pane files and, for HTML panes,
 * the local page assets they reference (within one size budget), and the
 * content hash that tells an unchanged snapshot apart.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { pageAssetType } from '../local-page-server';
import { insidePath } from './targets';

const MAX_PAGE_ASSETS = 64;

const ELEMENT = /<(?:link|script|img|source|video|audio|track|embed|input)\b[^>]*>/gi;
const REFERENCE = /\s(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Local relative references (styles, scripts, media) of an HTML page. */
export function pageReferences(html: string): string[] {
  const found = new Set<string>();
  for (const element of html.match(ELEMENT) ?? []) {
    for (const match of element.matchAll(REFERENCE)) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      // Root-relative paths leave the page's lease; schemes are not local.
      if (!raw || raw.startsWith('#') || raw.startsWith('/') || raw.startsWith('\\') || SCHEME.test(raw)) continue;
      const path = raw.replace(/[?#].*$/, '');
      try {
        found.add(decodeURIComponent(path));
      } catch {
        found.add(path);
      }
      if (found.size >= MAX_PAGE_ASSETS) return [...found];
    }
  }
  return [...found];
}

/** `path` relative to `root`, `/`-separated. */
export const relOf = (root: string, path: string): string => relative(root, path).split(sep).join('/');

export interface SnapshotSource {
  kind: string;
  /** Symlink-resolved file inside `root`. */
  path: string;
  /** The folder (symlink-resolved) the file and its page assets stay inside. */
  root: string;
}

export interface CollectedSnapshot {
  /** The folders the kept files come from: distinct, in pane order. */
  roots: string[];
  /** Each kept file by its kept path (`keptPathOf`). */
  files: Map<string, Buffer>;
  panes: string[];
  assets: string[];
  bytes: number;
}

/** Where a file at `rel` in root `index` of `count` sits in a version folder:
 *  at `rel` when the version has one root, else under the root's index. */
export const keptPathOf = (count: number, index: number, rel: string): string => (count > 1 ? `${index}/${rel}` : rel);

/** The files one version keeps, or null when a pane file does not fit
 *  `maxSnapshotBytes` (an asset that does not fit is left out). */
export async function collectSnapshot(
  sources: SnapshotSource[],
  maxSnapshotBytes: number
): Promise<CollectedSnapshot | null> {
  const roots = [...new Set(sources.map((source) => source.root))];
  const keptOf = (root: string, path: string) => keptPathOf(roots.length, roots.indexOf(root), relOf(root, path));
  const files = new Map<string, Buffer>();
  const panes: string[] = [];
  let bytes = 0;
  /** false when the file does not fit the remaining budget. */
  const add = async (kept: string, path: string): Promise<boolean> => {
    if (files.has(kept)) return true;
    const info = await stat(path);
    if (!info.isFile() || bytes + info.size > maxSnapshotBytes) return false;
    const data = await readFile(path);
    if (bytes + data.length > maxSnapshotBytes) return false;
    bytes += data.length;
    files.set(kept, data);
    return true;
  };
  for (const { kind, path, root } of sources) {
    if (!insidePath(root, path)) throw new Error('a snapshot source is outside its folder');
    const kept = keptOf(root, path);
    panes.push(kept);
    if (!(await add(kept, path))) return null;
    if (kind !== 'html') continue;
    for (const reference of pageReferences(files.get(kept)?.toString('utf8') ?? '')) {
      let real: string;
      try {
        real = await realpath(resolve(dirname(path), reference));
      } catch {
        continue;
      }
      // The page server's own asset policy: inside the root, not hidden, a web type.
      if (!insidePath(root, real) || !pageAssetType(root, real, dirname(path))) continue;
      // An asset that does not fit is left out; the page itself is kept.
      await add(keptOf(root, real), real).catch(() => false);
    }
  }
  const assets = [...files.keys()].filter((kept) => !panes.includes(kept));
  return { roots, files, panes, assets, bytes };
}

/** The content identity of a snapshot: where its files come from, its pane
 *  order and every kept file. */
export function snapshotHash({ roots, files, panes }: Omit<CollectedSnapshot, 'assets' | 'bytes'>): string {
  const hash = createHash('sha256').update(`${roots.join('\0')}\0\0${panes.join('\0')}`);
  for (const rel of [...files.keys()].sort()) {
    hash.update(`\0${rel}\0`).update(
      createHash('sha256')
        .update(files.get(rel) as Buffer)
        .digest()
    );
  }
  return hash.digest('hex');
}
