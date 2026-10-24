/**
 * Exports of a visualize tab: a file name for the save dialog, and inline
 * content saved into the project under `design/mockups/<slug>/` (never over
 * an existing file, never outside the working directory).
 */
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { VisualizeInlineContent, VisualizeInlineKind } from '../../shared/visualize';
import { insidePath, OutsideWorkingDirectoryError, resolveProjectOutput, visualizeKindForPath } from './targets';
import { writeFileInside } from './versions';

/** Where saved mockups go, relative to the working directory. */
export const MOCKUPS_DIRECTORY = 'design/mockups';

const INLINE_EXTENSIONS: Record<VisualizeInlineKind, string> = {
  mermaid: 'mmd',
  svg: 'svg',
  chart: 'json',
  html: 'html',
  markdown: 'md',
};

const MAX_SLUG_CHARS = 48;
const MAX_COLLISIONS = 1000;

export const inlineExtension = (kind: VisualizeInlineKind): string => INLINE_EXTENSIONS[kind];

/** Device names Windows refuses as a file or folder name. */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)$/;

/** A file-name-safe slug of `text` (lowercase letters and digits joined by
 *  `-`), or `fallback` when nothing usable is left. */
export function mockupSlug(text: string, fallback: string): string {
  const slug =
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SLUG_CHARS)
      .replace(/-+$/g, '') || fallback;
  return RESERVED_NAME.test(slug) ? `${slug}-mockup` : slug;
}

export interface SavedMockup {
  /** Relative to the working directory, `/`-separated. */
  rel: string;
  path: string;
  /** The panel can show the saved file as a tab. */
  openable: boolean;
}

/** Create `segments` under `root` (the resolved cwd) one level at a time. Each
 *  level must be a real directory (never a link) that resolves inside `root`;
 *  returns the resolved innermost folder. */
async function ensureRealDirectories(
  root: string,
  segments: string[],
  shown = `${MOCKUPS_DIRECTORY}/`
): Promise<string> {
  let current = root;
  for (const segment of segments) {
    const next = join(current, segment);
    let info = await lstat(next).catch(() => null);
    if (!info) {
      await mkdir(next).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      info = await lstat(next);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new OutsideWorkingDirectoryError(shown);
    }
    const real = await realpath(next);
    if (!insidePath(root, real)) throw new OutsideWorkingDirectoryError(shown);
    current = real;
  }
  return current;
}

/** Write `content.source` to `design/mockups/<slug>/<slug>.<ext>` under
 *  `cwd`. A slug whose file exists is skipped for `<slug>-2`, `-3`…. Folders
 *  are made level by level (links refused) and the file is created
 *  exclusively through `writeFileInside` (handle identity and post-open
 *  containment), so a folder swapped for a link at any moment cannot carry
 *  the bytes out, and nothing is ever overwritten. `beforeOpen` is a test seam
 *  between validation and the create. */
export async function saveInlineToProject(
  cwd: string,
  content: VisualizeInlineContent,
  label: string,
  hooks: { beforeOpen?(): unknown } = {}
): Promise<SavedMockup> {
  const base = mockupSlug(content.title ?? label, content.kind);
  const extension = inlineExtension(content.kind);
  const root = await realpath(cwd);
  const data = Buffer.from(content.source, 'utf8');
  for (let attempt = 1; attempt <= MAX_COLLISIONS; attempt += 1) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    const rel = `${MOCKUPS_DIRECTORY}/${slug}/${slug}.${extension}`;
    const folder = await ensureRealDirectories(root, [...MOCKUPS_DIRECTORY.split('/'), slug]);
    const path = join(folder, `${slug}.${extension}`);
    try {
      await writeFileInside(root, path, data, { exclusive: true, beforeOpen: hooks.beforeOpen });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    return { rel, path, openable: visualizeKindForPath(path) !== '' };
  }
  throw new Error(`could not find a free file name under ${MOCKUPS_DIRECTORY}/ for "${base}"`);
}

/** Where an agent export may overwrite an existing file (with `overwrite`). */
const OVERWRITE_ROOT = 'design/';

/** The project-relative, `/`-separated path an export `output` resolves to,
 *  validated like `capture`'s (inside cwd, links followed only to places
 *  inside it) with `extension` required. Creates nothing but the folders
 *  `resolveProjectOutput` makes; the write re-verifies every one. */
export async function resolveExportOutput(cwd: string, raw: string, extension: 'png' | 'pdf'): Promise<string> {
  if (!new RegExp(`\\.${extension}$`, 'i').test(raw)) throw new Error(`output must be a .${extension} path`);
  const path = await resolveProjectOutput(cwd, raw);
  return relative(await realpath(cwd), path)
    .split(sep)
    .join('/');
}

/** Write an export's bytes to `rel` (from `resolveExportOutput`) under `cwd`.
 *  Folders are made level by level (links refused) and the file goes through
 *  `writeFileInside` (handle identity, post-open containment, link count), so
 *  a folder swapped for a link at any moment cannot carry the bytes out. An
 *  existing file is refused unless `overwrite` is set and `rel` is under
 *  `design/`. `beforeOpen` is a test seam between validation and the open. */
export async function writeExportFile(
  cwd: string,
  rel: string,
  data: Buffer,
  options: { overwrite?: boolean; beforeOpen?(): unknown } = {}
): Promise<void> {
  const root = await realpath(cwd);
  const segments = rel.split('/');
  const name = segments.pop() as string;
  const folder = await ensureRealDirectories(root, segments, rel);
  const mayOverwrite =
    options.overwrite === true && (process.platform === 'win32' ? rel.toLowerCase() : rel).startsWith(OVERWRITE_ROOT);
  try {
    await writeFileInside(root, join(folder, name), data, { exclusive: !mayOverwrite, beforeOpen: options.beforeOpen });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      `${rel} already exists; an export only overwrites a file under ${OVERWRITE_ROOT} and only with overwrite: true`
    );
  }
}
