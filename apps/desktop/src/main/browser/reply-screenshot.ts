import type { WebContents } from 'electron';

import { persistBrowserScreenshot } from '../frame-files';
import type { BrowserCommand, BrowserCommandResult, BrowserSnapshotResultOptions } from './host-types';
import type { BrowserReplyHost } from './reply';
import { type EncodedBrowserScreenshot, scaledCaptureNote, screenshotWireImage } from './screenshot-image';

type ReplyScreenshotHost = Pick<BrowserReplyHost, 'state' | 'captureScreenshot' | 'bindVisualGrounding'>;

/** Where a screenshot goes: into the reply, or beside the run when the caller
 *  asked to keep pixels out of the conversation. A frame that cannot be
 *  written stays in the reply rather than disappearing. */
export async function attachFrame(
  result: BrowserCommandResult,
  command: BrowserCommand,
  capture: EncodedBrowserScreenshot,
  frameId: string
): Promise<BrowserCommandResult> {
  if (String(command.image_output || 'inline') === 'file') {
    const stored = await persistBrowserScreenshot(String(command.session_id || 'browser'), frameId, capture);
    if (stored) {
      result.text += `\n\nFrame written to ${stored.path} (${stored.bytes} bytes).`;
      return result;
    }
  }
  result.image = screenshotWireImage(capture);
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
    result.text += `\n\nFull-page screenshot: ${capture.width}x${capture.height} px; inspection-only and not coordinate-bound.${scaledCaptureNote(capture)}`;
  } else {
    host.bindVisualGrounding(guest, refSet, capture);
    result.text += `\n\nVisual screenshot: ${refSet.snapshotId} is ${capture.width}x${capture.height} image px; viewport ${refSet.viewportWidth}x${refSet.viewportHeight} CSS px. Coordinate actions require this snapshotId and use image-pixel coordinates.`;
  }
  await attachFrame(result, command, capture, refSet.snapshotId);
}
