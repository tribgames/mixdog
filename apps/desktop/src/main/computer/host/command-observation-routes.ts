/**
 * Commands answered by observing rather than acting: state verification, app
 * and history listings, and the capture, screenshot and zoom replies. A pixel
 * capture that produced no frame becomes a pixel_unavailable verdict here;
 * anything else falls through to input delivery.
 */
import { readComputerRunRecords } from '../session/run-log';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { pixelUnavailableReply, type CommandReplies } from './command-replies';
import type { CommandRouterHost } from './command-router';

/** Enough history to review a run without turning one read into a transcript. */
const MAX_HISTORY_RECORDS = 60;

export type ObservationRouteHost = Pick<
  CommandRouterHost,
  | 'sessionIdFor'
  | 'verifyWindowState'
  | 'listComputerApps'
  | 'captureComputer'
  | 'captureScreenshot'
  | 'captureZoom'
  | 'rememberObservedWindowScope'
>;

type FrameReplies = Pick<CommandReplies, 'frameReply'>;

async function screenshotReply(
  host: ObservationRouteHost,
  replies: FrameReplies,
  command: ComputerCommand
): Promise<ComputerCommandResult> {
  const screenshot = await host.captureScreenshot(command);
  if (screenshot.pixelUnavailable) {
    return pixelUnavailableReply('screenshot', screenshot.pixelUnavailable, screenshot.captureAttempts);
  }
  if (!screenshot.image || !screenshot.frame || !screenshot.frameId) {
    throw new Error('screenshot capture returned incomplete state');
  }
  if (screenshot.frame.windowId) {
    host.rememberObservedWindowScope(
      command,
      screenshot.frame.windowId,
      screenshot.frame.relatedWindowIds || [screenshot.frame.windowId]
    );
  }
  return replies.frameReply(
    command,
    screenshot.description,
    screenshot.image,
    screenshot.frameId,
    screenshot.captureAttempts
  );
}

async function zoomReply(
  host: ObservationRouteHost,
  replies: FrameReplies,
  command: ComputerCommand
): Promise<ComputerCommandResult> {
  const zoom = await host.captureZoom(command);
  if (!zoom) throw new Error('zoom capture failed');
  if (zoom.pixelUnavailable) {
    return pixelUnavailableReply('zoom', zoom.pixelUnavailable, zoom.captureAttempts);
  }
  if (!zoom.image || !zoom.frameId) throw new Error('zoom capture returned incomplete state');
  return replies.frameReply(command, zoom.description, zoom.image, zoom.frameId, zoom.captureAttempts);
}

/** The reply for an observation action, or null when the action is an input. */
export async function observationRoute(
  host: ObservationRouteHost,
  replies: FrameReplies,
  command: ComputerCommand,
  action: string
): Promise<ComputerCommandResult | null> {
  switch (action) {
    case 'verify':
      return await host.verifyWindowState(command);
    case 'list_apps':
      return await host.listComputerApps(command);
    case 'list_history': {
      const requested = Number(command.limit);
      const limit =
        Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_HISTORY_RECORDS) : MAX_HISTORY_RECORDS;
      const records = readComputerRunRecords(host.sessionIdFor(command), limit);
      return { text: JSON.stringify({ history: records, returned: records.length }) };
    }
    case 'capture': {
      const capture = await host.captureComputer(command);
      return {
        text: JSON.stringify(capture.payload),
        ...(capture.image ? { image: capture.image } : {}),
      };
    }
    case 'screenshot':
      return await screenshotReply(host, replies, command);
    case 'zoom':
      return await zoomReply(host, replies, command);
    default:
      return null;
  }
}
