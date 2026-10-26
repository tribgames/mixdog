// The remote page's typing field (one textarea) when a press reaches the page
// mid-composition: a half-typed syllable belongs to the field it was typed
// into, so it is committed there BEFORE the press can move the page's focus,
// and the IME's own late commit of it (focus leaving the textarea, the
// takeover's keyboard re-raise) is swallowed instead of landing in the next
// field. An empty composition is closed with nothing.
import { useMemo, useRef, type CompositionEvent, type FormEvent, type KeyboardEvent, type RefObject } from 'react';

type CompositionHandlers = {
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onInput(event: FormEvent<HTMLTextAreaElement>): void;
  onCompositionStart(event: CompositionEvent<HTMLTextAreaElement>): void;
  onCompositionUpdate(event: CompositionEvent<HTMLTextAreaElement>): void;
  onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>): void;
};

/** `finish()` commits a running composition to the page and ends the IME's. */
export function createCompositionFinisher(field: () => HTMLTextAreaElement | null) {
  let composing = false;
  let text = '';
  /** What was committed for the IME; its own commit of it is an echo. */
  let echo: string | null = null;
  return {
    wrap<T extends CompositionHandlers>(input: T): T {
      return {
        ...input,
        onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.nativeEvent.keyCode !== 229) echo = null;
          input.onKeyDown(event);
        },
        onInput: (event: FormEvent<HTMLTextAreaElement>) => {
          if (echo !== null && !composing) {
            const value = event.currentTarget.value;
            const committed = echo;
            echo = null;
            if (value === '' || value === committed) {
              event.currentTarget.value = '';
              return;
            }
          }
          input.onInput(event);
        },
        onCompositionStart: (event: CompositionEvent<HTMLTextAreaElement>) => {
          composing = true;
          text = '';
          echo = null;
          input.onCompositionStart(event);
        },
        onCompositionUpdate: (event: CompositionEvent<HTMLTextAreaElement>) => {
          // The IME still updating a composition already committed.
          if (!composing) return;
          text = event.data;
          input.onCompositionUpdate(event);
        },
        onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => {
          if (!composing) {
            event.currentTarget.value = '';
            return;
          }
          composing = false;
          input.onCompositionEnd(event);
        },
      };
    },
    finish(input: Pick<CompositionHandlers, 'onCompositionEnd'>): void {
      if (!composing) return;
      const element = field();
      composing = false;
      echo = text;
      if (!element) return;
      // Through the page input's own end, so it reaches the document (and
      // field) the composition started in.
      input.onCompositionEnd({ data: text, currentTarget: element } as unknown as CompositionEvent<HTMLTextAreaElement>);
      if (document.activeElement === element) {
        // Focus leaving the textarea ends the IME's composition (its commit is
        // the echo above); focusing it again keeps the keyboard where it was.
        element.blur();
        element.focus({ preventScroll: true });
      }
    },
  };
}

export function useCompositionFinisher<T extends CompositionHandlers>(
  input: T,
  field: RefObject<HTMLTextAreaElement | null>
): { handlers: T; finish(): void } {
  const finisher = useMemo(() => createCompositionFinisher(() => field.current), [field]);
  const inputRef = useRef(input);
  inputRef.current = input;
  return useMemo(
    () => ({ handlers: finisher.wrap(input), finish: () => finisher.finish(inputRef.current) }),
    [finisher, input]
  );
}
