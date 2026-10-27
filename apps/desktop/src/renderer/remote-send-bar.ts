// The phone typing bars' "send at once" field (the whole-PC screen bar and the
// remote browser bar on a phone): what is typed, an IME composition included,
// stays in the bar and nothing goes to the PC until Send (the round button) or
// the soft keyboard's Enter, which delivers the bar's whole text in one piece
// and clears the bar. An empty bar sends no text: Send / Enter becomes an
// Enter key and Backspace a Backspace key, so the PC can still be submitted
// to or deleted from without a second control. Pure: no DOM, so each rule is
// tested on plain objects.

/** The field always holds this one invisible character while it has focus and
 *  no text, so an empty bar still has something for a soft keyboard's
 *  Backspace to delete: the deletion arrives as an `input` event, which is the
 *  only trace Android keyboards leave (they send keydown 229 with no usable
 *  key). It is never part of the text. */
export const SEND_BAR_SENTINEL = '\u200b';

/** The parts of the textarea the bar reads and writes. */
export interface SendBarField {
  value: string;
  setSelectionRange?(start: number, end: number): void;
}

/** A key the bar routes to the PC / page (never typed into the bar). */
export interface SendBarKey {
  key: string;
  code?: string;
  keyCode?: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface SendBarKeyEvent extends SendBarKey {
  isComposing?: boolean;
}

export interface SendBarTarget {
  /** The bar's whole text, once. */
  text(text: string): void;
  /** A special key or chord for the PC / page, pressed and lifted at once. */
  key(press: SendBarKey): void;
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);
/** Move or delete inside the bar's text while it has any; the PC's when empty. */
const EDIT_KEYS: ReadonlySet<string> = new Set([
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
/** Always the PC's: nothing in a one-line bar uses them. */
const REMOTE_KEYS: ReadonlySet<string> = new Set(['Tab', 'Escape', 'Insert', 'ContextMenu']);
/** Ctrl/Cmd chords that edit the bar's text while it has any (select all, cut, undo, redo). */
const LOCAL_CHORDS: ReadonlySet<string> = new Set(['a', 'x', 'z', 'y']);
const PASTE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'insertFromPaste',
  'insertFromPasteAsQuotation',
  'insertFromDrop',
]);
const TRAILING_BREAK = /[\r\n]+$/u;

export function createSendBar(target: SendBarTarget) {
  let composing = false;
  /** The bar held text before the last edit: emptying it is not a Backspace. */
  let hadText = false;
  /** A Backspace handled from its keydown whose deletion may still arrive as
   *  an `input` event. */
  let echo: 'Backspace' | null = null;
  /** One Enter, seen so far through these signals: the named key, `beforeinput`
   *  insertLineBreak/insertParagraph, and a newline in `input`. The first
   *  submits; the others of the same Enter arrive in any order, each once,
   *  and are consumed while the bar is empty. Retired by the next real edit,
   *  a composition start, the Send button, or when the event loop turns (blur
   *  does not: the companions may land after it). */
  let pending: Partial<Record<'enter' | 'break' | 'newline', true>> | null = null;
  let retire: ReturnType<typeof setTimeout> | null = null;
  const settle = (): void => {
    pending = null;
    if (retire !== null) clearTimeout(retire);
    retire = null;
  };
  /** True: this signal repeats the Enter already submitted (swallow it). Any
   *  signal with text in the bar, or one already seen, is a new Enter. */
  const repeated = (signal: 'enter' | 'break' | 'newline', empty: boolean): boolean => {
    if (pending && empty && !pending[signal]) {
      pending[signal] = true;
      return true;
    }
    settle();
    pending = { [signal]: true };
    retire = setTimeout(settle, 0);
    return false;
  };
  /** Send ran mid-composition: the IME's own end of it is not new text. */
  let discardEnd = false;
  /** A paste is landing: its newlines are text, not Send. */
  let pasting = false;
  const textOf = (field: SendBarField): string => field.value.split(SEND_BAR_SENTINEL).join('');
  const reset = (field: SendBarField): void => {
    field.value = SEND_BAR_SENTINEL;
    field.setSelectionRange?.(SEND_BAR_SENTINEL.length, SEND_BAR_SENTINEL.length);
  };
  /** The soft keyboard's Enter arrived as text: the line break is Send, the
   *  text before it (the IME's last syllable included, already in the field)
   *  goes once. */
  const lineBreak = (field: SendBarField): boolean => {
    if (pasting || !TRAILING_BREAK.test(textOf(field))) return false;
    const body = textOf(field).replace(TRAILING_BREAK, '');
    if (repeated('newline', body === '')) reset(field);
    else {
      field.value = body;
      send(field);
    }
    return true;
  };
  const send = (field: SendBarField, focused = true): void => {
    // A running composition is already in the field's value; it is delivered
    // with the rest and the IME's late end of it is dropped, with no blur.
    if (composing) {
      composing = false;
      discardEnd = true;
    }
    const text = textOf(field);
    // Focus is kept as it is: a focused bar gets its sentinel back, a bar
    // that is not focused shows its placeholder.
    if (focused) reset(field);
    else field.value = '';
    hadText = false;
    if (text) target.text(text);
    else target.key({ key: 'Enter' });
  };
  return {
    get composing(): boolean {
      return composing;
    },
    /** Focus puts the sentinel in an empty bar; typed text stays. */
    focus(field: SendBarField): void {
      if (field.value === '') reset(field);
    },
    /** Blur empties an empty bar so the placeholder shows; typed text stays. */
    blur(field: SendBarField): void {
      echo = null;
      if (textOf(field) === '') field.value = '';
    },
    /** True: the event's default must be prevented. */
    keyDown(event: SendBarKeyEvent, field: SendBarField): boolean {
      // An IME key (Android sends 'Process' / 229): the composition and the
      // line break that follows it are read from compositionend / beforeinput.
      if (composing || event.isComposing || event.key === 'Process' || event.keyCode === 229) return false;
      if (MODIFIER_KEYS.has(event.key)) return false;
      const hasText = textOf(field) !== '';
      const chord = Boolean(event.ctrlKey || event.altKey || event.metaKey);
      const command = Boolean(event.ctrlKey || event.metaKey);
      const name = event.key.toLowerCase();
      if (chord) {
        // Paste goes into the bar; editing chords edit it while it has text;
        // every other chord is the PC's.
        if (command && !event.altKey && (name === 'v' || (hasText && LOCAL_CHORDS.has(name)))) return false;
        target.key(event);
        return true;
      }
      if (event.key === 'Enter') {
        if (!repeated('enter', !hasText)) send(field);
        return true;
      }
      if (event.key === 'Backspace' && !hasText) {
        echo = 'Backspace';
        target.key(event);
        return true;
      }
      if (EDIT_KEYS.has(event.key)) {
        if (hasText) return false;
        target.key(event);
        return true;
      }
      if (REMOTE_KEYS.has(event.key) || /^F(?:[1-9]|1[0-2])$/u.test(event.key)) {
        target.key(event);
        return true;
      }
      return false;
    },
    keyUp(): void {
      echo = null;
    },
    /** The `beforeinput` event (native; React has no such event). True: its
     *  default must be prevented. A line break is Send, once, even if a named
     *  Enter already sent it; a paste is marked so its newlines stay text. */
    beforeInput(event: { inputType: string }, field: SendBarField): boolean {
      if (PASTE_INPUT_TYPES.has(event.inputType)) {
        pasting = true;
        return false;
      }
      if (event.inputType !== 'insertLineBreak' && event.inputType !== 'insertParagraph') return false;
      if (!repeated('break', textOf(field) === '')) send(field);
      return true;
    },
    /** A paste event: the next input is pasted text. */
    paste(): void {
      pasting = true;
    },
    input(field: SendBarField, isComposing = false): void {
      if (composing || isComposing) return;
      const text = textOf(field);
      if (field.value === '') {
        // The sentinel was deleted: a Backspace the keyboard never keyed,
        // unless it emptied text or is the keydown's own.
        const keyed = echo === 'Backspace';
        echo = null;
        if (!keyed && !hadText) target.key({ key: 'Backspace' });
        reset(field);
        hadText = false;
        return;
      }
      if (lineBreak(field)) {
        hadText = false;
        return;
      }
      settle();
      pasting = false;
      hadText = text !== '';
    },
    compositionStart(): void {
      composing = true;
      discardEnd = false;
      echo = null;
      settle();
    },
    compositionEnd(field: SendBarField): void {
      composing = false;
      if (discardEnd) {
        discardEnd = false;
        if (textOf(field) !== '') reset(field);
        hadText = false;
        return;
      }
      // A keyboard whose Enter ended the composition with the break in it.
      if (lineBreak(field)) {
        hadText = false;
        return;
      }
      hadText = textOf(field) !== '';
    },
    /** The round button (`focused`: the bar has focus), or the soft keyboard's Enter. */
    send(field: SendBarField, focused = true): void {
      settle();
      send(field, focused);
    },
  };
}
