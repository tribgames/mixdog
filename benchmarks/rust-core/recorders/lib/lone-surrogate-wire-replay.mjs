// The replay of record-lone-surrogate-wire.mjs against a freshly started, built mixdogd: each case's request is sent as a desktop
// client sends it (packages/protocol-client `call`, which adds the `opId`), to the same local HTTP server Node talked to.
//
// - A case the core refuses by decision (`refused`): the client failure's detail equals the core's lone refusal of that field, whole;
//   the local server got no request; for an MCP server, `mcp/mcpStatus` and `mcp/getMcpServerConfig` answer after the call what they
//   answered before it, and every file of the world (lib/world-files.mjs: the config file among them) has the bytes it had before
//   the call (nothing was saved). Node's answer is shown beside it.
// - After the cases, `inventorySweep` (manifest): every refused request and notification field of the inventory (a method only a
//   phone may call sent from a phone paired through the relay), with the same checks on files and on the local server, to which the
//   language server reports every message it receives.
// Every look at the files is taken behind the manifest's barrier (`worldFiles.barrier`): a config write answered once the config's
// one writer has written it.
// - Every other case: what the window is given (the value, or the failure's message as apps/desktop/src/main/protocol/core-error.ts
//   frames it for the window) equals Node's outcome, and the requests the local server got equal Node's, in order; Node's values go
//   through the manifest's one mapping (`mapping.at`, lone-mapping.mjs) and nothing else.
import { basename, join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from './common.mjs';
import { CASES, ROOT, loneRefusal } from './lone-surrogate-wire-cases.mjs';
import { mapAt } from './lone-mapping.mjs';
import { endCore } from './core-stop.mjs';
import { NoAnswer, answered, startCore } from './phone-files-replay.mjs';
import { startRelay } from './phone-relay-core.mjs';
import { changedFiles, worldFiles } from './world-files.mjs';

const WORLDS = join('D:\\mixdog-build\\tmp', `${basename(REPO_ROOT)}-lone-surrogate-wire-replay`);
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const readRepoJson = (path) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8'));

/** The params of a frame holding a lone unit at the inventory's `pattern` and nothing else, and the field the core names (`*` is
 *  member `0`, a last `{}` a key holding the unit, a last `**` member `x`; the core reads the unit as U+FFFD in the name). The frame
 *  is refused before its params are read, so nothing else of them is needed. */
function loneAt(pattern) {
  const parts = pattern.split('/').slice(1);
  const params = {};
  const named = [];
  let at = params;
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (last && part === '{}') {
      at['a\ud800'] = 'v';
      named.push('a\ufffd');
      return;
    }
    const key = part === '*' ? '0' : part === '**' ? 'x' : part;
    named.push(key);
    if (last) at[key] = 'a\ud800';
    else at = at[key] = {};
  });
  return { params, pointer: `/${named.join('/')}` };
}

export async function replay({ exe, golden, manifest, only, startServer, buildWorld }) {
  const stubBin = buildWorld();
  const server = await startServer();
  // The echo stub first on PATH, so the core's `rust-analyzer` is the one Node's recording ran.
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
  // A relay with a paired phone (lib/phone-relay-core.mjs, as the phone replays pair one): the methods only a phone may call are sent
  // from it.
  const relay = await startRelay({ repoRoot: REPO_ROOT, clients: [], capabilities: { textFrames: 1, maxFrameBytes: 1_048_576 } });
  const core = await startCore(exe, join(WORLDS, 'core'), relay, true, { [pathKey]: `${stubBin};${process.env[pathKey]}` });
  let client = null;
  try {
    await answered('the core dialing the relay', relay.leg());
    const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
    const pairing = relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8')));
    const phone = await answered('the phone handshake', relay.openRawPhone('phone-1', '0123456789abcdef0123456789abcdef', pairing));
    let phoneIds = 0;
    /** The phone's request and the frame answering it (other frames passed over), or the close of its client. */
    const phoneCall = (method, params) =>
      answered(`the phone's ${method}`, (async () => {
        const id = ++phoneIds;
        await phone.send({ id, method, params });
        for (;;) {
          const next = await phone.next();
          if (next.closed !== undefined || next.frame?.id === id) return next.closed !== undefined ? { closed: next.closed } : next.frame;
        }
      })());
    const initialized = await phoneCall('initialize', { clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' }, capabilities: {} });
    if (!initialized.result) throw new Error(`the phone was not initialized: ${JSON.stringify(initialized)}`);
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
    // Every file of the core's folders and of the cases' world, but the paths the manifest declares (`worldFiles.skip`).
    const files = () => worldFiles({ core: join(WORLDS, 'core'), world: ROOT }, manifest.worldFiles.skip);
    // The barrier before every look at the files (manifest `worldFiles.barrier`): on the same connection, a config write of the theme
    // the config already holds, answered only once the config's one writer has written it; a write the refused call queued on that
    // writer is written before it. Its answer is required to be the theme's.
    let theme = null;
    const settle = async () => {
      theme ??= (await call('config/getTheme', {})).value;
      const set = await call('config/setTheme', { id: theme });
      if (!set.ok || set.value?.id !== theme) throw new Error(`the barrier's config write failed: ${JSON.stringify(set)}`);
    };
    /** `files()` once the core has settled. */
    const settled = async () => {
      await settle();
      return files();
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
      const filesBefore = entry.refused ? await settled() : null;
      server.log.splice(0);
      const got = await call(entry.core.method, entry.core.params);
      const filesAfter = entry.refused ? await settled() : null;
      const requests = server.log.splice(0);
      compared += 1;
      if (entry.refused) {
        // Refused naming the field, nothing sent, nothing stored: what a client reads after the call is what it read before, and
        // every file of the world (the config the server list is saved in among them) has the bytes it had.
        const core = { detail: got.ok ? got : got.detail, requests, state: await state(), changedFiles: changedFiles(filesBefore, filesAfter) };
        const expected = { detail: loneRefusal(entry.refused), requests: [], state: before, changedFiles: [] };
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
    // Every field the inventory refuses (a request's and a notification's), sent as a desktop client sends it with a lone unit
    // there (manifest `inventorySweep`): before and after it, every file of the world has its bytes and no stand-in server got a
    // request; a request is refused naming the field (one a desktop may not call, by its origin, before that).
    let swept = 0;
    if (!only || only === 'inventory-sweep') {
      const { inventory, methodTable, phoneOnly, languageServerLifecycle } = manifest.inventorySweep;
      const origins = new Map(readRepoJson(methodTable).clientMethods.map((row) => [row.method, row.origins]));
      for (const field of readRepoJson(inventory).classes.filter((entry) => entry.class === 'refused').flatMap((entry) => entry.fields)) {
        const [kind, method, pattern] = field.split(' ');
        if (kind === 'answer') continue;
        const { params, pointer } = loneAt(pattern);
        const before = await settled();
        server.log.splice(0);
        const desktop = kind === 'request' && origins.get(method).includes('local');
        if (kind === 'request' && !desktop && !phoneOnly.methods.includes(method)) throw new Error(`${field}: neither a desktop's method nor declared phone-only`);
        let answer = null;
        let expectedAnswer = null;
        if (desktop) {
          const got = await call(method, params);
          answer = got.ok ? got : got.detail;
          expectedAnswer = loneRefusal(`${method}.params${pointer}`);
        } else if (kind === 'request') {
          // The phone's frame as the core answers it: the JSON-RPC error under the client failure loneRefusal describes.
          const { code, message, data } = loneRefusal(`${method}.params${pointer}`);
          const got = await phoneCall(method, params);
          answer = got;
          expectedAnswer = { id: phoneIds, error: { code, message, data } };
        } else {
          // Frames of one connection are read in order: the barrier's write is read after the notification.
          client.notify(method, params);
        }
        const after = await settled();
        // The language server's closing handshake, which the core sends an idle server on its own timer (manifest
        // `inventorySweep.languageServerLifecycle`), is no call's; every other request either stand-in got is.
        const lifecycle = (request) => request.url === '/lsp' && languageServerLifecycle.methods.includes(request.received?.method);
        const core = { answer, requests: server.log.splice(0).filter((request) => !lifecycle(request)), changedFiles: changedFiles(before, after) };
        const expected = { answer: expectedAnswer, requests: [], changedFiles: [] };
        swept += 1;
        if (!isDeepStrictEqual(core, expected)) unexpected.push({ case: `inventory-sweep ${field}`, node: expected, core });
      }
    }
    console.log(
      `lone-surrogate-wire replay over ${exe}: ${compared} compared, ${refused.length} refused by decision, ${swept} refused inventory fields swept over ${files().size} world files, ${unexpected.length} unexpected`,
    );
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
    relay.close();
    await server.close();
    rmSync(WORLDS, { recursive: true, force: true });
  }
}
