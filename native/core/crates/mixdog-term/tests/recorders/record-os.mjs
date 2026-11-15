// Records what the Node TUI does in the clipboard, paste and OS helpers that need no process and no window, so the Rust
// helpers (`mixdog_term::clipboard`, `paste`, `os`) are checked against it (tests/os_twin.rs).
//
// The Node code is only read: the modules are imported from <tree>/src (a module with unexported helpers is read as text,
// given an export line and its relative imports made absolute, and imported from a data: URL; nothing is written to the
// tree).
//
//   node record-os.mjs --tree C:/Project/mixdog --write tests/goldens/os.json
//   node record-os.mjs --tree C:/Project/mixdog --check tests/goldens/os.json
//
// Recorded: the OSC 52 sequence and the skip rule, the native clipboard writer per platform, the Linux install hints, the
// pasted-text and image reference formats and parsers, the paste fold policy, the prompt content with images, the path
// candidates of a paste, the path cleaning and image type, the browser opener rules and launchers, and the macOS folder
// script.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-os.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}
const src = (...parts) => join(tree, 'src', ...parts);
const fileUrl = (path) => pathToFileURL(path).href;

// A module read as text, its relative imports made absolute and the named bindings exported, imported from a data: URL.
async function loadWithExports(path, names, replacements = []) {
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of replacements) {
    assert.ok(source.includes(from), `${path} no longer contains ${from}`);
    source = source.replace(from, to);
  }
  source += `\nexport { ${names.join(', ')} };\n`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const clipboard = await loadWithExports(src('tui', 'app', 'clipboard.mjs'), [
  'osc52ClipboardSequence',
  'shouldSkipOsc52',
  'nativeClipboardCommand',
  'clipboardHelperError',
  'OSC52_MAX_BYTES',
]);
const paste = await loadWithExports(
  src('tui', 'paste-attachments.mjs'),
  ['cleanPathText', 'mimeForPath'],
  [
    ["from './app/clipboard.mjs'", `from '${fileUrl(src('tui', 'app', 'clipboard.mjs'))}'`],
    ["from './paste-text-policy.mjs'", `from '${fileUrl(src('tui', 'paste-text-policy.mjs'))}'`],
    ["from '../runtime/shared/read-image-resize.mjs'", `from '${fileUrl(src('runtime', 'shared', 'read-image-resize.mjs'))}'`],
  ]
);
const policy = await import(fileUrl(src('tui', 'paste-text-policy.mjs')));
const openUrl = await import(fileUrl(src('runtime', 'shared', 'open-url.mjs')));
const launchers = await loadWithExports(
  src('runtime', 'shared', 'open-url.mjs'),
  [],
  [
    ["import { isWSL } from './wsl.mjs';", 'let wslFlag = false; const isWSL = () => wslFlag; export const setWsl = (value) => { wslFlag = value; };'],
    ["import { detachedSpawnOpts } from './spawn-flags.mjs';", 'const detachedSpawnOpts = {};'],
    ['tryOpenCandidates(candidates, 0);', 'return candidates;'],
  ]
);
const folder = await import(fileUrl(src('standalone', 'folder-dialog.mjs')));

// ---- the environment a case runs under ------------------------------------------------------------------------------------

const ENV_NAMES = ['TMUX', 'SSH_CONNECTION', 'SSH_TTY', 'WAYLAND_DISPLAY', 'DISPLAY', 'SystemRoot', 'WINDIR'];
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
function under(platform, env, fn) {
  for (const name of ENV_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const PLATFORMS = ['win32', 'darwin', 'linux'];
const envCases = [
  {},
  { TMUX: '/tmp/tmux-1000/default,123,0' },
  { TMUX: '' },
  { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' },
  { SSH_TTY: '/dev/pts/3' },
  { TMUX: 'x', SSH_TTY: '/dev/pts/3' },
  { WAYLAND_DISPLAY: 'wayland-0' },
  { WAYLAND_DISPLAY: '' },
  { DISPLAY: ':0' },
  { DISPLAY: ':0', SSH_TTY: '/dev/pts/3' },
];

// ---- the clipboard ----------------------------------------------------------------------------------------------------------

const texts = ['', 'hello', 'h\u00e9llo w\u00f6rld \u65e5\u672c\u8a9e', 'a\u001bb', 'line one\nline two\r\nline three', 'emoji \u{1F600} and \u{1F468}\u200d\u{1F469}'];
const record = {
  note: 'recorded by tests/recorders/record-os.mjs from the Node TUI sources; do not edit by hand',
  osc52Max: clipboard.OSC52_MAX_BYTES,
};
record.osc52 = [];
for (const text of texts) {
  for (const tmux of [false, true]) {
    const sequence = under('linux', tmux ? { TMUX: '/tmp/tmux-1000/default,1,0' } : {}, () => clipboard.osc52ClipboardSequence(text));
    record.osc52.push({ text, tmux, sequence });
  }
}
record.skip = [];
for (const platform of PLATFORMS) {
  for (const env of envCases) record.skip.push({ platform, env, skip: under(platform, env, () => clipboard.shouldSkipOsc52()) });
}
record.native = [];
for (const platform of PLATFORMS) {
  for (const env of envCases.filter((e) => !('TMUX' in e) && !('SSH_TTY' in e))) {
    for (const text of texts) {
      const { cmd, args: cmdArgs, input } = under(platform, env, () => clipboard.nativeClipboardCommand(text));
      record.native.push({ platform, env, text, cmd, args: cmdArgs, inputHex: Buffer.from(input).toString('hex') });
    }
  }
}
record.hints = {
  linux: Object.fromEntries(
    ['xclip', 'wl-copy'].map((cmd) => [cmd, under('linux', {}, () => clipboard.clipboardHelperError(cmd, { code: 'ENOENT' }).message)])
  ),
  darwinKeepsTheError: under('darwin', {}, () => {
    const original = { code: 'ENOENT' };
    return clipboard.clipboardHelperError('pbcopy', original) === original;
  }),
};
const noReaderSource = readFileSync(src('tui', 'app', 'clipboard.mjs'), 'utf8');
assert.ok(/export function noClipboardReaderError\(\)/.test(noReaderSource));
record.hints.noReader = (await import(fileUrl(src('tui', 'app', 'clipboard.mjs')))).noClipboardReaderError().message;

// ---- paste references and policy ----------------------------------------------------------------------------------------------

const pasteExports = await import(fileUrl(src('tui', 'paste-attachments.mjs')));
const policySpecs = [
  '', 'one', 'a\nb\n', 'a\r\nb\r\n\r\n', '\n\n', 'a\rb\rc',
  { unit: 'x', count: 999 }, { unit: 'x', count: 1000 }, { unit: 'x', count: 1001 }, { unit: '\u{1F600}', count: 501 },
  { lines: 200 },
];
const specText = (spec) =>
  typeof spec === 'string' ? spec : spec.lines ? Array.from({ length: spec.lines }, (_, i) => `l${i}`).join('\n') : spec.unit.repeat(spec.count);
record.policy = policySpecs.map((spec) => {
  const text = specText(spec);
  return {
    spec,
    lines: policy.pastedTextLineCount(text),
    fold: policy.shouldFoldPastedText(text),
    ref: policy.formatPastedTextRef(7, text),
  };
});
record.formatImageRef = [1, 12, 305].map((id) => ({ id, ref: pasteExports.formatImageRef(id) }));
const refInputs = [
  '',
  'a [Image #2] b [Image #10][Image #2] [Image #0] [Image #x] [Image #3',
  '[Image #[Image #5] [image #6] [Image #7 ]',
  '[Image #007] [Image #1][Image #1]',
  '[Pasted text #1 +4 lines] [Pasted text #7 +x lines] [Pasted text #9 +12 lines] [Pasted text #3 +1 line]',
  '[Pasted text #0 +4 lines] [Pasted text #5  +2 lines] [Pasted text #6 +2 lines',
  'mixed [Image #4] and [Pasted text #4 +9 lines]',
];
record.imageRefs = refInputs.map((input) => ({ input, ids: [...pasteExports.imageReferenceIds(input)] }));
record.textRefs = refInputs.map((input) => ({ input, ids: [...pasteExports.pastedTextReferenceIds(input)] }));
const imageSets = [
  [],
  [{ type: 'image', id: 1, content: 'AAA', mediaType: 'image/jpeg', metadataText: '[Image: 1x1]' }],
  [
    { type: 'image', id: 2, content: 'BBB' },
    { type: 'image', id: 1, content: 'AAA', metadataText: '' },
    { type: 'image', id: 3, content: 'CCC', mediaType: '' },
  ],
];
const promptTexts = ['hi', ' see [Image #1] and [Image #2] ', '  [Image #2]', '[Image #3][Image #1]', '   ', '[Image #9]'];
record.prompt = [];
for (const images of imageSets) {
  for (const text of promptTexts) {
    const keyed = Object.fromEntries(images.map((image) => [image.id, image]));
    record.prompt.push({ text, images, content: pasteExports.buildPromptContentWithImages(text, keyed) });
  }
}

// ---- paths -------------------------------------------------------------------------------------------------------------------

const pathTexts = [
  '/a/one.png ~/two.JPG C:\\three.gif\nnote file:///x/four.webp  x',
  'plain words /not/an/image.txt ./rel/a.jpeg ../up/b.WEBP',
  '',
  '\n',
  'a\r\nb\rc',
  '/a/b.png /a/c.png',
  ' /leading.png',
  'trailing /x.png ',
  'C:\\dir\\pic.png D:\\other\\pic.jpg',
  '"/quoted path/a.png" \'/single/b.png\'',
  '/a\\ b/c.png',
  'file:///home/u/a%20b.png file:///C:/Users/u/shot.PNG',
  '.png',
  'x.png.bak /y/z.gif',
];
record.candidates = [];
for (const platform of ['linux', 'win32']) {
  for (const text of pathTexts) {
    record.candidates.push({ platform, text, parts: under(platform, {}, () => pasteExports.splitPastedImagePathCandidates(text)) });
  }
}
const cleanInputs = [
  '  "/a b/c.png"  ', "'/a/c.png'", '"', "'", '""', '/a\\ b/c\\(1\\).png', '/a\\\nb.png', 'C:\\Users\\u\\a.png',
  'file:///home/u/a%20b.png', 'file:///C:/Users/u/a%20b.png', 'file:////server/share/a.png', 'file://host/x/../y.png?q=1#f',
  'file:///x/%ZZ.png', 'file:///x/%E4%B8%AD.png', 'file:///x/%FF.png', 'file:///x/./y/../z.png', 'file:///C|/a.png',
  'file:///a/b/..', 'file://', 'file:///100%.png', 'plain.png', '  ',
];
record.cleanPath = [];
for (const platform of ['linux', 'win32']) {
  for (const value of cleanInputs) {
    record.cleanPath.push({ platform, value, cleaned: under(platform, {}, () => paste.cleanPathText(value)) });
  }
}
record.mime = ['/a/b.PNG', 'b.jpg', 'b.JPEG', 'b.gif', 'b.webp', 'b.bmp', 'png', '.png', 'a.', '/dir.png/file', 'x.tar.png', ''].map((path) => ({
  path,
  mime: paste.mimeForPath(path),
}));

// ---- the browser opener ---------------------------------------------------------------------------------------------------------

record.canOpen = [];
for (const platform of PLATFORMS) {
  for (const wsl of [false, true]) {
    for (const env of envCases) record.canOpen.push({ platform, wsl, env, result: openUrl.canOpenBrowser(env, platform, wsl) });
  }
}
record.launchers = [];
const urls = ['https://example.com/a?b=1&c=2', "https://example.com/it's", 'http://127.0.0.1:1455/cb?code=a b'];
for (const platform of PLATFORMS) {
  for (const wsl of platform === 'linux' ? [false, true] : [false]) {
    for (const env of platform === 'win32' ? [{}, { SystemRoot: 'D:\\Win' }, { SystemRoot: '', WINDIR: 'E:\\W' }] : [{}]) {
      for (const url of urls) {
        const candidates = under(platform, env, () => {
          launchers.setWsl(wsl);
          return launchers.openInBrowser(url);
        });
        record.launchers.push({ platform, wsl, env, url, candidates });
      }
    }
  }
}

// ---- the folder picker -------------------------------------------------------------------------------------------------------------

record.macScript = ['Select a project folder', 'Pick "a" \\ folder', '', 'it\'s', 'back\\slash"quote'].map((title) => ({
  title,
  script: folder.macosChooseScript(title),
}));

// ---- write or check ----------------------------------------------------------------------------------------------------------------

const text = `${JSON.stringify(record, null, 1)}\n`;
const writeTo = option('--write');
const checkAgainst = option('--check');
if (writeTo) {
  writeFileSync(writeTo, text);
  console.log(`wrote ${writeTo}`);
}
if (checkAgainst) {
  const golden = readFileSync(checkAgainst, 'utf8');
  if (golden !== text) {
    console.error(`${checkAgainst} differs from what the Node code does now`);
    process.exit(1);
  }
  console.log('the recording matches');
}
