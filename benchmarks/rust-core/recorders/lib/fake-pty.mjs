// A scripted PTY for the Node terminal manager (it replaces '@homebridge/node-pty-prebuilt-multiarch', see fake-pty-hook.mjs).
// It behaves as a shell with Mixdog's integration does: a prompt marker on start, and for each line entered the start marker, the
// command's output, the done marker and a new prompt. Output is delivered from a microtask, so the order is the script's.
const PROMPT = '\x1b]697;P\x07PS> ';

export const ptys = [];

export function spawn(file, args, options) {
  const dataListeners = [];
  const exitListeners = [];
  let line = '';
  let dead = false;
  const emit = (text) => queueMicrotask(() => dataListeners.forEach((listener) => listener(text)));
  const pty = {
    pid: 1000 + ptys.length,
    cols: options.cols,
    rows: options.rows,
    resizes: [],
    file,
    args,
    options,
    onData: (listener) => dataListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    write(data) {
      if (dead) return;
      for (const char of data) {
        if (char !== '\r') {
          line += char;
          continue;
        }
        const command = line;
        line = '';
        const output = /^Write-Output (\S+)$/.exec(command)?.[1] ?? '';
        emit(`${command}\r\n\x1b]697;C\x07${output}\r\n\x1b]697;D;0\x07${PROMPT}`);
      }
    },
    resize(cols, rows) {
      pty.cols = cols;
      pty.rows = rows;
      pty.resizes.push([cols, rows]);
    },
    kill() {
      if (dead) return;
      dead = true;
      queueMicrotask(() => exitListeners.forEach((listener) => listener({ exitCode: 0 })));
    },
    pause() {},
    resume() {},
  };
  ptys.push(pty);
  emit(PROMPT);
  return pty;
}
