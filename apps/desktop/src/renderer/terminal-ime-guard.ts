// Korean (and other) IME commits in xterm under Linux/ibus arrive TWICE: xterm's
// CompositionHelper re-reads the helper textarea (substring from the composition
// start, never cleared) after compositionend AND `input`/keydown-229 paths send
// the committed syllable again, so `한글 안녕하세요` became `한글글 안녕하녕요`.
// The guard sends the committed text exactly once and strips xterm's echoes of
// it (also when combined with following input in one event, or arriving
// shortly after finalize). Everything else — space, Latin letters, punctuation,
// control bytes — always passes through.
//
// ibus-hangul commits a syllable in one of two shapes (real log: n3-events):
//   compositionend{data:'한'}                       — data on the event
//   compositionupdate '' → input(deleteContentBackward) → compositionend{data:''}
//     → input(insertText '글')                      — empty end, text on the input
// The committed text is whichever of the two is non-empty, sent exactly once.

function printable(data: string): boolean {
  for (const char of data) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false;
  }
  return data.length > 0;
}

// Commit texts xterm may echo again. An entry stays active until its finalize
// task ran, plus a short grace window for a late echo.
const ECHO_GRACE_MS = 100;

interface CommitEntry {
  seq: number;
  text: string;
  done: boolean;
  doneAt: number;
}

export class TerminalImeGuard {
  private composing = false;
  private finalizing = false;
  private committed = false;
  private seq = 0;
  private current: CommitEntry | null = null;
  private entries: CommitEntry[] = [];

  constructor(
    private readonly send: (data: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  compositionStart(): void {
    this.composing = true;
  }

  /** Returns this composition's sequence number for its finalize task. */
  compositionEnd(data: string): number {
    this.composing = false;
    this.finalizing = true;
    this.committed = false;
    this.seq += 1;
    this.current = { seq: this.seq, text: '', done: false, doneAt: 0 };
    this.entries.push(this.current);
    if (printable(data)) this.commit(data);
    return this.seq;
  }

  private commit(text: string): void {
    this.committed = true;
    if (this.current) this.current.text = text;
    this.send(text);
  }

  /** The textarea input event: its insertText commits a composition whose
   *  compositionend carried no data. Ignored once a commit was sent. */
  inputCommit(text: string, inputType: string): void {
    if (!this.finalizing || this.committed || inputType !== 'insertText' || !printable(text)) return;
    this.commit(text);
  }

  /** Call from a task queued AFTER xterm's own post-compositionend task. A
   *  stale task of an earlier composition (overlapping timers) is ignored. */
  finalizeDone(seq: number = this.seq): void {
    const entry = this.entries.find((e) => e.seq === seq);
    if (entry && !entry.done) {
      entry.done = true;
      entry.doneAt = this.now();
    }
    if (seq === this.seq) this.finalizing = false;
  }

  private activeEntries(): CommitEntry[] {
    const now = this.now();
    this.entries = this.entries.filter((e) => !e.done || now - e.doneAt < ECHO_GRACE_MS);
    return this.entries.filter((e) => e.text !== '');
  }

  /** The part of xterm's data event that is NOT a duplicate of a guarded
   *  commit ('' = drop all). Non-duplicate input (space, Latin letters,
   *  punctuation, control bytes) is always kept, also when xterm combined it
   *  with the echo in one event ("글 "). */
  filter(data: string): string {
    if (this.composing) return printable(data) ? '' : data;
    let rest = data;
    for (let stripped = true; stripped && rest !== ''; ) {
      stripped = false;
      for (const entry of this.activeEntries()) {
        if (rest.startsWith(entry.text)) {
          rest = rest.slice(entry.text.length);
          stripped = true;
          break;
        }
      }
    }
    return rest;
  }

  attach(element: HTMLElement): () => void {
    const start = () => this.compositionStart();
    const end = (event: Event) => {
      const seq = this.compositionEnd((event as CompositionEvent).data ?? '');
      // Bubble phase on an ancestor runs after xterm's textarea listener, so
      // this timeout is queued after xterm's own setTimeout(0) commit.
      setTimeout(() => this.finalizeDone(seq), 0);
    };
    const input = (event: Event) => {
      const e = event as InputEvent;
      this.inputCommit(e.data ?? '', e.inputType);
    };
    element.addEventListener('compositionstart', start, true);
    element.addEventListener('input', input);
    element.addEventListener('compositionend', end);
    return () => {
      element.removeEventListener('compositionstart', start, true);
      element.removeEventListener('compositionend', end);
      element.removeEventListener('input', input);
    };
  }
}