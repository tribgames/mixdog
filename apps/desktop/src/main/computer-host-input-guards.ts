/**
 * What Computer Use refuses before dispatch: destructive key chords, shell
 * payloads in typed text, and launch targets that are really a shell. These are
 * decided by the command alone, so they hold wherever the host runs.
 */
import type { ComputerCommand } from './computer-host-types';

export const MAX_COMPUTER_TYPE_TEXT_LENGTH = 30_000;
export const MAX_COMPUTER_KEY_SEQUENCE_LENGTH = 512;
export const MAX_COMPUTER_CLIPBOARD_TEXT_LENGTH = 50_000;

export const BLOCKED_COMPUTER_KEY_PATTERNS = [
  /%\{F4\}/i,
  /\^%\{(?:DEL|DELETE)\}/i,
  /#(?:L|\{L\})/i,
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

export function assertSafeComputerInput(command: ComputerCommand): void {
  if (command.action === 'key') {
    const keys = String(command.keys || '').replace(/\s+/g, '');
    if (keys.length > MAX_COMPUTER_KEY_SEQUENCE_LENGTH) {
      throw new Error(`input_too_large: key sequence exceeds ${MAX_COMPUTER_KEY_SEQUENCE_LENGTH} characters`);
    }
    if (BLOCKED_COMPUTER_KEY_PATTERNS.some((pattern) => pattern.test(keys))) {
      throw new Error('blocked_input: destructive or session-ending key combination');
    }
  }
  if (command.action === 'type' || command.action === 'set_value') {
    const text = String(command.text || '');
    if (text.length > MAX_COMPUTER_TYPE_TEXT_LENGTH) {
      throw new Error(`input_too_large: type text exceeds ${MAX_COMPUTER_TYPE_TEXT_LENGTH} characters`);
    }
    if (BLOCKED_COMPUTER_TYPE_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new Error('blocked_input: dangerous shell payload in type text');
    }
  }
  if (command.action === 'clipboard_write'
    && String(command.text || '').length > MAX_COMPUTER_CLIPBOARD_TEXT_LENGTH) {
    throw new Error(
      `input_too_large: clipboard text exceeds ${MAX_COMPUTER_CLIPBOARD_TEXT_LENGTH} characters`,
    );
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
