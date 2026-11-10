import assert from 'node:assert/strict';
import test from 'node:test';
import { applyConfigPatch, diffConfig } from './config-patch.mjs';

test('nested config edits preserve current sibling fields and do not mutate their inputs', () => {
  const before = { profile: { title: 'Before', language: 'ko' }, providers: {} };
  const after = { profile: { title: 'After', language: 'ko' }, providers: { demo: { enabled: false } } };
  const changes = diffConfig(before, after);
  const current = {
    profile: { title: 'Before', language: 'en', extra: true },
    providers: { demo: { enabled: true, baseURL: 'https://example.test' } },
    compaction: { auto: false },
  };
  const original = structuredClone(current);
  assert.deepEqual(applyConfigPatch(current, changes), {
    ...current,
    profile: { title: 'After', language: 'en', extra: true },
    providers: { demo: { enabled: false, baseURL: 'https://example.test' } },
  });
  assert.deepEqual(current, original);
  assert.equal(before.profile.title, 'Before');
});

test('config patches retain explicit false, null, empty strings, arrays and deletions', () => {
  const before = { enabled: true, title: 'old', route: 'old', skills: ['old'], shell: { command: 'pwsh' } };
  const after = { enabled: false, title: '', route: null, skills: [], shell: {} };
  assert.deepEqual(applyConfigPatch(before, diffConfig(before, after)), after);
  assert.deepEqual(applyConfigPatch({}, diffConfig(before, after)), {
    enabled: false,
    title: '',
    route: null,
    skills: [],
  });
  assert.deepEqual(applyConfigPatch({}, diffConfig({}, { marker: {} })), { marker: {} });
});

test('config patches compare object contents rather than key order and copy queued values', () => {
  assert.deepEqual(diffConfig({ one: { a: 1, b: 2 } }, { one: { b: 2, a: 1 } }), []);
  const after = { values: [{ label: 'saved' }] };
  const changes = diffConfig({}, after);
  after.values[0].label = 'mutated';
  const first = applyConfigPatch({}, changes);
  first.values[0].label = 'mutated again';
  assert.deepEqual(applyConfigPatch({}, changes), { values: [{ label: 'saved' }] });
});

test('a seed-only change fills a missing field and never overwrites a stored one', () => {
  const seed = [{ path: ['disabledAgents'], value: ['maintainer'], ifAbsent: true }];
  assert.deepEqual(applyConfigPatch({ theme: 'x' }, seed), { theme: 'x', disabledAgents: ['maintainer'] });
  assert.deepEqual(applyConfigPatch({ disabledAgents: ['worker'] }, seed), { disabledAgents: ['worker'] });
});

test('literal prototype-looking config keys remain own data properties', () => {
  const after = JSON.parse('{"__proto__":{"enabled":false},"constructor":{"prototype":{"enabled":false}}}');
  const saved = applyConfigPatch({}, diffConfig({}, after));
  assert.deepEqual(saved, after);
  assert.equal(Object.getPrototypeOf(saved), Object.prototype);
  assert.equal(Object.prototype.enabled, undefined);
});

test('a change with unlessSet is skipped when that stored value is set, judged before the whole patch', () => {
  const guard = { unlessSet: ['default'] };
  const patch = [
    { path: ['presets'], value: ['mine'], ...guard },
    { path: ['default'], value: 'workflow-lead', ...guard },
    { path: ['theme'], value: 'new' },
  ];
  // Unset (absent, null or empty): both guarded changes apply, whatever their order.
  for (const unset of [{}, { default: null }, { default: '' }]) {
    assert.deepEqual(applyConfigPatch({ theme: 'old', ...unset }, patch), {
      theme: 'new',
      presets: ['mine'],
      default: 'workflow-lead',
    });
    assert.deepEqual(applyConfigPatch({ ...unset }, [...patch].reverse()).default, 'workflow-lead');
  }
  // Set: the guarded changes stand down together; the unguarded one still applies.
  assert.deepEqual(applyConfigPatch({ theme: 'old', default: 'other', presets: ['theirs'] }, patch), {
    theme: 'new',
    default: 'other',
    presets: ['theirs'],
  });
});
