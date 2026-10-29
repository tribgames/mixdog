import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react';
import { subscribeComposerText, takeComposerText } from './composer-text-inbox';
import { useSurfaceActive } from './surface-activity';
import { useComposerShareIntake } from './use-composer-share-intake';

/** Text that reaches the draft from outside the textarea: a shared link/note
 *  (share sheet) and text sent to the composer. Both APPEND to what the
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
  // Text sent to "the composer" (composer-text-inbox) is taken by exactly one
  // composer: the focused pane's, while it is on screen. A conversation
  // brought to the front for it (parked behind a file tab) takes what waits
  // the moment it becomes that composer; retained sessions never do.
  const surfaceActive = useSurfaceActive();
  const takesText = shareActive && surfaceActive;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs and setters are stable and read at take time
  useEffect(() => {
    if (!takesText) return undefined;
    const take = () => {
      const texts = takeComposerText();
      if (texts.length === 0) return;
      setDraft((current) => {
        let next = current;
        for (const text of texts) next = `${next}${next && !/\s$/.test(next) ? ' ' : ''}${text}`;
        draftRef.current = next;
        return next;
      });
      historyNavigation.current = { index: -1, seed: '' };
      window.setTimeout(() => textarea.current?.focus(), 0);
    };
    take();
    return subscribeComposerText(take);
  }, [takesText]);
}
