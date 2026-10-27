// The phone's keyboard for the whole-PC screen view (docs/remote-screen.md):
// what typed text and the bar's keys become as `screen-text` / `screen-key`
// input, and the Chrome-Remote-Desktop-style special keys. The bar sends at
// once (remote-send-bar.ts): text goes only on Send. Pure: no DOM, so each
// rule is tested on plain objects.
import { remoteScreenKeyForCode } from '../shared/remote-screen';
import { MAX_REMOTE_SCREEN_TEXT, type RemoteScreenInput } from '../shared/remote-webrtc';
import { createSendBar, type SendBarKey } from './remote-send-bar';

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
  ContextMenu: 'ContextMenu',
  ' ': 'Space',
};

function codeFromKey(key: string): string | null {
  const named = KEY_NAME_CODES[key];
  if (named) return named;
  if (/^F(?:[1-9]|1[0-2])$/u.test(key)) return key;
  if (/^[a-z]$/iu.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/u.test(key)) return `Digit${key}`;
  return null;
}

/** The `code` a key press stands for: its own when the keyboard reports one,
 *  else the one its `key` names. */
export function screenKeyCode(press: Pick<SendBarKey, 'key' | 'code' | 'keyCode'>): string | null {
  if (press.code && press.keyCode !== 229 && remoteScreenKeyForCode(press.code)) return press.code;
  return codeFromKey(press.key);
}

/** A routed key or chord as pressed-and-lifted `screen-key` input; Ctrl, Alt,
 *  Win and Shift go down first and up last. A key with no code sends nothing. */
export function screenKeyPress(press: SendBarKey): RemoteScreenInput[] {
  const code = screenKeyCode(press);
  if (!code) return [];
  const modifiers = [
    press.ctrlKey && 'ControlLeft',
    press.altKey && 'AltLeft',
    press.metaKey && 'MetaLeft',
    press.shiftKey && 'ShiftLeft',
  ].filter((modifier): modifier is string => Boolean(modifier));
  return screenKeyChord([...modifiers, code]);
}

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

/** The bar's text as `screen-text`, in pieces the contract accepts
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

/** The phone bar's field: typing stays in the bar; Send (or Enter) delivers
 *  its whole text as `screen-text`, or an Enter key when the bar is empty.
 *  Special keys and chords go to the PC as keys (remote-send-bar.ts decides
 *  which stay in the bar while it has text). */
export function createScreenTextController(options: { emit(inputs: RemoteScreenInput[]): void }) {
  return createSendBar({
    text: (text) => options.emit(screenTextInputs(text)),
    key: (press) => {
      const inputs = screenKeyPress(press);
      if (inputs.length) options.emit(inputs);
    },
  });
}
