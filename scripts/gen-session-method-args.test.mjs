import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-session-method-args.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const FILES = [
  'scripts/gen-session-method-args.mjs',
  'packages/protocol/src/index.ts',
  'packages/protocol-client/src/actions/action-namespaces.mjs',
  'packages/protocol-client/src/actions/method-args.generated.mjs',
  'packages/protocol-client/src/actions/method-args.generated.d.mts',
];

function tempTree() {
  const dir = mkdtempSync(join(tmpdir(), 'gen-method-args-'));
  for (const file of FILES) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    cpSync(join(root, file), join(dir, file));
  }
  return dir;
}

const run = (dir, expectedStatus, ...args) => {
  const result = spawnSync(process.execPath, [join(dir, 'scripts/gen-session-method-args.mjs'), ...args], {
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
};

test('--check passes on the committed files and drifts when the protocol changes', () => {
  const dir = tempTree();
  try {
    run(dir, 0, '--check');
    const declaration = join(dir, 'packages/protocol-client/src/actions/method-args.generated.d.mts');
    writeFileSync(declaration, readFileSync(declaration, 'utf8').replaceAll('\r\n', '\n'));
    run(dir, 0, '--check');
    // macOS temp paths can enter through /var while ESM resolves /private/var.
    const alias = join(dir, 'packages-alias');
    symlinkSync(dir, alias, 'junction');
    const protocol = join(dir, 'packages/protocol/src/index.ts');
    const text = readFileSync(protocol, 'utf8');
    const changed = text.replace(
      /^(export type AccountAuthenticateProviderParams = \{[^\r\n]*) \};$/m,
      '$1 extra?: string, };'
    );
    assert.notEqual(changed, text, 'the exposed authentication method was changed');
    writeFileSync(protocol, changed);
    run(alias, 1, '--check');
    run(alias, 0);
    run(dir, 0, '--check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('node can import the generator without a file entry', () => {
  const url = new URL('./gen-session-method-args.mjs', import.meta.url);
  const source = `import { generate } from ${JSON.stringify(url.href)}; console.log(typeof generate);`;
  for (const args of [['-'], ['--eval', source, '--', join(fileURLToPath(url), 'not-an-entry')]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', ...args], { input: source, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'function');
  }
});

test('generate lists exposed methods only; thread flag and args follow the params type', () => {
  const source = `
export type APrm = { opId: OpId, threadId?: ThreadId, one: string, two?: Array<{ a: number, b: string, }>, };
export type BPrm = { /** doc, with comma */ x: Record<string, number>, };
export type CPrm = { opId: OpId, y: string, };
export type ClientMethods = {
  "ns/a": { params: APrm; result: JsonValue };
  "ns/b": { params: BPrm; result: JsonValue };
  "ns/c": { params: CPrm; result: JsonValue };
};
`;
  const out = generate(source, { ns: ['b', 'a'] });
  assert.match(out.mjs, /'ns\/a': \{ thread: true, args: \["one","two"\] \},\n/);
  assert.match(out.mjs, /'ns\/b': \{ thread: false, args: \["x"\] \},\n/);
  assert.doesNotMatch(out.mjs, /ns\/c/);
  assert.ok(out.mjs.indexOf('ns/a') < out.mjs.indexOf('ns/b'));
});
