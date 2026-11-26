import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { isAgentHomeSessionId } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { isOtherDevice } from '../shared/session-devices';
import type { ToolApprovalDecision } from '../shared/contract';
import {
  ApprovalCard,
  approvalRecordLabel,
  publishHeldSettlements,
  releaseApprovalCardState,
  retainHeldSettlements,
} from './ApprovalCard';
import { BrowserApprovalCard, useBrowserApprovals } from './BrowserApprovalHost';
import { QuestionCard } from './QuestionCard';
import { useAgentChatSession } from './agent-chat-mode';
import { approvalQuestions, buildAnswers, type QuestionDraft } from './question-card-logic';
import type { ComposerIslandFlash } from './ComposerIsland';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { CarriedFacts, carriedFold } from './list-carry';
import { t } from './i18n';
import { approvalInstanceKey } from './renderer-logic.mjs';
import { RETIRED_APPROVAL_MS, type RetiredApproval, useRetiredApproval } from './use-retired-approval';
import { useRelayedQuestion } from './use-relayed-question';
import { useViewerDevice } from './use-viewer-device';

/** A refusal the core did not confirm as a decision: the card clears its resolving state and can be answered again. */
export const UNCONFIRMED = 'unconfirmed';
/** `device`: the device the core says answered the request ('' when it names none). */
type AnsweredElsewhere = { id: string; device: string };

const NO_ITEMS: readonly TranscriptItem[] = [];
/** Whether a transcript's prompts name more than one device: each device's first prompt is noted with its place, so a
 *  list carried on is read from the rows it did not keep. */
export const usesMultipleDevices = carriedFold<TranscriptItem, CarriedFacts<string, number>, boolean>({
  make: () => new CarriedFacts(),
  rewind: (devices, from) => devices.rewind(from),
  read(devices, items, from) {
    for (let index = from; index < items.length; index += 1) {
      const item = items[index];
      if (item?.kind !== 'user' || typeof item.device !== 'string' || !item.device) continue;
      if (!devices.has(item.device)) devices.set(index, item.device, index);
    }
  },
  result: (devices) => devices.size > 1,
});

/** Tool approvals for the session this pane renders: the pending card, the
 *  approvals this device answered itself, and whether the conversation was
 *  used from several devices (only then is a device named). */
type LocalDecidedApproval = RetiredApproval & { sessionId: string; resultBefore: string };

/** The approval this device answered, kept once it left the dock (device ''
 *  names this PC) so the island can say what was decided. It belongs to the
 *  session it was answered in: another chat never shows it. `resultBefore` is
 *  the server's resolved approval at the time of the answer. */
function useLocalDecidedApproval(snapshot: Snapshot, decidedSessionId: string) {
  const [localDecided, setLocalDecided] = useState<LocalDecidedApproval | null>(null);
  const resolved = snapshot.toolApprovalResult;
  const resolvedId = String(resolved?.id ?? '');
  // The latest resolved approval, for an answer whose reply comes back after later snapshots.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  // Retired on the server's update: the resolved state moving on to another
  // approval means this one's trace has been taken (the island shows each
  // trace once, for its own duration, so the entry only has to outlive that).
  useEffect(() => {
    if (!localDecided) return;
    if (localDecided.sessionId !== decidedSessionId) return setLocalDecided(null);
    const own = String(localDecided.approval.id ?? '');
    if (resolvedId && resolvedId !== localDecided.resultBefore && resolvedId !== own) setLocalDecided(null);
  }, [localDecided, decidedSessionId, resolvedId]);
  // Fallback when no later update arrives: the same bound a retired approval
  // from another device is kept for (use-retired-approval.ts).
  useEffect(() => {
    if (!localDecided) return;
    const timer = window.setTimeout(() => setLocalDecided(null), RETIRED_APPROVAL_MS);
    return () => window.clearTimeout(timer);
  }, [localDecided]);
  return { localDecided, setLocalDecided, resolvedRef };
}

export function useConversationApprovals(
  snapshot: Snapshot,
  routeSessionIdRef: RefObject<string>,
  /** `docked`: this view renders the composer dock (a read-only view does
   *  not, so it claims no browser approval and those only mark the session). */
  { docked = true }: { docked?: boolean } = {}
) {
  const decidedLocally = useRef<{ sessionId: string; ids: Set<string> }>({ sessionId: '', ids: new Set() });
  const decidedSessionId = String(snapshot.sessionId || '');
  if (decidedLocally.current.sessionId !== decidedSessionId) {
    decidedLocally.current = { sessionId: decidedSessionId, ids: new Set() };
  } else if (decidedLocally.current.ids.size > 0) {
    const relevant = new Set([String(snapshot.toolApproval?.id ?? ''), String(snapshot.toolApprovalResult?.id ?? '')]);
    for (const id of decidedLocally.current.ids) if (!relevant.has(id)) decidedLocally.current.ids.delete(id);
  }
  const otherDeviceApproval = useRetiredApproval(snapshot, decidedLocally.current.ids);
  const { localDecided, setLocalDecided, resolvedRef } = useLocalDecidedApproval(snapshot, decidedSessionId);
  const retiredApproval =
    otherDeviceApproval ??
    (localDecided &&
    localDecided.sessionId === decidedSessionId &&
    String(snapshot.toolApproval?.id ?? '') !== String(localDecided.approval.id ?? '')
      ? localDecided
      : null);
  // The approval this device tried to answer after another device already had: it belongs to the chat it was refused
  // in, and ends once the snapshot no longer holds that request (the island keeps a shown flash for its own time).
  const [refusedElsewhere, setRefusedElsewhere] = useState<(AnsweredElsewhere & { sessionId: string }) | null>(null);
  const pendingApprovalId = String(snapshot.toolApproval?.id ?? '');
  useEffect(() => {
    if (!refusedElsewhere) return;
    if (refusedElsewhere.sessionId !== decidedSessionId || refusedElsewhere.id !== pendingApprovalId) {
      setRefusedElsewhere(null);
    }
  }, [refusedElsewhere, decidedSessionId, pendingApprovalId]);
  const answeredElsewhere = refusedElsewhere?.sessionId === decidedSessionId ? refusedElsewhere : null;
  const multiDevice = useMemo(() => usesMultipleDevices(snapshot.items ?? NO_ITEMS), [snapshot.items]);
  const viewerDevice = useViewerDevice();
  // Agent mode (agent-chat-mode.ts) narrows both cards to the bubble column together.
  const agentMode = useAgentChatSession(decidedSessionId);
  // Held requests in an agent's home thread fold away once their settling row arrives.
  useEffect(() => {
    if (!isAgentHomeSessionId(decidedSessionId)) return;
    return retainHeldSettlements(decidedSessionId);
  }, [decidedSessionId]);
  useLayoutEffect(() => {
    if (isAgentHomeSessionId(decidedSessionId)) publishHeldSettlements(decidedSessionId, snapshot.items ?? NO_ITEMS);
  }, [decidedSessionId, snapshot.items]);
  const resolvedApprovalId = String(snapshot.toolApprovalResult?.id ?? '');
  useEffect(() => {
    if (resolvedApprovalId && resolvedApprovalId !== pendingApprovalId) {
      releaseApprovalCardState(resolvedApprovalId);
    }
  }, [resolvedApprovalId, pendingApprovalId]);

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
        releaseApprovalCardState(approvalId);
        answeredHere.current = approvalId;
        if (sameSession && pendingApproval.kind !== 'question') {
          setLocalDecided({
            sessionId: decidedSessionId,
            approval: pendingApproval,
            resultBefore: String(resolvedRef.current?.id ?? ''),
            outcome: { approved: decision.approved === true, device: '' },
          });
        }
      }
      if (accepted === false) {
        // "Another device" is claimed only when the core published this request as decided. A refusal without that (this
        // connection does not hold the request, or the pane's state lags the core's) is not evidence of another device: the
        // pane reads its state again instead, and the card stays answerable until the refreshed state says otherwise.
        const result = resolvedRef.current;
        if (result && String(result.id ?? '') === approvalId) {
          setRefusedElsewhere({
            sessionId: decidedSessionId,
            id: approvalId,
            device: result.device,
          });
        } else {
          // Reproject from the client's current pending list (not the cached frame). Never awaited: the card is answerable
          // again at once, whether or not a read completes.
          try {
            void Promise.resolve(host.resyncSessionState?.(sessionId, { fresh: true })).catch(() => false);
          } catch {
            // A closed bridge leaves the card retryable.
          }
          return UNCONFIRMED;
        }
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
  const { answerHint, relay, wrapSubmit } = useRelayedQuestion(snapshot, Boolean(pendingApproval), routeSessionIdRef, {
    dismiss: dismissQuestion,
    answer: answerQuestion,
  });
  if (!approvalDock && browserPrompts.length > 0) {
    approvalDock = (
      <BrowserApprovalCard
        key={browserPrompts[0].id}
        prompt={browserPrompts[0]}
        queueLabel={browserPrompts.length > 1 ? `1/${browserPrompts.length}` : undefined}
      />
    );
  }
  return {
    approvalDock,
    questionCard,
    dismissQuestion,
    answerQuestion,
    /** The composer's placeholder while a message would answer a question. */
    answerHint,
    /** The handed-off session's question the composer answers, if any. */
    relay,
    wrapSubmit,
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
    // Named like a retired approval: whenever another device than this one answered (prompt rows never say who did).
    return {
      key: `elsewhere:${answeredElsewhere.id}`,
      text: isOtherDevice(answeredElsewhere.device, viewerDevice)
        ? `${t('Resolved on another device')} · ${t('from {{device}}', { device: answeredElsewhere.device })}`
        : t('Resolved on another device'),
    };
  }
  return null;
}
