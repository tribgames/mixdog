// Korean (and other) IME commits in xterm under Linux/ibus arrive TWICE: xterm's
// CompositionHelper re-reads the helper textarea (substring from the composition
// start, never cleared) after compositionend AND `input`/keydown-229 paths send
// the committed syllable again, so `한글 안녕하세요` became `한글글 안녕하녕요`.
// The guard makes compositionend.data the single source of IME text: printable
// data xterm emits while a composition is open or still finalizing is dropped,
// and the committed text is sent exactly once. Control bytes (Enter, DEL)
// always pass through.
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

export class TerminalImeGuard {
  private composing = false;
  private finalizing = false;
  private committed = false;
  private commitText = '';

  constructor(private readonly send: (data: string) => void) {}

  compositionStart(): void {
    this.composing = true;
  }

  compositionEnd(data: string): void {
    this.composing = false;
    this.finalizing = true;
    this.committed = false;
    this.commitText = '';
    if (printable(data)) {
      this.committed = true;
      this.commitText = data;
      this.send(data);
    }
  }

  /** The textarea input event: its insertText commits a composition whose
   *  compositionend carried no data. Ignored once a commit was sent. */
  inputCommit(text: string, inputType: string): void {
    if (!this.finalizing || this.committed || inputType !== 'insertText' || !printable(text)) return;
    this.committed = true;
    this.commitText = text;
    this.send(text);
  }

  /** Call from a task queued AFTER xterm's own post-compositionend task. */
  finalizeDone(): void {
    this.finalizing = false;
  }

  /** True when xterm's data event is a duplicate of the guarded commit. */
  shouldDrop(data: string): boolean {
    if (!printable(data)) return false;
    if (this.composing) return true;
    // Finalizing: only xterm's echo of the committed text is a duplicate; a
    // space, Latin letter or punctuation typed right after the commit is new input.
    return this.finalizing && data === this.commitText;
  }

  attach(element: HTMLElement): () => void {
    const start = () => this.compositionStart();
    const end = (event: Event) => {
      this.compositionEnd((event as CompositionEvent).data ?? '');
      // Bubble phase on an ancestor runs after xterm's textarea listener, so
      // this timeout is queued after xterm's own setTimeout(0) commit.
      setTimeout(() => this.finalizeDone(), 0);
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
