// A 1.4.5 process that dies in the middle of a turn: the scripted provider answers the first send with a
// tool call and the process is killed at the second send, so the turn checkpoint (`turn-checkpoints/`)
// and the unsaved turn are what a real crash leaves. Run by record-migration-145.mjs with the recorded
// environment; argv: <tree> <cwd> <id file>.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [tree, cwd, idFile] = process.argv.slice(2);
const at = (p) => import(pathToFileURL(join(tree, p)).href);
const manager = await at('src/runtime/agent/orchestrator/session/manager.mjs');
const { _withRegisteredProviderForTestAsync } = await at('src/runtime/agent/orchestrator/providers/registry.mjs');
let sends = 0;
const stub = {
  name: 'stub',
  contextWindow: 128000,
  async send() {
    sends += 1;
    if (sends === 2) process.kill(process.pid, 'SIGKILL');
    return { content: '', toolCalls: [{ id: 'call_x', name: 'list', arguments: { path: '.' } }], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 2 } };
  },
};
await _withRegisteredProviderForTestAsync('stub', stub, async () => {
  const session = manager.createSession({ provider: 'stub', model: 'stub-model', cwd, owner: 'user', sourceType: 'lead', agent: 'lead' });
  writeFileSync(idFile, session.id);
  await manager.flushPendingSessionSaves?.();
  await manager.askSession(session.id, 'start a long job', null, undefined, cwd, undefined, {});
});
