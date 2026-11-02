/** The key grammar of Computer Use, read as the key chords the browser key
 *  table (`browser/input-keyboard`) sends to a renderer. */
import { normalizeComputerKeySequence } from '../input/keyboard';

/** Named keys of the SendKeys grammar `normalizeComputerKeySequence` emits,
 *  by the name the browser key table knows. */
const NAMED_KEYS: Record<string, string> = {
  BACKSPACE: 'backspace',
  TAB: 'tab',
  ENTER: 'enter',
  ESC: 'escape',
  SPACE: 'space',
  PGUP: 'pageup',
  PGDN: 'pagedown',
  HOME: 'home',
  END: 'end',
  LEFT: 'arrowleft',
  UP: 'arrowup',
  RIGHT: 'arrowright',
  DOWN: 'arrowdown',
  DELETE: 'delete',
  PLUS: '+',
  MINUS: '-',
};
const MODIFIER_NAMES: Record<string, string> = { '^': 'control', '%': 'alt', '+': 'shift', '#': 'meta' };

function namedKey(name: string): string {
  const upper = name.toUpperCase();
  const key = NAMED_KEYS[upper] ?? (/^F([1-9]|1\d|2[0-4])$/.test(upper) ? upper.toLowerCase() : undefined);
  if (!key) {
    throw new Error(`background_unsupported: key {${name}} has no Electron input mapping; no input was sent`);
  }
  return key;
}

/** One chord per press, e.g. "control+alt+arrowleft", read from the
 *  normalized SendKeys grammar so the Electron route accepts exactly what the
 *  native one does. */
export function electronKeyPresses(sequence: string): string[] {
  const grammar = normalizeComputerKeySequence(sequence);
  // A single character is the literal key, even when it is grammar syntax.
  if ([...grammar].length === 1) return [grammar.toLowerCase()];
  const presses: string[] = [];
  let index = 0;
  while (index < grammar.length) {
    const modifiers: string[] = [];
    while (MODIFIER_NAMES[grammar[index]]) modifiers.push(MODIFIER_NAMES[grammar[index++]]);
    let key: string;
    let repeat = 1;
    if (grammar[index] === '{') {
      const end = grammar.indexOf('}', index);
      const named = /^(\S+)(?:\s+(\d+))?$/.exec(grammar.slice(index + 1, end));
      key = namedKey(named![1]);
      repeat = Number(named![2] ?? 1);
      index = end + 1;
    } else {
      const character = String.fromCodePoint(grammar.codePointAt(index)!);
      key = character.toLowerCase();
      index += character.length;
    }
    for (let count = 0; count < repeat; count++) presses.push([...modifiers, key].join('+'));
  }
  return presses;
}
