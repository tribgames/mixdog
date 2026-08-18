// Predictive local echo for the REMOTE terminal (relay RTT hides every
// keystroke for a full round trip). Modeled on VS Code's terminal typeahead:
// each predicted keystroke is queued with the exact echo bytes it expects,
// rendered locally only after the shell has proven it echoes canonically, and
// rolled back the moment reality disagrees. Shells that repaint their line on
// every key (PSReadLine over ConPTY, TUI apps, password prompts) never pass
// validation, so predictions stay invisible there and nothing can corrupt.

interface PendingPrediction {
  kind: "char" | "erase";
  /** The typed character ("char") or the character being erased ("erase"). */
  text: string;
  width: 1 | 2;
  /** Rendered predictions already painted the screen; their echo bytes are
   *  consumed on match instead of being written a second time. */
  rendered: boolean;
  at: number;
}

export interface TerminalLocalEchoHooks {
  /** Ordered write into the SAME pump that writes server output. */
  write(data: string): void;
  /** Cursor column when a fresh prediction may render (primary buffer, cursor
   *  at end of line, no queued server output), else null. */
  renderAnchor(): number | null;
  cols(): number;
  now?(): number;
}

/** Consecutive clean echo matches required before predictions become visible
 *  (mosh-style validation: the first keystrokes only measure the shell). */
const VALIDATION_STREAK = 2;
/** A prediction whose echo never arrives (dropped frame, silent shell) must
 *  not leave ghost glyphs behind. */
const PREDICTION_TIMEOUT_MS = 2_000;
/** An OSC longer than this is not a title update; stop carrying it. */
const MAX_CARRY = 4_096;

function cellWidth(char: string): 1 | 2 {
  const cp = char.codePointAt(0) ?? 0;
  return (cp >= 0x1100 && (cp <= 0x115f
    || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd))) ? 2 : 1;
}

function predictableChar(data: string): boolean {
  const points = [...data];
  if (points.length !== 1) return false;
  const cp = points[0].codePointAt(0) ?? 0;
  return cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f);
}

/** Echo variants shells use to erase one character at the end of the line. */
function eraseAlternatives(width: 1 | 2): string[] {
  return width === 2
    ? ["\b\b  \b\b", "\b\b\x1b[K"]
    : ["\b \b", "\b\x1b[K"];
}

type HeadMatch = { kind: "match"; length: number } | { kind: "partial" } | { kind: "no" };

export class TerminalLocalEcho {
  private pending: PendingPrediction[] = [];
  private carry = "";
  private streak = 0;
  /** Screen column where the still-unconfirmed rendered region starts. */
  private anchorCol = -1;
  private timer: ReturnType<typeof setTimeout> | 0 = 0;

  constructor(private readonly hooks: TerminalLocalEchoHooks) {}

  reset(): void {
    this.pending = [];
    this.carry = "";
    this.streak = 0;
    this.anchorCol = -1;
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
  }

  /** Keystroke on its way to the PTY. */
  onInput(data: string): void {
    this.expire();
    if (data === "\x7f") { this.predictBackspace(); return; }
    if (!predictableChar(data)) return;
    const width = cellWidth(data);
    let rendered = false;
    if (this.streak >= VALIDATION_STREAK && this.pending.every((p) => p.rendered)) {
      const col = this.pending.length
        ? this.anchorCol + this.renderedNetWidth()
        : this.hooks.renderAnchor();
      if (col !== null && col >= 0 && col + width <= this.hooks.cols() - 2) {
        if (!this.pending.length) this.anchorCol = col;
        this.hooks.write(data);
        rendered = true;
      }
    }
    this.pending.push({ kind: "char", text: data, width, rendered, at: this.now() });
    this.armTimer();
  }

  /** Server output; returns what should actually reach xterm (rollback
   *  sequences prepended, already-rendered echo bytes consumed). */
  onIncoming(data: string): string {
    this.expire();
    if (!data) return data;
    if (!this.pending.length && !this.carry) return data;
    let input = this.carry + data;
    this.carry = "";
    let out = "";
    while (this.pending.length && input) {
      const head = this.matchHead(input);
      if (head.kind === "partial") {
        if (input.length > MAX_CARRY) return this.mismatch(out, input);
        this.carry = input;
        return out;
      }
      if (head.kind === "match") {
        const p = this.pending.shift()!;
        const eaten = input.slice(0, head.length);
        input = input.slice(head.length);
        if (!p.rendered) out += eaten;
        else if (p.kind === "char") this.anchorCol += p.width;
        this.streak = Math.min(this.streak + 1, 99);
        if (!this.pending.length) this.anchorCol = -1;
        continue;
      }
      const skip = this.safeSkip(input);
      if (skip === "partial") {
        if (input.length > MAX_CARRY) return this.mismatch(out, input);
        this.carry = input;
        return out;
      }
      if (skip) { out += input.slice(0, skip); input = input.slice(skip); continue; }
      return this.mismatch(out, input);
    }
    return out + input;
  }

  private predictBackspace(): void {
    // Only a still-pending predicted character can be erased safely: its glyph
    // and width are known, so the erase echo is predictable and reversible.
    const stack: PendingPrediction[] = [];
    for (const p of this.pending) {
      if (p.kind === "char") stack.push(p);
      else stack.pop();
    }
    const target = stack.at(-1);
    if (!target) return;
    if (target.rendered) {
      this.hooks.write(target.width === 2 ? "\b\b  \b\b" : "\b \b");
    }
    this.pending.push({
      kind: "erase",
      text: target.text,
      width: target.width,
      rendered: target.rendered,
      at: this.now(),
    });
    this.armTimer();
  }

  private matchHead(input: string): HeadMatch {
    const p = this.pending[0];
    const alternatives = p.kind === "char" ? [p.text] : eraseAlternatives(p.width);
    let partial = false;
    for (const alt of alternatives.slice().sort((a, b) => b.length - a.length)) {
      if (input.startsWith(alt)) return { kind: "match", length: alt.length };
      if (alt.startsWith(input)) partial = true;
    }
    return partial ? { kind: "partial" } : { kind: "no" };
  }

  /** Sequences that may pass through the matcher without breaking predictions:
   *  they never move the cursor (SGR colors, cursor visibility, private modes,
   *  OSC titles, keypad modes, BEL). Anything cursor-moving is a mismatch. */
  private safeSkip(input: string): number | "partial" | null {
    if (input[0] === "\x07") return 1;
    if (input[0] !== "\x1b") return null;
    if (input.length === 1) return "partial";
    const kind = input[1];
    if (kind === "=" || kind === ">") return 2;
    if (kind === "]") {
      const bel = input.indexOf("\x07", 2);
      const st = input.indexOf("\x1b\\", 2);
      if (bel === -1 && st === -1) return "partial";
      if (bel !== -1 && (st === -1 || bel < st)) return bel + 1;
      return st + 2;
    }
    if (kind === "[") {
      for (let i = 2; i < input.length; i++) {
        const code = input.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          const final = input[i];
          const params = input.slice(2, i);
          if (final === "m") return i + 1;
          if ((final === "h" || final === "l") && params.startsWith("?")) return i + 1;
          return null;
        }
        if (!(code >= 0x20 && code <= 0x3f)) return null;
      }
      return "partial";
    }
    return null;
  }

  private mismatch(out: string, rest: string): string {
    const rollback = this.rollbackSequence();
    this.pending = [];
    this.carry = "";
    this.streak = 0;
    this.anchorCol = -1;
    return rollback + out + rest;
  }

  private rollbackSequence(): string {
    if (this.anchorCol < 0 || !this.pending.some((p) => p.rendered)) return "";
    return `\x1b[${this.anchorCol + 1}G\x1b[K`;
  }

  private renderedNetWidth(): number {
    let width = 0;
    for (const p of this.pending) width += p.kind === "char" ? p.width : -p.width;
    return width;
  }

  private expire(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
    const oldest = this.pending[0];
    if (oldest && this.now() - oldest.at > PREDICTION_TIMEOUT_MS) {
      const rollback = this.rollbackSequence();
      this.pending = [];
      this.carry = "";
      this.streak = 0;
      this.anchorCol = -1;
      if (rollback) this.hooks.write(rollback);
      return;
    }
    this.armTimer();
  }

  private armTimer(): void {
    if (this.timer || !this.pending.length) return;
    const oldest = this.pending[0];
    const delay = Math.max(50, PREDICTION_TIMEOUT_MS - (this.now() - oldest.at) + 50);
    this.timer = setTimeout(() => { this.timer = 0; this.expire(); }, delay);
  }

  private now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }
}