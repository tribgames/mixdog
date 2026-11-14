// Records the terminal bytes the Node TUI writes for each environment combination, so the Rust modes
// (`mixdog_term::modes`) are checked against them (tests/modes_twin.rs).
//
// The Node sources are only read from <tree>: their constant expressions are cut out of the text and evaluated, so a change
// in the sources shows as a difference (and a pattern that no longer matches stops the recorder).
//
//   node record-modes.mjs --tree C:/Project/mixdog --write tests/goldens/modes.json
//   node record-modes.mjs --tree C:/Project/mixdog --check tests/goldens/modes.json
//
// Sources: src/tui/index.jsx (reset, entry, mouse tracking, restore, hard exit), src/tui/theme.mjs (emitTerminalBackground),
// src/tui/keyboard-protocol.mjs and src/tui/app/use-terminal-chrome.mjs (extended keys), src/tui/app/use-mouse-input.mjs
// (the tracking restore after the ctrl+wheel zoom passthrough) and node_modules/ink/build/components/App.js (bracketed paste).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-modes.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

const read = (...parts) => readFileSync(join(tree, ...parts), 'utf8').split('\r\n').join('\n');
const indexSource = read('src', 'tui', 'index.jsx');
const themeSource = read('src', 'tui', 'theme.mjs');
const chromeSource = read('src', 'tui', 'app', 'use-terminal-chrome.mjs');
const mouseSource = read('src', 'tui', 'app', 'use-mouse-input.mjs');
const inkAppSource = read('node_modules', 'ink', 'build', 'components', 'App.js');
const keyboard = await import(pathToFileURL(join(tree, 'src', 'tui', 'keyboard-protocol.mjs')).href);

function must(source, pattern, what) {
  const match = pattern.exec(source);
  if (!match) throw new Error(`the source no longer matches: ${what}`);
  return match;
}

// `const NAME = <expression>;` as source text.
function constant(source, name) {
  return must(source, new RegExp(`const ${name} =\\s*([\\s\\S]*?);\\n`), `const ${name}`)[1];
}

// ---- index.jsx -------------------------------------------------------------------------------------------------------
const constNames = [
  'TERMINAL_MODE_RESET',
  'TERMINAL_OSC_RESET_BG',
  'TERMINAL_MODE_RESET_HIDDEN_CURSOR',
  'XTSHIFTESCAPE_ON',
  'MOUSE_TRACKING_ON',
  'ALT_SCROLL_RESTORE',
];
const entryExpr = must(
  indexSource,
  /process\.stdout\.write\(\s*(`\$\{TERMINAL_MODE_RESET_HIDDEN_CURSOR\}[^`]*`)\s*\)/,
  'the alternate screen entry write'
)[1];
const barExpr = must(indexSource, /process\.stdout\.write\(('\\x1b\[5 q')\)/, 'the blinking bar write')[1];
const restoreExpr = must(
  indexSource,
  /(`\$\{TERMINAL_MODE_RESET\}\$\{ALT_SCROLL_RESTORE\}[^`]*`)/,
  'the restoreTerminal write'
)[1];
const hardExitExpr = must(
  indexSource,
  /process\.stdout\.write\((`\$\{TERMINAL_MODE_RESET\}\$\{TERMINAL_OSC_RESET_BG\}`)\)/,
  'the hard exit write'
)[1];
const mouseTrackingExpr = must(indexSource, /const mouseTracking = (.+);/, 'const mouseTracking')[1];
must(indexSource, /if \(mouseTracking\) \{\s*process\.stdout\.write\(MOUSE_TRACKING_ON\);/, 'the mouse tracking write');

const indexBody = [
  ...constNames.map((name) => `const ${name} = ${constant(indexSource, name)};`),
  `const entry = ${entryExpr} + ${barExpr};`,
  `const restore = ${restoreExpr};`,
  `const hardExit = ${hardExitExpr};`,
  `const mouseTracking = ${mouseTrackingExpr};`,
  `return { resetShown: TERMINAL_MODE_RESET, resetHidden: TERMINAL_MODE_RESET_HIDDEN_CURSOR, oscResetBackground: TERMINAL_OSC_RESET_BG,
    altScrollRestore: ALT_SCROLL_RESTORE, entry, restore, hardExit, mouseTracking,
    mouseOn: mouseTracking ? MOUSE_TRACKING_ON : '' };`,
].join('\n');
const evaluateIndex = (env) =>
  new Function('process', 'POP_KITTY', 'DISABLE_MODIFY_OTHER_KEYS', indexBody)(
    { env },
    keyboard.POP_KITTY,
    keyboard.DISABLE_MODIFY_OTHER_KEYS
  );

// ---- the extended keys -----------------------------------------------------------------------------------------------
must(chromeSource, /stdout\.write\(ENABLE_KITTY_KEYBOARD \+ ENABLE_MODIFY_OTHER_KEYS\)/, 'the extended keys enable write');
must(chromeSource, /if \(!supportsExtendedKeys\(\)\) return;/, 'the extended keys gate');

// ---- the bracketed paste ---------------------------------------------------------------------------------------------
const pasteOn = new Function(`return ${must(inkAppSource, /stdout\.write\(('\\u001B\[\?2004h')\)/, 'the bracketed paste write')[1]};`)();

// ---- the tracking restore after the ctrl+wheel zoom passthrough -------------------------------------------------------
const trackingOn = new Function(`return ${constant(mouseSource, 'MOUSE_TRACKING_ON')};`)();
const trackingOff = new Function(`return ${constant(mouseSource, 'MOUSE_TRACKING_OFF')};`)();
const altScrollOff = new Function(`return ${constant(mouseSource, 'ALT_SCROLL_OFF')};`)();
must(mouseSource, /stdout\.write\(MOUSE_TRACKING_ON \+ ALT_SCROLL_OFF, /, 'the tracking restore write');
must(mouseSource, /stdout\.write\(MOUSE_TRACKING_OFF \+ ALT_SCROLL_OFF\)/, 'the passthrough write');
const mouse = {
  passthrough: trackingOff + altScrollOff,
  restore: trackingOn + altScrollOff,
  delayMs: Number(must(mouseSource, /setTimeoutFn\(\(\) => restore\(0\), (\d+)\)/, 'the restore delay')[1]),
  retryMs: Number(must(mouseSource, /setTimeoutFn\(\(\) => restore\(attempt \+ 1\), (\d+)\)/, 'the retry delay')[1]),
  maxRetries: Number(must(mouseSource, /attempt >= (\d+)\) return;/, 'the retry limit')[1]),
};

// ---- the theme background --------------------------------------------------------------------------------------------
const backgroundSource = must(
  themeSource,
  /export (function emitTerminalBackground\(rgbString\) \{[\s\S]*?\n\}\n)/,
  'emitTerminalBackground'
)[1];
const backgroundInputs = [
  'rgb(0, 128, 255)',
  'rgb(999,1,2)',
  'rgb(1,2,3)',
  'rgb( 10 , 20 , 30 )',
  'rgb(00012,3,4)',
  'rgb(256,0,0)',
  'RGB(1,2,3)',
  '',
  '#112233',
  'rgb(1,2)',
  'rgb(1,2,3,4)',
  'rgb(a,b,c)',
  'rgba(1,2,3)',
];
const background = backgroundInputs.map((input) => {
  const written = [];
  const emit = new Function('process', `${backgroundSource}; return emitTerminalBackground;`)({
    stdout: { isTTY: true, write: (text) => written.push(text) },
  });
  emit(input);
  return { input, out: written.join('') };
});

// ---- the environment combinations ------------------------------------------------------------------------------------
const wtValues = [undefined, '1'];
const mouseValues = [undefined, '', '0', 'false', 'NO', 'off', '1', 'on', ' 0'];
const keyEnvs = [
  {},
  { WT_SESSION: '1' },
  { TERM_PROGRAM: 'vscode', WT_SESSION: '1' },
  { MIXDOG_TUI_EXTENDED_KEYS: '0', WT_SESSION: '1' },
  { MIXDOG_TUI_EXTENDED_KEYS: 'on', TERM_PROGRAM: 'vscode' },
  { TERM: 'xterm-kitty' },
  { TMUX: '/tmp/tmux-1000/default,1,0' },
];
const relevant = [
  'WT_SESSION',
  'MIXDOG_TUI_MOUSE',
  'MIXDOG_TUI_EXTENDED_KEYS',
  'TERM_PROGRAM',
  'TERM',
  'KITTY_WINDOW_ID',
  'TMUX',
];
const saved = Object.fromEntries(relevant.map((name) => [name, process.env[name]]));
const combos = [];
try {
  for (const wt of wtValues) {
    for (const mouseValue of mouseValues) {
      for (const keyEnv of keyEnvs) {
        for (const name of relevant) delete process.env[name];
        const env = { ...keyEnv };
        if (wt !== undefined) env.WT_SESSION = wt;
        if (mouseValue !== undefined) env.MIXDOG_TUI_MOUSE = mouseValue;
        Object.assign(process.env, env);
        const evaluated = evaluateIndex(process.env);
        const extended = keyboard.supportsExtendedKeys();
        combos.push({
          env,
          extendedKeys: extended,
          extendedKeysOn: extended ? keyboard.ENABLE_KITTY_KEYBOARD + keyboard.ENABLE_MODIFY_OTHER_KEYS : '',
          mouse: evaluated.mouseTracking,
          mouseOn: evaluated.mouseOn,
        });
      }
    }
  }
} finally {
  for (const name of relevant) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
}

const fixed = evaluateIndex({});
const golden = {
  note: 'recorded by tests/recorders/record-modes.mjs from the Node TUI sources; do not edit by hand',
  fixed: {
    resetShown: fixed.resetShown,
    resetHidden: fixed.resetHidden,
    oscResetBackground: fixed.oscResetBackground,
    altScrollRestore: fixed.altScrollRestore,
    entry: fixed.entry,
    restore: fixed.restore,
    hardExit: fixed.hardExit,
    bracketedPasteOn: pasteOn,
  },
  mouse,
  background,
  combos,
};
const text = `${JSON.stringify(golden, null, 1)}\n`;

if (option('--write')) {
  writeFileSync(option('--write'), text);
  console.log(`wrote ${option('--write')}: ${combos.length} combinations, ${background.length} backgrounds`);
} else {
  const expected = readFileSync(option('--check'), 'utf8').replace(/\r\n/g, '\n');
  if (expected !== text) {
    console.error('the recording differs from the golden: run with --write and review the change');
    process.exit(1);
  }
  console.log(`the recording matches ${option('--check')}`);
}
