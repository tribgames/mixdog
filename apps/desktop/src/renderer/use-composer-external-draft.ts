import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useComposerShareIntake } from './use-composer-share-intake';

/** Text that reaches the draft from outside the textarea: a shared link/note
 *  (share sheet) and `mixdog:composer-draft` events. Both APPEND to what the
 *  user already typed, and keep draftRef in step with the state write. */
export function useComposerExternalDraft({
  draftRef,
  setDraft,
  textarea,
  historyNavigation,
  attachFiles,
  shareActive,
}: {
  draftRef: MutableRefObject<string>;
  setDraft: Dispatch<SetStateAction<string>>;
  textarea: RefObject<HTMLTextAreaElement | null>;
  historyNavigation: MutableRefObject<{ index: number; seed: string }>;
  attachFiles: Parameters<typeof useComposerShareIntake>[0]['attachFiles'];
  shareActive: boolean;
}) {
  // A shared link or note arrives as text: it JOINS the draft instead of
  // replacing whatever the user already typed.
  const appendSharedText = useCallback(
    (text: string) => {
      setDraft((current) => {
        const next = current.trim() ? `${current.replace(/\s+$/, '')}\n${text}` : text;
        draftRef.current = next;
        return next;
      });
      window.setTimeout(() => {
        textarea.current?.focus();
      }, 0);
    },
    [draftRef, setDraft, textarea]
  );
  useComposerShareIntake({ active: shareActive, attachFiles, appendText: appendSharedText });
  // biome-ignore lint/correctness/useExhaustiveDependencies: listener is mounted once; refs and setters are stable and read at event time
  useEffect(() => {
    const receiveDraft = (event: Event) => {
      const text = String((event as CustomEvent<unknown>).detail || '');
      if (!text) return;
      setDraft((current) => {
        const next = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${text}`;
        draftRef.current = next;
        return next;
      });
      historyNavigation.current = { index: -1, seed: '' };
      window.setTimeout(() => textarea.current?.focus(), 0);
    };
    window.addEventListener('mixdog:composer-draft', receiveDraft);
    return () => window.removeEventListener('mixdog:composer-draft', receiveDraft);
  }, []);
}
