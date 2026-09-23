const KEY_ALIASES = new Map<string, string>([
  ['backspace', 'BACKSPACE'],
  ['bs', 'BACKSPACE'],
  ['tab', 'TAB'],
  ['enter', 'ENTER'],
  ['return', 'ENTER'],
  ['esc', 'ESC'],
  ['escape', 'ESC'],
  ['space', 'SPACE'],
  ['pageup', 'PGUP'],
  ['pgup', 'PGUP'],
  ['pagedown', 'PGDN'],
  ['pgdn', 'PGDN'],
  ['home', 'HOME'],
  ['end', 'END'],
  ['left', 'LEFT'],
  ['arrowleft', 'LEFT'],
  ['up', 'UP'],
  ['arrowup', 'UP'],
  ['right', 'RIGHT'],
  ['arrowright', 'RIGHT'],
  ['down', 'DOWN'],
  ['arrowdown', 'DOWN'],
  ['insert', 'INSERT'],
  ['ins', 'INSERT'],
  ['delete', 'DELETE'],
  ['del', 'DELETE'],
  ['plus', 'PLUS'],
  ['minus', 'MINUS'],
  // A modifier is a key in its own right when it is held or tapped alone,
  // which is what key_down/key_up ask for.
  ['shift', 'SHIFT'],
  ['ctrl', 'CTRL'],
  ['control', 'CTRL'],
  ['alt', 'ALT'],
  ['capslock', 'CAPSLOCK'],
  ['numlock', 'NUMLOCK'],
  ['scrolllock', 'SCROLLLOCK'],
  ['win', 'LWIN'],
  ['windows', 'LWIN'],
  ['lwin', 'LWIN'],
  ['super', 'LWIN'],
  ['meta', 'LWIN'],
  ['apps', 'APPS'],
  ['contextmenu', 'APPS'],
  ['printscreen', 'PRTSC'],
  ['prtsc', 'PRTSC'],
  ['prtscr', 'PRTSC'],
  ['pause', 'PAUSE'],
]);

/** Actions whose `keys` field carries a sequence that must be normalized. */
export const KEY_SEQUENCE_ACTIONS = new Set(['key', 'key_down', 'key_up']);

const MODIFIER_GRAMMAR = new Map<string, string>([
  ['ctrl', '^'],
  ['control', '^'],
  ['cmdorctrl', '^'],
  ['commandorcontrol', '^'],
  ['alt', '%'],
  ['option', '%'],
  ['shift', '+'],
  // The Windows key; the worker grammar spells it '#'.
  ['win', '#'],
  ['windows', '#'],
  ['window', '#'],
  ['super', '#'],
  ['meta', '#'],
]);

const LEGACY_NAMED_KEYS = new Set([...KEY_ALIASES.values(), 'NUMLOCK', 'CAPSLOCK', 'SCROLLLOCK']);

function canonicalToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function normalizedKeyToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '+') return '{PLUS}';
  if (trimmed === '-') return '{MINUS}';
  const braced = trimmed.match(/^\{([^{}]+)\}$/);
  const canonical = canonicalToken(braced ? braced[1] : trimmed);
  const alias = KEY_ALIASES.get(canonical);
  if (alias) return `{${alias}}`;
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(canonical)) {
    return `{${canonical.toUpperCase()}}`;
  }
  if (/^[a-z0-9]$/.test(canonical)) return canonical.toUpperCase();
  const codePoints = [...trimmed];
  if (codePoints.length === 1 && !/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    return trimmed;
  }
  throw new Error(`invalid_key_chord: unsupported key token '${value.trim()}'`);
}

function canonicalChord(value: string): string | undefined {
  let remaining = value.trim();
  const modifiers: string[] = [];
  const modifierPrefix =
    /^(commandorcontrol|cmdorctrl|control|ctrl|command|cmd|meta|windows|window|super|win|option|alt|shift)\s*[+-]\s*(?=.)/i;
  while (remaining) {
    const match = remaining.match(modifierPrefix);
    if (!match) break;
    const grammar = MODIFIER_GRAMMAR.get(canonicalToken(match[1]));
    if (!grammar) {
      // cmd/command is ambiguous on Windows: a macOS shortcut means ctrl, the
      // key itself means win.
      throw new Error(
        `invalid_key_chord: unsupported modifier '${match[1]}'; on Windows use ctrl for app shortcuts or win for the Windows key`
      );
    }
    if (!modifiers.includes(grammar)) modifiers.push(grammar);
    remaining = remaining.slice(match[0].length);
  }
  if (!modifiers.length) return undefined;
  return `${modifiers.join('')}${normalizedKeyToken(remaining)}`;
}

function validLegacyNamedKey(value: string): boolean {
  const match = value.trim().match(/^([A-Za-z]+[0-9]*)(?:\s+([0-9]{1,3}))?$/);
  if (!match) return false;
  const token = match[1].toUpperCase();
  const validToken = LEGACY_NAMED_KEYS.has(token) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(token);
  if (!validToken) return false;
  if (!match[2]) return true;
  const repeat = Number(match[2]);
  return repeat >= 1 && repeat <= 100;
}

function validLegacySequence(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    let modifierCount = 0;
    while (index < value.length && '^%+#'.includes(value[index])) {
      modifierCount += 1;
      index += 1;
    }
    if (index >= value.length) return false;
    if (value[index] === '{') {
      const end = value.indexOf('}', index + 1);
      if (end < 0 || !validLegacyNamedKey(value.slice(index + 1, end))) return false;
      index = end + 1;
      continue;
    }
    if (modifierCount === 0 || !/[A-Za-z0-9]/.test(value[index])) return false;
    index += 1;
  }
  return true;
}

/**
 * Public Computer Use accepts conventional chords such as ctrl+alt+escape.
 * The Windows worker consumes SendKeys grammar, so translate only recognized
 * chords and preserve the legacy grammar used by existing internal callers.
 */
export function normalizeComputerKeySequence(value: string): string {
  const source = String(value || '');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(source)) {
    throw new Error('invalid_key_chord: key sequence contains control characters');
  }
  const raw = source.trim();
  if (!raw) throw new Error('invalid_key_chord: key sequence is empty');
  const chord = canonicalChord(raw);
  if (chord) return chord;
  // A plus on its own is the character the caller wants. As a named token it
  // would land on the '=' key it shares a virtual code with, and as grammar it
  // would read as a shift prefix, so the worker receives it as literal text.
  if (raw === '+' || canonicalToken(raw) === 'plus') return '+';
  // A lone '#' is the character; longer, it is the Windows-key grammar this
  // function itself emits, so normalizing twice stays stable.
  if (/[\^%{}~()]/.test(raw) || raw.startsWith('+') || (raw.length > 1 && raw.includes('#'))) {
    if (validLegacySequence(raw)) return raw;
    throw new Error(`invalid_key_chord: malformed legacy key sequence '${raw}'`);
  }
  return normalizedKeyToken(raw);
}
