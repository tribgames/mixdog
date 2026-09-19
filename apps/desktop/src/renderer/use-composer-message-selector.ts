// Esc-Esc message selector: pick a previous prompt, rewind the conversation
// to it on the engine side, and restore its text for editing.
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
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
  showNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const palette = useRef<HTMLDivElement>(null);
  // Rewindable prompts, oldest → newest (the newest row is preselected).
  const messages = Array.isArray(userMessages) ? userMessages : [];
  useMobileBack(open, () => setOpen(false));
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
      const value = asRecord(await invokeCapability<RecordValue>('rewindToItem', [messageId]));
      const text = String(value?.text || '');
      if (!text) {
        showNotice(t('Could not restore that message.'));
        return;
      }
      historyNavigation.current = { index: -1, seed: '' };
      setDraft(text);
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(text.length, text.length);
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
