import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeInputPath, splitJoinedPathScopes, toDisplayPath, urlAsPathMessage } from './path-utils.mjs';
import { tryExecuteExternalToolAdapter } from './external-tool-adapters.mjs';

process.env.MIXDOG_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'mixdog-pu-data-'));
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const { executeBuiltinTool } = await import('../builtin.mjs');

test('toDisplayPath strips a cwd prefix without changing unmatched absolute paths', () => {
  assert.equal(toDisplayPath(''), '');
  assert.equal(toDisplayPath('C:/proj/src/a.ts', 'C:/proj'), 'src/a.ts');
  assert.equal(toDisplayPath('C:\\proj\\src\\a.ts', 'C:/proj/'), 'src/a.ts');
  assert.equal(toDisplayPath('C:/proj', 'C:/proj'), '');
  assert.equal(toDisplayPath('C:/other/a.ts', 'C:/proj'), 'C:/other/a.ts');
  assert.equal(toDisplayPath('C:/proj/src/a.ts'), 'C:/proj/src/a.ts');
});

test('normalizeInputPath strips the slash before a drive letter on Windows', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(normalizeInputPath('/C:/x/y'), 'C:\\x\\y');
  assert.equal(normalizeInputPath('/C:\\x\\y'), 'C:\\x\\y');
  assert.equal(normalizeInputPath('/c/x/y'), 'c:\\x\\y');
});

test('/C:/ paths pass the write guard on Windows while ADS and trailing dot stay rejected', {
  skip: process.platform !== 'win32',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-slashdrive-'));
  try {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'one');
    const slashed = `/${file.replace(/\\/g, '/')}`;
    const ok = await tryExecuteExternalToolAdapter(
      'edit',
      { file_path: slashed, old_string: 'one', new_string: 'two' },
      dir,
      {}
    );
    assert.match(String(ok), /^Updated /);
    const ads = await tryExecuteExternalToolAdapter(
      'edit',
      { file_path: `${file}:stream`, old_string: 'a', new_string: 'b' },
      dir,
      {}
    );
    assert.match(String(ads), /NTFS ADS/);
    const dot = await tryExecuteExternalToolAdapter(
      'write',
      { file_path: `${join(dir, 'b.txt')}.`, contents: 'x' },
      dir,
      {}
    );
    assert.match(String(dot), /trailing dot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('http(s) URLs are redirected to web_fetch for edit and read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-url-'));
  try {
    assert.equal(urlAsPathMessage('https://example.com/a'), 'this is a URL; use web_fetch');
    assert.equal(urlAsPathMessage('C:\\a'), null);
    const edit = await tryExecuteExternalToolAdapter(
      'edit',
      { file_path: 'http://x.io/a', old_string: 'a', new_string: 'b' },
      dir,
      {}
    );
    assert.match(String(edit), /this is a URL; use web_fetch/);
    const read = await executeBuiltinTool('read', { path: 'https://example.com/a' }, dir, {});
    assert.match(String(read), /this is a URL; use web_fetch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edit accepts old_str/new_str aliases, rejects conflicts, and reports a precise shape error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-alias-'));
  try {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'one');
    const edit = (args) => tryExecuteExternalToolAdapter('edit', { file_path: file, ...args }, dir, {});
    assert.match(String(await edit({ old_str: 'one', new_str: 'two' })), /^Updated /);
    assert.equal(readFileSync(file, 'utf8'), 'two');
    assert.match(String(await edit({ old_string: 'two', new_str: 'three' })), /^Updated /);
    assert.equal(readFileSync(file, 'utf8'), 'three');
    const conflict = String(await edit({ old_string: 'three', old_str: 'other', new_string: 'x' }));
    assert.match(conflict, /both old_string and old_str with different values/);
    assert.equal(readFileSync(file, 'utf8'), 'three');
    const missing = String(await edit({ old_string: 'three' }));
    assert.match(missing, /^Error: edit requires string old_string and new_string \(got keys: file_path, old_string\)/);
    assert.doesNotMatch(missing, /unknown builtin tool/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('joined multi-path strings: spaced single path unchanged, existing pieces split, otherwise array hint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-joined-'));
  try {
    mkdirSync(join(dir, 'Program Files'));
    for (const n of ['a.txt', 'b.txt']) writeFileSync(join(dir, n), `${n}\n`);
    writeFileSync(join(dir, 'Program Files', 'x.txt'), 'x\n');

    const spaced = { path: 'Program Files' };
    assert.equal(splitJoinedPathScopes('grep', spaced, dir), null);
    assert.equal(spaced.path, 'Program Files');

    const comma = { path: 'a.txt,b.txt' };
    splitJoinedPathScopes('grep', comma, dir);
    assert.deepEqual(comma.path, ['a.txt', 'b.txt']);
    const space = { file_path: 'a.txt b.txt' };
    splitJoinedPathScopes('read', space, dir);
    assert.deepEqual(space.file_path, ['a.txt', 'b.txt']);
    const read = String(await executeBuiltinTool('read', { file_path: 'a.txt, b.txt' }, dir, {}));
    assert.match(read, /a\.txt/);
    assert.match(read, /b\.txt/);

    const mixed = String(await executeBuiltinTool('read', { path: 'a.txt,missing.txt' }, dir, {}));
    assert.match(mixed, /To pass several paths, send an array/);
    assert.doesNotMatch(mixed, /locate with find/i);

    const names = Array.from({ length: 11 }, (_, i) => `f${i}.txt`);
    for (const n of names) writeFileSync(join(dir, n), 'z\n');
    const over = String(await executeBuiltinTool('read', { path: names.join(',') }, dir, {}));
    assert.match(over, /11 given, max 10/);
    assert.match(over, /split or pass the parent directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('joined multi-path strings never widen scope beyond the working directory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'mixdog-joined-scope-'));
  const outside = mkdtempSync(join(tmpdir(), 'mixdog-joined-outside-'));
  const dir = join(parent, 'project');
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    for (const value of ['src, ..', `src,${parent}`, `src ${outside}`, '., src', `src,${dir}`]) {
      const args = { path: value };
      const message = splitJoinedPathScopes('grep', args, dir);
      assert.match(String(message), /send an array \(path\[\]\)/, value);
      assert.equal(args.path, value, `${value} stays unsplit`);
    }
    // An in-project junction/symlink whose real target is outside is outside.
    symlinkSync(outside, join(dir, 'link'), 'junction');
    const linked = { path: 'src, link' };
    assert.match(String(splitJoinedPathScopes('grep', linked, dir)), /send an array \(path\[\]\)/);
    assert.equal(linked.path, 'src, link');
    const ordinary = { path: 'src, docs' };
    assert.equal(splitJoinedPathScopes('glob', ordinary, dir), null);
    assert.deepEqual(ordinary.path, ['src', 'docs']);
    const nested = { file_path: 'src a.txt' };
    assert.equal(splitJoinedPathScopes('read', nested, dir), null);
    assert.deepEqual(nested.file_path, ['src', 'a.txt']);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('toDisplayPath matches Windows drive-letter casing', () => {
  assert.equal(toDisplayPath('c:/proj/src/a.ts', 'C:/PROJ'), 'src/a.ts');
});
