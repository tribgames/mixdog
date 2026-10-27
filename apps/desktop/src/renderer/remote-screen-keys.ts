// The phone's keyboard for the whole-PC screen view (docs/remote-screen.md):
// what a key event or typed text becomes as `screen-key` / `screen-text`
// input, the Chrome-Remote-Desktop-style special keys, and the soft-keyboard
// fallbacks. Pure: no DOM, so each rule is tested on plain event objects.
import { remoteScreenKeyForCode } from '../shared/remote-screen';
import { MAX_REMOTE_SCREEN_TEXT, type RemoteScreenInput } from '../shared/remote-webrtc';

/** The field always holds this one invisible character while it has focus, so
 *  an empty field still has something for a soft keyboard's Backspace to
 *  delete: the deletion arrives as an `input` event, which is the only trace
 *  Android keyboards leave (they send keydown 229 with no usable key). */
export const SCREEN_TEXT_SENTINEL = '\u200b';

/** The parts of a KeyboardEvent the mapping reads. */
export interface ScreenKeyEventLike {
  key: string;
  code: string;
  keyCode: number;
  isComposing?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export type ScreenKeyEcho = 'Backspace' | 'Enter';

export interface ScreenKeyResult {
  inputs: RemoteScreenInput[];
  /** The browser's own handling (a newline, a deletion) must not also happen. */
  preventDefault: boolean;
  /** The key was read from `key`, not `code`: the same press may still arrive
   *  as an `input` event, which must not send it a second time. */
  echo: ScreenKeyEcho | null;
}

const NO_KEY: ScreenKeyResult = { inputs: [], preventDefault: false, echo: null };

/** `KeyboardEvent.key` → the physical `code` it names, for keyboards that
 *  report no code (soft keyboards) or keyCode 229. */
const KEY_NAME_CODES: Readonly<Record<string, string>> = {
  Backspace: 'Backspace',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ' ': 'Space',
};

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

function codeFromKey(key: string): string | null {
  const named = KEY_NAME_CODES[key];
  if (named) return named;
  if (/^F(?:[1-9]|1[0-2])$/u.test(key)) return key;
  if (/^[a-z]$/iu.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/u.test(key)) return `Digit${key}`;
  return null;
}

/** The `code` a key event stands for: its own when the keyboard reports one,
 *  else the one its `key` names. */
export function screenKeyCode(event: Pick<ScreenKeyEventLike, 'key' | 'code' | 'keyCode'>): string | null {
  if (event.code && event.keyCode !== 229 && remoteScreenKeyForCode(event.code)) return event.code;
  return codeFromKey(event.key);
}

const keyPair = (code: string): RemoteScreenInput[] => screenKeyChord([code]);

/** Down for each code in order, then up in reverse: a chord, or one key. */
export function screenKeyChord(codes: readonly string[]): RemoteScreenInput[] {
  const keys = codes.map((code) => {
    const key = remoteScreenKeyForCode(code);
    if (!key) throw new TypeError(`No screen key for ${code}`);
    return key;
  });
  return [
    ...keys.map((key): RemoteScreenInput => ({ type: 'screen-key', action: 'down', ...key })),
    ...[...keys].reverse().map((key): RemoteScreenInput => ({ type: 'screen-key', action: 'up', ...key })),
  ];
}

/** A key pressed down on the phone's keyboard, as screen input. A printable
 *  character is left to the field's text path; a named key (and a chord with
 *  Ctrl, Alt or Win) is sent as keys, pressed and lifted at once. */
export function screenKeyDown(event: ScreenKeyEventLike): ScreenKeyResult {
  if (event.isComposing || event.key === 'Process' || MODIFIER_KEYS.has(event.key)) return NO_KEY;
  const chord = Boolean(event.ctrlKey || event.altKey || event.metaKey);
  if (!chord && [...event.key].length === 1) return NO_KEY;
  // Paste arrives through the paste event, with the text.
  if (chord && event.key.toLowerCase() === 'v') return NO_KEY;
  const code = screenKeyCode(event);
  if (!code) return NO_KEY;
  const modifiers = [
    event.ctrlKey && 'ControlLeft',
    event.altKey && 'AltLeft',
    event.metaKey && 'MetaLeft',
    event.shiftKey && 'ShiftLeft',
  ].filter((modifier): modifier is string => Boolean(modifier));
  const fallback = !event.code || event.keyCode === 229;
  return {
    inputs: screenKeyChord([...modifiers, code]),
    preventDefault: true,
    echo: fallback && (code === 'Backspace' || code === 'Enter') ? code : null,
  };
}

/** Typed or pasted text as `screen-text`, in pieces the contract accepts
 *  (never splitting a surrogate pair). */
export function screenTextInputs(text: string): RemoteScreenInput[] {
  const inputs: RemoteScreenInput[] = [];
  let piece = '';
  for (const character of text) {
    if (piece.length + character.length > MAX_REMOTE_SCREEN_TEXT) {
      inputs.push({ type: 'screen-text', text: piece });
      piece = '';
    }
    piece += character;
  }
  if (piece) inputs.push({ type: 'screen-text', text: piece });
  return inputs;
}

export interface ScreenSpecialKey {
  id: 'ctrl-alt-del' | 'print-screen' | 'escape' | 'tab' | 'win' | 'alt-tab';
  /** The English menu label (the catalog key). */
  label: string;
  /** Pressed in this order, lifted in reverse (1–8 distinct keys). */
  codes: readonly string[];
  /** Menu note: the secure desktop's helper must be installed for it to work. */
  needsHelper?: boolean;
}

/** The ⋯ menu's keys, as Chrome Remote Desktop lists them. No sticky row. */
export const SCREEN_SPECIAL_KEYS: readonly ScreenSpecialKey[] = [
  { id: 'ctrl-alt-del', label: 'Ctrl+Alt+Del', codes: ['ControlLeft', 'AltLeft', 'Delete'], needsHelper: true },
  { id: 'print-screen', label: 'PrintScreen', codes: ['PrintScreen'] },
  { id: 'escape', label: 'Esc', codes: ['Escape'] },
  { id: 'tab', label: 'Tab', codes: ['Tab'] },
  { id: 'win', label: 'Win', codes: ['MetaLeft'] },
  { id: 'alt-tab', label: 'Alt+Tab', codes: ['AltLeft', 'Tab'] },
];

/** A special key as one atomic `screen-keys` combo: the PC presses the keys in
 *  order and lifts them in reverse as a single step, acked `applied` only if
 *  every key went down and up. */
export function screenSpecialKeyInputs(id: ScreenSpecialKey['id']): RemoteScreenInput[] {
  const special = SCREEN_SPECIAL_KEYS.find((candidate) => candidate.id === id);
  if (!special) throw new TypeError(`Unknown special key ${id}`);
  const keys = special.codes.map((code) => {
    const key = remoteScreenKeyForCode(code);
    if (!key) throw new TypeError(`No screen key for ${code}`);
    return key;
  });
  return [{ type: 'screen-keys', keys }];
}

/** The phone keyboard's field: keyboard events and text in, screen input out. */
export function createScreenTextController(options: { emit(inputs: RemoteScreenInput[]): void }) {
  let composing = false;
  /** A key sent from its keydown whose input event may still follow. */
  let echo: ScreenKeyEcho | null = null;
  /** What the IME committed: its own late input of it is not new text. */
  let committed: string | null = null;
  const reset = (field: { value: string; setSelectionRange?(start: number, end: number): void }) => {
    field.value = SCREEN_TEXT_SENTINEL;
    field.setSelectionRange?.(SCREEN_TEXT_SENTINEL.length, SCREEN_TEXT_SENTINEL.length);
  };
  return {
    get composing(): boolean {
      return composing;
    },
    /** Focus puts the sentinel in; blur takes it out so the placeholder shows. */
    focus: reset,
    blur(field: { value: string }): void {
      field.value = '';
      echo = null;
    },
    /** True: the event's default must be prevented. */
    keyDown(event: ScreenKeyEventLike): boolean {
      const result = screenKeyDown({ ...event, isComposing: event.isComposing || composing });
      if (event.keyCode !== 229) committed = null;
      echo = result.echo;
      if (result.inputs.length) options.emit(result.inputs);
      return result.preventDefault;
    },
    keyUp(): void {
      echo = null;
    },
    input(field: { value: string; setSelectionRange?(start: number, end: number): void }, isComposing = false): void {
      if (composing || isComposing) return;
      const raw = field.value;
      reset(field);
      if (raw === '') {
        // The sentinel was deleted: a Backspace the keyboard never keyed.
        if (echo === 'Backspace') echo = null;
        else options.emit(keyPair('Backspace'));
        return;
      }
      const text = raw.split(SCREEN_TEXT_SENTINEL).join('');
      if (!text) return;
      if (echo === 'Enter' && /^[\r\n]+$/u.test(text)) {
        echo = null;
        return;
      }
      if (committed !== null && text === committed) {
        committed = null;
        return;
      }
      committed = null;
      options.emit(screenTextInputs(text));
    },
    compositionStart(): void {
      composing = true;
      committed = null;
    },
    /** The IME's final text; its field is cleared and the text goes out. */
    compositionEnd(text: string, field: { value: string; setSelectionRange?(start: number, end: number): void }): void {
      composing = false;
      reset(field);
      if (!text) return;
      committed = text;
      options.emit(screenTextInputs(text));
    },
    /** The bar's send button: Enter, pressed and lifted (a composition is finished first by the caller). */
    submit(): void {
      options.emit(keyPair('Enter'));
    },
    paste(text: string): void {
      if (text) options.emit(screenTextInputs(text));
    },
  };
}
