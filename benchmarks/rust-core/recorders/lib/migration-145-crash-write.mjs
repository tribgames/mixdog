// A 1.4.5 process that dies while it publishes a file: the product's own atomic writer has written its
// `<name>.mixdog-tmp-<hex>` and the process is killed in place of the rename that would publish it, as a
// power cut between the two leaves it. The write is the creation of a Goal (`goals/<session>.json`).
// Run by record-migration-145.mjs with the recorded environment; argv: <tree> <data dir> <session id>.
import fs from 'node:fs';import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [tree, data, sessionId, killedFile] = process.argv.slice(2);
const die = (from, to) => {
  if (!String(to).includes('goals')) return;
  fs.writeFileSync(killedFile, String(from));
  process.kill(process.pid, 'SIGKILL');
};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  die(from, to);
  return rename(from, to);
};
const promisesRename = fs.promises.rename;
fs.promises.rename = (from, to) => {
  die(from, to);
  return promisesRename(from, to);
};
syncBuiltinESMExports();
const { createGoalRuntime } = await import(pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/runtime-core/goal-runtime.mjs')).href);
await createGoalRuntime({ dataDir: data }).control(sessionId, { action: 'create', objective: 'A goal whose write was cut' });
