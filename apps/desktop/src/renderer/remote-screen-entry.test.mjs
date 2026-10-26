import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// ApprovalCard reads the window while it loads.
const dom = new JSDOM('<!doctype html><div id="host"></div>', { url: 'https://mixdog.test/' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const { approvalCardRows } = await import('./ApprovalCard.tsx');
const { phoneDockScreenAction } = await import('./phone-dock-switch.ts');
const { closeRemoteScreen, openRemoteScreen, remoteScreenAvailable, remoteScreenOpen } = await import(
  './remote-screen-request.ts'
);

const row = (surface, options) =>
  approvalCardRows(
    { kind: 'takeover', surface },
    { agentName: 'Agent', officeLabel: '', controlReady: true, ...options }
  );
const decisions = (rows) => rows.map((entry) => (typeof entry.decision === 'string' ? entry.decision : 'decide'));

test('a computer takeover gets "Open" only where the phone can show the PC screen', () => {
  assert.deepEqual(decisions(row('computer', { openScreen: true })), ['decide', 'open', 'decide']);
  assert.deepEqual(decisions(row('computer', { openScreen: false })), ['decide', 'decide']);
  // The browser dock being available is not the PC screen.
  assert.deepEqual(decisions(row('computer', { openPage: true })), ['decide', 'decide']);
});

test('the browser takeover keeps its own "Open", and the screen does not add one', () => {
  assert.deepEqual(decisions(row('browser', { openPage: true })), ['decide', 'open', 'decide']);
  assert.deepEqual(decisions(row('browser', { openScreen: true })), ['decide', 'decide']);
  assert.deepEqual(decisions(row('browser', { openPage: true, openScreen: true })), ['decide', 'open', 'decide']);
});

const hostApi = (extra = {}) => ({
  remoteBrowserWebrtc: 1,
  remoteBrowserWebrtcSignal: async () => {},
  onRemoteBrowserWebrtc: () => () => {},
  remoteBrowserControlOrdered: async () => {},
  remoteScreenDisplays: async () => [],
  ...extra,
});

test('the screen is offered only on a phone whose host serves it', () => {
  assert.equal(remoteScreenAvailable(hostApi(), true), true);
  assert.equal(remoteScreenAvailable(hostApi(), false), false);
  assert.equal(remoteScreenAvailable(undefined, true), false);
  assert.equal(remoteScreenAvailable(hostApi({ remoteBrowserWebrtc: 0 }), true), false);
  assert.equal(remoteScreenAvailable(hostApi({ remoteScreenDisplays: undefined }), true), false);
});

test('the ⋯ menu item opens the view and is absent without a host that serves it', () => {
  assert.equal(phoneDockScreenAction(false, true), null);
  const action = phoneDockScreenAction(true, false);
  assert.equal(action.id, 'switch-pc-screen');
  assert.equal(action.label, 'View entire PC screen');
  assert.equal(action.separatorBefore, false);
  assert.equal(phoneDockScreenAction(true, true).separatorBefore, true);
  assert.equal(remoteScreenOpen(), false);
  action.onSelect();
  assert.equal(remoteScreenOpen(), true);
  closeRemoteScreen();
  assert.equal(remoteScreenOpen(), false);
  openRemoteScreen();
  openRemoteScreen();
  assert.equal(remoteScreenOpen(), true);
  closeRemoteScreen();
});
