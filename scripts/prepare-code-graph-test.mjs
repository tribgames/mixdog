import { resolvePluginData } from '../src/runtime/shared/plugin-paths.mjs';
import { ensureGraphBinary } from '../src/runtime/agent/orchestrator/tools/graph-binary-fetcher.mjs';

const binary = await ensureGraphBinary(resolvePluginData());
process.stdout.write(`Prepared verified code-graph runtime: ${binary}\n`);
