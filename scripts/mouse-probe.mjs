#!/usr/bin/env node
/**
 * scripts/mouse-probe.mjs — raw SGR mouse event probe.
 *
 * Enables the same SGR mouse tracking the TUI uses and prints every mouse
 * escape sequence it receives, decoded (button id + modifier bits + coords).
 * Use it to see EXACTLY what the terminal sends for ctrl+wheel — if the ctrl
 * bit (16) never appears, the terminal is not forwarding the modifier and the
 * app-side zoom passthrough can never trigger.
 *
 * Run:  node scripts/mouse-probe.mjs   (q or Ctrl+C to quit)
 */
const ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

process.stdout.write(ON);
process.stdout.write('mouse-probe: wheel / ctrl+wheel / click here. q to quit.\n');
process.stdin.setRawMode(true);
process.stdin.resume();

const cleanup = () => {
  process.stdout.write(OFF);
  process.stdin.setRawMode(false);
  process.exit(0);
};
process.on('SIGINT', cleanup);

process.stdin.on('data', (buf) => {
  const s = buf.toString('utf8');
  if (s === 'q' || s === '\x03') return cleanup();
  let m; MOUSE.lastIndex = 0;
  let sawMouse = false;
  while ((m = MOUSE.exec(s)) !== null) {
    sawMouse = true;
    const b = Number(m[1]);
    const mods = [b & 4 ? 'shift' : '', b & 8 ? 'alt' : '', b & 16 ? 'ctrl' : ''].filter(Boolean).join('+') || 'none';
    const base = b & ~(4 | 8 | 16);
    const kind = base === 64 ? 'wheel-up' : base === 65 ? 'wheel-down' : base === 0 ? 'left' : base === 2 ? 'right' : (b & 32) ? 'motion' : `btn${base}`;
    process.stdout.write(`button=${b} base=${base} kind=${kind} mods=${mods} x=${m[2]} y=${m[3]} ${m[4] === 'M' ? 'press' : 'release'}\n`);
  }
  if (!sawMouse && s.startsWith('\x1b')) {
    process.stdout.write(`non-mouse escape: ${JSON.stringify(s)}\n`);
  }
});
