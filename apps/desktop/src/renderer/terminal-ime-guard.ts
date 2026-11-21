// IME commits in xterm under Linux/ibus reach onData more than once: xterm's
// CompositionHelper re-reads the helper textarea in a timer after compositionend
// (up to 100 ms late), a following keydown re-reads it again, and the `input`
// insertText path emits it a third time. The guard runs in the capture phase
// ahead of xterm's textarea listeners, sends each committed text once itself
// and empties the textarea; the slice xterm's timer reads of an already started
// next composition is dropped. Everything else on onData passes.
//
// ibus-hangul commits a syllable in one of two shapes (real capture, VM QA5):
//   A  compositionend{data:'한'}
//   B  compositionupdate '' → input(deleteContentBackward) → compositionend{data:''}
//        → input(insertText '글')
// In B xterm's own _inputEvent would emit the insertText again, so that event
// is consumed here.

function printable(data: string): boolean {
  for (const char of data) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false;
  }
  return data.length > 0;
}

// How long after a compositionend an insertText is still the same commit.
const COMMIT_WINDOW_MS = 200;

export interface ImeTextarea {
  value: string;
}

export class TerminalImeGuard {
  private composing = false;
  // B: the commit text is still to arrive on insertText. A: the text already
  // sent from compositionend, which a repeated insertText must not send again.
  private awaitingInsert = false;
  private lastCommit = '';
  private endedAt = 0;

  constructor(
    private readonly send: (data: string) => void,
    private readonly textarea: ImeTextarea,
    private readonly now: () => number = Date.now
  ) {}

  compositionStart(): void {
    this.composing = true;
    this.awaitingInsert = false;
    this.lastCommit = '';
  }

  compositionEnd(data: string): void {
    this.composing = false;
    this.endedAt = this.now();
    this.textarea.value = '';
    if (printable(data)) {
      this.awaitingInsert = false;
      this.lastCommit = data;
      this.send(data);
    } else {
      this.awaitingInsert = true;
      this.lastCommit = '';
    }
  }

  /** True when the input event carried IME commit text that was handled here
   *  and must not reach xterm. Everything else is left to xterm. */
  input(inputType: string, data: string): boolean {
    if (this.composing || inputType !== 'insertText' || !printable(data)) return false;
    if (this.now() - this.endedAt > COMMIT_WINDOW_MS) return false;
    if (this.awaitingInsert) {
      this.awaitingInsert = false;
      this.send(data);
    } else if (this.lastCommit === data) {
      this.lastCommit = '';
    } else {
      return false;
    }
    this.textarea.value = '';
    return true;
  }

  /** What of xterm's onData event may be sent ('' = nothing). */
  filter(data: string): string {
    return this.composing && printable(data) && this.textarea.value.includes(data) ? '' : data;
  }

  attach(element: HTMLElement): () => void {
    const textarea = this.textarea as unknown as EventTarget;
    const start = (event: Event) => {
      if (event.target === textarea) this.compositionStart();
    };
    const end = (event: Event) => {
      if (event.target === textarea) this.compositionEnd((event as CompositionEvent).data ?? '');
    };
    const input = (event: Event) => {
      if (event.target !== textarea) return;
      const e = event as InputEvent;
      if (this.input(e.inputType, e.data ?? '')) e.stopPropagation();
    };
    element.addEventListener('compositionstart', start, true);
    element.addEventListener('compositionend', end, true);
    element.addEventListener('input', input, true);
    return () => {
      element.removeEventListener('compositionstart', start, true);
      element.removeEventListener('compositionend', end, true);
      element.removeEventListener('input', input, true);
    };
  }
}
