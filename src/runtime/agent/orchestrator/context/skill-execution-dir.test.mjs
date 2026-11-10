import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSkillResultEnvelope, skillExecutionDir } from './skill-catalog.mjs';

const WIN_BUILTIN =
  'C:\\Program Files\\Mixdog\\resources\\runtime.asar\\node_modules\\mixdog\\src\\defaults\\skills\\skill-creator';
const POSIX_BUILTIN =
  '/Applications/Mixdog.app/Contents/Resources/runtime.asar/node_modules/mixdog/src/defaults/skills/skill-creator';

test('built-in skill directories inside runtime.asar map to the unpacked sidecar', () => {
  assert.equal(
    skillExecutionDir(WIN_BUILTIN, 'builtin'),
    'C:\\Program Files\\Mixdog\\resources\\runtime.asar.unpacked\\node_modules\\mixdog\\src\\defaults\\skills\\skill-creator'
  );
  assert.equal(
    skillExecutionDir(POSIX_BUILTIN, 'builtin'),
    '/Applications/Mixdog.app/Contents/Resources/runtime.asar.unpacked/node_modules/mixdog/src/defaults/skills/skill-creator'
  );
  assert.equal(
    skillExecutionDir('C:/Mixdog/resources/runtime.asar/node_modules/mixdog/src/defaults/skills/pptx', 'builtin'),
    'C:/Mixdog/resources/runtime.asar.unpacked/node_modules/mixdog/src/defaults/skills/pptx'
  );
});

test('already-unpacked, non-asar, and look-alike built-in paths are unchanged', () => {
  const unpacked = '/opt/Mixdog/resources/runtime.asar.unpacked/node_modules/mixdog/src/defaults/skills/pptx';
  assert.equal(skillExecutionDir(unpacked, 'builtin'), unpacked);
  assert.equal(
    skillExecutionDir('C:\\Project\\mixdog\\src\\defaults\\skills\\skill-creator', 'builtin'),
    'C:\\Project\\mixdog\\src\\defaults\\skills\\skill-creator'
  );
  assert.equal(skillExecutionDir('/srv/my-runtime.asar/skills/x', 'builtin'), '/srv/my-runtime.asar/skills/x');
});

test('user, plugin, and project skill directories are never remapped', () => {
  for (const source of ['global', 'plugin', 'project', undefined]) {
    assert.equal(skillExecutionDir(WIN_BUILTIN, source), WIN_BUILTIN);
    assert.equal(skillExecutionDir(POSIX_BUILTIN, source), POSIX_BUILTIN);
  }
});

test('the envelope substitutes the mapped directory for MIXDOG_SKILL_DIR and base-dir', () => {
  const dir = skillExecutionDir(WIN_BUILTIN, 'builtin');
  const envelope = buildSkillResultEnvelope(
    'skill-creator',
    'node "${MIXDOG_SKILL_DIR}/scripts/validate-skill.mjs" "<skill-directory>"',
    dir
  );
  const expected =
    'C:/Program Files/Mixdog/resources/runtime.asar.unpacked/node_modules/mixdog/src/defaults/skills/skill-creator';
  assert.ok(envelope.includes(`<base-dir>${expected}</base-dir>`));
  assert.ok(envelope.includes(`node "${expected}/scripts/validate-skill.mjs"`));
  assert.ok(!envelope.includes('runtime.asar/'));
});

test('the envelope renders MIXDOG_SKILL_NODE as the same bare launcher command for every shell', () => {
  const envelope = buildSkillResultEnvelope(
    'pptx',
    '${MIXDOG_SKILL_NODE} "${MIXDOG_SKILL_DIR}/scripts/source-extract.mjs" <file>\n${MIXDOG_SKILL_NODE} x',
    WIN_BUILTIN
  );
  const dir = WIN_BUILTIN.replace(/\\/g, '/');
  assert.ok(envelope.includes(`mixdog-skill-node "${dir}/scripts/source-extract.mjs" <file>\nmixdog-skill-node x`));
  assert.ok(!envelope.includes('${MIXDOG_SKILL_NODE}'));
  // skill-creator's validator keeps its plain-node command.
  const validator = buildSkillResultEnvelope(
    'skill-creator',
    'node "${MIXDOG_SKILL_DIR}/scripts/validate-skill.mjs"',
    '/s'
  );
  assert.ok(validator.includes('node "/s/scripts/validate-skill.mjs"'));
});
