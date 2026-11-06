#!/usr/bin/env node
// Parity goldens for the file tools beyond the shared `fixtures/tools` set: edit's typographic
// rematch and apply_patch's diagnostics, renames and deletes. The real Node tools run over a fresh
// workspace per case; each case stores its files, args, the scrubbed envelope text and the
// workspace afterwards.
//
//   node record.mjs --tree <Node product tree with node_modules> [--native-root <dir holding mixdog-patch>]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const tree = resolve(opt('tree'));
const nativeRoot = resolve(opt('native-root') ?? join(tree, 'native'));
const exe = process.platform === 'win32' ? '.exe' : '';
const work = mkdtempSync(join(tmpdir(), 'mixdog-fs-golden-'));
process.env.MIXDOG_DATA_DIR = join(work, 'data');
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(work, 'failures.jsonl');
process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '0';
process.env.MIXDOG_PATCH_NATIVE_BIN = join(nativeRoot, 'mixdog-patch', 'target', 'release', `mixdog-patch${exe}`);
const importFrom = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { executeBuiltinTool } = await importFrom('src/runtime/agent/orchestrator/tools/builtin.mjs');
const { executePatchTool } = await importFrom('src/runtime/agent/orchestrator/tools/patch.mjs');
const { normalizeToolEnvelope } = await importFrom('src/runtime/agent/orchestrator/session/tool-envelope.mjs');

const patch = (...lines) => `*** Begin Patch\n${lines.join('\n')}\n*** End Patch\n`;
const edit = (name, files, input) => ({ name: `edit-${name}`, tool: 'edit', files, input });
const apply = (name, files, text, extra = {}) => ({ name: `patch-${name}`, tool: 'apply_patch', files, input: { patch: text, ...extra } });

const cases = [
  edit('typo-double-quotes', { 't.txt': 'He said “hi” there\n' }, { path: 't.txt', old_string: 'said "hi"', new_string: 'said "bye"' }),
  edit('typo-dash', { 't.txt': 'range 1 – 5 here\n' }, { path: 't.txt', old_string: 'range 1 - 5', new_string: 'range 1 - 9' }),
  edit('typo-nbsp', { 't.txt': 'a\u00a0b c\n' }, { path: 't.txt', old_string: 'a b', new_string: 'x y' }),
  edit('typo-single-quotes', { 't.txt': 'it’s ‘fine’ now\n' }, { path: 't.txt', old_string: "it's 'fine'", new_string: "don't 'ok'" }),
  edit('typo-replace-all-uniform', { 't.txt': '“a” and “a”\n' }, { path: 't.txt', old_string: '"a"', new_string: '"b"', replace_all: true }),
  edit('typo-replace-all-mixed', { 't.txt': '“a” and ”a”\n' }, { path: 't.txt', old_string: '"a"', new_string: '"b"', replace_all: true }),
  edit('typo-multiline', { 't.txt': 'x\n“q”\ny\n' }, { path: 't.txt', old_string: 'x\n"q"', new_string: 'x\n"r"' }),
  edit('typo-crlf', { 't.txt': 'x\r\n“q”\r\n' }, { path: 't.txt', old_string: '"q"', new_string: '"r"' }),
  edit('typo-same-after-rematch', { 't.txt': 'a – b\n' }, { path: 't.txt', old_string: 'a - b', new_string: 'a – b' }),
  edit('typo-delete-line', { 't.txt': 'keep\n“gone”\nkeep2\n' }, { path: 't.txt', old_string: '"gone"', new_string: '' }),
  edit('typo-ambiguous', { 't.txt': '“a” x\n“a” y\n' }, { path: 't.txt', old_string: '"a"', new_string: '"b"' }),

  edit('missing-file', {}, { path: 'nope.txt', old_string: 'a', new_string: 'b' }),
  edit('create-new', {}, { path: 'deep/dir/new.txt', old_string: '', new_string: 'hello\n' }),
  edit('create-existing', { 't.txt': 'x\n' }, { path: 't.txt', old_string: '', new_string: 'hello\n' }),
  edit('fill-empty', { 't.txt': '' }, { path: 't.txt', old_string: '', new_string: 'hello\n' }),
  edit('same-strings', { 't.txt': 'x\n' }, { path: 't.txt', old_string: 'x', new_string: 'x' }),
  edit('alias-keys', { 't.txt': 'x\n' }, { path: 't.txt', old_str: 'x', new_str: 'y' }),
  edit('alias-conflict', { 't.txt': 'x\n' }, { path: 't.txt', old_string: 'x', old_str: 'z', new_string: 'y' }),
  edit('not-strings', { 't.txt': 'x\n' }, { path: 't.txt', old_string: 'x' }),
  edit('ambiguous-lf', { 't.txt': 'dup\nmid\ndup\n' }, { path: 't.txt', old_string: 'dup', new_string: 'one' }),
  edit('ambiguous-many', { 't.txt': Array.from({ length: 10 }, () => 'dup').join('\n') + '\n' }, { path: 't.txt', old_string: 'dup', new_string: 'one' }),
  edit('ambiguous-overlap', { 't.txt': 'aaa\n' }, { path: 't.txt', old_string: 'aa', new_string: 'b' }),
  edit('replace-all', { 't.txt': 'dup\nmid\ndup\n' }, { path: 't.txt', old_string: 'dup', new_string: 'one', replace_all: true }),
  edit('replace-all-string-true', { 't.txt': 'dup\nmid\ndup\n' }, { path: 't.txt', old_string: 'dup', new_string: 'one', replace_all: 'true' }),
  edit('no-match-nearest', { 't.txt': 'alpha\nlonger_token = 1;\nomega\n' }, { path: 't.txt', old_string: 'longer_token = 2;', new_string: 'x' }),
  edit('no-match-nothing', { 't.txt': 'alpha\nomega\n' }, { path: 't.txt', old_string: 'zzz', new_string: 'x' }),
  edit('crlf-multiline', { 't.txt': 'a\r\nb\r\nc\r\n' }, { path: 't.txt', old_string: 'a\nb', new_string: 'A\nB' }),
  edit('crlf-single-line-new-lines', { 't.txt': 'a\r\nb\r\n' }, { path: 't.txt', old_string: 'a', new_string: 'x\ny' }),
  edit('crlf-ambiguous', { 't.txt': 'a\r\nb\r\na\r\nb\r\n' }, { path: 't.txt', old_string: 'a\nb', new_string: 'x' }),
  edit('crlf-delete-block', { 't.txt': 'a\r\nb\r\nc\r\n' }, { path: 't.txt', old_string: 'b\nc', new_string: '' }),
  edit('nfc-tier', { 't.txt': 'caf\u0065\u0301 au lait\n' }, { path: 't.txt', old_string: 'caf\u00e9', new_string: 'tea' }),
  edit('delete-line', { 't.txt': 'a\nb\nc\n' }, { path: 't.txt', old_string: 'b', new_string: '' }),
  edit('delete-last-no-newline', { 't.txt': 'a\nb' }, { path: 't.txt', old_string: 'b', new_string: '' }),
  edit('trailing-blanks-text', { 't.txt': 'a\n' }, { path: 't.txt', old_string: 'a', new_string: 'x  \ny \t\nz' }),
  edit('trailing-blanks-markdown', { 't.md': 'a\n' }, { path: 't.md', old_string: 'a', new_string: 'x  \ny' }),
  edit('no-path', {}, { old_string: 'a', new_string: 'b' }),
  edit('file-path-key', { 't.txt': 'x\n' }, { file_path: 't.txt', old_string: 'x', new_string: 'y' }),
  edit('empty-path', {}, { path: '  ', old_string: 'a', new_string: 'b' }),
  edit('directory', { 'd/x.txt': 'x\n' }, { path: 'd', old_string: 'a', new_string: 'b' }),
  edit('bom-utf8', { 't.txt': '\ufeffhello\n' }, { path: 't.txt', old_string: 'hello', new_string: 'bye' }),
  edit('crlf-trailing-blank-new', { 't.txt': 'a\r\nb\r\n' }, { path: 't.txt', old_string: 'a\nb', new_string: 'x  \ny' }),
  edit('single-line-lf-in-mixed', { 't.txt': 'a\nb\r\nc\n' }, { path: 't.txt', old_string: 'c', new_string: 'x\ny' }),
  edit('curly-tier-native', { 't.txt': 'say “a” and “b”\n' }, { path: 't.txt', old_string: 'say "a" and "b"\nmore', new_string: 'x' }),
  edit('binary',{ 't.bin': 'a\u0000b' }, { path: 't.bin', old_string: 'a', new_string: 'x' }),

  apply('divergence-middle', { 'a.js': 'one\ntwo\nthree\nfour\n' }, patch('*** Update File: a.js', '@@', ' one', '-TWO', '+2', ' three'), { fuzzy: false }),
  apply('divergence-past-eof', { 'a.js': 'one\ntwo\n' }, patch('*** Update File: a.js', '@@', ' one', ' two', '-three', '+3'), { fuzzy: false }),
  apply('divergence-fuzzy', { 'a.js': 'one\ntwo\nthree\nfour\n' }, patch('*** Update File: a.js', '@@', ' one', '-TWO', '+2', ' three')),
  apply('anchor-missing-nearest', { 'a.js': 'function nop() {}\nlet x = 1;\n' }, patch('*** Update File: a.js', '@@ function nope', '-let x = 1;', '+let x = 2;'), { fuzzy: false }),
  apply('anchor-missing-bare', { 'a.js': 'abc\ndef\n' }, patch('*** Update File: a.js', '@@ XYZ', '-def', '+DEF'), { fuzzy: false }),
  apply('anchor-chain', { 'a.js': 'class A {\n  a() {}\n  method b() {\n    old\n  }\n}\n' }, patch('*** Update File: a.js', '@@ class A', '@@ method b', '-    old', '+    new')),
  apply('anchor-trimmed', { 'a.js': 'function f() {   \n  old\n}\n' }, patch('*** Update File: a.js', '@@ function f() {', '-  old', '+  new')),
  apply('anchor-typographic', { 'a.js': 'say “hi”\nold\n' }, patch('*** Update File: a.js', '@@ say "hi"', '-old', '+new')),
  apply('anchor-numeric', { 'a.js': 'a\nb\nc\nd\n' }, patch('*** Update File: a.js', '@@ 3', ' c', '-d', '+D')),
  apply('anchor-out-of-order', { 'a.js': 'alpha\nbeta\ngamma\ndelta\n' }, patch('*** Update File: a.js', '@@ gamma', '-gamma', '+GAMMA', '@@ alpha', '-alpha', '+ALPHA')),
  apply('envelope-marker', { 'a.js': 'a\nb\n' }, patch('*** Update File: a.js', '@@', ' a', '-*** Update File: b.js', '+x')),
  apply('update-missing', {}, patch('*** Update File: nope.js', '@@', '-a', '+b')),
  apply('ambiguity-notice', { 'a.js': 'x\nfoo\ny\nfoo\nz\n' }, patch('*** Update File: a.js', '@@', ' foo', '+bar')),
  apply('eof-ignored-notice', { 'a.js': 'a\nb\nc\n' }, patch('*** Update File: a.js', '@@', ' a', '-b', '+B', '*** End of File')),
  apply('two-hunks', { 'a.js': 'a\nb\nc\nd\ne\n' }, patch('*** Update File: a.js', '@@', '-b', '+B', '@@', '-d', '+D')),
  apply('add-new', {}, patch('*** Add File: dir/new.txt', '+one', '+two')),
  apply('add-existing', { 'a.txt': 'x\n' }, patch('*** Add File: a.txt', '+one')),
  apply('delete', { 'gone.txt': 'a\nb\n' }, patch('*** Delete File: gone.txt')),
  apply('delete-missing', {}, patch('*** Delete File: gone.txt')),
  apply('mixed', { 'u.txt': 'a\nb\n', 'd.txt': 'x\n' }, patch('*** Add File: n.txt', '+new', '*** Update File: u.txt', '@@', '-b', '+B', '*** Delete File: d.txt')),
  apply('rename-pure', { 'old.txt': 'x\ny\n' }, patch('*** Update File: old.txt', '*** Move to: sub/new.txt')),
  apply('rename-edit', { 'old.txt': 'x\ny\n' }, patch('*** Update File: old.txt', '*** Move to: new.txt', '@@', '-y', '+Y')),
  apply('rename-dry-run', { 'old.txt': 'x\ny\n' }, patch('*** Update File: old.txt', '*** Move to: new.txt'), { dry_run: true }),
  apply('rename-dest-exists', { 'old.txt': 'x\n', 'new.txt': 'z\n' }, patch('*** Update File: old.txt', '*** Move to: new.txt')),
  apply('rename-source-missing', {}, patch('*** Update File: old.txt', '*** Move to: new.txt')),
  apply('rename-same-path', { 'old.txt': 'x\n' }, patch('*** Update File: old.txt', '*** Move to: old.txt')),
  apply('rename-dest-dir', { 'old.txt': 'x\n', 'sub/keep.txt': 'k\n' }, patch('*** Update File: old.txt', '*** Move to: sub')),
  apply('rename-duplicate-dest', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '*** Move to: c.txt', '*** Update File: b.txt', '*** Move to: c.txt')),
  apply('rename-duplicate-source', { 'a.txt': 'a\n' }, patch('*** Update File: a.txt', '*** Move to: c.txt', '*** Update File: a.txt', '*** Move to: d.txt')),
  apply('rename-touches-section', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '*** Move to: c.txt', '*** Update File: b.txt', '@@', '-b', '+B', '*** Update File: c.txt', '@@', '-a', '+A')),
  apply('rename-with-other-section', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '*** Move to: c.txt', '*** Update File: b.txt', '@@', '-b', '+B')),
];

const snapshot = (root) => {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(root, full).split('\\').join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
};

const recorded = [];
for (const [index, c] of cases.entries()) {
  const ws = join(work, `ws${index}`);
  mkdirSync(ws, { recursive: true });
  for (const [rel, data] of Object.entries(c.files)) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), data);
  }
  const fwd = ws.replace(/\\/g, '/');
  const scrub = (text) => String(text).replaceAll(ws, '<ROOT>').replaceAll(fwd, '<ROOT>');
  const input = c.tool === 'apply_patch' ? { ...c.input, base_path: ws } : c.input;
  let outcome;
  try {
    const raw = c.tool === 'apply_patch' ? await executePatchTool('apply_patch', input, ws) : await executeBuiltinTool(c.tool, input, ws);
    const env = normalizeToolEnvelope(raw);
    outcome = { text: scrub(env.result ?? ''), isError: env.isError === true || /^Error[\s:[]/.test(String(env.result ?? '')) };
  } catch (e) {
    outcome = { thrown: scrub(String(e?.message ?? e)) };
  }
  recorded.push({
    name: c.name,
    tool: c.tool,
    files: c.files,
    input: c.tool === 'apply_patch' ? { ...c.input, base_path: '<ROOT>' } : c.input,
    ...outcome,
    after: snapshot(ws),
  });
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'cases.json');
writeFileSync(out, `${JSON.stringify(recorded, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${recorded.length} cases -> ${out}`);
