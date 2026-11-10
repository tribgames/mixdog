#!/usr/bin/env node
// A v1.4.5 process (the tag's own session store, `git archive 69fe41b05`) that writes one lead session the way that release did: its
// `createSession` and `askSession` against a scripted provider, saved as the one JSON file that release kept per session.
//   node write-v145-session.mjs <v1.4.5 tree> <cwd> <clock ms> <prompt>   (MIXDOG_DATA_DIR names the data directory)
// Prints the written session's id.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { installDeterministicWorld } from './deterministic-world.mjs';

const [treeArg, cwd, startArg, prompt] = process.argv.slice(2);
installDeterministicWorld({ start: Number(startArg), pid: 4243 });
const load = (p) => import(pathToFileURL(join(treeArg, p)).href);
const manager = await load('src/runtime/agent/orchestrator/session/manager.mjs');
const store = await load('src/runtime/agent/orchestrator/session/store.mjs');
const { _withRegisteredProviderForTestAsync } = await load('src/runtime/agent/orchestrator/providers/registry.mjs');
const stub = {
  name: 'stub',
  contextWindow: 128000,
  async send() {
    return { content: 'reply', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
  },
};
let id;
await _withRegisteredProviderForTestAsync('stub', stub, async () => {
  id = manager.createSession({ provider: 'stub', model: 'stub-model', owner: 'user', sourceType: 'lead', agent: 'lead', cwd }).id;
  await manager.askSession(id, prompt, null, undefined, cwd, undefined, {});
});
await store.drainSessionStore();
process.stdout.write(id);
process.exit(0);
