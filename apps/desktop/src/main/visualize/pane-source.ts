/**
 * The source view's read of a pane file: contained in its root, capped.
 */
import { open as openFileHandle, realpath } from 'node:fs/promises';

import { MAX_VISUALIZE_SOURCE_BYTES, type VisualizePaneText } from '../../shared/visualize';
import type { FileTarget } from './tab-state';
import { insidePath } from './targets';

/** The text of `target` as read now, when it still resolves inside its root. */
export async function readPaneSource(target: FileTarget): Promise<VisualizePaneText> {
  // Re-resolved on every read: a link swapped in must not leave the root.
  const [file, realRoot] = await Promise.all([realpath(target.path), realpath(target.root)]);
  if (!insidePath(realRoot, file)) throw new Error(`target is outside its folder: ${target.target}`);
  const handle = await openFileHandle(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, MAX_VISUALIZE_SOURCE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > MAX_VISUALIZE_SOURCE_BYTES };
  } finally {
    await handle.close();
  }
}
