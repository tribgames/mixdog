// The phone's generic `invokeCapability` over the real protocol client (mock transport): a capability no other group claims (the
// composer's voice status, which decides whether the microphone shows) reaches the core as its method and its answer reaches the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect, sessionReducer } from '../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../packages/protocol-client/src/mock.ts';
import { adapter } from './remote-protocol-capabilities.ts';

const protocolOptions = JSON.parse(readFileSync(new URL('../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8'));
const row = (id) => ({ id, preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null });

async function phoneClient(voice) {
  const net = new MockNetwork();
  const sent = [];
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: protocolOptions.clientInfo,
    capabilities: protocolOptions.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...protocolOptions.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  void (async () => {
    for (;;) {
      const request = JSON.parse(await conn.nextSent());
      sent.push(request);
      if (request.method === 'thread/start') {
        conn.serverSend({ id: request.id, result: { thread: row('control'), subscription: { id: 's1', mode: 'snapshot', epoch: 'e0', startSeq: 1 } } });
      } else if (request.method === 'thread/read') {
        conn.serverSend({ id: request.id, result: { thread: row(request.params.threadId), items: [], state: {}, hasOlder: false } });
      } else if (request.method === 'voice/getVoiceStatus') {
        conn.serverSend({ id: request.id, result: voice });
      } else conn.serverSend({ id: request.id, result: {} });
    }
  })();
  return { client: await connecting, sent };
}

test('a capability no other group claims is answered over the protocol, not rejected for lack of an owner', async () => {
  const { client, sent } = await phoneClient({ enabled: true, installed: true });
  const host = { ctx: {}, client: () => client, declareLane() {} };
  const answer = await adapter.calls.invokeCapability([{ capability: 'getVoiceStatus', args: [] }], host);
  assert.equal(answer.value.installed, true, 'the composer shows the microphone from this value');
  assert.ok(sent.some((request) => request.method === 'voice/getVoiceStatus'), `the core was asked: ${sent.map((request) => request.method)}`);
});

test('the delegation-mode control and the composer reads are answered, so their placeholders settle', async () => {
  const { client, sent } = await phoneClient({});
  const host = { ctx: {}, client: () => client, declareLane() {} };
  for (const capability of ['getOrchestrationMode', 'getConfiguredOrchestrationMode']) {
    const before = sent.length;
    const answer = await adapter.calls.invokeCapability([{ capability, args: [] }], host);
    assert.ok('value' in answer, `${capability} answers the page`);
    assert.ok(sent.slice(before).some((request) => !/^thread\//.test(request.method)), `${capability} reached the core: ${sent.slice(before).map((r) => r.method)}`);
  }
});

test('what the desktop refuses to a remote client, or malformed, is refused before anything is sent', async () => {
  const { client, sent } = await phoneClient({});
  const host = { ctx: {}, client: () => client, declareLane() {} };
  const refused = async (request, pattern) => {
    const before = sent.length;
    await assert.rejects(async () => adapter.calls.invokeCapability([request], host), pattern, JSON.stringify(request));
    assert.equal(sent.length, before, `${JSON.stringify(request)} sent nothing`);
  };
  // The remote exclusions (Node's assertRemoteCapability): the media resolver and every conversation import capability.
  await refused({ capability: 'resolveMediaFile', args: ['x'] }, /not available over remote access/);
  for (const capability of ['listImportableConversations', 'getConversationImportJobs', 'startConversationImport']) {
    await refused({ capability, args: [] }, /not available over remote access/);
  }
  // Shape and count: an unknown name, an unknown field, an extra argument to a capability that takes none.
  await refused({ capability: 'noSuchCapability', args: [] }, /capability is unavailable/);
  await refused({ capability: 'getVoiceStatus', args: [], extra: 1 }, /./);
  await refused({ capability: 'getVoiceStatus', args: ['extra'] }, /invalid number of arguments/);
  // Node's argument-sensitive refusals: a standing allow and turning on Allow all actions stay at this PC.
  await refused({ capability: 'setAgentPermission', args: ['agent', 'tool', 'allow'] }, /standing allow/);
  await refused({ capability: 'setDeveloperOption', args: ['allowAllActions', true] }, /Allow all actions/);
  // A capability's own rule: a retry names the addressed session.
  await refused({ capability: 'retryFailedTurn', args: ['sess_a', 'turn-1'], sessionId: 'sess_b' }, /retry session must match/);
});

test('the other permission modes and turning the option off are not refused', async () => {
  const { client, sent } = await phoneClient({});
  const host = { ctx: {}, client: () => client, declareLane() {} };
  for (const request of [
    { capability: 'setAgentPermission', args: ['agent', 'tool', 'deny'] },
    { capability: 'setDeveloperOption', args: ['allowAllActions', false] },
  ]) {
    const before = sent.length;
    await adapter.calls.invokeCapability([request], host);
    assert.ok(sent.length > before, `${request.capability} was sent`);
  }
});

test('a project path is absolute in either syntax on the phone, the host platform decides on the desktop', async () => {
  const { isAbsolute } = await import('node:path');
  const { requiredDesktopCapabilityRequest } = await import('../main/ipc-capability-request.ts');
  const skills = (projectPath) => ({ capability: 'skillsStatus', args: [{ projectPath }] });
  const phone = async (projectPath) => adapter.calls.invokeCapability([skills(projectPath)], { ctx: {}, client: () => ({}), declareLane() {} });
  for (const path of ['C:/work', 'C:\\work', '/work']) {
    // The phone's rule takes either syntax (it gets as far as the client, which is not a real one here).
    await assert.rejects(() => phone(path), (error) => !/projectPath is invalid/.test(error.message), path);
  }
  await assert.rejects(() => phone('work'), /projectPath is invalid/);
  for (const path of ['C:/work', '/work', 'work']) {
    const ask = () => requiredDesktopCapabilityRequest(skills(path));
    if (isAbsolute(path)) assert.doesNotThrow(ask, path);
    else assert.throws(ask, /projectPath is invalid/, path);
  }
});