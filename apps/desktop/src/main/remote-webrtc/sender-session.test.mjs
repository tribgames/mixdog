// The live-view sender window's permission policy: screen capture is a
// video-only `media` request from the sender's own contents and page, and
// nothing else is ever granted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  REMOTE_WEBRTC_SENDER_CSP,
  REMOTE_WEBRTC_SENDER_CSP_PLACEHOLDER,
  remoteWebrtcSenderCspPlugin,
  stampRemoteWebrtcSenderCsp,
} from '../../../scripts/remote-webrtc-sender-csp.mjs';
import {
  installRemoteWebrtcSenderSession,
  REMOTE_WEBRTC_SENDER_DEVELOPMENT_CSP,
  remoteWebrtcSenderPageUrl,
  remoteWebrtcSenderPermissionAllowed,
} from './sender-session.ts';

const builtPage = {
  file:
    process.platform === 'win32'
      ? 'C:\\app\\out\\renderer\\remote-webrtc-sender.html'
      : '/app/out/renderer/remote-webrtc-sender.html',
};
const devPage = { developmentUrl: 'http://localhost:5173/', file: builtPage.file };
const own = {};
const request = (page, overrides = {}) => ({
  permission: 'media',
  sender: own,
  own,
  mediaTypes: ['video'],
  requestingUrl: remoteWebrtcSenderPageUrl(page),
  isMainFrame: true,
  ...overrides,
});

test('the sender window may open a video capture from its own page, built or dev', () => {
  assert.equal(remoteWebrtcSenderPermissionAllowed(request(builtPage), builtPage), true);
  assert.equal(remoteWebrtcSenderPermissionAllowed(request(devPage), devPage), true);
  // What Electron reports for a `chromeMediaSource: 'desktop'` capture.
  assert.equal(remoteWebrtcSenderPermissionAllowed(request(builtPage, { mediaTypes: [] }), builtPage), true);
  assert.equal(
    remoteWebrtcSenderPermissionAllowed(
      request(builtPage, { requestingUrl: `${pathToFileURL(builtPage.file).href}?x=1#y` }),
      builtPage
    ),
    true,
    'a query or fragment is the same document'
  );
});

test('audio, other permissions and a missing media kind are denied', () => {
  for (const mediaTypes of [['audio'], ['video', 'audio'], ['audio', 'video'], undefined, 'video']) {
    assert.equal(
      remoteWebrtcSenderPermissionAllowed(request(builtPage, { mediaTypes }), builtPage),
      false,
      String(mediaTypes)
    );
  }
  for (const permission of [
    'clipboard-sanitized-write',
    'clipboard-read',
    'fullscreen',
    'display-capture',
    'geolocation',
    'notifications',
    'openExternal',
    'unknown',
  ]) {
    assert.equal(remoteWebrtcSenderPermissionAllowed(request(builtPage, { permission }), builtPage), false, permission);
  }
});

test('other contents, other pages and sub-frames are denied', () => {
  for (const sender of [{}, null, undefined]) {
    assert.equal(remoteWebrtcSenderPermissionAllowed(request(builtPage, { sender }), builtPage), false);
  }
  for (const missing of [null, undefined]) {
    assert.equal(
      remoteWebrtcSenderPermissionAllowed(request(builtPage, { own: missing, sender: missing }), builtPage),
      false
    );
  }
  for (const requestingUrl of [
    'https://example.com/remote-webrtc-sender.html',
    'file:///C:/elsewhere/index.html',
    pathToFileURL(builtPage.file.replace('remote-webrtc-sender', 'index')).href,
    'http://localhost:5173/index.html',
    'http://localhost:5174/remote-webrtc-sender.html',
    'not a url',
    undefined,
  ]) {
    assert.equal(
      remoteWebrtcSenderPermissionAllowed(request(devPage, { requestingUrl }), devPage),
      false,
      String(requestingUrl)
    );
    assert.equal(
      remoteWebrtcSenderPermissionAllowed(request(builtPage, { requestingUrl }), builtPage),
      false,
      String(requestingUrl)
    );
  }
  assert.equal(remoteWebrtcSenderPermissionAllowed(request(builtPage, { isMainFrame: false }), builtPage), false);
  assert.equal(remoteWebrtcSenderPermissionAllowed(request(builtPage, { isMainFrame: undefined }), builtPage), false);
});

function fakeSession() {
  const handlers = {};
  return {
    handlers,
    setPermissionCheckHandler: (handler) => (handlers.check = handler),
    setPermissionRequestHandler: (handler) => (handlers.request = handler),
    setDevicePermissionHandler: (handler) => (handlers.device = handler),
    webRequest: { onHeadersReceived: (handler) => (handlers.headers = handler) },
  };
}

test("the installed handlers grant only the sender contents' video capture and deny every check", () => {
  const target = fakeSession();
  let current = own;
  installRemoteWebrtcSenderSession(target, builtPage, () => current);
  const ask = (contents, permission, details) => {
    let answer;
    target.handlers.request(contents, permission, (value) => (answer = value), details);
    return answer;
  };
  const video = { mediaTypes: ['video'], requestingUrl: remoteWebrtcSenderPageUrl(builtPage), isMainFrame: true };
  assert.equal(ask(own, 'media', video), true);
  assert.equal(ask(own, 'media', { ...video, mediaTypes: ['video', 'audio'] }), false);
  assert.equal(ask(own, 'fullscreen', video), false);
  assert.equal(ask({}, 'media', video), false);
  current = null;
  assert.equal(ask(own, 'media', video), false, 'a destroyed or replaced window has no grant');
  assert.equal(target.handlers.check(own, 'media', 'file://', { mediaType: 'video' }), false);
  assert.equal(target.handlers.check(own, 'clipboard-sanitized-write', 'file://', {}), false);
  assert.equal(target.handlers.device(), false);
});

test('the dev page, and only it, gets the development CSP header; the built page gets none', () => {
  const dev = fakeSession();
  installRemoteWebrtcSenderSession(dev, devPage, () => own);
  const answer = (url) => {
    let result;
    dev.handlers.headers({ url, responseHeaders: { 'X-Kept': ['1'] } }, (value) => (result = value));
    return result;
  };
  const policy = answer(remoteWebrtcSenderPageUrl(devPage));
  assert.deepEqual(policy.responseHeaders['Content-Security-Policy'], [REMOTE_WEBRTC_SENDER_DEVELOPMENT_CSP]);
  assert.deepEqual(policy.responseHeaders['X-Kept'], ['1']);
  assert.deepEqual(answer('https://example.com/other.html'), {});

  // The built page's policy is in its document (below); no header duplicates it.
  const built = fakeSession();
  installRemoteWebrtcSenderSession(built, builtPage, () => own);
  assert.equal(built.handlers.headers, undefined);
});

test('the built sender document carries a closed CSP before its script; the dev document carries none', () => {
  const source = readFileSync(new URL('../../renderer/remote-webrtc-sender.html', import.meta.url), 'utf8');
  assert.ok(source.includes(REMOTE_WEBRTC_SENDER_CSP_PLACEHOLDER), 'the document has the stamp placeholder');

  const built = stampRemoteWebrtcSenderCsp(source, true);
  assert.ok(!built.includes(REMOTE_WEBRTC_SENDER_CSP_PLACEHOLDER));
  const tag = `<meta http-equiv="Content-Security-Policy" content="${REMOTE_WEBRTC_SENDER_CSP}" />`;
  assert.ok(built.includes(tag));
  assert.ok(built.indexOf(tag) < built.indexOf('<script'), 'the policy precedes every script');

  const dev = stampRemoteWebrtcSenderCsp(source, false);
  assert.ok(!dev.includes('Content-Security-Policy') && !dev.includes(REMOTE_WEBRTC_SENDER_CSP_PLACEHOLDER));

  // No unsafe source, no remote source, nothing but its own script.
  assert.match(REMOTE_WEBRTC_SENDER_CSP, /^default-src 'none'; script-src 'self'; /u);
  assert.doesNotMatch(REMOTE_WEBRTC_SENDER_CSP, /unsafe-|https?:|wss?:|\*|data:|blob:/u);
  assert.equal(REMOTE_WEBRTC_SENDER_CSP.match(/script-src [^;]*/u)[0], "script-src 'self'");
  for (const directive of ['base-uri', 'object-src', 'form-action']) {
    assert.match(REMOTE_WEBRTC_SENDER_CSP, new RegExp(`${directive} 'none'`, 'u'));
  }
});

test('the Vite plugin stamps a build and strips the dev server', () => {
  const html = '<head><!--mixdog-sender-csp--></head>';
  const stamped = (command, source = html) => {
    const plugin = remoteWebrtcSenderCspPlugin();
    plugin.configResolved({ command });
    // Vite runs this 'pre' hook without a bundle, in a build as in the dev server.
    return plugin.transformIndexHtml.handler(source, { filename: 'remote-webrtc-sender.html' });
  };
  assert.match(stamped('build'), /Content-Security-Policy/u);
  assert.equal(stamped('serve'), '<head></head>');
  assert.equal(stamped('build', '<head></head>'), '<head></head>');
});
