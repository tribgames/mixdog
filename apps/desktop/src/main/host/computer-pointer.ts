/**
 * `host/computer/pointerFeedback`: a Computer Use helper's pointer progress, which the overlay draws as the agent's
 * arrow (`computer/host/pointer-cursor.ts` `publishPointerProgress`, through the presence mirror once it is bound). The
 * core has already matched each event to a helper line it understands and a phase the overlay paints (`worker-pool.ts` `reportPointerProgress`); the events
 * are fed to the same consumer the PowerShell worker fed, in the helper's order, and the request is answered `null`.
 */
import type { HostComputerPointerFeedbackParams } from '../../../../../packages/protocol/src/index.ts';
import { publishPointerProgress } from '../computer/host/pointer-cursor';
import { recordCursorDiagnostic } from '../computer/overlay/cursor-diagnostics';
import { HOST_INVALID_PARAMS, HostRpcError, type HostConnection, objectParams } from './connection';

export const HOST_COMPUTER_POINTER_FEEDBACK = 'host/computer/pointerFeedback';

type PointerProgressListener = typeof publishPointerProgress;

export function registerComputerPointer(
  connection: HostConnection,
  publish: PointerProgressListener = publishPointerProgress
): void {
  connection.handleRequest(HOST_COMPUTER_POINTER_FEEDBACK, async (params): Promise<null> => {
    const { sessionId, events } = objectParams<HostComputerPointerFeedbackParams>(params, HOST_COMPUTER_POINTER_FEEDBACK);
    if (typeof sessionId !== 'string' || !Array.isArray(events)) {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_COMPUTER_POINTER_FEEDBACK} needs sessionId and events.`);
    }
    for (const event of events) {
      recordCursorDiagnostic('received');
      const { x, y, held, phase, mode, windowId } = (event ?? {}) as Record<string, unknown>;
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        typeof held !== 'boolean' ||
        typeof phase !== 'string' ||
        (mode !== 'foreground' && mode !== 'background')
      ) {
        recordCursorDiagnostic('discarded_event');
        continue;
      }
      recordCursorDiagnostic('validated');
      try {
        publish(sessionId, x, y, held, mode, phase, typeof windowId === 'string' ? windowId : undefined);
      } catch {
        recordCursorDiagnostic('event_handler_failed');
      }
    }
    return null;
  });
}
