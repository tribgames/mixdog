import type { Terminal } from '@xterm/xterm';

export type TerminalClipboardChord = 'copy' | 'paste' | null;

// Windows key codes, as Chromium's editing key bindings and xterm match them.
const KEY_C = 67;
const KEY_V = 86;

type ChordEvent = Pick<KeyboardEvent, 'keyCode' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

/** The clipboard action a key asks of the terminal: Cmd+C/V on macOS;
 *  elsewhere Ctrl+Shift+C/V, Ctrl+V, and Ctrl+C only over a selection (without
 *  one it stays the program's interrupt). */
export function terminalClipboardChord(
  event: ChordEvent,
  isMac: boolean,
  hasSelection: boolean
): TerminalClipboardChord {
  if (event.altKey || (event.keyCode !== KEY_C && event.keyCode !== KEY_V)) return null;
  const copy = event.keyCode === KEY_C;
  if (isMac) {
    if (!event.metaKey || event.ctrlKey || event.shiftKey) return null;
    return copy ? 'copy' : 'paste';
  }
  if (!event.ctrlKey || event.metaKey) return null;
  if (!copy) return 'paste';
  return event.shiftKey || hasSelection ? 'copy' : null;
}

/** xterm turns Ctrl+V into ^V and cancels the keydown, so the browser's paste
 *  command never runs. A paste chord is kept from xterm with its default left
 *  in place: the native paste fires the `paste` event xterm feeds through its
 *  own paste path (bracketed paste, line endings), with no clipboard-read
 *  permission. Copy writes the terminal selection itself and cancels the key. */
export function attachTerminalClipboardKeys(
  term: Pick<Terminal, 'attachCustomKeyEventHandler' | 'hasSelection' | 'getSelection' | 'clearSelection'>,
  isMac: boolean,
  writeClipboard: (text: string) => Promise<void>
): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const chord = terminalClipboardChord(event, isMac, term.hasSelection());
    if (!chord) return true;
    if (chord === 'copy') {
      event.preventDefault();
      const text = term.getSelection();
      // Output never clears a selection: kept, it would turn every later Ctrl+C into another copy.
      term.clearSelection();
      if (text) void writeClipboard(text).catch(() => undefined);
    }
    return false;
  });
}
