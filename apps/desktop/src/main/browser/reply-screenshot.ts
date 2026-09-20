/**
 * A screenshot in the reply is bound to the snapshot it was taken with, so
 * coordinates read off the image can be trusted against that snapshot id. A
 * page that changed between the two is refused; a full-page capture is
 * inspection only and binds nothing.
 */
import type { WebContents } from 'electron';

import { persistFrameImage } from '../frame-files';
import type { BrowserCommand, BrowserCommandResult, BrowserSnapshotResultOptions } from './command';
import type { BrowserReplyHost } from './reply';

export type ReplyScreenshotHost = Pick<BrowserReplyHost, 'state' | 'captureScreenshot' | 'bindVisualGrounding'>;

/** Where a screenshot goes: into the reply, or beside the run when the caller
 *  asked to keep pixels out of the conversation. A frame that cannot be
 *  written stays in the reply rather than disappearing. */
export function attachFrame(
  result: BrowserCommandResult,
  command: BrowserCommand,
  capture: { mimeType: string; data: string },
  frameId: string
): BrowserCommandResult {
  if (String(command.image_output || 'inline') === 'file') {
    const stored = persistFrameImage('browser', String(command.session_id || 'browser'), frameId, capture);
    if (stored) {
      result.text += `\n\nFrame written to ${stored.path} (${stored.bytes} bytes).`;
      return result;
    }
  }
  result.image = { mimeType: capture.mimeType, data: capture.data };
  return result;
}

export async function attachScreenshot(
  host: ReplyScreenshotHost,
  guest: WebContents,
  command: BrowserCommand,
  result: BrowserCommandResult,
  options: BrowserSnapshotResultOptions,
  signal?: AbortSignal
): Promise<void> {
  const refSet = host.state.peek(guest)?.refSet;
  if (!refSet) throw new Error('browser screenshot could not bind to the fresh snapshot');
  const capture = await host.captureScreenshot(guest, options.targetIsBackground === true, command, signal);
  if (host.state.peek(guest)?.refSet !== refSet) {
    throw new Error('page changed during screenshot capture; take a fresh snapshot');
  }
  if (capture.fullPage) {
    result.text += `\n\nFull-page screenshot: ${capture.width}x${capture.height} px; inspection-only and not coordinate-bound.`;
  } else {
    host.bindVisualGrounding(guest, refSet, capture);
    result.text += `\n\nVisual screenshot: ${refSet.snapshotId} is ${capture.width}x${capture.height} image px; viewport ${refSet.viewportWidth}x${refSet.viewportHeight} CSS px. Coordinate actions require this snapshotId and use image-pixel coordinates.`;
  }
  attachFrame(result, command, capture, refSet.snapshotId);
}
