// No desktop source reads or writes a userData file the core moved. The names are the migrated
// files of native/core/crates/mixdog-migrate/src/desktop_profile/plan.rs (FILE_KINDS) and the
// supplement files of desktop_profile/supplement.rs (FILES). A name in a non-test source outside
// the allowlist means a second reader of a file that now has one owner, the core.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

const FILE_KINDS = [
  'desktop-projects.json',
  'agent-rooms.json',
  'agent-greetings.json',
  'notification-preferences.json',
  'session-auto-retention.json',
  'remote-activated.json',
  'remote-access-settings.json',
  'remote-clients.json',
  'relay-device.json',
  'relay-device-revocations.json',
  'relay-e2ee.json',
  'remote-bridge.token',
  'remote-native-push.json',
  'pc-access-revokes.json',
  'selected-file-grants.json',
]
const SUPPLEMENT_FILES = ['ssh-hosts.json', 'port-forwards.json', 'remote-hosts.json', 'server-windows.json']

// Files (relative to apps/desktop/src, forward slashes) that may name a moved file, with the reason.
// These are readers the core has not yet taken over; each entry is deleted with the module that
// reads the file, and the test fails on an entry that no longer names a moved file.
const ALLOWLIST = new Map([
  ['main/connections/port-forward-store.ts', 'port-forwards.json store, awaiting its deletion'],
  ['main/connections/window-restore.ts', 'server-windows.json store, awaiting its deletion'],
  ['main/index.ts', 'pc-access-revokes.json path handed to the revoke queue, awaiting its deletion'],
  ['main/notification-preferences.ts', 'notification-preferences.json store, awaiting its deletion'],
  ['main/remote-relay-device.ts', 'relay-device identity and revocation files, awaiting their deletion'],
  ['main/ssh/ssh-host-store.ts', 'ssh-hosts.json store, awaiting its deletion'],
])

const isTest = (name) => /\.(test|slow\.test|electron\.test)\.(mjs|ts|tsx|js)$/.test(name) || name.endsWith('.d.ts')

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(entry.name) && !isTest(entry.name)) yield path
  }
}

// Block and line comments are documentation, not readers.
const BLOCK_COMMENT = new RegExp(String.raw`/\*[\s\S]*?\*/`, 'g')
const LINE_COMMENT = new RegExp(String.raw`(^|[^:'"])//.*$`, 'gm')
const stripComments = (text) => text.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '$1')

test('no desktop source names a userData file the core moved', () => {
  const names = [...FILE_KINDS, ...SUPPLEMENT_FILES]
  const hits = []
  const allowedSeen = new Set()
  for (const path of sources(SRC)) {
    const rel = relative(SRC, path).split(sep).join('/')
    const text = stripComments(readFileSync(path, 'utf8'))
    for (const name of names) {
      if (!text.includes(name)) continue
      if (ALLOWLIST.has(rel)) allowedSeen.add(rel)
      else hits.push(`${rel}: ${name}`)
    }
  }
  assert.deepEqual(hits, [])
  assert.deepEqual([...ALLOWLIST.keys()].filter((rel) => !allowedSeen.has(rel)), [], 'stale allowlist entry')
})
