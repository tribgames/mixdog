// IME composition lifecycle for the composer textarea. Chromium does not
// report `KeyboardEvent.isComposing` consistently across every IME event
// ordering, so the explicit composition events are tracked too.
import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { isMobileRemoteSurface } from './mobile-surface';

const composingElements = new WeakSet<Element>();

/** True while an IME composition is open in this composer textarea. */
export function isComposerComposing(element: Element): boolean {
  return composingElements.has(element);
}

/** Commits the IME composition still open in the focused field before a send
 *  empties it. A programmatic value change drops the composition without
 *  `compositionend` and without telling the keyboard, which then writes its
 *  composing text back into the emptied field. A focus change is the one
 *  page-side way to end it: the browser commits the text, and on Android the
 *  keyboard's input session restarts, so the span is dropped. */
export function finishComposerComposition(element: HTMLTextAreaElement | null): void {
  if (!element || document.activeElement !== element || !composingElements.has(element)) return;
  element.blur();
  element.focus({ preventScroll: true });
}

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: mounts listeners once on the textarea; refs and setters are stable and read at event time
  useEffect(() => {
    const element = textarea.current;
    if (!element) return undefined;
    let reconcileFrame = 0;
    const onCompositionStart = () => {
      composingRef.current = true;
      composingElements.add(element);
    };
    const onBlur = () => {
      composingElements.delete(element);
    };
    const onCompositionEnd = () => {
      composingRef.current = false;
      composingElements.delete(element);
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
      // Phone keyboards are exempt: their Enter is the line-break key.
      const newline = event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph';
      if (
        newline &&
        !isMobileRemoteSurface() &&
        (composingRef.current || event.isComposing || suppressImeLineBreakRef.current)
      ) {
        event.preventDefault();
        suppressImeLineBreakRef.current = false;
      }
    };
    element.addEventListener('compositionstart', onCompositionStart);
    element.addEventListener('compositionend', onCompositionEnd);
    element.addEventListener('beforeinput', onBeforeInput);
    element.addEventListener('blur', onBlur);
    return () => {
      composingElements.delete(element);
      element.removeEventListener('blur', onBlur);
      window.cancelAnimationFrame(reconcileFrame);
      element.removeEventListener('compositionstart', onCompositionStart);
      element.removeEventListener('compositionend', onCompositionEnd);
      element.removeEventListener('beforeinput', onBeforeInput);
    };
  }, []);
}
