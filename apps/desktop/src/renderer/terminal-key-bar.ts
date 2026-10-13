// Phone key bar: the keys a soft keyboard lacks, plus sticky Ctrl/Alt. Pure
// sequence/modifier logic; TerminalKeyBar.tsx renders it and TerminalPane.tsx
// feeds the result through the same input path as typed text.

export type TerminalBarKey = 'esc' | 'tab' | 'up' | 'down' | 'right' | 'left' | 'ctrl-c';

export interface TerminalModifiers {
  ctrl: boolean;
  alt: boolean;
}

const ARROW_FINAL: Record<'up' | 'down' | 'right' | 'left', string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

/** Bytes a bar key sends. Arrows follow xterm's cursor-key mode (DECCKM). */
export function terminalBarSequence(key: TerminalBarKey, applicationCursorKeys = false): string {
  switch (key) {
    case 'esc':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'ctrl-c':
      return '\x03';
    default:
      return `\x1b${applicationCursorKeys ? 'O' : '['}${ARROW_FINAL[key]}`;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC-led arrow sequence is the point.
const ARROW_SEQUENCE = /^\x1b[[O]([ABCD])$/u;

/** Applies sticky modifiers to one input chunk. Arrows become xterm-style
 *  modified CSI (`ESC [ 1 ; <mod> <final>`), a single character becomes its
 *  Ctrl code and/or gains the Alt (ESC) prefix; anything else passes through. */
export function applyTerminalModifiers(data: string, { ctrl, alt }: TerminalModifiers): string {
  if (!ctrl && !alt) return data;
  const arrow = ARROW_SEQUENCE.exec(data);
  if (arrow) return `\x1b[1;${1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)}${arrow[1]}`;
  if ([...data].length !== 1) return data;
  let out = data;
  if (ctrl) {
    const code = data.charCodeAt(0);
    if (data === ' ') out = '\x00';
    else if (data === '?') out = '\x7f';
    else if ((code >= 0x40 && code <= 0x5f) || (code >= 0x61 && code <= 0x7a)) out = String.fromCharCode(code & 0x1f);
  }
  return alt ? `\x1b${out}` : out;
}

/** Sticky Ctrl/Alt for one terminal: a toggle arms it, the next input
 *  (typed or bar key) consumes it. */
export class StickyModifiers {
  private state: TerminalModifiers = { ctrl: false, alt: false };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): TerminalModifiers => this.state;

  toggle(name: keyof TerminalModifiers): void {
    this.state = { ...this.state, [name]: !this.state[name] };
    this.emit();
  }

  /** Returns the armed modifiers and clears them. */
  take(): TerminalModifiers {
    const armed = this.state;
    if (armed.ctrl || armed.alt) {
      this.state = { ctrl: false, alt: false };
      this.emit();
    }
    return armed;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const modifiersByTerminal = new Map<string, StickyModifiers>();

export function terminalModifiers(key: string): StickyModifiers {
  let modifiers = modifiersByTerminal.get(key);
  if (!modifiers) {
    modifiers = new StickyModifiers();
    modifiersByTerminal.set(key, modifiers);
  }
  return modifiers;
}

export function forgetTerminalModifiers(key: string): void {
  modifiersByTerminal.delete(key);
}
