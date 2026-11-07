// Writes native/core/fixtures/agent-trace/MANIFEST.json (the set is written by five recorders, so
// this one lists them in `command`). Run after the recorders:
//   MIXDOG_REPO=<node tree> node write-agent-trace-manifest.mjs [--tree <dir with node_modules>]
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(process.env.MIXDOG_REPO ?? join(here, '..', '..', '..'));
const common = await import(pathToFileURL(join(repo, 'benchmarks/rust-core/recorders/lib/common.mjs')).href);
const args = common.parseArgs();
const tree = common.resolveTree(args);
const setDir = resolve(join(here, '..', '..', '..', 'native', 'core', 'fixtures', 'agent-trace'));
const dir = 'benchmarks/rust-core/recorders';
const files = common.writeSetManifest(setDir, {
  set: 'agent-trace',
  recorder: `${dir}/record-agent-trace.mjs`,
  command: [
    `node ${dir}/record-agent-trace.mjs <out>/golden.json`,
    `node ${dir}/record-agent-trace-builders.mjs <out>/builders-golden.json`,
    `node ${dir}/record-agent-trace-sites.mjs <out>/sites-golden.json`,
    `node ${dir}/record-agent-trace-tools.mjs <out>/tools-golden.json`,
    `node ${dir}/record-trace-store.mjs <out>/trace-store-golden.json`,
  ].join(' && ').concat(' (each with MIXDOG_REPO=<tree>)'),
  identityTree: tree,
});
console.log(`wrote ${files} files`);
