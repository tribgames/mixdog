// Tripwire, not a proof. It lists the modules that write the Lead preset
// (`upsertWorkflowPreset(…, 'lead', …)`) or call `persistLeadRoute(`, so a NEW
// writer shows up in review. Such a writer must go through the runtime setRoute
// (whose `onlyIfEmpty` compare-and-set sees every setRoute pick) or keep the
// runtime Main route in step itself, as onboarding does. It cannot see writes
// that build the preset another way, nor edits to the config file by other
// processes (those reach the runtime through the config reload sync).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set([
  'session-runtime/boot/providers.mjs', // persistLeadRoute: the setRoute persistence
  'session-runtime/workflow-agents-api/onboarding.mjs', // moves the runtime Main route with the write
  'runtime/agent/orchestrator/runtime-core/workflow.mjs', // the helper itself
]);

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) yield path;
  }
}

/** Source text without block and line comments. */
function code(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const posix = (path) => relative(root, path).replaceAll('\\', '/');

test('only the setRoute persistence and onboarding write the Lead preset', () => {
  const writers = [];
  for (const path of sources(root)) {
    if (/upsertWorkflowPreset\(\s*[\w.]+\s*,\s*'lead'/.test(code(path))) writers.push(posix(path));
  }
  assert.deepEqual(
    writers.filter((path) => !ALLOWED.has(path)),
    []
  );
});

test('persistLeadRoute is called only from the route persistence of setRoute', () => {
  const callers = [];
  for (const path of sources(root)) {
    if (/persistLeadRoute\(/.test(code(path))) callers.push(posix(path));
  }
  assert.deepEqual(callers, ['session-runtime/model-route/route-persist.mjs']);
});

test('the matcher ignores comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lead-writers-'));
  try {
    const file = join(dir, 'sample.mjs');
    writeFileSync(file, "// upsertWorkflowPreset(x, 'lead', y)\n/* persistLeadRoute( */\nconst a = 1;\n");
    assert.equal(/upsertWorkflowPreset\(|persistLeadRoute\(/.test(code(file)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
