import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { isOtherDevice, sessionUsesMultipleDevices } from '../shared/session-devices';
import type { ToolApprovalDecision } from '../shared/contract';
import { ApprovalCard } from './ApprovalCard';
import { QuestionCard } from './QuestionCard';
import { approvalQuestions } from './question-card-logic';
import type { ComposerIslandFlash } from './ComposerIsland';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { approvalInstanceKey } from './renderer-logic.mjs';
import { type RetiredApproval, useRetiredApproval } from './use-retired-approval';
import { useViewerDevice } from './use-viewer-device';

type AnsweredElsewhere = { id: string; device: string };

/** Tool approvals for the session this pane renders: the pending card, the
 *  approvals this device answered itself, and whether the conversation was
 *  used from several devices (only then is a device named). */
export function useConversationApprovals(snapshot: Snapshot, routeSessionIdRef: RefObject<string>) {
  // Bounded to this session, and to the ids the retired-approval check can
  // still consult: the pending approval and the last published result.
  const decidedLocally = useRef<{ sessionId: string; ids: Set<string> }>({ sessionId: '', ids: new Set() });
  const decidedSessionId = String(snapshot.sessionId || '');
  if (decidedLocally.current.sessionId !== decidedSessionId) {
    decidedLocally.current = { sessionId: decidedSessionId, ids: new Set() };
  } else if (decidedLocally.current.ids.size > 0) {
    const relevant = new Set([String(snapshot.toolApproval?.id ?? ''), String(snapshot.toolApprovalResult?.id ?? '')]);
    for (const id of decidedLocally.current.ids) if (!relevant.has(id)) decidedLocally.current.ids.delete(id);
  }
  const retiredApproval = useRetiredApproval(snapshot, decidedLocally.current.ids);
  // The approval this device tried to answer after another device already had.
  const [answeredElsewhere, setAnsweredElsewhere] = useState<AnsweredElsewhere | null>(null);
  const multiDevice = useMemo(() => sessionUsesMultipleDevices(snapshot.items), [snapshot.items]);
  const viewerDevice = useViewerDevice();

  // A pending approval grows the island into its card. An answer from another
  // device leaves no card: the island flashes it instead.
  // A pending ask_user question renders in the transcript instead.
  let approvalCard: ReactNode = null;
  let questionCard: ReactNode = null;
  // Sending a message while a question waits closes the question first.
  let dismissQuestion: (() => Promise<unknown>) | null = null;
  const pendingApproval = snapshot.toolApproval;
  if (pendingApproval && String(pendingApproval.id ?? '') !== answeredElsewhere?.id) {
    const resolveDecision = async (decision: ToolApprovalDecision) => {
      const host = window.mixdogDesktop;
      const sessionId = routeSessionIdRef.current;
      const approvalId = String(pendingApproval.id ?? '');
      if (!sessionId) return false;
      const accepted = await host.resolveToolApprovalForSession(sessionId, approvalId, decision);
      if (accepted === true && decidedLocally.current.sessionId === decidedSessionId) {
        decidedLocally.current.ids.add(approvalId);
      }
      if (accepted === false) {
        const result = snapshot.toolApprovalResult;
        setAnsweredElsewhere({
          id: approvalId,
          device:
            multiDevice && result?.id === approvalId && isOtherDevice(result.device, viewerDevice)
              ? result.device
              : '',
        });
      }
      return accepted;
    };
    const questions = pendingApproval.kind === 'question' ? approvalQuestions(pendingApproval.args) : null;
    if (questions) {
      questionCard = (
        <QuestionCard key={approvalInstanceKey(pendingApproval.id)} questions={questions} resolve={resolveDecision} />
      );
      dismissQuestion = () => resolveDecision({ approved: false, reason: 'dismissed by user' });
    } else {
      approvalCard = (
        <ApprovalCard
          key={approvalInstanceKey(pendingApproval.id)}
          approval={pendingApproval}
          resolve={(approved) => resolveDecision({ approved })}
        />
      );
    }
  }
  return { approvalCard, questionCard, dismissQuestion, retiredApproval, answeredElsewhere, multiDevice, viewerDevice };
}

/** The island's one-shot notice: an approval settled on another device wins
 *  over this device's own refused answer. */
export function conversationIslandFlash(
  retiredApproval: RetiredApproval | null,
  answeredElsewhere: AnsweredElsewhere | null,
  viewerDevice: string | null
): ComposerIslandFlash | null {
  if (retiredApproval && isOtherDevice(retiredApproval.outcome.device, viewerDevice)) {
    const { approval, outcome } = retiredApproval;
    return {
      key: `retired:${approvalInstanceKey(approval.id)}`,
      text: outcome.approved
        ? t('Allowed from {{device}}', { device: outcome.device })
        : t('Denied from {{device}}', { device: outcome.device }),
    };
  }
  if (answeredElsewhere) {
    return {
      key: `elsewhere:${answeredElsewhere.id}`,
      text: answeredElsewhere.device
        ? `${t('Resolved on another device')} · ${t('from {{device}}', { device: answeredElsewhere.device })}`
        : t('Resolved on another device'),
    };
  }
  return null;
}
