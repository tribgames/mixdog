import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// The computer handlers reach Electron's screen and windows at import; outside Electron a stand-in answers.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export default "";export const screen = {};export const BrowserWindow = { getAllWindows: () => [] };export const app = {};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { registerComputerProcessFate } = await import('./computer-process-fate.ts');

function serve(source) {
  const handlers = new Map();
  registerComputerProcessFate({ handleRequest: (method, handler) => handlers.set(method, handler) }, source);
  return (params) => handlers.get('host/computer/processFate')(params, new AbortController().signal);
}

test('the host answers the OS state of one process from its own worker, and never takes a command', async () => {
  const asked = [];
  const answer = serve(() => ({
    readProcessFate: async (process) => {
      asked.push(process);
      return { state: 'running', created: '133700' };
    },
  }));
  assert.deepEqual(await answer({ pid: 4321, created: '' }), { state: 'running', created: '133700' });
  assert.deepEqual(asked, [{ pid: 4321, created: '' }]);
});

test('a malformed process is refused and no host running is unavailable', async () => {
  const answer = serve(() => ({
    readProcessFate: async () => assert.fail('nothing is read for a malformed request'),
  }));
  for (const params of [
    { pid: 0, created: '' },
    { pid: '1', created: '' },
    { pid: 1.5, created: '' },
    { pid: 2 },
    'x',
  ]) {
    await assert.rejects(answer(params), /pid|object/, JSON.stringify(params));
  }
  await assert.rejects(serve(() => null)({ pid: 4, created: '' }), /unavailable/);
});
