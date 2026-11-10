// The leftover form the replay compares (lib/tool-failure-rows.mjs leftAtExit), on job reports built for the case.
//   node --test benchmarks/rust-core/recorders/lib/tool-failure-rows.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { leftAtExit } from './tool-failure-rows.mjs';

const NODE = '"C:\\Program Files\\nodejs\\node.exe"';
const report = (program, commandLine) => ({ program, left: [{ pid: program + 1, name: 'node', parentPid: program, parent: 'node', commandLine }] });

test('two leftovers under the same parent with different command lines are different leftovers', () => {
  const node = leftAtExit(report(100, `${NODE} fx-mcp.mjs`), { workspace: 'D:\\a\\ws', dataDir: 'D:\\a\\data' });
  const core = leftAtExit(report(200, `${NODE} unrelated-leak.mjs`), { workspace: 'D:\\b\\ws', dataDir: 'D:\\b\\data' });
  assert.notDeepEqual(core, node);
});

test("a command line naming each run's own workspace and data folder is the same leftover", () => {
  const node = leftAtExit(report(100, `${NODE} D:\\a\\ws\\fx-mcp.mjs --log D:\\a\\data\\x`), { workspace: 'D:\\a\\ws', dataDir: 'D:\\a\\data' });
  const core = leftAtExit(report(200, `${NODE} D:\\b\\ws\\fx-mcp.mjs --log D:\\b\\data\\x`), { workspace: 'D:\\b\\ws', dataDir: 'D:\\b\\data' });
  assert.deepEqual(core, node);
  assert.equal(core[0].commandLine, `${NODE} <WS>\\fx-mcp.mjs --log <DATA>\\x`);
});
