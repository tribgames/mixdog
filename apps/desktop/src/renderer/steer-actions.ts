// The actions under a message sent while a turn runs: "Send now", cancel and
// "Send again". The pane owns them (they address the session it paints); the
// composer only lends its editor, for a message taken back.
import { createContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopPromptContent, DesktopSubmitOptions, DesktopTurnTakeoverReceipt } from '../shared/contract';
import type { ComposerProps } from './Composer';
import { restoreAttachmentsFromRecord } from './composer-attachment-restore';
import { composerSubmitErrorText } from './composer-submit-error';
import { composerScopeHasContent } from './composer-draft';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { RecordValue } from './desktop-types';
import { t } from './i18n';
import { asRecord } from './text-format';
import { queuedPlainAnswer, steerQueuedAsAnswer } from './question-card-logic';
import { useComposerCapability } from './use-composer-capability';
import { parkComposerRecovery } from './use-composer-submission';
import { uuidv7 } from '../../../../packages/protocol-client/src/client.ts';

/** The composer's side of a message taken back from the transcript. */
export type ComposerDraftHandoff = {
  /** The conversation the editor shows now: its identity scope (the
   *  session id for a session pane). */
  scope(): string;
  /** The editor's recovery scope: where a message for this conversation
   *  waits while another one is shown. */
  recoveryScope(): string;
  /** Puts the message (its text and attachments) into the editor, before
   *  what it holds. `ifEmpty`: only when the editor holds nothing. Returns
   *  whether it did. `replace`: the message takes the place of the whole
   *  draft and its chips (editing a previous message). `submissionId`: the
   *  message went out under it and may have landed, so a resend of it
   *  unchanged keeps it. */
  restore(
    value: RecordValue,
    options?: { ifEmpty?: boolean; replace?: boolean; notice?: string; submissionId?: string }
  ): boolean;
};

export type SteerActions = {
  /** Delivers the message now: the running turn ends taken over by it, and it starts the next one. */
  sendNow(id: string): void;
  /** Takes the message back; its text returns to an empty editor. */
  cancel(id: string): void;
  /** Sends a message that could not be sent again, under its own id. */
  retry(id: string): void;
};

export type SteerContextValue = {
  actions: SteerActions;
  draft: { current: ComposerDraftHandoff | null };
  /** A turn runs that a message can take over: "Send now" has something to send. */
  canSendNow: boolean;
};

/** Provided by a pane that can act on its session (never a read-only view). */
export const SteerContext = createContext<SteerContextValue | null>(null);

const NO_IDS: ReadonlySet<string> = new Set();
const NO_ITEMS: PendingPromptItem[] = [];

function markId(set: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void, id: string, on: boolean) {
  set((current) => {
    if (current.has(id) === on) return current;
    const next = new Set(current);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
}

function takenIds(value: RecordValue | undefined, id: string): string[] {
  const ids = Array.isArray(value?.ids) ? value.ids.map(String).filter(Boolean) : [];
  return ids.length ? ids : [id];
}

type DraftRestoreOptions = Parameters<ComposerDraftHandoff['restore']>[1];
/** The conversation an action started in, captured when it started. */
type DraftOrigin = { scope: string; recoveryScope: string };

function promptRestoreRecord(content: DesktopPromptContent, options?: DesktopSubmitOptions): RecordValue {
  const pastedTexts = options?.pastedTexts ? { pastedTexts: options.pastedTexts } : {};
  // A text-only message still carries its pasted texts and text files.
  if (typeof content === 'string') return { text: content, ...pastedTexts };
  const pasted = Object.entries(options?.pastedImages || {});
  const metadata = new Set(pasted.map(([, image]) => image.metadataText).filter(Boolean));
  const imageData = content.flatMap((part) => (part.type === 'image' ? [part.data] : []));
  const pastedImages = Object.fromEntries(
    pasted.flatMap(([key, image], index) => (imageData[index] ? [[key, { ...image, content: imageData[index] }]] : []))
  );
  return {
    text: content.flatMap((part) => (part.type === 'text' && !metadata.has(part.text) ? [part.text] : [])).join('\n'),
    pastedImages,
    ...pastedTexts,
    content: content.filter((part) => part.type === 'file'),
  };
}

/** The id of one press of "Send now", an operation id as the core takes them (a UUIDv7): every send of that press
 *  carries it. */
const newOperationId = (): string => uuidv7(Date.now());

function restoreDraft(
  draft: { current: ComposerDraftHandoff | null },
  origin: DraftOrigin,
  value: RecordValue,
  options: DraftRestoreOptions = {}
): void {
  const editor = draft.current;
  if (editor && editor.scope() === origin.scope) {
    editor.restore(value, options);
    return;
  }
  if (!origin.scope || !origin.recoveryScope) return;
  // The ids are the record's own; the composer that takes the message back
  // renumbers them into its sequence (mergeRestoredAttachments).
  const restored = restoreAttachmentsFromRecord(value, String(value.text || ''), {
    reservedIds: new Set(),
    sequence: { current: 1 },
  });
  if (!restored.text.trim() && !restored.attachments.length) return;
  if (options.ifEmpty && composerScopeHasContent(origin.scope)) return;
  parkComposerRecovery(origin.recoveryScope, restored.text, restored.attachments);
}

/** A press of "Send now", by the session it was made in and the message. */
const pressOf = (sessionId: string, id: string) => `${sessionId}\0${id}`;

/** What the pane shows of the queue: what the core publishes, in the order it will deliver it. A message sent now is
 *  the core's to account for: it is shown while the core lists it in the queue, first and as sent once the core says so
 *  (`priority: 'now'`), and its row stands for it once that lands. The pane adds only what it knows ahead of the core's
 *  next queue: a press of "Send now" (the entry reads as sent, first, as the core will publish it) and a message taken
 *  back or given as an answer (`hidden`). Both end with the queue entry they are about. */
function useSteerVisibility(steerItems: PendingPromptItem[], sessionId: string) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_IDS);
  const [pressed, setPressed] = useState<ReadonlySet<string>>(NO_IDS);
  useEffect(() => {
    const live = new Set(steerItems.map((item) => String(item.id)));
    const prune = (keep: (key: string) => boolean) => (current: ReadonlySet<string>) => {
      const next = [...current].filter(keep);
      return next.length === current.size ? current : new Set(next);
    };
    setHidden(prune((id) => live.has(id)));
    // A press belongs to its session: another session's queue says nothing about it.
    const own = pressOf(sessionId, '');
    setPressed(prune((key) => !key.startsWith(own) || live.has(key.slice(own.length))));
  }, [steerItems, sessionId]);
  const visibleSteerItems = useMemo(() => {
    const sentNow = (item: PendingPromptItem) =>
      pressed.has(pressOf(sessionId, String(item.id))) ||
      (item.steer === 'pending' && asRecord(item.queueEntry)?.priority === 'now');
    const sent = steerItems.filter(sentNow);
    if (!hidden.size && !sent.length) return steerItems;
    const items = [
      ...sent.map((item) => ({ ...item, steer: 'sending' as const })),
      ...steerItems.filter((item) => !sentNow(item)),
    ].filter((item) => !hidden.has(String(item.id)));
    return items.length ? items : NO_ITEMS;
  }, [hidden, pressed, steerItems, sessionId]);
  return { visibleSteerItems, setHidden, setPressed };
}

export function useSteerActions({
  steerItems,
  turnId,
  sessionId,
  invokeResult,
  applySnapshot,
  submit,
  answerQuestion,
  onTaken,
}: {
  steerItems: PendingPromptItem[];
  /** The turn the session runs, as the core names it; '' while none runs. */
  turnId: string;
  sessionId: string;
  invokeResult: ComposerProps['invokeResult'];
  applySnapshot: ComposerProps['applySnapshot'];
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  /** Set while a question waits: plain text answers it instead. */
  answerQuestion: { current: ((reply: string) => Promise<unknown>) | null | undefined };
  /** The messages left the session queue: their optimistic twins go. */
  onTaken: (ids: string[]) => void;
}) {
  const { invokeCapability } = useComposerCapability({ invokeResult, applySnapshot, sessionId });
  const { visibleSteerItems, setHidden, setPressed } = useSteerVisibility(steerItems, sessionId);
  const latest = useRef({ steerItems, turnId, sessionId, invokeCapability, invokeResult, submit, onTaken });
  latest.current = { steerItems, turnId, sessionId, invokeCapability, invokeResult, submit, onTaken };
  const draft = useRef<ComposerDraftHandoff | null>(null);
  const inFlight = useRef(false);
  const actions = useMemo<SteerActions>(() => {
    const find = (id: string) => latest.current.steerItems.find((item) => String(item.id) === id);
    // The conversation an action started in: what it takes back returns there.
    const originScope = (): DraftOrigin => {
      const editor = draft.current;
      if (editor) return { scope: editor.scope(), recoveryScope: editor.recoveryScope() };
      return { scope: latest.current.sessionId, recoveryScope: '' };
    };
    // One action at a time: a second press while the first is in flight is dropped.
    const exclusive = (work: () => Promise<void>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      void work().finally(() => {
        inFlight.current = false;
      });
    };
    const sendNow = async (id: string) => {
      const item = find(id);
      if (item?.steer !== 'pending' || item.steerLocal) return;
      // What the user saw when they pressed: the session, and the turn it ran.
      const {
        invokeCapability: invoke,
        invokeResult: run,
        onTaken: taken,
        sessionId: pressedIn,
        turnId: seen,
      } = latest.current;
      const origin = originScope();
      const press = pressOf(pressedIn, id);
      const answer = answerQuestion.current;
      const answers = Boolean(answer) && queuedPlainAnswer(item.queueEntry) !== null;
      // No turn runs to take over (the action is not offered then): the message is the queue's to start as it stands.
      if (!answers && !seen) return;
      markId(setPressed, press, true);
      let receipt: DesktopTurnTakeoverReceipt | undefined;
      try {
        // A question waits: a plain follow-up answers it rather than
        // interrupting the turn, which would close the question unanswered.
        if (answer && answers) {
          let restored: RecordValue | undefined;
          const result = await steerQueuedAsAnswer(async () => {
            restored = await invoke<RecordValue>('restoreQueued', ['', id]);
            return restored && Number(restored.count) > 0 ? String(restored.text || '') : undefined;
          }, answer);
          if (!result.text) return;
          // The core handed the message back and it became the answer (or returns to the editor): it leaves here, ahead
          // of the queue the core publishes without it.
          markId(setHidden, id, true);
          taken(takenIds(restored, id));
          if (!result.answered) {
            restoreDraft(
              draft,
              origin,
              { text: result.text },
              { notice: 'The answer was not sent. Your message is back in the editor.' }
            );
          }
          return;
        }
        // One command for the press: the core decides it against the turn that runs and the queue as they are then.
        receipt = await run(() =>
          window.mixdogDesktop.takeOverTurn(pressedIn, { opId: newOperationId(), turnId: seen, queuedId: id })
        );
      } finally {
        // Only a message the core accepted reads as sent, until the queue the core publishes says so itself or drops it.
        if (receipt?.kind !== 'accepted') markId(setPressed, press, false);
      }
      // Refused and still queued: nothing was changed, and it waits as it did.
      if (!receipt || receipt.message === 'queued') return;
      // The next turn's input, or already delivered: the row the core writes stands for it, under the submission it
      // answers. Delivered, no bubble is left for it while the queue this pane holds still lists it.
      if (receipt.message === 'consumed') markId(setHidden, id, true);
      const submission = receipt.kind === 'accepted' ? receipt.submissionId : undefined;
      taken(submission && submission !== id ? [id, submission] : [id]);
    };
    const cancel = async (id: string) => {
      const item = find(id);
      if (!item) return;
      const { invokeCapability: invoke, onTaken: taken } = latest.current;
      const origin = originScope();
      if (item.steer === 'failed') {
        taken([id]);
        const record = item.retry ? promptRestoreRecord(item.retry.content, item.retry.options) : { text: item.text };
        restoreDraft(draft, origin, record, { ifEmpty: true });
        return;
      }
      if (item.steerLocal || item.steer === 'sending') return;
      markId(setHidden, id, true);
      const value = await invoke<RecordValue>('restoreQueued', ['', id]);
      if (!value || Number(value.count) < 1) {
        markId(setHidden, id, false);
        return;
      }
      taken(takenIds(value, id));
      restoreDraft(draft, origin, value, { ifEmpty: true });
    };
    const retry = async (id: string) => {
      const item = find(id);
      if (item?.steer !== 'failed' || !item.retry) return;
      const { content, options } = item.retry;
      const { submit: send } = latest.current;
      const origin = originScope();
      let accepted: unknown = false;
      let refusal: string | undefined;
      try {
        accepted = await send(content, options);
      } catch (error) {
        refusal = composerSubmitErrorText(error);
      }
      // Sent again after the turn ended and refused: the message would be
      // gone, so it goes back into the editor it came from.
      if (accepted !== true) {
        restoreDraft(draft, origin, promptRestoreRecord(content, options), {
          notice: refusal || t('The message was not sent. It has been kept for retry.'),
          ...(options?.id ? { submissionId: options.id } : {}),
        });
      }
    };
    return {
      sendNow: (id) => exclusive(() => sendNow(id)),
      cancel: (id) => exclusive(() => cancel(id)),
      retry: (id) => exclusive(() => retry(id)),
    };
  }, [answerQuestion, setHidden, setPressed]);
  const canSendNow = Boolean(turnId);
  const context = useMemo<SteerContextValue>(() => ({ actions, draft, canSendNow }), [actions, canSendNow]);
  return { visibleSteerItems, context };
}
