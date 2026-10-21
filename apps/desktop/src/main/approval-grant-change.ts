import type { ToolApprovalDecision } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';

/** Answers a pending approval on the host and, when the answer stored a
 *  standing grant ("always allow", `remember` agent/always), broadcasts the
 *  `permissions` settings-changed scope so open "Always allowed" lists re-read.
 *  The one path for this PC's answer and a paired phone's answer. */
export async function resolveToolApprovalAnnouncingGrant(
  host: Pick<DesktopService, 'resolveToolApprovalForSession'>,
  invokeDesktopOperation: (name: string, args: unknown[]) => Promise<unknown>,
  sessionId: string,
  id: string,
  decision: ToolApprovalDecision
): Promise<boolean> {
  const accepted = await host.resolveToolApprovalForSession(sessionId, id, decision);
  if (accepted === true && (decision.remember === 'agent' || decision.remember === 'always')) {
    void invokeDesktopOperation('notifySettingsChanged', ['permissions']).catch(() => {});
  }
  return accepted;
}
