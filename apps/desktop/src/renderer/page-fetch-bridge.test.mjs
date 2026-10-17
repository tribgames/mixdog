import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  PAGE_FETCH_MAX_INFLIGHT,
  PAGE_FETCH_REQUEST,
  PAGE_FETCH_RESPONSE,
  pageFetchBridgeScript,
  servePageFetches,
  withPageFetchBridge,
} from './page-fetch-bridge.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function page() {
  const dom = new JSDOM('<!doctype html><body><iframe></iframe></body>', { runScripts: 'outside-only' });
  const frame = dom.window.document.querySelector('iframe');
  return { dom, frame, inner: frame.contentWindow };
}

test("the parent answers the frame's requests with the fetcher, transferring the bytes", async () => {
  const { dom, frame, inner } = page();
  globalThis.window = dom.window;
  const posted = [];
  inner.postMessage = (message, target, transfer) => posted.push([message, target, transfer]);
  const asked = [];
  const stop = servePageFetches(frame, async (reference) => {
    asked.push(reference);
    if (reference === '/site/data.json')
      return { bytes: new TextEncoder().encode('{"n":1}'), mime: 'application/json' };
    throw new Error('The page may only read its own project files.');
  });
  const send = (data, source = inner) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source }));
  send({ type: PAGE_FETCH_REQUEST, id: 1, reference: '/site/data.json' });
  // A request from anything but the frame (another window, the app) is ignored.
  send({ type: PAGE_FETCH_REQUEST, id: 2, reference: '/site/data.json' }, dom.window);
  await tick();
  assert.deepEqual(asked, ['/site/data.json']);
  const [[reply, target, transfer]] = posted;
  assert.equal(target, '*');
  assert.deepEqual(
    { ...reply, body: undefined },
    { type: PAGE_FETCH_RESPONSE, id: 1, ok: true, status: 200, mime: 'application/json', body: undefined }
  );
  assert.equal(new TextDecoder().decode(reply.body), '{"n":1}');
  assert.deepEqual(transfer, [reply.body]);

  // A path the fetcher refuses (escape, outside URL, host refusal) answers 404;
  // a malformed request 400; nothing reaches the fetcher for those.
  send({ type: PAGE_FETCH_REQUEST, id: 3, reference: '/../secret.txt' });
  send({ type: PAGE_FETCH_REQUEST, id: 4, reference: 7 });
  send({ type: PAGE_FETCH_REQUEST, id: 5, reference: 'x'.repeat(5000) });
  send({ type: PAGE_FETCH_REQUEST, id: '6', reference: '/a' });
  await tick();
  assert.deepEqual(
    posted.slice(1).map(([message]) => [message.id, message.ok, message.status]),
    [
      [4, false, 400],
      [5, false, 400],
      [3, false, 404],
    ]
  );
  assert.deepEqual(asked, ['/site/data.json', '/../secret.txt']);

  // After cleanup nothing is served.
  stop();
  send({ type: PAGE_FETCH_REQUEST, id: 7, reference: '/site/data.json' });
  await tick();
  assert.equal(posted.length, 4);
});

test('outstanding requests are capped', async () => {
  const { dom, frame, inner } = page();
  globalThis.window = dom.window;
  const posted = [];
  inner.postMessage = (message) => posted.push(message);
  const waiting = [];
  servePageFetches(frame, () => new Promise((resolve) => waiting.push(resolve)));
  const send = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: inner }));
  for (let id = 1; id <= PAGE_FETCH_MAX_INFLIGHT + 1; id += 1)
    send({ type: PAGE_FETCH_REQUEST, id, reference: `/f${id}` });
  assert.deepEqual(posted, [{ type: PAGE_FETCH_RESPONSE, id: PAGE_FETCH_MAX_INFLIGHT + 1, ok: false, status: 429 }]);
  assert.equal(waiting.length, PAGE_FETCH_MAX_INFLIGHT);
});

/** Runs the in-page script in a frame whose parent records what it posts. */
function bridgedFrame(pagePath) {
  const { dom, inner } = page();
  const toParent = [];
  // Plain copies: the page's objects belong to the frame's realm.
  dom.window.postMessage = (message) => toParent.push(JSON.parse(JSON.stringify(message)));
  const realFetches = [];
  inner.fetch = async (input) => {
    realFetches.push(String(input));
    return new Response('live', { status: 200 });
  };
  inner.Response = Response;
  inner.eval(pageFetchBridgeScript(pagePath));
  const answer = (data) =>
    inner.dispatchEvent(
      new inner.MessageEvent('message', { data: { type: PAGE_FETCH_RESPONSE, ...data }, source: dom.window })
    );
  return { dom, inner, toParent, realFetches, answer };
}

test('in the page, fetch of a project file goes to the parent and resolves against the page', async () => {
  const { inner, toParent, realFetches, answer } = bridgedFrame('site/index.html');
  const loading = inner.fetch('data/x.json');
  assert.deepEqual(toParent, [{ type: PAGE_FETCH_REQUEST, id: 1, reference: '/site/data/x.json' }]);
  answer({ id: 1, ok: true, status: 200, mime: 'application/json', body: new TextEncoder().encode('{"n":2}').buffer });
  const response = await loading;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { n: 2 });
  // Root-relative and a refusal.
  const missing = inner.fetch('/other.bin');
  assert.equal(toParent[1].reference, '/other.bin');
  answer({ id: 2, ok: false, status: 404 });
  assert.equal((await missing).status, 404);
  // Writes are refused locally.
  assert.equal((await inner.fetch('data/x.json', { method: 'POST' })).status, 405);
  // Outside URLs go straight to the real fetch (the frame's CSP allows https).
  assert.equal((await inner.fetch('https://api.test/v1')).status, 200);
  assert.deepEqual(realFetches, ['https://api.test/v1']);
  assert.equal(toParent.length, 2, 'nothing about an outside request reaches the app');
});

test('in the page, an aborted fetch rejects and a late answer is ignored', async () => {
  const { inner, toParent, answer } = bridgedFrame('index.html');
  const before = new inner.AbortController();
  before.abort();
  await assert.rejects(inner.fetch('data.json', { signal: before.signal }), (error) => error.name === 'AbortError');
  assert.deepEqual(toParent, [], 'an already-aborted fetch asks the parent nothing');

  const during = new inner.AbortController();
  const loading = inner.fetch('data.json', { signal: during.signal });
  assert.equal(toParent.length, 1);
  during.abort();
  await assert.rejects(loading, (error) => error.name === 'AbortError');
  answer({
    id: toParent[0].id,
    ok: true,
    status: 200,
    mime: 'text/plain',
    body: new TextEncoder().encode('stale').buffer,
  });

  const fresh = inner.fetch('data.json');
  answer({
    id: toParent[1].id,
    ok: true,
    status: 200,
    mime: 'text/plain',
    body: new TextEncoder().encode('fresh').buffer,
  });
  assert.equal(await (await fresh).text(), 'fresh');
});

test('in the page, XHR of a project file is answered with text, json or bytes', async () => {
  const { inner, toParent, answer } = bridgedFrame('index.html');
  const xhr = new inner.XMLHttpRequest();
  const seen = [];
  xhr.onreadystatechange = () => seen.push(xhr.readyState);
  const loaded = new Promise((resolve) => {
    xhr.onload = resolve;
  });
  xhr.open('GET', 'notes.txt');
  xhr.setRequestHeader('X-Test', '1');
  xhr.send();
  assert.deepEqual(toParent, [{ type: PAGE_FETCH_REQUEST, id: 1, reference: '/notes.txt' }]);
  answer({ id: 1, ok: true, status: 200, mime: 'text/plain', body: new TextEncoder().encode('hello').buffer });
  await loaded;
  assert.deepEqual([xhr.status, xhr.responseText, xhr.getResponseHeader('Content-Type')], [200, 'hello', 'text/plain']);
  assert.deepEqual(seen, [1, 4]);

  const json = new inner.XMLHttpRequest();
  json.responseType = 'json';
  const done = new Promise((resolve) => json.addEventListener('load', resolve));
  json.open('GET', 'd.json');
  json.send();
  answer({ id: 2, ok: true, status: 200, mime: 'application/json', body: new TextEncoder().encode('[1,2]').buffer });
  await done;
  assert.equal(JSON.stringify(json.response), '[1,2]');

  const failed = new inner.XMLHttpRequest();
  const error = new Promise((resolve) => failed.addEventListener('error', resolve));
  failed.open('GET', 'gone.bin');
  failed.send();
  answer({ id: 3, ok: false, status: 404 });
  await error;
  assert.equal(failed.status, 404);
});

test('in the page, aborting an XHR fires abort and ignores the late reply', async () => {
  const { inner, toParent, answer } = bridgedFrame('index.html');
  const xhr = new inner.XMLHttpRequest();
  const events = [];
  for (const type of ['readystatechange', 'load', 'error', 'abort', 'loadend'])
    xhr.addEventListener(type, () => events.push(`${type}:${xhr.readyState}`));
  xhr.open('GET', 'a.txt');
  xhr.send();
  xhr.abort();
  assert.deepEqual(events, ['readystatechange:1', 'readystatechange:4', 'abort:4', 'loadend:4']);
  assert.deepEqual([xhr.readyState, xhr.status, xhr.responseText], [0, 0, '']);
  answer({
    id: toParent[0].id,
    ok: true,
    status: 200,
    mime: 'text/plain',
    body: new TextEncoder().encode('late').buffer,
  });
  await tick();
  assert.equal(events.length, 4, 'a late reply fires nothing');
  assert.deepEqual([xhr.readyState, xhr.status, xhr.responseText], [0, 0, '']);
});

test('in the page, re-opening an XHR ignores the old reply and applies the new one', async () => {
  const { inner, toParent, answer } = bridgedFrame('index.html');
  const xhr = new inner.XMLHttpRequest();
  const loads = [];
  xhr.addEventListener('load', () => loads.push(xhr.responseText));
  xhr.open('GET', 'old.txt');
  xhr.send();
  xhr.open('GET', 'new.txt');
  xhr.send();
  const [oldRequest, newRequest] = toParent;
  answer({
    id: oldRequest.id,
    ok: true,
    status: 200,
    mime: 'text/plain',
    body: new TextEncoder().encode('old').buffer,
  });
  await tick();
  assert.deepEqual(loads, []);
  assert.equal(xhr.readyState, 1);
  answer({
    id: newRequest.id,
    ok: true,
    status: 200,
    mime: 'text/plain',
    body: new TextEncoder().encode('new').buffer,
  });
  await tick();
  assert.deepEqual(loads, ['new']);
  assert.equal(xhr.readyState, 4);
});

test('the bridge goes first in the page head', () => {
  const html = withPageFetchBridge('<!doctype html><html><head><title>t</title></head><body></body></html>', 'a.html');
  assert.match(html, /^<!doctype html><html><head><script>\(function \(\) \{/);
  assert.equal(html.includes('</script><title>t</title>'), true);
  // A page path cannot close the script.
  assert.equal(pageFetchBridgeScript('</script><x>.html').includes('</script'), false);
});
