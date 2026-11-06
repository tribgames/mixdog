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
  apply('delete-then-add', { 'a.txt': 'old\nlines\n' }, patch('*** Delete File: a.txt', '*** Add File: a.txt', '+new')),
  apply('delete-crlf', { 'c.txt': 'a\r\nb\r\nc\r\n' }, patch('*** Delete File: c.txt')),
  apply('delete-update-other', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Delete File: a.txt', '*** Update File: b.txt', '@@', '-b', '+B')),
  apply('delete-directory', { 'd/x.txt': 'x\n' }, patch('*** Delete File: d')),
  apply('delete-dry-run', { 'a.txt': 'a\nb\n' }, patch('*** Delete File: a.txt'), { dry_run: true }),
  apply('delete-and-update-same', { 'a.txt': 'a\n' }, patch('*** Delete File: a.txt', '*** Update File: a.txt', '@@', '-a', '+A')),
  apply('rename-crlf', { 'old.txt': 'x\r\ny\r\nz\r\n' }, patch('*** Update File: old.txt', '*** Move to: new.txt', '@@', ' x', '-y', '+Y', ' z')),
  apply('rename-hunk-miss', { 'old.txt': 'x\ny\n' }, patch('*** Update File: old.txt', '*** Move to: new.txt', '@@', '-nothing', '+x')),
  apply('rename-two', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '*** Move to: x/a.txt', '*** Update File: b.txt', '*** Move to: x/b.txt')),
  apply('rename-nested-source', { 'src/old.txt': 'x\n' }, patch('*** Update File: src/old.txt', '*** Move to: dst/deep/new.txt')),
  apply('rename-case-only', { 'old.txt': 'x\n' }, patch('*** Update File: old.txt', '*** Move to: OLD.txt')),
  apply('rename-dest-add', { 'a.txt': 'a\n' }, patch('*** Update File: a.txt', '*** Move to: c.txt', '*** Add File: c.txt', '+n')),
  apply('rename-other-delete-source', { 'a.txt': 'a\n' }, patch('*** Update File: a.txt', '*** Move to: c.txt', '*** Delete File: a.txt')),
  apply('rename-and-update-batch', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, patch('*** Update File: a.txt', '*** Move to: z.txt', '*** Update File: b.txt', '@@', '-b', '+B', '*** Update File: c.txt', '@@', '-c', '+C')),
  apply('rename-dry-run-hunk', { 'old.txt': 'x\ny\n' }, patch('*** Update File: old.txt', '*** Move to: new.txt', '@@', '-y', '+Y'), { dry_run: true }),
  apply('seq-second-fails', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: b.txt', '@@', '-missing', '+x')),
  apply('seq-first-fails', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '@@', '-missing', '+x', '*** Update File: b.txt', '@@', '-b', '+B')),
  apply('seq-all-fail', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '@@', '-no', '+x', '*** Update File: b.txt', '@@', '-no', '+x')),
  apply('seq-dry-run', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: b.txt', '@@', '-b', '+B'), { dry_run: true }),
  apply('seq-dry-run-fail', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: b.txt', '@@', '-no', '+B'), { dry_run: true }),
  apply('seq-add-exists', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Add File: b.txt', '+n')),
  apply('seq-merge-same-file', { 'a.txt': 'a\nb\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: b.txt', '@@', '-b', '+B', '*** Update File: a.txt', '@@', '-b', '+X')),
  apply('seq-conflict', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: b.txt', '@@', '-b', '+B', '*** Delete File: a.txt')),
  apply('seq-empty-section', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '*** Update File: b.txt', '@@', '-b', '+B')),
  apply('seq-delete-missing-skip', { 'a.txt': 'a\n', 'b.txt': 'b\n' }, patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: nope.txt', '@@', '-a', '+B')),
  apply('update-same-file-twice', { 'a.txt': 'a\nb\nc\n' }, patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: a.txt', '@@', '-c', '+C')),
  apply('update-no-hunks', { 'a.txt': 'a\n' }, patch('*** Update File: a.txt')),
  apply('update-noop-hunk', { 'a.txt': 'a\nb\n' }, patch('*** Update File: a.txt', '@@', '-a', '+a')),
  apply('update-pure-insert-eof', { 'a.txt': 'a\nb\n' }, patch('*** Update File: a.txt', '@@', '+c')),
  apply('update-crlf', { 'a.txt': 'a\r\nb\r\nc\r\n' }, patch('*** Update File: a.txt', '@@', ' a', '-b', '+B', '+B2')),
  apply('update-no-final-newline', { 'a.txt': 'a\nb' }, patch('*** Update File: a.txt', '@@', '-b', '+B')),
  apply('update-indent-drift', { 'a.js': 'function f() {\n    x();\n    y();\n}\n' }, patch('*** Update File: a.js', '@@', '-  x();', '+  z();')),
  apply('update-unique-earlier', { 'a.txt': 'one\ntwo\nthree\nfour\n' }, patch('*** Update File: a.txt', '@@ three', '-three', '+3', '@@ one', '-one', '+1')),
  apply('update-eof-hunk', { 'a.txt': 'x\ny\nx\ny\n' }, patch('*** Update File: a.txt', '@@', ' x', '-y', '+Y', '*** End of File')),
  apply('update-bad-move-twice', { 'a.txt': 'a\n' }, patch('*** Update File: a.txt', '*** Move to: b.txt', '*** Move to: c.txt')),
  apply('add-empty', {}, patch('*** Add File: e.txt')),
  apply('add-blank-lines', {}, patch('*** Add File: e.txt', '+a', '', '+b', '')),
  apply('add-dry-run', {}, patch('*** Add File: e.txt', '+a'), { dry_run: true }),
  apply('no-patch-header', { 'a.txt': 'a\n' }, 'just text'),
  apply('line-before-header', { 'a.txt': 'a\n' }, '*** Begin Patch\nstray\n*** End Patch\n'),
  apply('eof-before-lines', { 'a.txt': 'a\n' }, patch('*** Update File: a.txt', '*** End of File')),
  apply('crlf-patch-text', { 'a.txt': 'a\nb\n' }, '*** Begin Patch\r\n*** Update File: a.txt\r\n@@\r\n-a\r\n+A\r\n*** End Patch\r\n'),
  apply('quoted-path', { 'a b.txt': 'a\n' }, patch('*** Update File: "a b.txt"', '@@', '-a', '+A')),
  apply('decorated-path', { 'a.txt': 'a\n' }, patch('*** Update File: a.txt ***', '@@', '-a', '+A')),
  // Recovery tiers (v4a-windows.mjs): one case where the tier rescues, one where its guard refuses.
  apply('tier-opcode-prefix', { 'a.md': '- Plan\nkeep\n' }, patch('*** Update File: a.md', '@@', '- Plan', '+- Done')),
  apply('tier-opcode-prefix-delete-only', { 'a.md': '- Plan\nkeep\n' }, patch('*** Update File: a.md', '@@', '- Plan')),
  apply('tier-opcode-prefix-ambiguous', { 'a.md': '- Plan\nkeep\n- Plan\n' }, patch('*** Update File: a.md', '@@', '- Plan', '+- Done')),
  apply('tier-plus-as-context', { 'a.txt': 'a\n+ TODO\nb\n' }, patch('*** Update File: a.txt', '@@', ' a', '+ TODO', '-b', '+B')),
  apply('tier-plus-as-context-no-relocate', { 'a.txt': 'a\nb\na\n+ TODO\nb\n' }, patch('*** Update File: a.txt', '@@', ' a', '+ TODO', ' b')),
  apply('tier-escape-equiv', { 'a.txt': 'x\ncaf\\u00e9\ny\n' }, patch('*** Update File: a.txt', '@@', '-café', '+coffee')),
  apply('tier-escape-equiv-ambiguous', { 'a.txt': 'caf\\u00e9\ncaf\\u00e9\n' }, patch('*** Update File: a.txt', '@@', '-café', '+coffee')),
  apply('tier-escape-equiv-eof', { 'a.txt': 'x\ncaf\\u00e9\ny\n' }, patch('*** Update File: a.txt', '@@', '-café', '+coffee', '*** End of File')),
  apply('tier-context-tolerance', { 'a.txt': 'alpha one\nbeta two\ngamma three\ndelta four\n' }, patch('*** Update File: a.txt', '@@', ' alpha one', ' beta twoo', '-gamma three', '+GAMMA')),
  apply('tier-context-tolerance-dissimilar-falls-to-outer-trim', { 'a.txt': 'alpha one\nbeta two\ngamma three\ndelta four\n' }, patch('*** Update File: a.txt', '@@', ' alpha one', ' zzzzzz', '-gamma three', '+GAMMA')),
  apply('tier-context-tolerance-ambiguous', { 'a.txt': 'alpha one\nbeta two\ngamma three\nalpha one\nbeta two\ngamma three\n' }, patch('*** Update File: a.txt', '@@', ' alpha one', ' beta twoo', ' gamma three', '+X')),
  apply('tier-outer-trim', { 'a.txt': 'a\nb\nTARGET\nc\n' }, patch('*** Update File: a.txt', '@@', ' zzz', '-TARGET', '+T2', ' c')),
  apply('tier-outer-trim-ambiguous', { 'a.txt': 'TARGET\nc\nq\nTARGET\nc\n' }, patch('*** Update File: a.txt', '@@', ' zzz', '-TARGET', '+T2', ' c')),
  apply('tier-outer-trim-insert-only', { 'a.txt': 'a\nb\nc\n' }, patch('*** Update File: a.txt', '@@', ' zzz', '+new', ' b')),
  apply('tier-edit-distance', { 'a.txt': 'start here\n  return value;\nfinish here\nend\n' }, patch('*** Update File: a.txt', '@@', ' start here', '-  retur value;', '+  return 1;', ' finish here')),
  apply('tier-edit-distance-too-far', { 'a.txt': 'start here\n  return value;\nfinish here\nend\n' }, patch('*** Update File: a.txt', '@@', ' start here', '-  retrn valu;', '+  return 1;', ' finish here')),
  apply('tier-edit-distance-two-lines', { 'a.txt': 'start here\n  return value;\n' }, patch('*** Update File: a.txt', '@@', ' start here', '-  retur value;', '+  return 1;')),
  // Read redirects (read-redirects.mjs): a missing header path is re-pointed at its unique relocated twin.
  apply('redirect-basename', { 'src/lib/a.js': 'one\ntwo\n' }, patch('*** Update File: a.js', '@@', '-one', '+ONE')),
  apply('redirect-basename-ambiguous', { 'x/a.js': 'one\n', 'y/a.js': 'one\n' }, patch('*** Update File: a.js', '@@', '-one', '+ONE')),
  apply('redirect-basename-case', { 'src/A.JS': 'one\n' }, patch('*** Update File: a.js', '@@', '-one', '+ONE')),
  apply('redirect-existing-wins', { 'a.js': 'one\n', 'src/a.js': 'one\n' }, patch('*** Update File: a.js', '@@', '-one', '+ONE')),
  apply('redirect-vendor-skipped', { 'node_modules/p/a.js': 'one\n' }, patch('*** Update File: a.js', '@@', '-one', '+ONE')),
  apply('redirect-hidden-skipped', { '.hid/a.js': 'one\n' }, patch('*** Update File: a.js', '@@', '-one', '+ONE')),
  apply('redirect-suffix-strip', { 'src/a.js': 'one\n' }, patch('*** Update File: proj/src/a.js', '@@', '-one', '+ONE')),
  apply('redirect-delete', { 'sub/gone.txt': 'x\ny\n' }, patch('*** Delete File: gone.txt')),
  apply('redirect-add-untouched', { 'sub/new.txt': 'x\n' }, patch('*** Add File: new.txt', '+n')),
  apply('redirect-none-found', { 'q.js': 'one\n' }, patch('*** Update File: a.js', '@@', '-one', '+ONE')),
  // Overlapping hunks: the conversion emits both, so the wording is the applying engine's own.
  apply('overlap-partial', { 'a.txt': 'a\nb\nc\nd\n' }, patch('*** Update File: a.txt', '@@', ' a', '-b', '+B', '@@', ' b', '-c', '+C')),
  apply('overlap-same-position', { 'a.txt': 'a\nb\nc\nd\n' }, patch('*** Update File: a.txt', '@@', '-b', '+B', '@@', '-b', '+X')),
  apply('overlap-insert-same-index', { 'a.txt': 'a\nb\nc\n' }, patch('*** Update File: a.txt', '@@', '+x', '@@', '+y')),
  // Request intake (request.mjs / parsing.mjs): salvage, validation, and the route flags.
  apply('format-invalid', { 'a.txt': 'one\n' }, patch('*** Update File: a.txt', '@@', '-one', '+ONE'), { format: 'xml' }),
  apply('format-v4a-explicit', { 'a.txt': 'one\n' }, '*** Update File: a.txt\n@@\n-one\n+ONE\n', { format: 'v4a' }),
  apply('compacted-placeholder', { 'a.txt': 'one\n' }, '[mixdog compacted patch: 120 chars, sha256:abcd]'),
  apply('compacted-placeholder-midbody', { 'a.txt': 'one\n' }, '*** Begin Patch\n[mixdog compacted patch v4a, sha256:abcd]\n*** End Patch\n'),
  apply('empty-patch', { 'a.txt': 'one\n' }, '   \n'),
  apply('shattered-keys', { 'a.txt': 'one\n' }, '*** Begin Patch', { '*** Update File: a.txt': '@@', '-one': '+ONE', '*** End Patch': '' }),
  apply('salvage-leading-blank', { 'a.txt': 'one\n' }, '\n\n*** Update File: a.txt\n@@\n-one\n+ONE\n'),
  apply('salvage-begin-patch-case', { 'a.txt': 'one\n' }, '***  begin patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** End Patch\n'),
  apply('salvage-implied-path', { 'a.txt': 'one\n' }, '*** Begin Patch\na.txt\n@@\n-one\n+ONE\n*** End Patch\n'),
  apply('salvage-implied-file-prefix', { 'a.txt': 'one\n' }, '*** Begin Patch\nFile: a.txt\n@@\n-one\n+ONE\n*** End Patch\n'),
  apply('salvage-unified-in-envelope', { 'a.txt': 'one\ntwo\n' }, '*** Begin Patch\n--- a/a.txt\n+++ b/a.txt\n@@\n-one\n+ONE\n*** End Patch\n'),
  apply('bare-unified', { 'a.txt': 'one\ntwo\n' }, '--- a/a.txt\n+++ b/a.txt\n@@\n-one\n+ONE\n'),
  apply('bare-unified-anchor', { 'a.txt': 'fn a\n  x\nfn b\n  x\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ fn b\n-  x\n+  y\n'),
  apply('bare-unified-two-files', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, '--- a/a.txt\n+++ b/a.txt\n@@\n-one\n+ONE\n--- a/b.txt\n+++ b/b.txt\n@@\n-two\n+TWO\n'),
  apply('bare-unified-duplicate-path', { 'a.txt': 'one\ntwo\n' }, '--- a/a.txt\n+++ b/a.txt\n@@\n-one\n+ONE\n--- a/a.txt\n+++ b/a.txt\n@@\n-two\n+TWO\n'),
  apply('bare-unified-create-delete', { 'old.txt': 'x\n' }, '--- /dev/null\n+++ b/new.txt\n@@\n+hello\n--- a/old.txt\n+++ /dev/null\n@@\n-x\n'),
  apply('bare-unified-mixed-counted', { 'a.txt': 'one\ntwo\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n@@\n-two\n+TWO\n'),
  apply('bare-unified-format-unified', { 'a.txt': 'one\n' }, '--- a/a.txt\n+++ b/a.txt\n@@\n-one\n+ONE\n', { format: 'unified' }),
  apply('ordered-ok', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, patch('*** Update File: a.txt', '@@', '-one', '+ONE', '*** Update File: b.txt', '@@', '-two', '+TWO'), { sequence: true }),
  apply('ordered-stop', { 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' }, patch('*** Update File: a.txt', '@@', '-one', '+ONE', '*** Update File: b.txt', '@@', '-nope', '+X', '*** Update File: c.txt', '@@', '-three', '+THREE'), { sequence: true }),
  apply('ordered-stop-dry-run', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, patch('*** Update File: a.txt', '@@', '-one', '+ONE', '*** Update File: b.txt', '@@', '-nope', '+X'), { mode: 'ordered', dry_run: true }),
  apply('ordered-same-file-twice', { 'a.txt': 'one\ntwo\n' }, patch('*** Update File: a.txt', '@@', '-one', '+ONE', '*** Update File: a.txt', '@@', '-two', '+TWO'), { mode: 'sequence' }),
  apply('ordered-rename-unit', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, patch('*** Update File: a.txt', '*** Move to: c.txt', '@@', '-one', '+ONE', '*** Update File: b.txt', '@@', '-two', '+TWO'), { sequence: true }),
  apply('ordered-rename-unit-dry-run', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, patch('*** Update File: a.txt', '*** Move to: c.txt', '@@', '-one', '+ONE', '*** Update File: b.txt', '@@', '-two', '+TWO'), { sequence: true, dry_run: true }),
  apply('mode-unknown-ignored', { 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' }, patch('*** Update File: a.txt', '@@', '-one', '+ONE', '*** Update File: b.txt', '@@', '-nope', '+X', '*** Update File: c.txt', '@@', '-three', '+THREE'), { mode: 'batch' }),
  // Genuine unified diffs (jsdiff parsePatch -> native engine).
  apply('unified-counted', { 'a.txt': 'one\ntwo\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n'),
  apply('unified-no-prefix', { 'a.txt': 'one\ntwo\n' }, '--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n'),
  apply('unified-timestamps', { 'a.txt': 'one\ntwo\n' }, '--- a/a.txt\t2024-01-01 00:00:00\n+++ b/a.txt\t2024-01-02 00:00:00\n@@ -2 +2 @@\n-two\n+TWO\n'),
  apply('unified-create', {}, '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n'),
  apply('unified-delete', { 'old.txt': 'x\ny\n' }, '--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n'),
  apply('unified-delete-missing', {}, '--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n'),
  apply('unified-two-files', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-two\n+TWO\n'),
  apply('unified-two-hunks', { 'a.txt': '1\n2\n3\n4\n5\n6\n7\n8\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-1\n+one\n 2\n@@ -7,2 +7,2 @@\n 7\n-8\n+eight\n'),
  apply('unified-stale-context', { 'a.txt': 'one\ntwo\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-nope\n+ONE\n'),
  apply('unified-wrong-line-number', { 'a.txt': 'a\nb\nc\nd\ne\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-d\n+D\n'),
  apply('unified-fuzz-context-drift', { 'a.txt': 'alpha\nbeta\ngamma\ndelta\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,4 +1,4 @@\n alpha\n betaX\n-gamma\n+GAMMA\n delta\n'),
  apply('unified-no-fuzz', { 'a.txt': 'alpha\nbeta\ngamma\ndelta\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,4 +1,4 @@\n alpha\n betaX\n-gamma\n+GAMMA\n delta\n', { fuzzy: false }),
  apply('unified-no-newline-marker', { 'a.txt': 'one\ntwo' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+TWO\n\\ No newline at end of file\n'),
  apply('unified-crlf-file', { 'a.txt': 'one\r\ntwo\r\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n'),
  apply('unified-git-headers', { 'a.txt': 'one\n' }, 'diff --git a/a.txt b/a.txt\nindex 1111111..2222222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n'),
  apply('unified-git-new-file', {}, 'diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n'),
  apply('unified-wrong-counts-fallback', { 'a.txt': 'one\ntwo\nthree\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,5 +1,5 @@\n-one\n+ONE\n two\n'),
  apply('unified-counts-too-small-fallback', { 'a.txt': 'one\ntwo\nthree\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n two\n'),
  apply('unified-counts-too-small-format-unified', { 'a.txt': 'one\ntwo\nthree\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n two\n', { format: 'unified' }),
  apply('unified-counts-too-big-fallback', { 'a.txt': 'one\ntwo\nthree\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,5 +1,5 @@\n-one\n+ONE\n two\n three\n'),
  apply('unified-wrong-counts-format-unified', { 'a.txt': 'one\ntwo\nthree\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,5 +1,5 @@\n-one\n+ONE\n two\n', { format: 'unified' }),
  apply('unified-missing-plus-header', { 'a.txt': 'one\n' }, '--- a/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n'),
  apply('unified-invalid-line', { 'a.txt': 'one\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-one\n?weird\n'),
  apply('unified-no-hunks', { 'a.txt': 'one\n' }, '--- a/a.txt\n+++ b/a.txt\n'),
  apply('unified-garbage', { 'a.txt': 'one\n' }, 'this is not a patch\nat all\n'),
  apply('unified-duplicate-target', { 'a.txt': 'one\ntwo\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n--- a/a.txt\n+++ b/a.txt\n@@ -2 +2 @@\n-two\n+TWO\n'),
  apply('unified-redirect', { 'src/lib/a.js': 'one\ntwo\n' }, '--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-one\n+ONE\n'),
  apply('unified-dry-run', { 'a.txt': 'one\ntwo\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n', { dry_run: true }),
  apply('unified-dry-run-stale', { 'a.txt': 'one\ntwo\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-nope\n+ONE\n', { dry_run: true }),
  apply('unified-ordered-stop', { 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-nope\n+X\n--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-three\n+THREE\n', { sequence: true }),
  apply('unified-rollback-create-exists', { 'a.txt': 'one\n', 'n.txt': 'taken\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n'),
  // reject_partial: false — hunk-level skips (V4A) and file-level skips (engine).
  apply('reject-partial-false-hunk', { 'a.txt': 'one\ntwo\nthree\n' }, patch('*** Update File: a.txt', '@@', '-one', '+ONE', '@@', '-nope', '+X', '@@', '-three', '+THREE'), { reject_partial: false }),
  apply('reject-partial-false-all-hunks', { 'a.txt': 'one\n' }, patch('*** Update File: a.txt', '@@', '-nope', '+X'), { reject_partial: false }),
  apply('reject-partial-false-two-files', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, patch('*** Update File: a.txt', '@@', '-one', '+ONE', '*** Update File: b.txt', '@@', '-nope', '+X'), { reject_partial: false }),
  apply('reject-partial-false-ordered', { 'a.txt': 'one\ntwo\n', 'b.txt': 'x\n' }, patch('*** Update File: a.txt', '@@', '-one', '+ONE', '@@', '-nope', '+X', '*** Update File: b.txt', '@@', '-x', '+X'), { reject_partial: false, sequence: true }),
  apply('reject-partial-false-unified-files', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-nope\n+X\n', { reject_partial: false }),
  apply('reject-partial-false-unified-dry-run', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-nope\n+X\n', { reject_partial: false, dry_run: true }),
  apply('tier-exact-not-fuzzy', { 'a.txt': 'alpha one\nbeta two\ngamma three\n' }, patch('*** Update File: a.txt', '@@', ' alpha one', ' beta twoo', '-gamma three', '+GAMMA'), { fuzzy: false }),
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
