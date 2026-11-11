// The replay of record-inbound-lone-surrogate.mjs against a freshly started, built mixdogd, behind a scripted relay with a paired phone
// (lib/phone-relay-core.mjs). A `call` step is the phone's own call through its router and adapter (remote-shim-protocol.ts,
// remote-protocol-files.ts), as phone-files-replay.mjs makes it; its outcome is compared whole with Node's answer frame. A `raw` step is
// sealed as it stands and the close the phone is told is compared whole with Node's.
//
// Expected values are Node's, with one rule applied: under the decision of decisions.md "frame-lone-surrogate" (a), the core reads an
// unpaired surrogate escape as U+FFFD, so a lone code unit Node echoed back is expected as U+FFFD (`String.prototype.toWellFormed`).
// A step marked `refused` (lone surrogate where no shipped client sends one) has no Node counterpart: the core must refuse it.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

/** Node's value as the core must give it under (a): every string well formed, keys included. Two keys of one object that become
 *  one fail the replay: a merged object is never compared. */
function wellFormed(value) {
  if (typeof value === 'string') return value.toWellFormed();
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key.toWellFormed(), wellFormed(item)]);
    const keys = new Set(entries.map(([key]) => key));
    if (keys.size !== entries.length) throw new Error(`two keys of Node's answer read as one under (a): ${JSON.stringify(Object.keys(value))}`);
    return Object.fromEntries(entries);
  }
  return value;
}

/** The first frame `take` yields that `matches` (other frames are passed over), or the close; one deadline for the whole wait. */
function firstFrame(take, matches, what) {
  const scan = async () => {
    for (;;) {
      const next = await take();
      if (next.closed !== undefined || matches(next.frame)) return next;
    }
  };
  return within(scan(), what);
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
    // A step marked `accepted` (cases file) is a difference decisions.md accepts: its answer must equal Node's answer to the declared
    // stand-in step; then it is shown whole as ACCEPTED, and any other answer is unexpected.
    const accepted = [];
    let compared = 0;
    for (const step of STEPS) {
      if (only && step.name !== only && step.name !== 'register-project') continue;
      if (step.refused) {
        // No Node counterpart (input no shipped client sends): the call must fail with the core's refusal of a lone surrogate
        // outside free text, and the connection stay open; its lack of effect is in the folder and preferences compared below.
        const closing = relay.whenClosed(phone.clientId).then((closed) => ({ closed }));
        const outcome = await within(
          Promise.race([
            phone.router.call(step.call, step.json !== undefined ? JSON.parse(step.json) : clone(step.params)).then(
              (value) => ({ ok: true, value: value === undefined ? null : clone(value) }),
              (error) => ({ ok: false, error: error.message }),
            ),
            closing,
          ]),
          `the answer to ${step.name}`,
        );
        compared += 1;
        const refused = outcome.ok === false && outcome.error.includes('text without unpaired surrogates');
        if (!refused) unexpected.push({ step: `${step.name} (refused by the rule, no Node counterpart)`, node: 'the core refuses it: text without unpaired surrogates', core: outcome });
        if (outcome.closed !== undefined) phone = await openRouter();
        continue;
      }
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
          // No Node counterpart (the core's method names are its own): the answer is compared whole with the core's own refusal of a
          // name that does not exist, sent next on the same connection, and the connection must answer the frame after that.
          const answerTo = (id, what) => firstFrame(() => raw.phone.next(), (f) => f?.id === id, `the answer of ${raw.clientId} to ${what}`);
          const lone = await answerTo(step.coreId, step.name);
          await raw.phone.send(frame(step.coreStandIn.raw));
          const standIn = await answerTo(step.coreId, `${step.name}: the stand-in`);
          await raw.phone.send(frame(step.coreNext.raw));
          const after = await answerTo(step.coreNext.id, `${step.name}: the next frame`);
          if (standIn.closed !== undefined || !standIn.frame.error) throw new Error(`${step.name}: the core did not refuse its stand-in: ${JSON.stringify(standIn)}`);
          got = { answer: lone.closed !== undefined ? { closed: lone.closed } : lone.frame, nextAnswered: after.closed === undefined && after.frame.result !== undefined };
          compared += 1;
          const expected = { answer: standIn.frame, nextAnswered: true };
          if (!isDeepStrictEqual(got, expected)) unexpected.push({ step: `${step.name} (compared with the core's refusal of ${step.coreStandIn.raw})`, node: expected, core: got });
          continue;
        }
      } else {
        // The answer, or the close of the phone's client when the core refuses the frame (a closed call never answers).
        const closing = relay.whenClosed(phone.clientId).then((closed) => ({ closed }));
        got = await within(
          Promise.race([
            phone.router.call(step.call, step.json !== undefined ? JSON.parse(step.json) : clone(step.params)).then(
              (value) => ({ answer: { ok: true, value: value === undefined ? null : clone(value) } }),
              (error) => ({ answer: { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) } }),
            ),
            closing,
          ]),
          `the answer to ${step.name}`,
        );
        if (got.closed !== undefined) phone = await openRouter();
      }
      const expectedOf = (recorded) => (recorded.closed !== undefined ? { closed: recorded.closed } : { answer: wellFormed(recorded.answer) });
      const expected = expectedOf(node);
      compared += 1;
      if (step.accepted) {
        // The accepted answer is Node's own answer to the stand-in step, and only that one.
        const standIn = golden.steps.find((recorded) => recorded.name === step.accepted.standIn);
        if (!standIn) throw new Error(`the recording has no stand-in step ${step.accepted.standIn} for ${step.name}`);
        const declared = expectedOf(standIn);
        if (!isDeepStrictEqual(got, declared)) unexpected.push({ step: `${step.name} (compared with Node's answer to ${step.accepted.standIn})`, node: declared, core: got });
        else if (!isDeepStrictEqual(got, expected)) {
          const why = `differs from Node's own answer as declared, equals Node's answer to ${step.accepted.standIn}; ${step.accepted.decision}`;
          accepted.push({ step: step.name, node: expected, core: got, why });
        }
      } else if (!isDeepStrictEqual(got, expected)) unexpected.push({ step: step.name, node: expected, core: got });
    }
    if (!only) {
      // Sorted by name as the recording is: the order is the file system's listing, which no Node code chose.
      const files = readdirSync(PROJECT, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((entry) => ({ name: hex(Buffer.from(entry.name)), ...(entry.isDirectory() ? { dir: true } : { bytes: hex(readFileSync(join(PROJECT, entry.name))) }) }));
      compared += 1;
      if (!isDeepStrictEqual(files, golden.files)) unexpected.push({ step: 'project folder', node: golden.files, core: files });
      // Node's preferences file (desktop-projects.json `{version:2, aliases{path:name}, hidden[path]}`) is the core's `projects` rows
      // (DS §4.1): `aliases` every row's alias, `hidden` the hidden rows in `hidden_rank` order.
      const db = new DatabaseSync(join(core.dataDir, 'state', 'core.sqlite'), { readOnly: true });
      const rows = db.prepare('SELECT path, alias, hidden FROM projects ORDER BY hidden_rank, path').all();
      db.close();
      const stored = { aliases: Object.fromEntries(rows.filter((row) => row.alias).map((row) => [row.path, row.alias])), hidden: rows.filter((row) => row.hidden).map((row) => row.path) };
      const { aliases, hidden } = wellFormed(JSON.parse(golden.preferences));
      compared += 1;
      if (!isDeepStrictEqual(stored, { aliases, hidden })) unexpected.push({ step: 'preferences', node: { aliases, hidden }, core: stored });
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
    // killTree waits, with its own deadline and message, for the core to exit.
    await killTree(core.child);
    relay.close();
    rmSync(WORLDS, { recursive: true, force: true });
  }
}
