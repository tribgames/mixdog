// The replay of record-lone-surrogate-wire.mjs against a freshly started, built mixdogd: each case's request is sent as a desktop
// client sends it (packages/protocol-client `call`, which adds the `opId`), to the same local HTTP server Node talked to.
//
// - A case the core refuses by decision (`refused`): the client failure's detail equals the core's lone refusal of that field, whole;
//   the local server got no request; for an MCP server, `mcp/getMcpServerConfig` answers for its name as for a name never added
//   (nothing was saved). Node's answer is shown beside it.
// - Every other case: what the window is given (the value, or the failure's message as apps/desktop/src/main/protocol/core-error.ts
//   frames it for the window) equals Node's outcome, and the requests the local server got equal Node's, in order.
import { basename, join } from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from './common.mjs';
import { CASES, loneRefusal } from './lone-surrogate-wire-cases.mjs';
import { NoAnswer, answered, killTree, startCore } from './phone-files-replay.mjs';

const WORLDS = join('D:\\mixdog-build\\tmp', `${basename(REPO_ROOT)}-lone-surrogate-wire-replay`);
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

export async function replay({ exe, golden, only, startServer, buildWorld }) {
  buildWorld();
  const server = await startServer();
  const core = await startCore(exe, join(WORLDS, 'core'), null);
  let client = null;
  try {
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    const { coreErrorForWindow } = await here('apps/desktop/src/main/protocol/core-error.ts');
    client = await answered('the connection (initialize)', connect({
      target: { id: 'core' },
      connector: createWsConnector(async () => core.endpoint),
      clientInfo: { name: 'mixdog-replay-desktop', title: 'Mixdog', version: '1.4.5', kind: 'desktop' },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
      random: Math.random,
    }));
    const call = async (method, params) => {
      try {
        const value = await answered(method, client.call(method, clone(params)));
        return { ok: true, value: value === undefined ? null : clone(value) };
      } catch (error) {
        if (error instanceof NoAnswer) throw error;
        return { ok: false, error: coreErrorForWindow(error)?.message ?? String(error), detail: error?.detail ? clone(error.detail) : null };
      }
    };
    const unexpected = [];
    const refused = [];
    let compared = 0;
    for (const entry of CASES) {
      if (!entry.core || (only && entry.name !== only)) continue;
      const node = golden.cases.find((recorded) => recorded.name === entry.name);
      if (!node) throw new Error(`the recording has no case ${entry.name}`);
      server.log.splice(0);
      const got = await call(entry.core.method, entry.core.params);
      const requests = server.log.splice(0);
      compared += 1;
      if (entry.refused) {
        const effect = { requests };
        if (entry.absent) {
          const named = (name) => call('mcp/getMcpServerConfig', { name }).then((answer) => JSON.stringify(answer).split(name).join('<name>'));
          effect.configSameAsNeverAdded = (await named(entry.absent)) === (await named(`${entry.absent}-never-added`));
        }
        const core = { detail: got.ok ? got : got.detail, ...effect };
        const expected = { detail: loneRefusal(entry.refused), requests: [], ...(entry.absent ? { configSameAsNeverAdded: true } : {}) };
        if (!isDeepStrictEqual(core, expected)) unexpected.push({ case: `${entry.name} (refused by decision)`, node: expected, core });
        else refused.push({ case: entry.name, node: node.node, nodeRequests: node.requests, core: core.detail });
        continue;
      }
      // Node's first custom provider built for an origin warms it with a fire-and-forget `HEAD /` (openai-compat.mjs
      // `preconnect`, once per origin and process), which the core does not send for a custom origin: a difference of
      // provider construction, not of the string under test, so the warm-up is left out of both sides.
      const sent = (log) => log.filter((request) => !(request.method === 'HEAD' && request.url === '/'));
      const core = { node: got.ok ? { ok: true, value: got.value } : { ok: false, error: got.error }, requests: sent(requests) };
      const expected = { node: node.node, requests: sent(node.requests) };
      if (!isDeepStrictEqual(core, expected)) unexpected.push({ case: entry.name, node: expected, core });
    }
    console.log(`lone-surrogate-wire replay over ${exe}: ${compared} compared, ${refused.length} refused by decision, ${unexpected.length} unexpected`);
    for (const entry of refused) {
      console.log(`REFUSED BY DECISION ${entry.case}`);
      console.log(`   node: ${JSON.stringify({ answer: entry.node, requests: entry.nodeRequests }).slice(0, 600)}`);
      console.log(`   core: ${JSON.stringify(entry.core).slice(0, 600)}`);
    }
    for (const entry of unexpected) {
      console.log(`DIFF ${entry.case}`);
      console.log(`   node: ${JSON.stringify(entry.node).slice(0, 900)}`);
      console.log(`   core: ${JSON.stringify(entry.core).slice(0, 900)}`);
    }
    return unexpected.length ? 1 : 0;
  } finally {
    client?.close?.();
    await killTree(core.child);
    await server.close();
    rmSync(WORLDS, { recursive: true, force: true });
  }
}
