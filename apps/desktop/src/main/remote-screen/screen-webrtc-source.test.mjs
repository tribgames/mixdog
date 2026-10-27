import assert from 'node:assert/strict';
import test from 'node:test';

import { createScreenWebrtcSource } from './screen-webrtc-source.ts';

function fakeScreen(over = {}) {
  const listeners = { geometry: new Set(), stop: new Set() };
  const geometry = {
    generation: 3,
    pixelWidth: 1920,
    pixelHeight: 1080,
    cssWidth: 1920,
    cssHeight: 1080,
    deviceScaleFactor: 1,
  };
  const plan = { sourceId: 'screen:0:0', width: 1920, height: 1080, maxFrameRate: 30 };
  const state = { running: false, inputs: [], releases: 0, stops: [], outcome: 'applied' };
  return {
    state,
    listeners,
    screen: {
      start: async () => {
        if (over.deny) throw new Error('denied');
        state.running = true;
        return { plan, geometry, status: { state: 'live', helper: 'not-needed', control: true } };
      },
      running: () => state.running,
      geometry: () => geometry,
      capturePlan: () => (state.running ? plan : null),
      handleInput: async (input, generation) => {
        state.inputs.push([input, generation]);
        return state.outcome;
      },
      releaseInput: async () => {
        state.releases += 1;
      },
      stop: async (reason) => {
        state.stops.push(reason);
        state.running = false;
      },
      onGeometry(listener) {
        listeners.geometry.add(listener);
        return () => listeners.geometry.delete(listener);
      },
      onStop(listener) {
        listeners.stop.add(listener);
        return () => listeners.stop.delete(listener);
      },
      status: () => ({ state: 'live', helper: 'not-needed', control: true }),
      onStatus: () => () => {},
      cursor: () => null,
      onCursor: () => () => {},
      onFrame: () => () => {},
      videoPath: () => 'capture',
      onVideoPath: () => () => {},
      setHelperVideo: () => {},
      setVideoRun: () => {},
      nextVideoRun: () => (state.runs = (state.runs ?? 0) + 1),
      onHelperHold: () => () => {},
      onHelperChallenge: () => () => {},
      helperGrant: () => {},
      requestHelperInstall: () => {},
    },
  };
}

function fakeSink() {
  const calls = [];
  return {
    calls,
    sink: {
      geometryChanged: (key, geometry) => calls.push(['geometry', key, geometry?.generation ?? null]),
      frame: () => calls.push(['frame']),
      captureChanged: (key) => calls.push(['capture', key]),
      channelPush: (key, message) => calls.push(['push', key, message.kind]),
      drawnTrack: (key, drawn) => calls.push(['drawn', key, drawn]),
    },
  };
}

test('start admits once, reports geometry and exposes the capture plan', async () => {
  const fake = fakeScreen();
  const sink = fakeSink();
  const source = createScreenWebrtcSource(fake.screen, { screenId: '0', sink: sink.sink });
  assert.deepEqual(source.source, { kind: 'screen', screenId: '0' });
  assert.equal(source.capturePlan(), null);
  source.start();
  source.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sink.calls, [['geometry', 'screen:0', 3]]);
  assert.equal(source.capturePlan().sourceId, 'screen:0:0');
  assert.deepEqual(source.page(), { documentId: null, geometry: fake.screen.geometry() });
});

test('dispatch forwards screen input, throws on rejection and refuses page input', async () => {
  const fake = fakeScreen();
  const source = createScreenWebrtcSource(fake.screen, { screenId: '0', sink: fakeSink().sink });
  await source.dispatch({ type: 'screen-pointer', action: 'move', x: 1, y: 2 });
  assert.deepEqual(fake.state.inputs[0][1], 3);
  fake.state.outcome = 'rejected';
  await assert.rejects(source.dispatch({ type: 'screen-text', text: 'a' }));
  await assert.rejects(source.dispatch({ type: 'click', x: 1, y: 1 }));
});

test('release is forwarded every time; geometry renewal and stop reach the sink', async () => {
  const fake = fakeScreen();
  const sink = fakeSink();
  const source = createScreenWebrtcSource(fake.screen, { screenId: '0', sink: sink.sink });
  await source.release();
  await source.release();
  assert.equal(fake.state.releases, 2);
  for (const listener of fake.listeners.geometry) listener({ plan: {}, geometry: { generation: 4 } });
  for (const listener of fake.listeners.stop) listener('revoked');
  assert.deepEqual(sink.calls, [
    ['geometry', 'screen:0', 4],
    ['capture', 'screen:0'],
    ['geometry', 'screen:0', null],
  ]);
  source.stop();
  assert.deepEqual(fake.state.stops, ['viewer-left']);
});

test('a refused start reports no geometry and the error', async () => {
  const fake = fakeScreen({ deny: true });
  const sink = fakeSink();
  const errors = [];
  const source = createScreenWebrtcSource(fake.screen, {
    screenId: '0',
    sink: sink.sink,
    onStartError: (error) => errors.push(error),
  });
  source.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sink.calls, [['geometry', 'screen:0', null]]);
  assert.equal(errors.length, 1);
});
