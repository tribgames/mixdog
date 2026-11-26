import { realpath, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { WebContents } from 'electron';

import type { VisualizeInlineContent } from '../../shared/visualize';
import { registerFilePreview } from '../file-preview';
import { coreLocalPages } from '../core-local-pages';
import { windowIdFor } from '../core-port/window-ids';
import { inlinePageFiles } from './inline-page';
import type { VisualizeServiceDeps } from './service';

type PaneTarget = Parameters<VisualizeServiceDeps['preparePane']>[0];

let virtualLeaseSeq = 0;
const virtualLeaseOwners = new Map<string, string>();

/** A chart / html sketch as a virtual page: its own lease (opaque origin,
 *  scripts on), the same problem capture and network guard as file pages. */
export async function inlinePageUrl(
  content: VisualizeInlineContent,
  contents: WebContents | undefined,
  observe: (contents: WebContents) => void
): Promise<string> {
  if (contents) observe(contents);
  const baseOwner = contents ? windowIdFor(contents) : 'visualize';
  const ownerId = `${baseOwner}:virtual:${++virtualLeaseSeq}`;
  const url = await coreLocalPages().virtual(await inlinePageFiles(content), {
    owner: contents,
    ownerId,
  });
  virtualLeaseOwners.set(url, ownerId);
  return url;
}

/** Revoke a virtual-page lease in core when its tab ends, reloads, or parks. */
export function revokeInlinePageUrl(url: string): void {
  const ownerId = virtualLeaseOwners.get(url);
  if (!ownerId) return;
  virtualLeaseOwners.delete(url);
  void coreLocalPages()
    .revokeOwner(ownerId)
    .catch(() => undefined);
}

/** The preview URL of one pane file, contained in its root (the cwd, an
 *  outside page's own folder, or a kept version's folder). */
export async function panePreviewUrl(
  target: PaneTarget,
  host: {
    /** Read after the root resolves: the window may change meanwhile. */
    contents(): WebContents | undefined;
    observe(contents: WebContents): void;
    convertDocument(root: string, rel: string): Promise<unknown>;
  }
): Promise<string> {
  // Targets arrive symlink-resolved; so must the root they are relative to.
  const root = await realpath(target.root);
  const rel = relative(root, target.path).split(sep).join('/');
  if (target.kind === 'html') {
    const contents = host.contents();
    if (contents) host.observe(contents);
    // The project scope serves the page's own styles, scripts and media
    // from its root (never above it); the lease dies with the window.
    return coreLocalPages().url(root, rel, { owner: contents, ownerId: contents && windowIdFor(contents) });
  }
  if (target.kind === 'document') {
    const convert = async () =>
      (await host.convertDocument(root, rel)) as {
        path: string;
        mtimeMs: number;
        size: number;
      };
    const converted = await convert();
    // The core's cache evicts by count: a read that finds the PDF gone converts the source again.
    const preview = registerFilePreview(converted.path, `${converted.mtimeMs}:${converted.size}`, {
      regenerate: convert,
    });
    if (!preview) throw new Error(`the converted preview of ${target.target} is unavailable`);
    return preview.url;
  }
  const info = await stat(target.path);
  // Rooted: every request re-resolves the file and refuses it once it no
  // longer lies inside its root.
  const preview = registerFilePreview(target.path, `${info.mtimeMs}:${info.size}`, { root });
  if (!preview) throw new Error(`no in-app preview for ${target.target}`);
  return preview.url;
}
