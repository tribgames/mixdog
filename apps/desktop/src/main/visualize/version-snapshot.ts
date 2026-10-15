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
  /** Symlink-resolved file inside the working directory. */
  path: string;
}

export interface CollectedSnapshot {
  /** Each kept file by its cwd-relative path. */
  files: Map<string, Buffer>;
  panes: string[];
  assets: string[];
  bytes: number;
}

/** The files one version keeps, or null when a pane file does not fit
 *  `maxSnapshotBytes` (an asset that does not fit is left out). */
export async function collectSnapshot(
  cwd: string,
  sources: SnapshotSource[],
  maxSnapshotBytes: number
): Promise<CollectedSnapshot | null> {
  const realCwd = await realpath(cwd);
  const files = new Map<string, Buffer>();
  const panes: string[] = [];
  let bytes = 0;
  /** false when the file does not fit the remaining budget. */
  const add = async (path: string): Promise<boolean> => {
    const rel = relOf(realCwd, path);
    if (files.has(rel)) return true;
    const info = await stat(path);
    if (!info.isFile() || bytes + info.size > maxSnapshotBytes) return false;
    const data = await readFile(path);
    if (bytes + data.length > maxSnapshotBytes) return false;
    bytes += data.length;
    files.set(rel, data);
    return true;
  };
  for (const source of sources) {
    if (!insidePath(realCwd, source.path)) throw new Error('a snapshot source is outside the working directory');
    panes.push(relOf(realCwd, source.path));
    if (!(await add(source.path))) return null;
    if (source.kind !== 'html') continue;
    const page = files.get(relOf(realCwd, source.path));
    for (const reference of pageReferences(page?.toString('utf8') ?? '')) {
      let real: string;
      try {
        real = await realpath(resolve(dirname(source.path), reference));
      } catch {
        continue;
      }
      // The page server's own asset policy: inside cwd, not hidden, a web type.
      if (!insidePath(realCwd, real) || !pageAssetType(realCwd, real, dirname(source.path))) continue;
      // An asset that does not fit is left out; the page itself is kept.
      await add(real).catch(() => false);
    }
  }
  const assets = [...files.keys()].filter((rel) => !panes.includes(rel));
  return { files, panes, assets, bytes };
}

/** The content identity of a snapshot: its pane order and every kept file. */
export function snapshotHash(files: Map<string, Buffer>, panes: string[]): string {
  const hash = createHash('sha256').update(panes.join('\0'));
  for (const rel of [...files.keys()].sort()) {
    hash.update(`\0${rel}\0`).update(
      createHash('sha256')
        .update(files.get(rel) as Buffer)
        .digest()
    );
  }
  return hash.digest('hex');
}
