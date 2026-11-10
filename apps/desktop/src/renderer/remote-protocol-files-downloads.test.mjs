// The phone's five download calls through the files adapter, every step of Node's recording (native/core/fixtures/file-downloads, recorded
// from b6f10295a by benchmarks/rust-core/recorders/record-file-downloads.mjs) compared whole with what the page saw: the frame
// (`ok`/`value`, or `error` and its `errorCode`). The adapter owns the arguments and the conversation a request names; the core's table
// answers the rest, replayed by the workspace crate (transfer/replay.rs) and, over a relay, by the daemon's remote e2e. Here the core is a
// stand-in that gives each table-level step the answer the recording shows, in the shape the protocol gives a domain failure, so what is
// compared is what the adapter asks for and how it turns the core's answer into the page's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adapter } from './remote-protocol-files.ts';

const recording = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../native/core/fixtures/file-downloads/file-downloads.json', import.meta.url)), 'utf8'));
const DIR = 'C:/replay';
// The conversations the recording's host listed: s1 in a registered project, s2 a task; any other is not available.
const PROJECT = `${DIR}/project`;
const threads = { s1: { projectPath: PROJECT }, s2: { projectPath: null } };

const hex = (n) => n.toString(16).padStart(12, '0');
const valueOf = (token, serial) => (token.startsWith('<version#') ? `V${String(serial).padStart(42, '0')}` : `00000000-0000-4000-8000-${hex(serial)}`);

/** Binds the recording's `<kind#n>` tokens to values of the shape the adapter checks, and puts them back into arguments and answers. */
function tokens() {
  const bound = new Map();
  const bind = (text) => (typeof text === 'string' && /^<[a-zA-Z]+#\d+>$/.test(text) ? (bound.has(text) ? bound.get(text) : bound.set(text, valueOf(text, bound.size + 1)).get(text)) : text);
  const walk = (node) => (Array.isArray(node) ? node.map(walk) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)])) : typeof node === 'string' ? bind(node).replaceAll('<dir>', DIR) : node);
  return walk;
}

/** The core as the protocol shows it to the client: a result, or an error whose `detail.data` names the domain failure. */
const domainFailure = (frame) =>
  Object.assign(new Error(frame.error), { detail: { data: { reason: 'domainError', message: frame.error, ...(frame.errorCode ? { code: frame.errorCode } : {}) } } });

const FRAME = (outcome) => outcome;

test('every recorded download call answers the page as Node did, and asks the core for what the call means', async () => {
  let compared = 0;
  for (const scenario of recording.scenarios) {
    const resolve = tokens();
    for (const [index, step] of scenario.steps.entries()) {
      if (step.op !== 'call') continue;
      const label = `${scenario.name} #${index}`;
      const frame = resolve(step.frame);
      const asked = [];
      const client = {
        call: async (method, params) => {
          if (method === 'thread/read') {
            const thread = threads[params.threadId];
            if (!thread) throw domainFailure({ error: 'no such thread' });
            return { thread };
          }
          asked.push({ method, params });
          if (!frame.ok) throw domainFailure(frame);
          // The core's answer to an abort is `{ ended }`, the page's is the bare boolean.
          return step.method === 'fileDownloadAbort' ? { ended: frame.value } : frame.value;
        },
      };
      const host = { ctx: {}, client: () => client, declareLane() {} };
      let seen;
      try {
        seen = { ok: true, value: await adapter.calls[step.method](resolve(step.params), host) };
      } catch (error) {
        seen = { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) };
      }
      const { id: _id, ...recorded } = frame;
      // A call the adapter refuses reaches the core with nothing; one it lets through reaches it once, as its own method.
      const refusedHere = !frame.ok && !frame.errorCode && frame.error !== 'offset is past the end of the file.';
      assert.deepEqual(FRAME(seen), recorded, label);
      const unavailable = frame.errorCode === 'file-download:unavailable' && step.method === 'fileDownloadAuthorize';
      const outside = frame.errorCode === 'file-download:outside-project' && !asked.length;
      assert.equal(asked.length, refusedHere || unavailable || outside ? 0 : 1, `${label}: ${JSON.stringify(asked)}`);
      compared += 1;
    }
  }
  // Every plain call of the recording; the three calls held while a device is unpaired are the core's alone (the workspace replay).
  assert.equal(compared, 200);
});

test('the core is asked for the stage each call names, with the conversation resolved to its project', async () => {
  const sent = [];
  const client = {
    call: async (method, params) => {
      sent.push([method, params]);
      if (method === 'thread/read') return { thread: threads[params.threadId] };
      return method === 'transfer/endRead' ? { ended: true } : {};
    },
  };
  const host = { ctx: {}, client: () => client, declareLane() {} };
  const id = '00000000-0000-4000-8000-000000000001';
  const version = 'A'.repeat(43);
  await adapter.calls.fileDownloadAuthorize([{ source: { kind: 'project', sessionId: 's1', relPath: 'out.bin' }, purpose: 'save' }], host);
  await adapter.calls.fileDownloadAuthorize([{ source: { kind: 'session', sessionId: 's2', path: `${DIR}/a.bin` }, purpose: 'open' }], host);
  await adapter.calls.fileDownloadBegin([id], host);
  await adapter.calls.fileDownloadRange([id, 0, 4, version], host);
  await adapter.calls.fileDownloadFinish([id], host);
  assert.equal(await adapter.calls.fileDownloadAbort([id], host), true);
  assert.deepEqual(sent.filter(([method]) => method !== 'thread/read'), [
    ['transfer/authorizeRead', { source: { kind: 'file', root: PROJECT, rel: 'out.bin' }, purpose: 'save' }],
    ['transfer/authorizeRead', { source: { kind: 'sessionFile', path: `${DIR}/a.bin` }, purpose: 'open' }],
    ['transfer/redeemGrant', { grantId: id }],
    ['transfer/readRange', { transferId: id, offset: 0, length: 4, version }],
    ['transfer/finishRead', { transferId: id }],
    ['transfer/endRead', { transferId: id }],
  ]);
});
