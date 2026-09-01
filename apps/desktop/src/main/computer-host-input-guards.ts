/**
 * What Computer Use refuses before dispatch: destructive key chords, shell
 * payloads in typed text, and launch targets that are really a shell. These are
 * decided by the command alone, so they hold wherever the host runs.
 */
import type { ComputerCommand } from './computer-host-types';
import { normalizeComputerKeySequence } from './computer-host-keyboard';

export const MAX_COMPUTER_TYPE_TEXT_LENGTH = 30_000;
export const MAX_COMPUTER_KEY_SEQUENCE_LENGTH = 512;
export const MAX_COMPUTER_POINTER_MODIFIERS_LENGTH = 32;
export const MAX_COMPUTER_TARGET_TOKEN_LENGTH = 4_096;
export const MAX_COMPUTER_MENU_LABEL_LENGTH = 512;
export const MAX_COMPUTER_STRUCTURED_ITEMS = 8;
export const MAX_COMPUTER_CLIPBOARD_TEXT_LENGTH = 50_000;

export const BLOCKED_COMPUTER_KEY_PATTERN_SOURCE = [
  String.raw`(?=[%+^]*%)[%+^]*\{F4(?:\s+\d{1,3})?\}`,
  String.raw`(?=[%+^]*\^)(?=[%+^]*%)[%+^]*\{(?:DEL|DELETE|END)(?:\s+\d{1,3})?\}`,
  String.raw`(?=[%+^]*\+)[%+^]*\{(?:DEL|DELETE)(?:\s+\d{1,3})?\}`,
  String.raw`#(?:L|\{L\})`,
].map((source) => `(?:${source})`).join('|');

export const BLOCKED_COMPUTER_KEY_PATTERNS = [
  new RegExp(BLOCKED_COMPUTER_KEY_PATTERN_SOURCE, 'i'),
];

export const BLOCKED_COMPUTER_TYPE_PATTERNS = [
  /\bcurl\b[^|\r\n]*\|\s*(?:bash|sh)\b/i,
  /\bwget\b[^|\r\n]*\|\s*(?:bash|sh)\b/i,
  /\bsudo\s+rm\s+-[^\r\n]*[rf]/i,
  /\brm\s+-rf\s+\/\s*$/i,
  /:\s*\(\)\s*\{\s*:\|:\s*&\s*\}/,
];

export const BLOCKED_COMPUTER_LAUNCH_ALWAYS_PATTERNS = [
  /[\r\n\0]|javascript:/i,
];
export const BLOCKED_COMPUTER_NON_HTTP_LAUNCH_PATTERNS = [
  /&&|\|\|/,
  /(?:^|[\\/"'])\s*(?:cmd|powershell|pwsh|wt|wsl|bash|sh|zsh|fish|nu|wscript|cscript|mshta|rundll32|regsvr32)(?:\.exe)?(?:["'\s]|$)/i,
  /\.(?:bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|appref-ms)(?:["']?\s*)$/i,
];

export function assertSafeComputerTargetTokens(command: ComputerCommand): void {
  const targetTokens = [
    ['window', command.window],
    ['window_id', command.window_id],
    ['frame_id', command.frame_id],
    ['ref', command.ref],
    ['to', command.to],
    ['app', command.app],
  ] as const;
  for (const [field, value] of targetTokens) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new Error(`invalid_target: ${field} must be a string`);
    }
    if (typeof value === 'string' && !value.trim()) {
      throw new Error(`invalid_target: ${field} must not be empty`);
    }
  }
  for (const [field, value] of [
    ...targetTokens,
    ['query', command.query],
    ['role', command.role],
    ['continuation', command.continuation],
  ] as const) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new Error(`invalid_input: ${field} must be a string`);
    }
    if (typeof value === 'string' && value.length > MAX_COMPUTER_TARGET_TOKEN_LENGTH) {
      throw new Error(
        `input_too_large: ${field} exceeds ${MAX_COMPUTER_TARGET_TOKEN_LENGTH} characters`,
      );
    }
  }
  if (command.path !== undefined && command.path !== null) {
    if (!Array.isArray(command.path) || command.path.some((label) => typeof label !== 'string')) {
      throw new Error('invalid_menu_path: path must contain only string labels');
    }
    if (command.path.length < 1 || command.path.length > MAX_COMPUTER_STRUCTURED_ITEMS) {
      throw new Error(
        `invalid_menu_path: path must contain 1..${MAX_COMPUTER_STRUCTURED_ITEMS} labels`,
      );
    }
    if (command.path.some((label) => label.length > MAX_COMPUTER_MENU_LABEL_LENGTH)) {
      throw new Error(
        `input_too_large: menu label exceeds ${MAX_COMPUTER_MENU_LABEL_LENGTH} characters`,
      );
    }
    if (command.path.some((label) => !label.trim())) {
      throw new Error('invalid_menu_path: menu labels must not be empty');
    }
  }
  if (command.expect !== undefined && command.expect !== null) {
    if (!Array.isArray(command.expect)
      || command.expect.length < 1
      || command.expect.length > MAX_COMPUTER_STRUCTURED_ITEMS) {
      throw new Error(
        `invalid_verify: expect must contain 1..${MAX_COMPUTER_STRUCTURED_ITEMS} predicates`,
      );
    }
    for (const predicate of command.expect) {
      if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) {
        throw new Error('invalid_verify: each expectation must be an object');
      }
      const predicateTypes = {
        present: 'string',
        absent: 'string',
        title_contains: 'string',
        window_exists: 'boolean',
      } as const;
      for (const [field, value] of Object.entries(predicate)) {
        const expectedType = predicateTypes[field as keyof typeof predicateTypes];
        if (!expectedType) {
          throw new Error(`invalid_verify: unknown predicate field ${field}`);
        }
        if (typeof value !== expectedType) {
          throw new Error(`invalid_verify: ${field} must be a ${expectedType}`);
        }
        if (typeof value === 'string' && value.length > MAX_COMPUTER_TARGET_TOKEN_LENGTH) {
          throw new Error(
            `input_too_large: verify text exceeds ${MAX_COMPUTER_TARGET_TOKEN_LENGTH} characters`,
          );
        }
      }
    }
  }
}

export function assertSafeComputerInput(command: ComputerCommand): void {
  if (typeof command.action !== 'string' || !command.action.trim()) {
    throw new Error('invalid_action: action must be a non-empty string');
  }
  assertSafeComputerTargetTokens(command);
  if (command.delivery !== undefined
    && command.delivery !== 'background'
    && command.delivery !== 'foreground') {
    throw new Error('invalid_delivery: delivery must be background or foreground');
  }
  if (command.modifiers !== undefined && command.modifiers !== null) {
    if (typeof command.modifiers !== 'string') {
      throw new Error('invalid_modifiers: modifiers must be a string');
    }
    const modifiers = command.modifiers;
    if (modifiers.length > MAX_COMPUTER_POINTER_MODIFIERS_LENGTH) {
      throw new Error(
        `input_too_large: pointer modifiers exceed ${MAX_COMPUTER_POINTER_MODIFIERS_LENGTH} characters`,
      );
    }
    if (!/^(?:ctrl|shift|alt)(?:\+(?:ctrl|shift|alt))*$/i.test(modifiers)) {
      throw new Error('invalid_modifiers: use only ctrl, shift, or alt joined by +');
    }
    const modifierParts = modifiers.toLowerCase().split('+');
    if (new Set(modifierParts).size !== modifierParts.length) {
      throw new Error('invalid_modifiers: duplicate pointer modifiers are unavailable');
    }
    if (modifierParts.includes('alt')
      && command.delivery !== 'foreground') {
      throw new Error('invalid_modifiers: alt pointer input requires foreground delivery');
    }
  }
  if (command.action === 'scroll') {
    if (command.direction !== undefined
      && !['up', 'down', 'left', 'right'].includes(command.direction)) {
      throw new Error('invalid_scroll: direction must be up, down, left, or right');
    }
    if (command.amount !== undefined
      && (!Number.isInteger(command.amount) || command.amount < 1 || command.amount > 100)) {
      throw new Error('invalid_scroll: amount must be an integer from 1 to 100');
    }
  }
  if (command.action === 'move_window') {
    for (const [field, value] of [
      ['x', command.x],
      ['y', command.y],
      ['width', command.width],
      ['height', command.height],
    ] as const) {
      if (value !== undefined && !Number.isInteger(value)) {
        throw new Error(`invalid_window_bounds: ${field} must be an integer`);
      }
    }
    if (command.width !== undefined && command.width < 1) {
      throw new Error('invalid_window_bounds: width must be positive');
    }
    if (command.height !== undefined && command.height < 1) {
      throw new Error('invalid_window_bounds: height must be positive');
    }
  }
  if (command.action === 'window_state'
    && !['minimize', 'maximize', 'restore'].includes(String(command.state || ''))) {
    throw new Error('invalid_window_state: state must be minimize, maximize, or restore');
  }
  if (command.action === 'key') {
    if (typeof command.keys !== 'string') {
      throw new Error('invalid_key_chord: keys must be a string');
    }
    const rawKeys = command.keys;
    if (rawKeys.length > MAX_COMPUTER_KEY_SEQUENCE_LENGTH) {
      throw new Error(`input_too_large: key sequence exceeds ${MAX_COMPUTER_KEY_SEQUENCE_LENGTH} characters`);
    }
    const keys = normalizeComputerKeySequence(rawKeys);
    if (BLOCKED_COMPUTER_KEY_PATTERNS.some((pattern) => pattern.test(keys))) {
      throw new Error('blocked_input: destructive or session-ending key combination');
    }
  }
  if (command.action === 'type' || command.action === 'set_value') {
    if (typeof command.text !== 'string') {
      throw new Error(`invalid_input: ${command.action} text must be a string`);
    }
    const text = command.text;
    if (text.length > MAX_COMPUTER_TYPE_TEXT_LENGTH) {
      throw new Error(`input_too_large: type text exceeds ${MAX_COMPUTER_TYPE_TEXT_LENGTH} characters`);
    }
    if (BLOCKED_COMPUTER_TYPE_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new Error('blocked_input: dangerous shell payload in type text');
    }
  }
  if (command.action === 'clipboard_write') {
    if (typeof command.text !== 'string') {
      throw new Error('invalid_input: clipboard text must be a string');
    }
    if (command.text.length > MAX_COMPUTER_CLIPBOARD_TEXT_LENGTH) {
      throw new Error(
        `input_too_large: clipboard text exceeds ${MAX_COMPUTER_CLIPBOARD_TEXT_LENGTH} characters`,
      );
    }
  }
  if (command.action === 'launch') {
    const app = String(command.app || '').trim();
    const httpUrl = /^https?:\/\//i.test(app);
    if (!app
      || BLOCKED_COMPUTER_LAUNCH_ALWAYS_PATTERNS.some((pattern) => pattern.test(app))
      || (!httpUrl
        && BLOCKED_COMPUTER_NON_HTTP_LAUNCH_PATTERNS.some((pattern) => pattern.test(app)))) {
      throw new Error('blocked_input: shell, script-host, or shortcut launch is unavailable in Computer Use');
    }
  }
}
