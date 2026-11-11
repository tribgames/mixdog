// The replay of record-lone-surrogate-wire.mjs against a freshly started, built mixdogd: each case's request is sent as a desktop
// client sends it (packages/protocol-client `call`, which adds the `opId`), to the same local HTTP server Node talked to.
//
// - A case the core refuses by decision (`refused`): the client failure's detail equals the core's lone refusal of that field, whole;
//   the local server got no request; for an MCP server, `mcp/mcpStatus` and `mcp/getMcpServerConfig` answer after the call what they
//   answered before it (nothing was saved). Node's answer is shown beside it.
// - Every other case: what the window is given (the value, or the failure's message as apps/desktop/src/main/protocol/core-error.ts
//   frames it for the window) equals Node's outcome, and the requests the local server got equal Node's, in order; Node's values go
//   through the manifest's one mapping (`mapping.at`, lone-mapping.mjs) and nothing else.
import { basename, join } from 'node:path';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from './common.mjs';
import { CASES, loneRefusal } from './lone-surrogate-wire-cases.mjs';
import { mapAt } from './lone-mapping.mjs';
import { endCore } from './core-stop.mjs';
import { NoAnswer, answered, startCore } from './phone-files-replay.mjs';

const WORLDS = join('D:\\mixdog-build\\tmp', `${basename(REPO_ROOT)}-lone-surrogate-wire-replay`);
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

export async function replay({ exe, golden, manifest, only, startServer, buildWorld }) {
  const stubBin = buildWorld();
  const server = await startServer();
  // The echo stub first on PATH, so the core's `rust-analyzer` is the one Node's recording ran.
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
  const core = await startCore(exe, join(WORLDS, 'core'), null, true, { [pathKey]: `${stubBin};${process.env[pathKey]}` });
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
      // What a client reads of an MCP server (`after`): the server list and its config.
      const state = async () => (entry.after ? { status: await call('mcp/mcpStatus', {}), config: await call('mcp/getMcpServerConfig', { name: entry.after }) } : null);
      const before = entry.refused ? await state() : null;
      server.log.splice(0);
      const got = await call(entry.core.method, entry.core.params);
      const requests = server.log.splice(0);
      compared += 1;
      if (entry.refused) {
        // Refused naming the field, nothing sent, nothing stored: what a client reads after the call is what it read before.
        const core = { detail: got.ok ? got : got.detail, requests, state: await state() };
        const expected = { detail: loneRefusal(entry.refused), requests: [], state: before };
        if (!isDeepStrictEqual(core, expected)) unexpected.push({ case: `${entry.name} (refused by decision)`, node: expected, core });
        else refused.push({ case: entry.name, node: node.node, nodeRequests: node.requests, core: core.detail });
        continue;
      }
      // Node's requests without the ones the manifest declares Node-only (`nodeOnlyRequests`: the warm-up HEAD / of its first
      // custom provider, at its recorded position); each declared one must be there as recorded. The core's are compared whole.
      const sent = (log) => {
        const declared = manifest.nodeOnlyRequests.filter((only) => only.case === entry.name);
        for (const only of declared) {
          if (!isDeepStrictEqual(log[only.index], only.request)) throw new Error(`${entry.name}: the declared Node-only request ${JSON.stringify(only.request)} is not at ${only.index} of the recording`);
        }
        return log.filter((_, index) => !declared.some((only) => only.index === index));
      };
      const core = { node: got.ok ? { ok: true, value: got.value } : { ok: false, error: got.error }, requests };
      // Node's value through the one mapping, at the places the manifest lists for this case (lone-mapping.mjs).
      const mapped = mapAt({ node: node.node, requests: node.requests }, manifest.mapping.at[entry.name] ?? []);
      const expected = { node: mapped.node, requests: sent(mapped.requests) };
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
    // Stopped as the app's quit stops it, its job included (a kill of the core alone left the world's daemon-owner claim lock busy at the removal below).
    await endCore(core);
    await server.close();
    rmSync(WORLDS, { recursive: true, force: true });
  }
}
