/**
 * The URL a visualize pane loads: a local page lease for HTML and inline
 * pages, a converted preview for Office files, the media scheme otherwise.
 */
import { realpath, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { WebContents } from 'electron';

import type { VisualizeInlineContent } from '../../shared/visualize';
import { registerFilePreview } from '../file-preview';
import { localPageUrl, localVirtualPageUrl } from '../local-page-server';
import { inlinePageFiles } from './inline-page';
import type { VisualizeServiceDeps } from './service';

type PaneTarget = Parameters<VisualizeServiceDeps['preparePane']>[0];

/** Pages of this window need no authorization step beyond owning the lease. */
const authorizeOwned = async () => {};

/** A chart / html sketch as a virtual page: its own lease (opaque origin,
 *  scripts on), the same problem capture and network guard as file pages. */
export async function inlinePageUrl(
  content: VisualizeInlineContent,
  contents: WebContents | undefined,
  observe: (contents: WebContents) => void
): Promise<string> {
  if (contents) observe(contents);
  return localVirtualPageUrl(await inlinePageFiles(content), { owner: contents, authorize: authorizeOwned });
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
    return localPageUrl(root, rel, { scope: 'project', owner: contents, authorize: authorizeOwned });
  }
  if (target.kind === 'document') {
    const converted = (await host.convertDocument(root, rel)) as {
      path: string;
      mtimeMs: number;
      size: number;
    };
    const preview = registerFilePreview(converted.path, `${converted.mtimeMs}:${converted.size}`);
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
