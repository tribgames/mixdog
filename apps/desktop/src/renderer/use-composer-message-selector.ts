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

/** The selector lists at most this many prompts (TUI parity). */
const REWIND_TARGETS = 20;

/** The prompts the session can be rewound to, oldest → newest, read from its stored history (`thread/rewindTargets/list`):
 *  every prompt counts, wherever the window of rows held is. Undefined when the host cannot list them. */
async function storedRewindTargets(sessionId: string): Promise<Array<{ id: string; text: string }> | undefined> {
  const list = window.mixdogDesktop?.listRewindTargets;
  if (!sessionId || !list) return undefined;
  const { data } = await list(sessionId, { limit: REWIND_TARGETS });
  return data
    .filter((target) => target.text.trim())
    .map((target) => ({ id: target.position, text: target.text.trim() }))
    .reverse();
}

export function useComposerMessageSelector({
  sessionId = '',
  userMessages,
  restoring,
  setRestoring,
  invokeCapability,
  setDraft,
  textarea,
  historyNavigation,
  showNotice,
}: {
  /** The session whose stored prompts are listed; the held rows' prompts (`userMessages`) stand in where none can be. */
  sessionId?: string;
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
  // What the selector was opened with, read from the stored history when it opened.
  const [stored, setStored] = useState<{ sessionId: string; rows: Array<{ id: string; text: string }> } | null>(null);
  const opening = useRef(0);
  // Rewindable prompts, oldest → newest (the newest row is preselected).
  const messages =
    stored && stored.sessionId === sessionId ? stored.rows : Array.isArray(userMessages) ? userMessages : [];
  useMobileBack(open, () => setOpen(false));
  // biome-ignore lint/correctness/useExhaustiveDependencies: index is the trigger that re-scrolls the selected option into view
  useEffect(() => {
    if (open) scrollSelectedOptionIntoView(palette);
  }, [index, open]);
  const show = (rows: Array<{ id: string; text: string }>) => {
    if (rows.length === 0) {
      showNotice(t('No message to jump back to.'));
      return;
    }
    setIndex(rows.length - 1);
    setOpen(true);
  };
  const openSelector = () => {
    const asked = ++opening.current;
    const fallback = Array.isArray(userMessages) ? userMessages : [];
    if (!sessionId || !window.mixdogDesktop?.listRewindTargets) {
      show(fallback);
      return;
    }
    void storedRewindTargets(sessionId)
      .catch(() => undefined)
      .then((rows) => {
        if (asked !== opening.current) return;
        if (rows) setStored({ sessionId, rows });
        show(rows ?? fallback);
      });
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
        showNotice(
          error instanceof Error && error.message ? error.message : t('Could not restore that message.'),
          'error'
        );
        return;
      }
      const text = String(value?.text || '');
      if (!text) {
        showNotice(t('Could not restore that message.'), 'error');
        return;
      }
      historyNavigation.current = { index: -1, seed: '' };
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
