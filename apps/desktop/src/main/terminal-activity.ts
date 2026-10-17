// Command activity of one PTY, read from the private OSC markers that
// Mixdog's own shell integration (terminal-shell-integration.ts) prints:
//   ESC ] 697 ; P BEL        a prompt is showing
//   ESC ] 697 ; C BEL        the line just entered starts running
//   ESC ] 697 ; D ; <n> BEL  the command finished with exit code n
// (ST = ESC \ is accepted in place of BEL.) The scanner removes every complete
// marker from the stream before it is buffered or shown, so a replay trimmed
// mid-sequence can never expose marker text.
import { TERMINAL_FOCUS_LEASE_MS, type TerminalActivityState } from '../shared/terminal-activity';

export type TerminalMarker = { kind: 'prompt' } | { kind: 'start' } | { kind: 'done'; exitCode: number | null };

export const TERMINAL_MARKER_PREFIX = '\x1b]697;';
/** Longest marker body worth waiting for across chunks ("D;-2147483648"). */
const MAX_MARKER_BODY = 24;

function parseMarker(body: string): TerminalMarker | null {
  if (body === 'P') return { kind: 'prompt' };
  if (body === 'C') return { kind: 'start' };
  if (body === 'D') return { kind: 'done', exitCode: null };
  const done = /^D;(-?\d{1,10})$/.exec(body);
  return done ? { kind: 'done', exitCode: Number(done[1]) } : null;
}

/** Streaming marker reader and stripper. A chunk ending where a marker may
 *  begin holds that tail back until the next chunk (or flush()) decides it;
 *  every complete marker is removed from the returned text. */
export class TerminalMarkerScanner {
  private carry = '';

  /** Text is held back, waiting for the rest of a possible marker. */
  get pending(): boolean {
    return this.carry.length > 0;
  }

  /** Release held-back text as output (no further chunk is coming soon). */
  flush(): string {
    const held = this.carry;
    this.carry = '';
    return held;
  }

  scan(data: string): { text: string; markers: TerminalMarker[] } {
    const input = this.carry ? this.carry + data : data;
    this.carry = '';
    const markers: TerminalMarker[] = [];
    let text = '';
    let from = 0;
    let search = 0;
    for (;;) {
      const start = input.indexOf(TERMINAL_MARKER_PREFIX, search);
      if (start === -1) break;
      const body = start + TERMINAL_MARKER_PREFIX.length;
      const window = input.slice(body, body + MAX_MARKER_BODY + 2);
      const bel = window.indexOf('\x07');
      const st = window.indexOf('\x1b\\');
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      if (end === -1 || end > MAX_MARKER_BODY) {
        // Unterminated so far: hold it for the rest, unless it is already too
        // long to be a marker (then it is ordinary output).
        if (end === -1 && input.length - body <= MAX_MARKER_BODY) {
          this.carry = input.slice(start);
          return { text: text + input.slice(from, start), markers };
        }
        search = body;
        continue;
      }
      const marker = parseMarker(window.slice(0, end));
      if (marker) markers.push(marker);
      text += input.slice(from, start);
      from = search = body + end + (end === bel ? 1 : 2);
    }
    // A chunk ending inside the prefix itself ("…\x1b]69").
    let held = 0;
    for (let length = Math.min(TERMINAL_MARKER_PREFIX.length - 1, input.length - from); length > 0; length -= 1) {
      if (input.endsWith(TERMINAL_MARKER_PREFIX.slice(0, length))) {
        held = length;
        break;
      }
    }
    this.carry = held ? input.slice(-held) : '';
    return { text: text + input.slice(from, input.length - held), markers };
  }
}

export interface TerminalActivityOptions {
  /** The integration reports prompts only (cmd): a line submitted at a
   *  prompt is what starts a command. */
  inferStartFromSubmit?: boolean;
}

/** One PTY's activity state. Starts unknown (null); only markers move it, so
 *  a shell without integration never leaves unknown. */
export class TerminalActivityTracker {
  private current: TerminalActivityState | null = null;
  private readonly focus = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly onChange: (state: TerminalActivityState | null) => void,
    private readonly options: TerminalActivityOptions = {}
  ) {}

  get state(): TerminalActivityState | null {
    return this.current;
  }

  get focused(): boolean {
    return this.focus.size > 0;
  }

  marker(marker: TerminalMarker): void {
    if (marker.kind === 'start') this.start();
    else if (this.current === 'running') this.set(this.focused ? 'idle' : 'finished');
    else if (marker.kind === 'prompt' && this.current === null) this.set('idle');
  }

  /** Input written to the PTY (keystrokes, pastes, agent commands). */
  input(data: string): void {
    if (!this.options.inferStartFromSubmit || (this.current !== 'idle' && this.current !== 'finished')) return;
    if (data.includes('\r')) this.start();
  }

  /** `client` names one view (the desktop window, one phone connection). A
   *  focus claim lasts TERMINAL_FOCUS_LEASE_MS unless renewed. */
  setFocus(client: string, focused: boolean): void {
    const lease = this.focus.get(client);
    if (lease) clearTimeout(lease);
    this.focus.delete(client);
    if (!focused) return;
    const next = setTimeout(() => this.focus.delete(client), TERMINAL_FOCUS_LEASE_MS);
    next.unref?.();
    this.focus.set(client, next);
    if (this.current === 'finished') this.set('idle');
  }

  /** The shell exited: nothing reports any more. */
  exit(): void {
    this.dispose();
    if (this.current !== null) this.set(null);
  }

  dispose(): void {
    for (const lease of this.focus.values()) clearTimeout(lease);
    this.focus.clear();
  }

  private start(): void {
    this.set('running');
  }

  private set(state: TerminalActivityState | null): void {
    if (this.current === state) return;
    this.current = state;
    this.onChange(state);
  }
}
