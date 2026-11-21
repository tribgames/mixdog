import { useCallback, useRef, type RefObject } from 'react';
import type { DesktopPromptContent, DesktopSubmitOptions, ToolApprovalDecision } from '../shared/contract';
import { useHandoffTarget } from './agent-task-line';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { approvalQuestions, buildAnswers, questionAwareSubmit, type QuestionDraft } from './question-card-logic';

type ComposerSubmit<R> = (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<R>;

/** A question a handed-off session asks, answered from this chat's composer. */
export function useRelayedQuestion(
  snapshot: Snapshot,
  hasOwnApproval: boolean,
  routeSessionIdRef: RefObject<string>,
  own: { dismiss: (() => Promise<unknown>) | null; answer: ((reply: string) => Promise<unknown>) | null }
) {
  const relayPending = (snapshot.handoffQuestions ?? []).filter((question) => typeof question.record !== 'string');
  const relayQuestion = hasOwnApproval ? undefined : relayPending[0];
  const relayId = String(relayQuestion?.id ?? '');
  const relayDrafts = useRef<QuestionDraft[]>([]);
  const relayDraftsId = useRef('');
  if (relayDraftsId.current !== relayId) {
    relayDraftsId.current = relayId;
    relayDrafts.current = [];
  }
  const relayHandoff = (relayQuestion?.handoff ?? {}) as { title?: unknown; agentId?: unknown };
  const relayName = useHandoffTarget(
    String(relayQuestion?.sessionId || ''),
    String(relayHandoff.agentId || ''),
    String(relayHandoff.title || '')
  ).name;
  let answerHint: string | undefined = own.dismiss ? t('Sending answers the question') : undefined;
  if (relayQuestion) answerHint = t('Sending answers the question from {{name}}', { name: relayName });
  const relay = relayQuestion ? { id: relayId, draftsRef: relayDrafts } : null;
  const live = useRef({ relayQuestion, dismissQuestion: own.dismiss, answerQuestion: own.answer });
  live.current = { relayQuestion, dismissQuestion: own.dismiss, answerQuestion: own.answer };
  /** `submit` as this chat's composer sends: its own question's answer, else
   *  the oldest relayed question's, else a message. */
  const wrapSubmit = useCallback(
    <R>(submit: ComposerSubmit<R>): ComposerSubmit<R | boolean> =>
      async (content, options) => {
        const { relayQuestion: asked, dismissQuestion: dismiss, answerQuestion: answer } = live.current;
        if (answer && dismiss) return questionAwareSubmit(submit, answer, dismiss)(content, options);
        const questions = asked ? approvalQuestions(asked.args) : null;
        if (!asked || !questions) return submit(content, options);
        const id = String(asked.id ?? '');
        const resolve = async (decision: ToolApprovalDecision) => {
          const sessionId = routeSessionIdRef.current;
          if (!sessionId) return false;
          return window.mixdogDesktop.resolveToolApprovalForSession(sessionId, id, decision);
        };
        const picks = relayDraftsId.current === id ? relayDrafts.current : [];
        return questionAwareSubmit(
          submit,
          (reply) => resolve({ approved: true, answers: buildAnswers(questions, picks), reply }),
          () => resolve({ approved: false, reason: 'dismissed by user' }),
          {
            tooLong: (max) =>
              new Error(
                t('This answer is too long for the question (up to {{max}} characters). Your draft has been kept.', {
                  max,
                })
              ),
          }
        )(content, options);
      },
    [routeSessionIdRef]
  );
  return { answerHint, relay, wrapSubmit };
}
