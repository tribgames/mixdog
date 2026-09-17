import assert from 'node:assert/strict';
import test from 'node:test';
import { createSetupUiRequests } from './ui-requests.mjs';
import { createSetupToolExecutor } from './executor.mjs';
import { resolveTuiRuntimeNotificationDelivery } from '../../tui/session/notification-plan.mjs';

test('Desktop setup waits for a matching, single-use receipt; snapshot metadata carries no edit body', async () => {
  let event;
  const broker = createSetupUiRequests({
    getSessionId: () => 'session-a',
    notifySessionUi: (_session, content, meta) => { event = { content, meta }; return true; },
  });
  const args = { action: 'set_instructions', content: 'private instructions' };
  const pending = broker.request(args);
  assert.equal(event.meta.kind, 'setup-ui');
  assert.doesNotMatch(JSON.stringify(event), /private instructions/);
  assert.deepEqual(resolveTuiRuntimeNotificationDelivery(event, event.content), { action: 'setup-ui', id: event.meta.id });
  assert.equal(broker.claimSetupRequest('missing', 'owner'), null);
  const claim = broker.claimSetupRequest(event.meta.id, 'owner');
  assert.deepEqual(claim.args, args);
  assert.equal(broker.claimSetupRequest(event.meta.id, 'other-window'), null);
  assert.equal(broker.completeSetupRequest(event.meta.id, 'wrong-owner', { result: {} }), false);
  assert.equal(broker.completeSetupRequest(event.meta.id, 'owner', { result: { saved: true, scope: 'desktop-host' } }), true);
  assert.deepEqual(await pending, { saved: true, scope: 'desktop-host' });
  assert.equal(broker.claimSetupRequest(event.meta.id, 'owner'), null);
  assert.equal(broker.completeSetupRequest(event.meta.id, 'owner', { result: {} }), false);
});

test('headless, expired and cancelled requests fail without granting a Desktop mutation', async () => {
  const absent = createSetupUiRequests({ getSessionId: () => 's', notifySessionUi: () => false });
  await assert.rejects(absent.request({ action: 'set_appearance' }), /no attached Desktop/);
  let id;
  const broker = createSetupUiRequests({
    getSessionId: () => 's', claimTimeoutMs: 10,
    notifySessionUi: (_session, _content, meta) => { id = meta.id; return true; },
  });
  await assert.rejects(broker.request({ action: 'set_appearance' }), /nothing was changed/);
  assert.equal(broker.claimSetupRequest(id, 'owner'), null);
  const controller = new AbortController();
  const cancelled = broker.request({ action: 'set_appearance' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(broker.claimSetupRequest(id, 'owner'), null);
});

test('setup uses the Desktop receipt rather than treating notification delivery as saved', async () => {
  let executor;
  executor = createSetupToolExecutor({
    getApi: () => ({}), getSessionId: () => 's',
    notifySessionUi: (_session, _content, meta) => {
      queueMicrotask(() => {
        const claim = executor.claimSetupRequest(meta.id, 'local-desktop');
        assert.equal(claim.args.action, 'set_desktop_settings');
        executor.completeSetupRequest(meta.id, 'local-desktop', { error: 'Desktop storage failed' });
      });
      return true;
    },
  });
  await assert.rejects(executor.execute({ action: 'set_desktop_settings', desktop: { keepAwake: false } }), /Desktop storage failed/);
});

test('a claimed Desktop request loses mutation authority as soon as its turn is cancelled', async () => {
  let id;
  const controller = new AbortController();
  const broker = createSetupUiRequests({
    getSessionId: () => 's',
    notifySessionUi: (_session, _content, meta) => { id = meta.id; return true; },
  });
  const pending = broker.request({ action: 'set_desktop_settings' }, { signal: controller.signal });
  broker.claimSetupRequest(id, 'desktop');
  assert.equal(broker.isSetupRequestActive(id, 'desktop'), true);
  assert.equal(broker.isSetupRequestActive(id, 'other-window'), false);
  controller.abort();
  assert.equal(broker.isSetupRequestActive(id, 'desktop'), false);
  assert.equal(broker.completeSetupRequest(id, 'desktop', { result: { saved: true } }), false);
  await assert.rejects(pending, /cancelled/);
});
