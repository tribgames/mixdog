// IME composition lifecycle for the composer textarea. Chromium does not
// report `KeyboardEvent.isComposing` consistently across every IME event
// ordering, so the explicit composition events are tracked too.
import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';

export function useComposerIme({
  textarea,
  composingRef,
  suppressImeLineBreakRef,
  draftRef,
  setDraft,
  setCaretOffset,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  composingRef: MutableRefObject<boolean>;
  suppressImeLineBreakRef: MutableRefObject<boolean>;
  draftRef: MutableRefObject<string>;
  setDraft: Dispatch<SetStateAction<string>>;
  setCaretOffset: (offset: number) => void;
}) {
  useEffect(() => {
    const element = textarea.current;
    if (!element) return undefined;
    let reconcileFrame = 0;
    const onCompositionStart = () => {
      composingRef.current = true;
    };
    const onCompositionEnd = () => {
      // Match the reference composer: a keydown delivered after compositionend
      // is the user's submit Enter, even when Chromium keeps both events in the
      // same task. The separate beforeinput guard below still blocks the stray
      // insertLineBreak emitted by engines that end composition after keydown.
      composingRef.current = false;
      const committed = element.value;
      draftRef.current = committed;
      setDraft((current) => (current === committed ? current : committed));
      setCaretOffset(element.selectionStart);
      window.cancelAnimationFrame(reconcileFrame);
      reconcileFrame = window.requestAnimationFrame(() => {
        if (composingRef.current || textarea.current !== element) return;
        const value = element.value;
        draftRef.current = value;
        setDraft((current) => (current === value ? current : value));
        setCaretOffset(element.selectionStart);
      });
    };
    const onBeforeInput = (event: InputEvent) => {
      // A composing Enter commits the IME candidate; it is not a request for a
      // line break. Electron can deliver the follow-up newline after
      // compositionend and a later task, using either browser input type.
      const newline = event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph';
      if (newline && (composingRef.current || event.isComposing || suppressImeLineBreakRef.current)) {
        event.preventDefault();
        suppressImeLineBreakRef.current = false;
      }
    };
    element.addEventListener('compositionstart', onCompositionStart);
    element.addEventListener('compositionend', onCompositionEnd);
    element.addEventListener('beforeinput', onBeforeInput);
    return () => {
      window.cancelAnimationFrame(reconcileFrame);
      element.removeEventListener('compositionstart', onCompositionStart);
      element.removeEventListener('compositionend', onCompositionEnd);
      element.removeEventListener('beforeinput', onBeforeInput);
    };
  }, []);
}
