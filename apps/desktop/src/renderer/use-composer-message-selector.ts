// Esc-Esc message selector: pick a previous prompt, rewind the conversation
// to it on the engine side, and restore its text for editing.
import { useCallback, useContext, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { SteerContext } from './steer-actions';
import type { DesktopCapability } from '../shared/contract';
import type { RecordValue } from './desktop-types';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { asRecord } from './text-format';
import { scrollSelectedOptionIntoView } from './use-composer-palettes';

export function useComposerMessageSelector({
  userMessages,
  restoring,
  setRestoring,
  invokeCapability,
  setDraft,
  textarea,
  historyNavigation,
  showNotice,
}: {
  userMessages?: Array<{ id: string; text: string }>;
  restoring: boolean;
  setRestoring: (value: boolean) => void;
  invokeCapability: <T>(capability: DesktopCapability, args?: unknown[]) => Promise<T | undefined>;
  setDraft: (value: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  historyNavigation: MutableRefObject<{ index: number; seed: string }>;
  showNotice: (message: string, tone?: 'info' | 'error') => void;
}) {
  const steer = useContext(SteerContext);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const palette = useRef<HTMLDivElement>(null);
  // Rewindable prompts, oldest → newest (the newest row is preselected).
  const messages = Array.isArray(userMessages) ? userMessages : [];
  useMobileBack(open, () => setOpen(false));
  // biome-ignore lint/correctness/useExhaustiveDependencies: index is the trigger that re-scrolls the selected option into view
  useEffect(() => {
    if (open) scrollSelectedOptionIntoView(palette);
  }, [index, open]);
  const openSelector = () => {
    if (messages.length === 0) {
      showNotice(t('No message to jump back to.'));
      return;
    }
    setIndex(messages.length - 1);
    setOpen(true);
  };
  // Selecting a row drops the conversation from that prompt onward (engine
  // side) and returns its text for editing — the "restore conversation".
  const rewindToMessage = async (messageId: string) => {
    if (!messageId || restoring) return;
    setOpen(false);
    setRestoring(true);
    try {
      let value: RecordValue | null;
      try {
        value = asRecord(await invokeCapability<RecordValue>('rewindToItem', [messageId]));
      } catch (error) {
        showNotice(error instanceof Error && error.message ? error.message : t('Could not restore that message.'), 'error');
        return;
      }
      const text = String(value?.text || '');
      if (!text) {
        showNotice(t('Could not restore that message.'), 'error');
        return;
      }
      historyNavigation.current = { index: -1, seed: '' };
      // The composer's own restore replaces the whole draft and its chips (the
      // same path a message taken back from the transcript uses), so a
      // pasted-text chip keeps its edit dialog and a plain message leaves no
      // stale chips behind.
      const handoff = steer?.draft.current;
      if (!handoff?.restore(value as RecordValue, { replace: true })) setDraft(text);
      if (typeof value?.notice === 'string' && value.notice) showNotice(value.notice, 'error');
      window.setTimeout(() => {
        const field = textarea.current;
        field?.focus();
        field?.setSelectionRange(field.value.length, field.value.length);
      }, 0);
    } finally {
      setRestoring(false);
    }
  };
  const reset = useCallback(() => {
    setOpen(false);
    setIndex(0);
  }, []);
  return { open, setOpen, index, setIndex, messages, palette, openSelector, rewindToMessage, reset };
}
