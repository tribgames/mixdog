import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MEMORY_STORE_FAULT_CODE,
  MemoryStoreFault,
  isStoreFault,
  markStoreFault,
} from './memory-cycle2-shared.mjs'

test('a foreign error is never classified by its text', () => {
  // The exact former marker text, now owned by nobody: a provider/DB error that
  // happens to read this way must stay an ordinary, recoverable action error.
  const lookalikeMessage = new Error('MemoryStoreFault: connection reset by peer')
  assert.equal(isStoreFault(lookalikeMessage), false)

  const lookalikeName = new Error('connection reset by peer')
  lookalikeName.name = 'MemoryStoreFault'
  assert.equal(isStoreFault(lookalikeName), false)

  const lookalikeBoth = new Error('MemoryStoreFault: rollback')
  lookalikeBoth.name = 'MemoryStoreFault:Error'
  assert.equal(isStoreFault(lookalikeBoth), false)

  // A half-claimed field is not a claim either.
  const halfClaim = new Error('nope')
  halfClaim.isMemoryStoreFault = true
  assert.equal(isStoreFault(halfClaim), false)
})

test('markStoreFault produces a typed fault and preserves the original', () => {
  const original = new Error('rollback')
  const fault = markStoreFault(original)
  assert.ok(fault instanceof MemoryStoreFault)
  assert.equal(isStoreFault(fault), true)
  assert.equal(fault.code, MEMORY_STORE_FAULT_CODE)
  // Message stays verbatim — it is not a classification channel.
  assert.equal(fault.message, 'rollback')
  assert.equal(fault.cause, original)
  assert.equal(original.message, 'rollback')
})

test('frozen, sealed and non-Error inputs still yield a typed fault', () => {
  const frozen = Object.freeze(new Error('commit ambiguous'))
  const fromFrozen = markStoreFault(frozen)
  assert.equal(isStoreFault(fromFrozen), true)
  assert.equal(fromFrozen.cause, frozen)
  assert.equal(frozen.message, 'commit ambiguous')

  const sealed = Object.seal(new Error('sealed write'))
  assert.equal(isStoreFault(markStoreFault(sealed)), true)

  const fromString = markStoreFault('boom')
  assert.equal(isStoreFault(fromString), true)
  assert.equal(fromString.message, 'boom')
})

test('marking is idempotent and non-faults stay unclassified', () => {
  const fault = markStoreFault(new Error('rollback'))
  assert.equal(markStoreFault(fault), fault)

  assert.equal(isStoreFault(new Error('guard mismatch')), false)
  assert.equal(isStoreFault(null), false)
  assert.equal(isStoreFault(undefined), false)
  assert.equal(isStoreFault('MemoryStoreFault: not an error'), false)
  assert.equal(isStoreFault({}), false)
})

test('an explicitly tagged cross-realm fault is recognised without instanceof', () => {
  // Second copy of the module (different realm/registry): instanceof fails, the
  // explicit field pair still classifies.
  const crossRealm = Object.assign(new Error('rollback'), {
    isMemoryStoreFault: true,
    code: MEMORY_STORE_FAULT_CODE,
  })
  assert.equal(crossRealm instanceof MemoryStoreFault, false)
  assert.equal(isStoreFault(crossRealm), true)
})
