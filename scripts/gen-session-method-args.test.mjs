import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { generate } from './gen-session-method-args.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const FILES = [
  'scripts/gen-session-method-args.mjs',
  'packages/protocol/src/index.ts',
  'packages/protocol-client/src/actions/action-namespaces.mjs',
  'packages/protocol-client/src/actions/method-args.generated.mjs',
  'packages/protocol-client/src/actions/method-args.generated.d.mts',
]

function tempTree() {
  const dir = mkdtempSync(join(tmpdir(), 'gen-method-args-'))
  for (const file of FILES) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    cpSync(join(root, file), join(dir, file))
  }
  return dir
}

const run = (dir, ...args) =>
  spawnSync(process.execPath, [join(dir, 'scripts/gen-session-method-args.mjs'), ...args], { encoding: 'utf8' })

test('--check passes on the committed files and drifts when the protocol changes', () => {
  const dir = tempTree()
  try {
    assert.equal(run(dir, '--check').status, 0)
    const protocol = join(dir, 'packages/protocol/src/index.ts')
    const text = readFileSync(protocol, 'utf8').replace('providerId: string, secret: string, };', 'providerId: string, secret: string, extra?: string, };')
    writeFileSync(protocol, text)
    assert.equal(run(dir, '--check').status, 1)
    assert.equal(run(dir).status, 0)
    assert.equal(run(dir, '--check').status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
`
  const out = generate(source, { ns: ['b', 'a'] })
  assert.match(out.mjs, /'ns\/a': \{ thread: true, args: \["one","two"\] \},\n/)
  assert.match(out.mjs, /'ns\/b': \{ thread: false, args: \["x"\] \},\n/)
  assert.doesNotMatch(out.mjs, /ns\/c/)
  assert.ok(out.mjs.indexOf('ns/a') < out.mjs.indexOf('ns/b'))
})
