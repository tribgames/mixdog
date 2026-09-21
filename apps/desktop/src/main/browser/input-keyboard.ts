/**
 * Keyboard input the way a page expects it from a real keyboard: a named key
 * or shortcut becomes rawKeyDown / char / keyUp with the physical key code
 * behind it, and typed text is one key event per character so a search box
 * that reacts on keydown sees every keystroke.
 */
import type { WebContents } from 'electron';

import { normalizeModifierMask, type SendBrowserInput, SHIFT_MODIFIER } from './input-primitives';

interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const KEY_TABLE: Record<string, KeySpec> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

/** US-layout characters whose physical key cannot be derived from the
 *  character itself. Deriving it turns "." into Delete (46) and "-" into
 *  Insert (45) for every page that reads a keydown's code. */
const CHARACTER_KEYS: Record<string, { code: string; keyCode: number; shift?: boolean }> = {
  ' ': { code: 'Space', keyCode: 32 },
  '`': { code: 'Backquote', keyCode: 192 },
  '~': { code: 'Backquote', keyCode: 192, shift: true },
  '-': { code: 'Minus', keyCode: 189 },
  _: { code: 'Minus', keyCode: 189, shift: true },
  '=': { code: 'Equal', keyCode: 187 },
  '+': { code: 'Equal', keyCode: 187, shift: true },
  '[': { code: 'BracketLeft', keyCode: 219 },
  '{': { code: 'BracketLeft', keyCode: 219, shift: true },
  ']': { code: 'BracketRight', keyCode: 221 },
  '}': { code: 'BracketRight', keyCode: 221, shift: true },
  '\\': { code: 'Backslash', keyCode: 220 },
  '|': { code: 'Backslash', keyCode: 220, shift: true },
  ';': { code: 'Semicolon', keyCode: 186 },
  ':': { code: 'Semicolon', keyCode: 186, shift: true },
  "'": { code: 'Quote', keyCode: 222 },
  '"': { code: 'Quote', keyCode: 222, shift: true },
  ',': { code: 'Comma', keyCode: 188 },
  '<': { code: 'Comma', keyCode: 188, shift: true },
  '.': { code: 'Period', keyCode: 190 },
  '>': { code: 'Period', keyCode: 190, shift: true },
  '/': { code: 'Slash', keyCode: 191 },
  '?': { code: 'Slash', keyCode: 191, shift: true },
  '!': { code: 'Digit1', keyCode: 49, shift: true },
  '@': { code: 'Digit2', keyCode: 50, shift: true },
  '#': { code: 'Digit3', keyCode: 51, shift: true },
  $: { code: 'Digit4', keyCode: 52, shift: true },
  '%': { code: 'Digit5', keyCode: 53, shift: true },
  '^': { code: 'Digit6', keyCode: 54, shift: true },
  '&': { code: 'Digit7', keyCode: 55, shift: true },
  '*': { code: 'Digit8', keyCode: 56, shift: true },
  '(': { code: 'Digit9', keyCode: 57, shift: true },
  ')': { code: 'Digit0', keyCode: 48, shift: true },
};

export function assertBrowserKeyDoesNotAccessClipboard(rawKey: string): void {
  const parts = String(rawKey || '')
    .trim()
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const key = parts.at(-1) || '';
  const modifiers = new Set(parts.slice(0, -1));
  const controlOrMeta =
    modifiers.has('control') ||
    modifiers.has('ctrl') ||
    modifiers.has('meta') ||
    modifiers.has('command') ||
    modifiers.has('cmd');
  const clipboardLetter = key === 'c' || key === 'v' || key === 'x';
  const clipboardInsert = key === 'insert' && (controlOrMeta || modifiers.has('shift'));
  if ((controlOrMeta && clipboardLetter) || clipboardInsert) {
    throw new Error('Browser Use press cannot access the system clipboard');
  }
}

/** The physical key behind one character. A single `press` and typed text
 *  share it, so both report the same code, key code and shift state. */
function characterKey(character: string): { code: string; keyCode: number; shift: boolean } {
  const mapped = CHARACTER_KEYS[character];
  if (mapped) return { code: mapped.code, keyCode: mapped.keyCode, shift: mapped.shift ?? false };
  const letter = /^[a-z]$/i.test(character);
  const digit = /^[0-9]$/.test(character);
  // An unmapped character (any non-US-layout letter) keeps the empty code
  // and zero key code a browser reports for it.
  let code = '';
  if (letter) code = `Key${character.toUpperCase()}`;
  else if (digit) code = `Digit${character}`;
  return {
    code,
    keyCode: letter || digit ? character.toUpperCase().charCodeAt(0) : 0,
    // Only a shifted punctuation mark carries Shift by itself. "Control+A"
    // names the A key, not Control+Shift+A, so a letter never adds it here.
    shift: false,
  };
}

interface KeyPress {
  spec: KeySpec;
  modifierBits: number;
  /** Shift still types a character; any other modifier makes it a shortcut. */
  typesText: boolean;
}

/** "Control+Shift+p", "enter", "+": the modifiers and the one key they hold,
 *  resolved to the event fields a page reads. */
function resolveKeyPress(rawKey: string): KeyPress {
  const raw = String(rawKey || '').trim();
  const plus = raw.endsWith('+');
  const parts = (plus ? raw.slice(0, -1) : raw)
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (plus) parts.push('+');
  const keyName = parts.pop() || '';
  const modifierNames = new Set(parts.map((part) => part.toLowerCase()));
  const character = keyName.length === 1 ? characterKey(keyName) : null;
  // A shifted character is Shift plus its base key; sending the base key
  // without Shift is a combination no keyboard can produce.
  const modifierBits = normalizeModifierMask([...modifierNames]) | (character?.shift ? SHIFT_MODIFIER : 0);
  const typesText = (modifierBits & ~SHIFT_MODIFIER) === 0;
  const normalized = keyName.toLowerCase();
  const typed = modifierNames.has('shift') ? keyName.toUpperCase() : keyName;
  let printable: KeySpec | null = null;
  if (character) {
    printable = { key: typed, code: character.code, keyCode: character.keyCode, text: typesText ? typed : undefined };
  }
  const functionKey: KeySpec | null = /^f([1-9]|1\d|2[0-4])$/.test(normalized)
    ? {
        key: normalized.toUpperCase(),
        code: normalized.toUpperCase(),
        keyCode: 111 + Number(normalized.slice(1)),
        text: undefined,
      }
    : null;
  const spec = KEY_TABLE[normalized] || printable || functionKey;
  if (!spec) {
    throw new Error(
      `unsupported key "${rawKey}"; use a character, modifier combination, or one of: ${Object.keys(KEY_TABLE).join(', ')}`
    );
  }
  return { spec, modifierBits, typesText };
}

export function createKeyboardInput(send: SendBrowserInput, options: { allowClipboard?: boolean }) {
  async function pressKey(guest: WebContents, rawKey: string, signal?: AbortSignal): Promise<void> {
    if (!options.allowClipboard) assertBrowserKeyDoesNotAccessClipboard(rawKey);
    const { spec, modifierBits, typesText } = resolveKeyPress(rawKey);
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers: modifierBits,
    };
    if ((await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, signal)) === 'dialog') return;
    // Control+Enter is a shortcut, not a newline: a shortcut never types.
    if (spec.text && typesText) {
      if (
        (await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'char', text: spec.text }, signal)) === 'dialog'
      )
        return;
    }
    await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, signal);
  }

  /** Typing the way a person does: one key event per character, so a search
   *  box that opens suggestions on keydown, or an editor that watches keys,
   *  reacts to it. Replacing a whole value in one step is `fill`. */
  async function typeText(guest: WebContents, text: string, signal?: AbortSignal): Promise<void> {
    for (const character of String(text ?? '')) {
      if (character === '\r') continue;
      if (character === '\n') {
        await pressKey(guest, 'enter', signal);
        continue;
      }
      const spec = characterKey(character);
      if (!spec.code) {
        // Outside the US layout — Korean, an accent, an emoji — no physical
        // key produces the character, so the browser's own text insertion
        // carries it and the page still sees an input event.
        if ((await send(guest, 'Input.insertText', { text: character }, signal)) === 'dialog') return;
        continue;
      }
      // Typing an uppercase letter is Shift plus its key, the way a person
      // produces it; pressing one as a shortcut key is not.
      const shifted = spec.shift || /^[A-Z]$/.test(character);
      const base = {
        key: character,
        code: spec.code,
        windowsVirtualKeyCode: spec.keyCode,
        nativeVirtualKeyCode: spec.keyCode,
        modifiers: shifted ? SHIFT_MODIFIER : 0,
      };
      if (
        (await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: character }, signal)) ===
        'dialog'
      )
        return;
      if ((await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, signal)) === 'dialog') return;
    }
  }

  return { pressKey, typeText };
}
