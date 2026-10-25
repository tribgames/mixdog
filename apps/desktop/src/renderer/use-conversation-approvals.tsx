import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { isAgentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { isOtherDevice, sessionUsesMultipleDevices } from '../shared/session-devices';
import type { ToolApprovalDecision } from '../shared/contract';
import { ApprovalCard, approvalRecordLabel, publishHeldSettlements } from './ApprovalCard';
import { BrowserApprovalCard, useBrowserApprovals } from './BrowserApprovalHost';
import { publishDockedApproval } from './approval-prompt';
import { QuestionCard } from './QuestionCard';
import { useAgentChatSession } from './agent-chat-mode';
import { approvalQuestions, buildAnswers, type QuestionDraft } from './question-card-logic';
import type { ComposerIslandFlash } from './ComposerIsland';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { approvalInstanceKey } from './renderer-logic.mjs';
import { type RetiredApproval, useRetiredApproval } from './use-retired-approval';
import { useViewerDevice } from './use-viewer-device';

type AnsweredElsewhere = { id: string; device: string };

const LOCAL_DECIDED_MS = 6_000;

/** Tool approvals for the session this pane renders: the pending card, the
 *  approvals this device answered itself, and whether the conversation was
 *  used from several devices (only then is a device named). */
export function useConversationApprovals(
  snapshot: Snapshot,
  routeSessionIdRef: RefObject<string>,
  /** `docked`: this view renders the composer dock (a read-only view does
   *  not, so it claims no browser approval and those only mark the session). */
  { docked = true }: { docked?: boolean } = {}
) {
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
  const otherDeviceApproval = useRetiredApproval(snapshot, decidedLocally.current.ids);
  // The approval this device answered, kept briefly once it left the dock
  // (device '' names this PC) so the island can say what was decided.
  // It belongs to the session it was answered in: another chat never shows it.
  const [localDecided, setLocalDecided] = useState<(RetiredApproval & { sessionId: string }) | null>(null);
  useEffect(() => {
    if (!localDecided) return;
    if (localDecided.sessionId !== decidedSessionId) return setLocalDecided(null);
    const timer = window.setTimeout(() => setLocalDecided(null), LOCAL_DECIDED_MS);
    return () => window.clearTimeout(timer);
  }, [localDecided, decidedSessionId]);
  const retiredApproval =
    otherDeviceApproval ??
    (localDecided &&
    localDecided.sessionId === decidedSessionId &&
    String(snapshot.toolApproval?.id ?? '') !== String(localDecided.approval.id ?? '')
      ? localDecided
      : null);
  // The approval this device tried to answer after another device already had.
  const [answeredElsewhere, setAnsweredElsewhere] = useState<AnsweredElsewhere | null>(null);
  const multiDevice = useMemo(() => sessionUsesMultipleDevices(snapshot.items), [snapshot.items]);
  const viewerDevice = useViewerDevice();
  // Agent mode (agent-chat-mode.ts) narrows both cards to the bubble column together.
  const agentMode = useAgentChatSession(decidedSessionId);
  // Held requests in an agent's home thread fold away once their settling row arrives.
  useLayoutEffect(() => {
    if (isAgentHomeSessionId(decidedSessionId)) publishHeldSettlements(decidedSessionId, snapshot.items ?? []);
  }, [decidedSessionId, snapshot.items]);

  // A pending ask_user question renders in the transcript, where the turn
  // waits on it; a pending approval (the session's own, then its browser
  // approvals) docks above the composer. An approval answered on another
  // device leaves the dock and stays in the transcript as one line saying who
  // answered; a question's answer flashes in the island.
  const browserPrompts = useBrowserApprovals(docked ? decidedSessionId : '');
  let approvalDock: ReactNode = null;
  let questionCard: ReactNode = null;
  // Sending a message while a question waits closes the question first.
  let dismissQuestion: (() => Promise<unknown>) | null = null;
  let answerQuestion: ((reply: string) => Promise<unknown>) | null = null;
  // The pending question card's current drafts, kept by the card.
  const questionDrafts = useRef<QuestionDraft[]>([]);
  const pendingApproval = snapshot.toolApproval;
  // The drafts belong to one approval: a new one starts empty.
  const draftsApprovalId = useRef('');
  if (draftsApprovalId.current !== String(pendingApproval?.id ?? '')) {
    draftsApprovalId.current = String(pendingApproval?.id ?? '');
    questionDrafts.current = [];
  }
  // The approval id this device's accepted answer settled, held only while
  // that same pending instance stays in the snapshot: a render without it
  // (gone, or another id) ends the hold, so a reissued id can be answered.
  const answeredHere = useRef('');
  if (answeredHere.current !== String(pendingApproval?.id ?? '')) answeredHere.current = '';
  if (pendingApproval && String(pendingApproval.id ?? '') !== answeredElsewhere?.id) {
    const resolveDecision = async (decision: ToolApprovalDecision) => {
      const host = window.mixdogDesktop;
      const sessionId = routeSessionIdRef.current;
      const approvalId = String(pendingApproval.id ?? '');
      if (!sessionId) return false;
      const accepted = await host.resolveToolApprovalForSession(sessionId, approvalId, decision);
      // Only while this pane still shows the session it was answered in.
      const sameSession = decidedLocally.current.sessionId === decidedSessionId;
      if (accepted === true && sameSession) decidedLocally.current.ids.add(approvalId);
      if (accepted === true) {
        answeredHere.current = approvalId;
        if (sameSession && pendingApproval.kind !== 'question') {
          setLocalDecided({
            sessionId: decidedSessionId,
            approval: pendingApproval,
            outcome: { approved: decision.approved === true, device: '' },
          });
        }
      }
      if (accepted === false) {
        const result = snapshot.toolApprovalResult;
        setAnsweredElsewhere({
          id: approvalId,
          device:
            multiDevice && result?.id === approvalId && isOtherDevice(result.device, viewerDevice) ? result.device : '',
        });
      }
      return accepted;
    };
    const questions = pendingApproval.kind === 'question' ? approvalQuestions(pendingApproval.args) : null;
    if (questions && answeredHere.current && answeredHere.current === String(pendingApproval.id ?? '')) {
      // This device's answer was accepted; the snapshot has not dropped the
      // approval yet. No card (a remount would show it enabled again), no
      // second answer, and the picks are spent.
      questionDrafts.current = [];
    } else if (questions) {
      questionCard = (
        <QuestionCard
          key={approvalInstanceKey(pendingApproval.id)}
          questions={questions}
          resolve={resolveDecision}
          draftsRef={questionDrafts}
          agentMode={agentMode}
        />
      );
      dismissQuestion = () => resolveDecision({ approved: false, reason: 'dismissed by user' });
      // A composer message answers the question together with the card's picks.
      answerQuestion = (reply) =>
        resolveDecision({
          approved: true,
          answers: buildAnswers(questions, questionDrafts.current),
          reply,
        });
    } else {
      // Every request waiting for this dock: the shown one, those queued
      // behind it (this chat's own, and copies of the sessions it delegated or
      // handed work to), and the browser's.
      const waiting = 1 + (Number(snapshot.toolApprovalsWaiting) || 0) + browserPrompts.length;
      // Another session's request counts even alone, so the next one reads "1/1".
      const forOther =
        Boolean(pendingApproval.surfaceSessionId) && String(pendingApproval.sessionId || '') !== decidedSessionId;
      approvalDock = (
        <ApprovalCard
          key={approvalInstanceKey(pendingApproval.id)}
          approval={pendingApproval}
          resolve={resolveDecision}
          agentMode={agentMode}
          queue={waiting > 1 || forOther ? `1/${waiting}` : undefined}
          hostSessionId={decidedSessionId}
        />
      );
    }
  }
  if (!approvalDock && browserPrompts.length > 0) {
    approvalDock = (
      <BrowserApprovalCard
        key={browserPrompts[0].id}
        prompt={browserPrompts[0]}
        queueLabel={browserPrompts.length > 1 ? `1/${browserPrompts.length}` : undefined}
      />
    );
  }
  // A copied request names the session that asks; its waiting line yields to the card.
  const dockedAsking =
    (pendingApproval && pendingApproval.kind !== 'question' ? String(pendingApproval.sessionId || '') : '') ||
    (browserPrompts[0]?.sessionId ?? '');
  useLayoutEffect(() => {
    if (!decidedSessionId) return;
    publishDockedApproval(decidedSessionId, dockedAsking === decidedSessionId ? '' : dockedAsking);
    return () => publishDockedApproval(decidedSessionId, '');
  }, [decidedSessionId, dockedAsking]);
  return {
    approvalDock,
    questionCard,
    dismissQuestion,
    answerQuestion,
    retiredApproval,
    answeredElsewhere,
    multiDevice,
    viewerDevice,
  };
}

function retiredOutcomeIcon(outcome: { expired?: boolean; approved?: boolean }) {
  if (outcome.expired) return 'clock';
  return outcome.approved ? 'check' : 'close-small';
}

/** The island's one-shot notice: an approval settled on another device wins
 *  over this device's own refused answer. */
export function conversationIslandFlash(
  retiredApproval: RetiredApproval | null,
  answeredElsewhere: AnsweredElsewhere | null,
  viewerDevice: string | null
): ComposerIslandFlash | null {
  // Answered on another device: the docked card leaves and this one line
  // says what was decided and where ("Send an email · Allowed from DESKTOP-7").
  // Answered on this PC: the same line without a device ("Run a command · Allowed").
  // A question's answer or timeout leaves no trace here (its card is in the transcript).
  if (
    retiredApproval &&
    retiredApproval.approval.kind !== 'question' &&
    (!retiredApproval.outcome.device || isOtherDevice(retiredApproval.outcome.device, viewerDevice))
  ) {
    const { approval, outcome } = retiredApproval;
    const named = Boolean(outcome.device);
    let result: string;
    if (outcome.expired) {
      result = t('Expired');
    } else if (named) {
      result = outcome.approved
        ? t('Allowed from {{device}}', { device: outcome.device })
        : t('Denied from {{device}}', { device: outcome.device });
    } else {
      result = outcome.approved ? t('Allowed') : t('Denied');
    }
    return {
      key: `retired:${approvalInstanceKey(approval.id)}`,
      text: `${approvalRecordLabel(approval)} · ${result}`,
      icon: retiredOutcomeIcon(outcome),
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
