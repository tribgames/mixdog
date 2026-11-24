import assert from 'node:assert/strict';
import test from 'node:test';
import { hostNavigationGuards } from './remote-host-navigation.ts';

const HOST = 'https://relay.example.com/d/abc/';
const event = (isMainFrame) => ({
  isMainFrame,
  prevented: false,
  preventDefault() {
    this.prevented = true;
  },
});

test('a main-frame redirect off the host is stopped and opens nothing; a followed link opens in the browser', () => {
  const opened = [];
  const guards = hostNavigationGuards(HOST, (target) => opened.push(target));
  const redirect = event(true);
  guards.onRedirect(redirect, 'https://evil.example.com/');
  assert.equal(redirect.prevented, true);
  const link = event(true);
  guards.onNavigate(link, 'https://example.com/a');
  assert.equal(link.prevented, true);
  const same = event(true);
  guards.onRedirect(same, `${HOST}x`);
  guards.onNavigate(same, `${HOST}y`);
  assert.equal(same.prevented, false);
  assert.deepEqual(opened, ['https://example.com/a']);
});

test('a subframe navigation or redirect is neither stopped nor opened externally', () => {
  const opened = [];
  const guards = hostNavigationGuards(HOST, (target) => opened.push(target));
  const frame = event(false);
  guards.onRedirect(frame, 'https://evil.example.com/');
  guards.onNavigate(frame, 'https://evil.example.com/');
  assert.equal(frame.prevented, false);
  assert.deepEqual(opened, []);
});
