// Records every real tool definition once, for the goldens that reference definitions instead of inlining them
// (`lib/tool-definitions.mjs` `compactTools`): the product's tools, the delegated agent's `git`/`task`, the `shell`
// texts, the internal tools as `_getMcpTools` projects them and the edit dialects, each keyed by name and variant
// with the content hash of its canonical JSON. The Rust loader is `mixdog_js::fixture_tools`.
//
//   node benchmarks/rust-core/recorders/record-shared-tool-definitions.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/tool-definitions/definitions.json (`tree` names the product tree's `src` hash).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'tool-definitions-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, parseArgs, productIdentity, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { toolDefinitionsFixture } = await import('./lib/tool-definitions.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'tool-definitions');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-shared-tool-definitions.mjs';
const identity = productIdentity(tree);
const fixture = await toolDefinitionsFixture(tree, { srcSha256: identity.srcSha256 });
writeJson(join(stage, 'definitions.json'), fixture);
writeSetManifest(stage, { set: 'tool-definitions', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
console.log(`tool definitions: ${Object.keys(fixture.definitions).length} entries`);