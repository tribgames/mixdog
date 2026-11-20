import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [program, validator, skill, ...forwarded] = process.argv.slice(2);
assert.ok(process.versions.electron, 'the skill must run on packaged Electron');
assert.equal(realpathSync.native(process.execPath), program, 'the skill must run on Electron from this package');
assert.equal(
  realpathSync.native(process.argv[1]),
  realpathSync.native(fileURLToPath(import.meta.url)),
  'the launcher must make the script the entry'
);
assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined, 'node mode must not leak past the launcher');

// The shipped entry rewrites process.argv. The native diagnostic report keeps
// the original command line of this Electron child, including its real entry.
const expectedEntry = process.env.MIXDOG_ARTIFACT_SKILL_ENTRY;
const guardUrl = process.env.MIXDOG_ARTIFACT_SKILL_GUARD;
const { commandLine } = process.report.getReport().header;
const [executable, ...originalArgs] = commandLine;
assert.equal(realpathSync.native(executable), program, 'the original command must name packaged Electron');
const prefix = guardUrl ? ['--import', guardUrl] : [];
assert.deepEqual(
  originalArgs.slice(0, prefix.length),
  prefix,
  'only the guarded probe may preload its resolution guard'
);
const [entry, script, ...args] = originalArgs.slice(prefix.length);
assert.equal(realpathSync.native(entry), expectedEntry, 'the child must have started on the packaged skill entry');
assert.equal(realpathSync.native(script), process.argv[1], 'the packaged entry must receive this skill script');
assert.deepEqual(args, process.argv.slice(2), 'the packaged entry must preserve the child arguments');

if (guardUrl) {
  assert.equal(
    globalThis[Symbol.for('mixdog.packaged-skill-entry')],
    expectedEntry,
    'the preload must observe the packaged entry resolution'
  );
}

const { validateSkillDirectory } = await import(pathToFileURL(validator).href);
const result = validateSkillDirectory(skill);
assert.ok(result.ok, result.errors.join('\n'));
console.log(JSON.stringify({ skill: result.skill.name, forwarded }));
