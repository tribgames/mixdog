// The actions under a message sent while a turn runs: "Send now", cancel and
// "Send again". The pane owns them (they address the session it paints); the
// composer only lends its editor, for a message taken back.
import { createContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopAbortOptions, DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import type { ComposerProps } from './Composer';
import { restoreAttachmentsFromRecord } from './composer-attachment-restore';
import {
  composerScopeHasContent,
  rejectComposerSubmissionRecovery,
  retainComposerSubmissionRecovery,
} from './composer-draft';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { RecordValue } from './desktop-types';
import { t } from './i18n';
import { queuedPlainAnswer, steerQueuedAsAnswer } from './question-card-logic';
import { useComposerCapability } from './use-composer-capability';

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
   *  draft and its chips (editing a previous message). */
  restore(value: RecordValue, options?: { ifEmpty?: boolean; replace?: boolean; notice?: string }): boolean;
};

export type SteerActions = {
  /** Delivers the message now: the turn stops at once and reads it. */
  sendNow(id: string): void;
  /** Takes the message back; its text returns to an empty editor. */
  cancel(id: string): void;
  /** Sends a message that could not be sent again, under its own id. */
  retry(id: string): void;
};

export type SteerContextValue = { actions: SteerActions; draft: { current: ComposerDraftHandoff | null } };

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

/** A message this pane sent, as the record the editor restores from: its
 *  words with their attachment tokens, the pasted images with their bytes
 *  (the content's image parts, in order), pasted / attached texts and the
 *  PDF / Office parts. */
export function promptRestoreRecord(content: DesktopPromptContent, options?: DesktopSubmitOptions): RecordValue {
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

let parkedSequence = 0;

/** Returns a taken-back message — its words and its attachments — to the
 *  editor of the conversation it was taken from. The pane is reused across
 *  sessions, so when its editor shows another conversation by the time the
 *  action completes, the message waits as that conversation's recovery and
 *  is handed back when it is shown again; it never lands in another
 *  session's editor. `ifEmpty` holds there too: nothing typed or stashed. */
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
  const id = `steer-restore-${++parkedSequence}`;
  retainComposerSubmissionRecovery({
    id,
    scope: origin.recoveryScope,
    text: restored.text,
    attachments: restored.attachments,
  });
  rejectComposerSubmissionRecovery(id);
}

export function useSteerActions({
  steerItems,
  busy,
  sessionId,
  invokeResult,
  applySnapshot,
  abort,
  submit,
  answerQuestion,
  onTaken,
}: {
  steerItems: PendingPromptItem[];
  busy: boolean;
  sessionId: string;
  invokeResult: ComposerProps['invokeResult'];
  applySnapshot: ComposerProps['applySnapshot'];
  abort: (options?: DesktopAbortOptions) => Promise<unknown>;
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  /** Set while a question waits: plain text answers it instead. */
  answerQuestion: { current: ((reply: string) => Promise<unknown>) | null | undefined };
  /** The messages left the session queue: their optimistic twins go. */
  onTaken: (ids: string[]) => void;
}) {
  const { invokeCapability } = useComposerCapability({ invokeResult, applySnapshot, sessionId });
  // Taken back (hidden until the queue publication catches up) and being
  // sent now (the action row gives way while the turn stops).
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_IDS);
  const [sending, setSending] = useState<ReadonlySet<string>>(NO_IDS);
  useEffect(() => {
    const live = new Set(steerItems.map((item) => String(item.id)));
    const prune = (current: ReadonlySet<string>) => {
      const next = [...current].filter((id) => live.has(id));
      return next.length === current.size ? current : new Set(next);
    };
    setHidden(prune);
    setSending(prune);
  }, [steerItems]);
  const visibleSteerItems = useMemo(() => {
    if (!hidden.size && !sending.size) return steerItems;
    const items = steerItems
      .filter((item) => !hidden.has(String(item.id)))
      .map((item) => (sending.has(String(item.id)) ? { ...item, steer: 'sending' as const } : item));
    return items.length ? items : NO_ITEMS;
  }, [hidden, sending, steerItems]);
  const latest = useRef({ steerItems, busy, sessionId, invokeCapability, abort, submit, onTaken });
  latest.current = { steerItems, busy, sessionId, invokeCapability, abort, submit, onTaken };
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
      const { invokeCapability: invoke, abort: stopTurn, onTaken: taken } = latest.current;
      const origin = originScope();
      markId(setSending, id, true);
      const answer = answerQuestion.current;
      // A question waits: a plain follow-up answers it rather than
      // interrupting the turn, which would close the question unanswered.
      if (answer && queuedPlainAnswer(item.queueEntry) !== null) {
        let restored: RecordValue | undefined;
        const result = await steerQueuedAsAnswer(async () => {
          restored = await invoke<RecordValue>('restoreQueued', ['', id]);
          return restored && Number(restored.count) > 0 ? String(restored.text || '') : undefined;
        }, answer);
        if (!result.text) {
          markId(setSending, id, false);
          return;
        }
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
      const value = await invoke<RecordValue>('prioritizeQueued', [id]);
      if (!value || Number(value.count) < 1) {
        markId(setSending, id, false);
        return;
      }
      taken(takenIds(value, id));
      if (latest.current.busy) await stopTurn({ restorePrompt: false });
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
      try {
        accepted = await send(content, options);
      } catch {
        accepted = false;
      }
      // Sent again after the turn ended and refused: the message would be
      // gone, so it goes back into the editor it came from.
      if (accepted !== true) {
        restoreDraft(draft, origin, promptRestoreRecord(content, options), {
          notice: t('The message was not sent. It has been kept for retry.'),
        });
      }
    };
    return {
      sendNow: (id) => exclusive(() => sendNow(id)),
      cancel: (id) => exclusive(() => cancel(id)),
      retry: (id) => exclusive(() => retry(id)),
    };
  }, [answerQuestion]);
  const context = useMemo<SteerContextValue>(() => ({ actions, draft }), [actions]);
  return { visibleSteerItems, context };
}
