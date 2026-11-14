// Records what the Ink fork's input pipeline delivers for a corpus of terminal byte streams, so the Rust decoder
// (`mixdog_term::input::Decoder`) is checked against it (tests/keys_twin.rs).
//
// The Node code is only read: the modules are imported from <tree>/node_modules/ink/build, nothing is written there.
//
//   node record-keys.mjs --tree C:/Project/mixdog --write tests/goldens/keys.json
//   node record-keys.mjs --tree C:/Project/mixdog --check tests/goldens/keys.json
//
// Each corpus entry is fed through `createInputParser()` the way `components/App.js` reads stdin (a chunk that is one bare
// ESC is a cancel gesture delivered at once; any other partial escape sequence waits 20 ms for its continuation; a fake
// clock stands in for the timer) and each delivered event is turned into the pair `hooks/use-input.js` hands a handler.
// Whole, byte by byte, split in two at the listed points, and byte by byte with 25 ms between the chunks are recorded; a
// variant that equals the whole-chunk result is not stored.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-keys.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}
const inkBuild = join(tree, 'node_modules', 'ink', 'build');
const load = (file) => import(pathToFileURL(join(inkBuild, file)).href);
const { createInputParser } = await load('input-parser.js');
const { default: parseKeypress, nonAlphanumericKeys } = await load('parse-keypress.js');

const ESCAPE_FLUSH_MS = 20;
const SLOW_GAP_MS = 25;
const ESC = '\x1b';

// hooks/use-input.js handleData, without the React and exitOnCtrlC parts.
function inputPair(data) {
  const keypress = parseKeypress(data);
  const key = {
    upArrow: keypress.name === 'up',
    downArrow: keypress.name === 'down',
    leftArrow: keypress.name === 'left',
    rightArrow: keypress.name === 'right',
    pageDown: keypress.name === 'pagedown',
    pageUp: keypress.name === 'pageup',
    home: keypress.name === 'home',
    end: keypress.name === 'end',
    return: keypress.name === 'return',
    escape: keypress.name === 'escape',
    ctrl: keypress.ctrl,
    shift: keypress.shift,
    tab: keypress.name === 'tab',
    backspace: keypress.name === 'backspace',
    delete: keypress.name === 'delete',
    meta: keypress.meta,
    super: keypress.super ?? false,
    hyper: keypress.hyper ?? false,
    capsLock: keypress.capsLock ?? false,
    numLock: keypress.numLock ?? false,
    eventType: keypress.eventType,
  };
  let input;
  if (keypress.isKittyProtocol) {
    if (keypress.isPrintable) input = keypress.text ?? keypress.name;
    else if (keypress.ctrl && keypress.name.length === 1) input = keypress.name;
    else input = '';
  } else if (keypress.ctrl) {
    input = keypress.name ?? '';
  } else {
    input = keypress.sequence;
  }
  if (!keypress.isKittyProtocol && nonAlphanumericKeys.includes(keypress.name)) input = '';
  if (input.startsWith(ESC)) input = input.slice(1);
  if (input.length === 1 && /[A-Z]/.test(input)) key.shift = true;
  return { input, key };
}

const FLAG_ORDER = [
  'upArrow', 'downArrow', 'leftArrow', 'rightArrow', 'pageDown', 'pageUp', 'home', 'end', 'return', 'escape',
  'ctrl', 'shift', 'tab', 'backspace', 'delete', 'meta', 'super', 'hyper', 'capsLock', 'numLock',
];

// App.js dispatchParsedEvent, with a mouse listener attached and a paste listener attached.
function record(event) {
  if (event.kind === 'response') return null;
  if (event.kind === 'mouse') {
    return { t: 'mouse', button: event.button, action: event.action, col: event.col, row: event.row };
  }
  if (event.kind === 'key' && !event.isPasted && (event.name === 'wheelup' || event.name === 'wheeldown')) {
    const wm = /\x1b\[<(\d+);/.exec(event.sequence);
    return { t: 'wheel', name: event.name, ctrl: wm ? (Number(wm[1]) & 16) !== 0 : false };
  }
  if (event.isPasted) return { t: 'paste', text: event.sequence ?? '' };
  const sequence = event.sequence ?? '';
  const { input, key } = inputPair(sequence);
  const out = { t: 'key', sequence, input, key: FLAG_ORDER.filter((name) => key[name]) };
  if (key.eventType !== undefined) out.eventType = key.eventType;
  return out;
}

// Feed the chunks, one every `gapMs` of fake time, the way App.js handleReadable and its pending-escape timer do.
function simulate(chunks, gapMs) {
  const parser = createInputParser();
  const decoder = new StringDecoder('utf8');
  const out = [];
  const deliver = (events) => {
    for (const event of events ?? []) {
      const recorded = record(event);
      if (recorded) out.push(recorded);
    }
  };
  let deadline = null;
  const fire = (now) => {
    if (deadline !== null && now >= deadline) {
      deadline = null;
      deliver(parser.flushPendingEscape());
    }
  };
  let now = 0;
  for (const chunk of chunks) {
    fire(now);
    const text = decoder.write(chunk);
    if (text !== '') {
      deadline = null;
      const hadPendingEscape = parser.hasPendingEscape();
      const bareEscapeChunk = !hadPendingEscape && text === ESC;
      deliver(parser.push(text));
      if (bareEscapeChunk && parser.hasPendingEscape()) deliver(parser.flushPendingEscape());
      if (parser.hasPendingEscape()) deadline = now + ESCAPE_FLUSH_MS;
    }
    now += gapMs;
  }
  fire(now + 1000);
  return out;
}

// ---------------------------------------------------------------- corpus

const corpus = [];
const add = (name, data) => corpus.push({ name, bytes: Buffer.from(data, 'utf8') });
const addBytes = (name, bytes) => corpus.push({ name, bytes: Buffer.from(bytes) });
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const hex = (n) => n.toString(16).padStart(2, '0');

// printable ASCII
for (let c = 0x20; c <= 0x7e; c += 1) add(`ascii ${hex(c)}`, String.fromCharCode(c));
for (const text of [
  'hello', 'hello world', 'abc123', 'a b', '  ', 'The quick brown fox', 'x[y', 'x]y', 'O', 'P', 'AB', 'aB',
  '한글', '한글 입력 테스트', '漢字かな', '😀', 'a😀b', '👨‍👩‍👧', 'é', 'ñ', 'e\u0301', '\u00a0', '\u2028', '\ufeff', '\u200b',
  'Ünï', '日本語のテキスト', '🇰🇷', '\ud7a3', '\uffff',
]) add(`text ${JSON.stringify(text)}`, text);
// control bytes and text mixed with them
for (let c = 0x00; c <= 0x1f; c += 1) if (c !== 0x1b) add(`ctl ${hex(c)}`, String.fromCharCode(c));
add('del', '\x7f');
for (const text of [
  'a\x00b', 'a\rb', 'a\nb', 'a\tb', '\r\n', '\n\r', 'a\r\nb', '\x7f\x7f\x7f', 'ab\x08c', '\x08\x08', 'a\x7fb\x7fc',
  '\x03', '\x04', '\x1a', '\x1c\x1d\x1e\x1f', '한\x7f글', 'abc\r', '\ta\t',
]) add(`mixed ${JSON.stringify(text)}`, text);
// meta (ESC prefix)
for (let c = 0x20; c <= 0x7e; c += 1) add(`esc+ ${hex(c)}`, ESC + String.fromCharCode(c));
for (let c = 0x00; c <= 0x1f; c += 1) add(`esc+ctl ${hex(c)}`, ESC + String.fromCharCode(c));
add('esc+del', `${ESC}\x7f`);
for (const text of ['한', '😀', 'é', '\u00a0']) add(`esc+${text}`, ESC + text);
for (const text of [`${ESC}${ESC}`, `${ESC}${ESC}${ESC}`, `${ESC}${ESC}a`, `${ESC}${ESC} `, `${ESC}${ESC}\r`, `${ESC} ${ESC}`, `${ESC}a${ESC}b`]) {
  add(`escape runs ${JSON.stringify(text)}`, text);
}

// cursor / navigation keys in every encoding
const modifiers = [...range(1, 9), 16];
for (const letter of 'ABCDEFHPQRSZabcdeGIJKLMNOTUVWXY') {
  add(`csi ${letter}`, `${ESC}[${letter}`);
  add(`ss3 ${letter}`, `${ESC}O${letter}`);
  add(`meta csi ${letter}`, `${ESC}${ESC}[${letter}`);
  add(`meta ss3 ${letter}`, `${ESC}${ESC}O${letter}`);
  add(`csi ${letter} lone mod`, `${ESC}[5${letter}`);
  for (const mod of modifiers) {
    add(`csi 1;${mod} ${letter}`, `${ESC}[1;${mod}${letter}`);
    if (mod <= 8) add(`ss3 1;${mod} ${letter}`, `${ESC}O1;${mod}${letter}`);
  }
}
for (const letter of 'ABCDE') add(`linux ${letter}`, `${ESC}[[${letter}`);
for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28, 29, 31, 32, 33, 34, 99]) {
  add(`tilde ${number}`, `${ESC}[${number}~`);
  add(`linux tilde ${number}`, `${ESC}[[${number}~`);
  add(`shift $ ${number}`, `${ESC}[${number}$`);
  add(`ctrl ^ ${number}`, `${ESC}[${number}^`);
  add(`meta tilde ${number}`, `${ESC}${ESC}[${number}~`);
  for (const mod of modifiers) {
    add(`tilde ${number};${mod}`, `${ESC}[${number};${mod}~`);
    if (mod <= 3) add(`dollar ${number};${mod}`, `${ESC}[${number};${mod}$`);
  }
}
for (const text of [
  `${ESC}[1;5`, `${ESC}[1;`, `${ESC}[;5A`, `${ESC}[1;0A`, `${ESC}[1;1A`, `${ESC}[1;A`, `${ESC}[1;~`, `${ESC}[~`, `${ESC}[;~`,
  `${ESC}[1;99999999999A`, `${ESC}[1;4294967297A`, `${ESC}[1;4294967296A`, `${ESC}[3;2147483649~`, `${ESC}[1;2;3A`,
  `${ESC}[?1A`, `${ESC}[>A`, `${ESC}[ A`, `${ESC}[1 A`, `${ESC}[A1`, `${ESC}OA1`, `${ESC}NA`, `${ESC}NP`, `${ESC}O5A`,
  `${ESC}[<A`, `${ESC}[=A`, `${ESC}[1;5:3A`, `${ESC}[200`, `${ESC}[200~`,
]) add(`odd csi ${JSON.stringify(text)}`, text);

// kitty keyboard protocol
const codepoints = [
  97, 65, 122, 90, 48, 57, 13, 9, 27, 127, 8, 32, 1, 3, 26, 0, 28, 33, 126, 228, 0xd55c, 0x1f600, 0x10ffff, 0x110000, 0xd7ff,
  0xd800, 0xdfff, 0xe000, 57358, 57359, 57363, 57364, 57376, 57398, 57399, 57408, 57409, 57416, 57426, 57427, 57428, 57440, 57441,
  57453, 57454, 57455, 99999999999,
];
const kittyMods = [undefined, 1, 2, 3, 4, 5, 6, 9, 17, 33, 65, 129, 256, 99999];
for (const cp of codepoints) {
  for (const mod of kittyMods) add(`kitty ${cp};${mod}`, mod === undefined ? `${ESC}[${cp}u` : `${ESC}[${cp};${mod}u`);
}
for (const cp of [97, 13, 27, 9, 127, 57441]) {
  for (const mod of [1, 2, 5]) for (const event of [0, 1, 2, 3, 4, 99]) add(`kitty ${cp};${mod}:${event}`, `${ESC}[${cp};${mod}:${event}u`);
}
for (const text of [
  '97', '65:66', '1114112', '0', '55296', '128512', '97:98:99', ':', '::', '97:', ':97', '12345678901', '32', '13', '27',
]) {
  add(`kitty text ${text}`, `${ESC}[97;1;${text}u`);
  add(`kitty text event ${text}`, `${ESC}[97;2:1;${text}u`);
  add(`kitty text bare ${text}`, `${ESC}[13;1;${text}u`);
}
for (const text of [
  `${ESC}[u`, `${ESC}[;5u`, `${ESC}[97;u`, `${ESC}[97;5;u`, `${ESC}[97;5:u`, `${ESC}[97:5u`, `${ESC}[97;5;97:u`, `${ESC}[97;5:3;u`,
  `${ESC}[97;5u `, `${ESC}[97;5U`, `${ESC}[97;5;a u`, `${ESC}[32;5u`, `${ESC}[32;6u`, `${ESC}[-1u`, `${ESC}[97;5:3:4u`,
]) add(`kitty odd ${JSON.stringify(text)}`, text);
for (const letter of 'ABCDEFHPQRSZGM') {
  for (const mod of [1, 2, 5, 8]) for (const event of [1, 2, 3, 0, 4]) add(`kitty special 1;${mod}:${event} ${letter}`, `${ESC}[1;${mod}:${event}${letter}`);
}
for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24, 25, 99]) {
  for (const mod of [1, 2, 5]) for (const event of [1, 2, 3]) add(`kitty special ${number};${mod}:${event} ~`, `${ESC}[${number};${mod}:${event}~`);
}
for (const text of [`${ESC}[3;1:3~x`, `${ESC}[1;1:1Ay`, `${ESC}[1;1:A`, `${ESC}[1;:1A`, `${ESC}[1;1:1`]) add(`kitty special odd ${JSON.stringify(text)}`, text);

// xterm modifyOtherKeys
for (const key of [13, 9, 8, 127, 27, 32, 97, 65, 48, 49, 91, 44, 0x1f600, 99999, 0, 3]) {
  for (const mod of [1, 2, 3, 4, 5, 6, 7, 8, 9]) add(`modifyOtherKeys ${mod};${key}`, `${ESC}[27;${mod};${key}~`);
}
for (const text of [`${ESC}[27;5;13~x`, `${ESC}[27;5;13`, `${ESC}[27;5;~`, `${ESC}[27;;13~`, `${ESC}[27~`, `${ESC}[27;5~`]) {
  add(`modifyOtherKeys odd ${JSON.stringify(text)}`, text);
}

// bracketed paste
const PS = `${ESC}[200~`;
const PE = `${ESC}[201~`;
for (const payload of [
  'hello', '', 'a\nb\nc', 'a\r\nb\r\n', 'a\rb', 'tab\there', 'a\x1bb', `${ESC}[A`, `a${ESC}[Ab`, `${ESC}`, `x${ESC}`, `${ESC}${ESC}`,
  `${ESC}[200~inner`, `${ESC}[201`, `${ESC}[20`, '한글 붙여넣기\n두번째 줄', '😀\n😀', '\x7f\x08', '[<0;1;1M', `${ESC}[<0;1;1M`, `${ESC}]0;x\x07`,
  `${ESC}P1$r0m${ESC}\\`, '\x00\x01\x02', 'long '.repeat(40), 'line\n'.repeat(30),
]) {
  add(`paste ${JSON.stringify(payload).slice(0, 40)}`, PS + payload + PE);
  add(`paste then text ${JSON.stringify(payload).slice(0, 30)}`, `${PS}${payload}${PE}tail`);
  add(`text then paste ${JSON.stringify(payload).slice(0, 30)}`, `head${PS}${payload}${PE}`);
  add(`paste unterminated ${JSON.stringify(payload).slice(0, 30)}`, PS + payload);
}
for (const text of [
  PE, `${PE}x`, `x${PE}`, `${PS}${PS}a${PE}`, `${PS}a${PE}${PS}b${PE}`, `${PS}a${PE}${PE}`, PS, `${PS}${PS}`, `${PS}${PE}${PS}${PE}`,
  `${ESC}[200`, `${ESC}[2`, `${ESC}[201`, `${ESC}[201~`, `${ESC}[200~${ESC}`, `${ESC}[200~${ESC}[`, `${ESC}[200~${ESC}[201`,
  `${PS}a${PE}${ESC}[A`, `${ESC}[A${PS}a${PE}${ESC}[B`,
]) add(`paste markers ${JSON.stringify(text)}`, text);

// mouse
const sgrButtons = [0, 1, 2, 3, 4, 8, 12, 16, 20, 28, 32, 33, 34, 35, 36, 40, 48, 64, 65, 66, 67, 68, 72, 80, 81, 84, 96, 97, 128, 129, 192];
const cells = [[1, 1], [10, 5], [200, 100], [0, 0], [2047, 1]];
for (const button of sgrButtons) {
  for (const final of 'Mm') for (const [col, row] of cells) add(`sgr ${button};${col};${row}${final}`, `${ESC}[<${button};${col};${row}${final}`);
}
for (const text of [
  `${ESC}[<0;5;5Mx`, `x${ESC}[<0;5;5M`, `${ESC}[<0;5;5M${ESC}[<0;6;5M`, `${ESC}[<0;5;5`, `${ESC}[<0;5;5X`, `${ESC}[<0;5M`, `${ESC}[<;5;5M`,
  `${ESC}[<0;5;5;M`, `${ESC}[<64;5;5M${ESC}[<65;5;5M`, `${ESC}[<64;5;5Mhello`, `a${ESC}[<64;5;5Mb`, `${ESC}[<-1;5;5M`, `${ESC}[<0;5;5Mm`,
]) add(`sgr odd ${JSON.stringify(text)}`, text);
const x10 = (button, col, row) => `${ESC}[M${String.fromCharCode(32 + button, col, row)}`;
for (const button of [0, 1, 2, 3, 32, 35, 64, 65, 66, 67, 68, 80, 96, 97, 128]) {
  for (const [col, row] of [[33, 33], [60, 40], [100, 100], [127, 127], [200, 50], [0x4e00, 0x20]]) add(`x10 ${button};${col};${row}`, x10(button, col, row));
}
for (const text of [
  `${ESC}[M`, `${ESC}[M ${'!'}`, `${ESC}[M\x01`, `${ESC}[M\x01\x01\x01`, `${ESC}[M \x01!`, `${ESC}[M!!`, `${x10(64, 33, 33)}${x10(65, 33, 33)}`,
  `${x10(64, 33, 33)}abc`, `a${x10(64, 33, 33)}`, `${ESC}[M\u{1f600}!`, `${ESC}[M!\u{1f600}`,  `${ESC}[M\x7f!!`, `${ESC}[Mab`, `${ESC}[M${ESC}[A`,
]) add(`x10 odd ${JSON.stringify(text)}`, text);
for (const text of [
  '[<0;5;5M', '[<0;5;5m', '[<64;1;1M', '[<65;1;1M', '[<0;5;5', '[<0;5M', 'x[<0;5;5M', '[<0;5;5Mx', '[M`!!', '[Ma!!', '[M\x7f!!', '[M!!!',
  '[MAX]', '[M`!', '[M`!!!', '[M`한한', '[M`\u{1f600}', '[M```', 'ab[<0;5;5Mcd', '[<0;5;5M[<0;6;5M', '[<1;2;3M',
]) add(`orphan tail ${JSON.stringify(text)}`, text);

// focus reports
for (const text of [`${ESC}[I`, `${ESC}[O`, `${ESC}[I${ESC}[O`, `a${ESC}[Ib`, `${ESC}[1I`, `${ESC}[?I`, `${ESC}OI`, `${ESC}OO`, `${PS}${ESC}[I${PE}`]) {
  add(`focus ${JSON.stringify(text)}`, text);
}

// terminal replies
for (const text of [
  `${ESC}[?1;2c`, `${ESC}[?62;1;2;4c`, `${ESC}[?c`, `${ESC}[?1;2`, `${ESC}[>0;276;0c`, `${ESC}[>c`, `${ESC}[>1;2`, `${ESC}[?2004;1$y`, `${ESC}[?2004;2$y`,
  `${ESC}[?2026;0$y`, `${ESC}[?2004$y`, `${ESC}[?2004;$y`, `${ESC}[?1u`, `${ESC}[?0u`, `${ESC}[?u`, `${ESC}[?12;40R`, `${ESC}[?12R`, `${ESC}[12;40R`,
  `${ESC}[1;2c`, `${ESC}[=1c`, `${ESC}]11;rgb:1e1e/1e1e/1e1e\x07`, `${ESC}]11;rgb:1e1e/1e1e/1e1e${ESC}\\`, `${ESC}]10;rgb:ffff/ffff/ffff\x07`,
  `${ESC}]4;1;rgb:cc/00/00${ESC}\\`, `${ESC}]52;c;SGVsbG8=\x07`, `${ESC}]0;title\x07`, `${ESC}]abc\x07`, `${ESC}]11;abc`, `${ESC}]11;`, `${ESC}]11;\x07`,
  `${ESC}P>|xterm(388)${ESC}\\`, `${ESC}P>|WezTerm 2024\x07`, `${ESC}P>|`, `${ESC}P1$r0m${ESC}\\`, `${ESC}P+q544e${ESC}\\`, `${ESC}_Gi=1;OK${ESC}\\`,
  `${ESC}[?1;2cx`, `x${ESC}[?1;2c`, `${ESC}[?1;2c${ESC}[A`, `${ESC}]11;rgb:0/0/0\x07a`,
]) add(`reply ${JSON.stringify(text)}`, text);

// truncated sequences followed by text, rejected sequences, back to back
for (const text of [
  `${ESC}[`, `${ESC}[1;`, `${ESC}[Ahello`, `${ESC}a`, `${ESC}O`, `${ESC}Ox`, `${ESC}OA`, `abc${ESC}`, `abc${ESC}[`, `${ESC}[1;5`, `${ESC}[1;5Ax`, `${ESC}]`,
  `${ESC}]11`, `${ESC}P`, `${ESC}_`, `${ESC}[?`, `${ESC}[?1`, `${ESC}(`, `${ESC}(B`, `${ESC}(0x`, `${ESC}#8`, `${ESC} F`, `${ESC}=`, `${ESC}>`, `${ESC}7`,
  `${ESC}\x01`, `${ESC}[\x01`, `${ESC}O\x01`, `${ESC}[1\x01a`, `${ESC}[\x7f`, `${ESC}[한`, `${ESC}O한`, `${ESC}(\x01`, `${ESC}[1;5\x01`, `${ESC}[A${ESC}[B${ESC}[C`,
  `a${ESC}[Ab`, `${ESC}[A${ESC}`, `${ESC}${ESC}[A${ESC}[B`, `${ESC}[1;5A${ESC}[1;5B`, `${ESC}O${ESC}[A`, `${ESC}[${ESC}[A`, `${ESC}[1;${ESC}[A`,
  `${ESC}[Aa${ESC}[Bb${ESC}[Cc`, `${ESC}x${ESC}y${ESC}z`, `abc${ESC}def`, `${ESC}\r\n`, `${ESC}\t`, `${ESC}[\r`, `${ESC}[A\r`, `\r${ESC}[A`,
]) add(`sequence ${JSON.stringify(text)}`, text);
for (const text of [
  `${ESC}[A${ESC}[B${ESC}[C${ESC}[D`, `hello${ESC}[Aworld`, `${ESC}[1;5C${ESC}[1;5D`, `${ESC}[27;5;13~${ESC}[13;5u\r`, `한${ESC}[A글${ESC}[B`,
  `\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<65;5;5M`, `typed\x1b[<0;3;3Mmore`,
]) add(`stream ${JSON.stringify(text)}`, text);

// bytes that are not valid UTF-8
addBytes('invalid ff', [0xff]);
addBytes('invalid a ff b', [0x61, 0xff, 0x62]);
addBytes('invalid truncated 2', [0x61, 0xc3]);
addBytes('invalid truncated 3', [0xe2, 0x82]);
addBytes('invalid truncated 4', [0xf0, 0x9f, 0x98]);
addBytes('invalid cont', [0x80]);
addBytes('invalid cont run', [0x80, 0x80, 0x61]);
addBytes('invalid overlong', [0xc0, 0x80, 0x61]);
addBytes('invalid f0 80 80', [0xf0, 0x80, 0x80, 0x61]);
addBytes('invalid e2 82 61', [0xe2, 0x82, 0x61]);
addBytes('invalid surrogate', [0xed, 0xa0, 0x80, 0x61]);
addBytes('invalid esc c3', [0x1b, 0xc3]);
addBytes('invalid esc c3 a9', [0x1b, 0xc3, 0xa9]);
addBytes('invalid in csi', [0x1b, 0x5b, 0xff, 0x41]);
addBytes('invalid f5', [0xf5, 0x80, 0x80, 0x80]);
addBytes('valid then truncated', [0x61, 0xed, 0x95]);

// ---------------------------------------------------------------- recording

function splitPoints(length) {
  if (length <= 64) return range(1, length - 1);
  const points = new Set([...range(1, 8), ...range(length - 8, length - 1)]);
  for (let at = 7; at < length; at += 7) points.add(at);
  return [...points].filter((at) => at > 0 && at < length).sort((a, b) => a - b);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const entries = corpus.map(({ name, bytes }) => {
  const whole = simulate([bytes], 0);
  const entry = { name, hex: bytes.toString('hex'), splitPoints: splitPoints(bytes.length), whole, others: {} };
  const keep = (label, events) => {
    if (!same(events, whole)) entry.others[label] = events;
  };
  keep('bytewise', simulate([...bytes].map((b) => Buffer.from([b])), 0));
  for (const at of entry.splitPoints) keep(`split:${at}`, simulate([bytes.subarray(0, at), bytes.subarray(at)], 0));
  keep('slow', simulate([...bytes].map((b) => Buffer.from([b])), SLOW_GAP_MS));
  return entry;
});

const golden = {
  note: 'Recorded by tests/recorders/record-keys.mjs from node_modules/ink/build; do not edit by hand.',
  escapeFlushMs: ESCAPE_FLUSH_MS,
  slowGapMs: SLOW_GAP_MS,
  entries,
};
const text = `${JSON.stringify(golden)}\n`;

if (option('--write')) {
  writeFileSync(option('--write'), text);
  console.log(`wrote ${entries.length} entries to ${option('--write')}`);
} else {
  const recorded = readFileSync(option('--check'), 'utf8');
  if (recorded === text) {
    console.log(`ok: ${entries.length} entries match ${option('--check')}`);
  } else {
    const old = JSON.parse(recorded).entries;
    const changed = entries.filter((entry, at) => !same(entry, old[at])).map((entry) => entry.name);
    console.error(`MISMATCH: ${changed.length} of ${entries.length} entries differ (${changed.slice(0, 5).join(', ')})`);
    process.exit(1);
  }
}
