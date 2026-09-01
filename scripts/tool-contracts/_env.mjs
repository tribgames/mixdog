// Shared per-process environment for the tool-contract suites. Import this
// module FIRST in every suite: it wires the debug native-spawn binary and
// keeps intentionally malformed fixtures out of production failure logs.
import '../native-spawn-test-runtime.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// These suites intentionally drive malformed/stale apply_patch cases. Keep
// those fixtures out of the user's production failure and replay histories.
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(tmpdir(), `mixdog-tool-contracts-failures-${process.pid}.jsonl`);
process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '0';

const localGraphBin = join(
  root,
  'native',
  'mixdog-graph',
  'target',
  'debug',
  process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph',
);
if (!process.env.MIXDOG_GRAPH_BIN && existsSync(localGraphBin)) {
  process.env.MIXDOG_GRAPH_BIN = localGraphBin;
}
