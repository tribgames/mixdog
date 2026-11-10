// The replay of record-inbound-lone-surrogate.mjs against a freshly started, built mixdogd, behind a scripted relay with a paired phone
// (lib/phone-relay-core.mjs). A `call` step is the phone's own call through its router and adapter (remote-shim-protocol.ts,
// remote-protocol-files.ts), as phone-files-replay.mjs makes it; its outcome is compared whole with Node's answer frame. A `raw` step is
// sealed as it stands and the close the phone is told is compared whole with Node's.
//
// Expected values are Node's, with one rule applied: under the decision of decisions.md "frame-lone-surrogate" (a), the core reads an
// unpaired surrogate escape as U+FFFD, so a lone code unit Node echoed back is expected as U+FFFD (`String.prototype.toWellFormed`).
import { once } from 'node:events';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from './common.mjs';
import { frame } from './raw-frame-bytes.mjs';
import { PROJECT, STEPS, buildWorld } from './inbound-lone-surrogate-cases.mjs';
import { startRelay } from './phone-relay-core.mjs';
import { killTree, startCore } from './phone-files-replay.mjs';

const WORLDS = join('D:\\mixdog-build\\tmp', `${basename(REPO_ROOT)}-inbound-lone-surrogate-replay`);
const PHONE_ID = '0123456789abcdef0123456789abcdef';
const WAIT_MS = 30_000;
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** `promise`, or a failure naming `what` once the deadline passes. */
function within(promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing within ${WAIT_MS} ms`)), WAIT_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Node's value as the core must give it under (a): every string well formed, keys included. */
function wellFormed(value) {
  if (typeof value === 'string') return value.toWellFormed();
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toWellFormed(), wellFormed(item)]));
  return value;
}

export async function replay({ exe, golden, only }) {
  const relay = await startRelay({ repoRoot: REPO_ROOT, clients: [], capabilities: { textFrames: 1, maxFrameBytes: 1_048_576 } });
  const core = await startCore(exe, join(WORLDS, 'core'), relay);
  const clients = [];
  try {
    buildWorld();
    await within(relay.leg(), 'the core dialing the relay');
    const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
    const pairing = relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8')));
    const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-files.ts');
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
    // The router arms a per-call deadline on the page's window timers; this replay has its own deadline per call.
    globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
    const base = {
      target: { id: 'core' },
      clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      // A dropped connection is an outcome here (a refused frame), never a reason to reconnect: the reconnect loop's first wait
      // never ends, and the step reads the close from the relay.
      clock: { sleep: () => new Promise(() => {}) },
      random: Math.random,
    };
    let opened = 0;
    const openRouter = async () => {
      const clientId = `phone-${++opened}`;
      const connector = await within(relay.openPhone(clientId, PHONE_ID, pairing), `the handshake of ${clientId}`);
      const client = await within(connect({ ...base, connector }), `the connection of ${clientId}`);
      clients.push(client);
      const host = { ctx: { browserId: PHONE_ID }, client: () => client, declareLane() {} };
      const router = createProtocolRouter([adapter], { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false });
      return { clientId, router };
    };
    const openRaw = async () => {
      const clientId = `phone-${++opened}`;
      const phone = await within(relay.openRawPhone(clientId, PHONE_ID, pairing), `the handshake of ${clientId}`);
      await phone.send({ id: 0, method: 'initialize', params: { clientInfo: base.clientInfo, capabilities: {} } });
      const initialized = await within(phone.next(), `the initialize answer of ${clientId}`);
      if (!initialized.frame?.result) throw new Error(`${clientId} was not initialized: ${JSON.stringify(initialized)}`);
      return { clientId, phone };
    };

    let phone = await openRouter();
    const unexpected = [];
    // A step marked `accepted` (cases file) is a difference decisions.md accepts: shown whole, not counted as unexpected.
    const accepted = [];
    let compared = 0;
    for (const step of STEPS) {
      if (only && step.name !== only && step.name !== 'register-project') continue;
      const node = golden.steps.find((recorded) => recorded.name === step.name);
      if (!node) throw new Error(`the recording has no step ${step.name}`);
      let got;
      if (step.raw !== undefined || step.coreRaw !== undefined) {
        const raw = await openRaw();
        await raw.phone.send(frame(step.raw ?? step.coreRaw));
        if (step.raw !== undefined) {
          const next = await within(raw.phone.next(), `the close of ${raw.clientId} after ${step.name}`);
          got = next.closed !== undefined ? { closed: next.closed } : { frame: next.frame };
        } else {
          // The core's method names are its own: what is compared is the phone's fate (answered on the same connection, not closed).
          let next;
          do next = await within(raw.phone.next(), `the answer of ${raw.clientId} to ${step.name}`);
          while (next.frame && next.frame.id !== step.coreId);
          got = next.closed !== undefined ? { closed: next.closed } : { answered: true };
        }
      } else {
        // The answer, or the close of the phone's client when the core refuses the frame (a closed call never answers).
        const closing = relay.whenClosed(phone.clientId).then((closed) => ({ closed }));
        got = await within(
          Promise.race([
            phone.router.call(step.call, clone(step.params)).then(
              (value) => ({ answer: { ok: true, value: value === undefined ? null : clone(value) } }),
              (error) => ({ answer: { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) } }),
            ),
            closing,
          ]),
          `the answer to ${step.name}`,
        );
        if (got.closed !== undefined) phone = await openRouter();
      }
      const expected = node.closed !== undefined ? { closed: node.closed } : step.coreRaw !== undefined ? { answered: true } : { answer: wellFormed(node.answer) };
      compared += 1;
      if (!isDeepStrictEqual(got, expected)) (step.accepted ? accepted : unexpected).push({ step: step.name, node: expected, core: got, why: step.accepted });
    }
    if (!only) {
      const files = readdirSync(PROJECT, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((entry) => ({ name: hex(Buffer.from(entry.name)), ...(entry.isDirectory() ? { dir: true } : { bytes: hex(readFileSync(join(PROJECT, entry.name))) }) }));
      compared += 1;
      if (!isDeepStrictEqual(files, golden.files)) unexpected.push({ step: 'project folder', node: golden.files, core: files });
    }
    console.log(`inbound-lone-surrogate replay over ${exe}: ${compared} compared, ${accepted.length} accepted differences, ${unexpected.length} unexpected`);
    for (const entry of accepted) {
      console.log(`ACCEPTED ${entry.step} (${entry.why})`);
      console.log(`   node: ${JSON.stringify(entry.node).slice(0, 600)}`);
      console.log(`   core: ${JSON.stringify(entry.core).slice(0, 600)}`);
    }
    for (const entry of unexpected) {
      console.log(`DIFF ${entry.step}`);
      console.log(`   node: ${JSON.stringify(entry.node).slice(0, 600)}`);
      console.log(`   core: ${JSON.stringify(entry.core).slice(0, 600)}`);
    }
    return unexpected.length ? 1 : 0;
  } finally {
    for (const client of clients) client.close?.();
    const exited = core.child.exitCode !== null || core.child.signalCode !== null ? Promise.resolve() : once(core.child, 'exit');
    killTree(core.child);
    await within(exited, 'the core exiting');
    relay.close();
    rmSync(WORLDS, { recursive: true, force: true });
  }
}
