// A session create lists its cwd and reads its instruction files off the main
// thread; the synchronous composition then reads nothing from the directory.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { composeSessionSystem } from '../../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import { readStartupFiles } from './materialize.mjs';

/** Sync fs calls that name `dir` (readdir / realpath / open of anything inside it). */
function spyOnDir(dir) {
  const hits = [];
  const originals = { readdirSync: fs.readdirSync, openSync: fs.openSync, realpath: fs.realpathSync.native };
  const touches = (target) => String(target).startsWith(dir);
  fs.readdirSync = function (target, ...rest) {
    if (touches(target)) hits.push(['readdirSync', String(target)]);
    return originals.readdirSync.call(this, target, ...rest);
  };
  fs.openSync = function (target, ...rest) {
    if (touches(target)) hits.push(['openSync', String(target)]);
    return originals.openSync.call(this, target, ...rest);
  };
  fs.realpathSync.native = function (target, ...rest) {
    if (touches(target)) hits.push(['realpathSync', String(target)]);
    return originals.realpath.call(this, target, ...rest);
  };
  syncBuiltinESMExports();
  return {
    hits,
    restore() {
      fs.readdirSync = originals.readdirSync;
      fs.openSync = originals.openSync;
      fs.realpathSync.native = originals.realpath;
      syncBuiltinESMExports();
    },
  };
}

test('the create path reads the cwd off-thread and composition then does no directory read', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-startup-files-'));
  writeFileSync(join(cwd, 'AGENTS.md'), 'Project rule: be brief.');
  writeFileSync(join(cwd, 'notes.txt'), 'x');
  const spy = spyOnDir(cwd);
  try {
    const startup = await readStartupFiles({ currentCwd: cwd, config: { instructionFiles: 'agents' } });
    assert.deepEqual(spy.hits, [], 'the async read touched the directory without a sync call');
    assert.match(startup.instructionFilesContext, /Project rule: be brief\./);
    assert.match(startup.cwdStartupEntries, /AGENTS\.md/);

    const prompt = composeSessionSystem(
      { cwd, promptConfig: { instructionFiles: 'agents' }, ...startup },
      {
        profile: {},
        providerName: 'openai',
        modelName: 'gpt-5.4',
        surface: { ownerIsAgent: false, resolvedAgent: 'lead', skills: [], toolsForRouting: [] },
        sessionMode: 'coding',
        sessionId: 'sess_startup_files',
      }
    );
    assert.deepEqual(spy.hits, [], 'composition read nothing from the directory');
    assert.match(prompt.environmentTailContext, /notes\.txt/);
  } finally {
    spy.restore();
    rmSync(cwd, { recursive: true, force: true });
  }
});
