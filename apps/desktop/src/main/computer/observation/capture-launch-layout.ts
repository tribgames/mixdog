import { sleep } from '../shared/common';
import type { ComputerCommand } from '../shared/types';
import type { CaptureEngineHost } from './capture';

/** A launched window is listed before its content finishes laying out: Paint
 *  shows 89 accessible elements half a second in and 114 once settled. */
const LAUNCH_LAYOUT_POLL_MS = 200;
const LAUNCH_LAYOUT_BUDGET_MS = 2_000;

export type LaunchLayoutHost = Pick<CaptureEngineHost, 'assertExecutionNotAborted' | 'sessionIdFor'> &
  Partial<Pick<CaptureEngineHost, 'callPowerShell'>>;

/** The window's read-only accessible roles and names, or null when unreadable. */
async function layoutFingerprint(
  host: LaunchLayoutHost,
  command: ComputerCommand,
  windowId: string
): Promise<string | null> {
  try {
    const reply = await host.callPowerShell!({
      action: 'window_predicates',
      window_id: windowId,
      session_id: host.sessionIdFor(command),
      max_elements: 400,
      read_only: true,
    });
    const elements = reply.ok ? reply.result?.elements : undefined;
    if (!Array.isArray(elements)) return null;
    return JSON.stringify(elements.map((element: { role?: unknown; name?: unknown }) => [element.role, element.name]));
  } catch {
    return null;
  }
}

/** Wait, within a bound, until two reads of the launched window agree. The
 *  reads never touch the session's refs, so the capture that follows is the
 *  only observation the caller receives. */
export async function awaitSettledLayout(
  host: LaunchLayoutHost,
  command: ComputerCommand,
  windowId: string
): Promise<void> {
  if (!host.callPowerShell) return;
  const deadline = performance.now() + LAUNCH_LAYOUT_BUDGET_MS;
  let previous = await layoutFingerprint(host, command, windowId);
  while (previous !== null && performance.now() < deadline) {
    await sleep(LAUNCH_LAYOUT_POLL_MS);
    host.assertExecutionNotAborted();
    const next = await layoutFingerprint(host, command, windowId);
    if (next === null || next === previous) return;
    previous = next;
  }
}
