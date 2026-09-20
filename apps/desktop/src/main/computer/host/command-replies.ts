/**
 * The replies a command can end in without reaching the backend: a pixel
 * frame honouring image_output, a pixel_unavailable verdict, and the
 * recapture-required reply that refreshes the observation a stale target
 * invalidated.
 */
import { persistFrameImage } from '../../frame-files';
import {
  buildRecaptureRequiredPayload,
  isFreshRecaptureObservation,
  recaptureRequirementCode,
} from '../observation/recapture';
import type { CaptureAttempt } from '../shared/capture-attempts';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import type { CommandRouterHost } from './command-router';

export type CommandRepliesHost = Pick<
  CommandRouterHost,
  | 'sessionIdFor'
  | 'invalidateActionTargets'
  | 'resolveRecaptureWindowTarget'
  | 'freshObservedWindowScope'
  | 'captureAfterAction'
>;

export function pixelUnavailableReply(
  action: string,
  pixelUnavailable: unknown,
  captureAttempts?: CaptureAttempt[]
): ComputerCommandResult {
  return {
    text: JSON.stringify({
      ok: false,
      action,
      code: 'pixel_unavailable',
      pixel_status: 'unavailable',
      pixel_unavailable: pixelUnavailable,
      ...(captureAttempts?.length ? { capture_attempts: captureAttempts } : {}),
      escalation: 'recapture',
    }),
  };
}

export function createCommandReplies(host: CommandRepliesHost) {
  const {
    sessionIdFor,
    invalidateActionTargets,
    resolveRecaptureWindowTarget,
    freshObservedWindowScope,
    captureAfterAction,
  } = host;

  /** Honour image_output for the pixel-only replies that carry no capture
   *  payload. A frame that cannot be written stays in the reply. */
  function frameReply(
    command: ComputerCommand,
    description: string,
    image: { mimeType: string; data: string },
    frameId: string,
    captureAttempts?: CaptureAttempt[]
  ): ComputerCommandResult {
    if (String(command.image_output || 'inline') !== 'file') return { text: description, image, captureAttempts };
    const stored = persistFrameImage('computer', sessionIdFor(command), frameId, image);
    if (!stored) return { text: description, image, captureAttempts };
    return {
      captureAttempts,
      text: `${description}; frame written to ${stored.path} (${stored.bytes} bytes)`,
    };
  }

  async function recaptureRequiredReply(
    command: ComputerCommand,
    error: unknown
  ): Promise<ComputerCommandResult | null> {
    if (!recaptureRequirementCode(error)) return null;
    invalidateActionTargets(command);
    const recaptureTarget = await resolveRecaptureWindowTarget(
      command,
      freshObservedWindowScope(command)?.primaryWindowId || ''
    );
    const windowId = recaptureTarget.windowId;
    const capture = windowId
      ? await captureAfterAction(command, windowId, 0, 0)
      : {
          metadata: {
            ok: false,
            action: 'capture',
            error: recaptureTarget.error || 'exact target window is unavailable for recapture',
          },
        };
    const recaptureSucceeded = isFreshRecaptureObservation(capture.metadata, windowId);
    if (!recaptureSucceeded) invalidateActionTargets(command);
    const payload = buildRecaptureRequiredPayload(
      String(command.action || 'computer'),
      error,
      capture.metadata,
      windowId
    );
    if (!payload) return null;
    return {
      text: JSON.stringify(payload),
      ...(recaptureSucceeded && 'image' in capture && capture.image ? { image: capture.image } : {}),
    };
  }

  return { frameReply, recaptureRequiredReply };
}

export type CommandReplies = ReturnType<typeof createCommandReplies>;
