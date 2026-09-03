import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isSafeConsolidation, extractAnchorTokens, isStrictDuplicate, charDice,
  isSafeConservativeDelete, digestRedundancy,
} from './memory-cycle3-guards.mjs'

const target = {
  id: 18,
  element: 'Mixdog installed-app fast deployment',
  summary: 'From C:\\Project\\mixdog, use npm run update:dev:fast --prefix apps/desktop for incremental installed-app updates.',
}
const source = {
  id: 21,
  element: 'Web/VPS deploy one-liner',
  summary: 'Use pwsh scripts/deploy-remote.ps1 [-FastDirect] for fast build, staging, atomic VPS swap.',
}

test('consolidation applies when every anchor from target and sources survives', () => {
  const verdict = isSafeConsolidation(target, [source],
    'Deploy commands',
    'Local: npm run update:dev:fast --prefix apps/desktop from C:\\Project\\mixdog; VPS: pwsh scripts/deploy-remote.ps1 [-FastDirect] for build, staging, atomic VPS swap.')
  assert.equal(verdict.ok, true, verdict.reason)
})

test('consolidation is held when a path or command is dropped', () => {
  const verdict = isSafeConsolidation(target, [source],
    'Deploy commands',
    'Local: npm run update:dev:fast --prefix apps/desktop from C:\\Project\\mixdog; VPS via the deploy script with -FastDirect.')
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /drops anchors/)
  assert.match(verdict.reason, /deploy-remote\.ps1/)
})

test('consolidation is held when the rewrite is longer than its parts', () => {
  const padded = `${target.summary} ${source.summary} ` + 'and additionally remember this padding text '.repeat(3)
  const verdict = isSafeConsolidation(target, [source], 'Deploy commands', padded)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /expands/)
})

test('anchor extraction keeps paths, flags, and quoted phrases, ignores prose', () => {
  const anchors = extractAnchorTokens('Use pwsh scripts/deploy-remote.ps1 [-FastDirect] and say "로컬 배포" for the app')
  assert.ok(anchors.has('scripts/deploy-remote.ps1'))
  assert.ok(anchors.has('-fastdirect'))
  assert.ok(anchors.has('로컬 배포'))
  assert.ok(!anchors.has('use'))
  assert.ok(!anchors.has('for'))
})

test('strict duplicate needs near-identical text, not shared topic', () => {
  assert.equal(isStrictDuplicate(target, { ...target, id: 99 }), true)
  assert.equal(isStrictDuplicate(target, source), false)
  assert.ok(charDice('abc', 'abc') === 1)
})

test('default-echo delete needs corroboration from the digest', async () => {
  const digest = 'Never deploy or restart the Mixdog app without explicit per-instance user approval.'
  const core = { element: 'approval before deploy', summary: 'Never deploy or restart the Mixdog app without explicit per-instance user approval.' }
  assert.ok(digestRedundancy(core.summary, digest) >= 0.5)
  const ok = await isSafeConservativeDelete(core, { reason: 'default' }, digest, { embed: null })
  assert.equal(ok.ok, true)
  const held = await isSafeConservativeDelete(core, { reason: 'default' }, 'Completely unrelated rule text about spreadsheets.', { embed: null })
  assert.equal(held.ok, false)
  const noReason = await isSafeConservativeDelete(core, {}, digest, { embed: null })
  assert.equal(noReason.ok, false)
})

test('semantic echo recognises a cross-language restatement through embeddings', async () => {
  // Stub embedder: the Korean core and the English rule map to the same
  // direction; the unrelated digest line points elsewhere.
  const vec = (text) => (/승인|approval/.test(text) ? [1, 0, 0] : [0, 1, 0])
  const embed = async (text) => vec(text)
  const digest = 'Never deploy or restart the Mixdog app without explicit per-instance user approval.\nSpreadsheet cells must not contain formulas that reference hidden sheets.'
  const core = { element: '재시작 전 명시적 승인', summary: '배포·재시작은 매번 명시적으로 승인받는다.' }
  const verdict = await isSafeConservativeDelete(core, { reason: 'restatement' }, digest, { embed })
  assert.equal(verdict.ok, true, verdict.reason)
  assert.match(verdict.reason, /semantic echo/)
})
