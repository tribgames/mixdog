// The page bridge of a remote visualize page. The page runs in an opaque
// origin frame with no address of its own for the project's files, so its
// own `fetch`/XHR of project files (data files, JSON, textures…) has nowhere
// to go. A script injected first in the page answers those requests from the
// parent instead: it posts the reference, this side resolves it against the
// page with the same containment as an inlined asset and reads it through the
// pane's own range method (the host re-checks every read). Anything else (an
// outside https URL) goes to the real fetch, which the frame's CSP allows.
import { withHeadScript } from '../shared/sandbox-storage-shim';

export const PAGE_FETCH_REQUEST = 'mixdog-page-fetch';
export const PAGE_FETCH_RESPONSE = 'mixdog-page-fetch-result';
/** Requests one page may have outstanding; more answer 429. */
export const PAGE_FETCH_MAX_INFLIGHT = 16;
const MAX_REFERENCE_LENGTH = 4096;

const FAKE_ORIGIN = 'https://mixdog-page.invalid';

/** The in-page half (plain ES5, no `</script`). `page` is the page's path
 *  relative to its root: relative URLs resolve against it. */
export function pageFetchBridgeScript(page: string): string {
  const base = JSON.stringify(`${FAKE_ORIGIN}/${encodeURI(page)}`).replace(/</g, '\\u003c');
  return `(function () {
  var parentWindow = window.parent;
  if (!parentWindow || parentWindow === window) return;
  var ORIGIN = ${JSON.stringify(FAKE_ORIGIN)};
  var BASE = ${base};
  var docBase = String(document.baseURI || '');
  var docDir = docBase.slice(0, docBase.lastIndexOf('/') + 1);
  var pending = Object.create(null);
  var seq = 0;
  function reference(raw) {
    var text = String(raw);
    var url;
    try { url = new URL(text, BASE); } catch (error) { return null; }
    if (url.origin === ORIGIN) return url.pathname;
    // An absolute URL built from the document's own address (Request objects,
    // new URL(x, location.href)) names the page's folder.
    if (/^https?:/.test(docDir) && url.href.indexOf(docDir) === 0) {
      try { return new URL(url.href.slice(docDir.length), BASE).pathname; } catch (error) { return null; }
    }
    return null;
  }
  function abortReason(signal) {
    if (signal.reason !== undefined) return signal.reason;
    try { return new DOMException('The operation was aborted.', 'AbortError'); } catch (error) {
      var aborted = new Error('The operation was aborted.');
      aborted.name = 'AbortError';
      return aborted;
    }
  }
  // The bridge protocol has no cancel message: forgetting the id drops a late
  // reply, and the parent's read finishes unobserved.
  function cancel(id) { delete pending[id]; }
  function request(ref, signal, handle) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(abortReason(signal)); return; }
      seq += 1;
      var id = seq;
      if (handle) handle.id = id;
      var onAbort = function () {
        delete pending[id];
        reject(abortReason(signal));
      };
      pending[id] = function (data) {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(data);
      };
      if (signal) signal.addEventListener('abort', onAbort);
      parentWindow.postMessage({ type: ${JSON.stringify(PAGE_FETCH_REQUEST)}, id: id, reference: ref }, '*');
    });
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parentWindow) return;
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(PAGE_FETCH_RESPONSE)} || !pending[data.id]) return;
    var done = pending[data.id];
    delete pending[data.id];
    done(data);
  });
  function readable(method) { method = String(method || 'GET').toUpperCase(); return method === 'GET' || method === 'HEAD'; }
  var realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      var raw = input && typeof input === 'object' && 'url' in input ? input.url : input;
      var ref = reference(raw);
      if (ref === null) return realFetch.apply(this, arguments);
      var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      if (!readable(method)) return Promise.resolve(new Response(null, { status: 405, statusText: 'Method Not Allowed' }));
      var signal = (init && init.signal) || (input && typeof input === 'object' && input.signal) || null;
      return request(ref, signal).then(function (reply) {
        if (!reply.ok) return new Response(null, { status: reply.status || 404, statusText: 'Not Found' });
        return new Response(String(method).toUpperCase() === 'HEAD' ? null : reply.body, { status: 200, headers: { 'Content-Type': reply.mime || 'application/octet-stream' } });
      });
    };
  }
  var XHR = window.XMLHttpRequest;
  if (XHR) {
    var open = XHR.prototype.open;
    var send = XHR.prototype.send;
    var setHeader = XHR.prototype.setRequestHeader;
    var define = function (target, values) {
      for (var key in values) Object.defineProperty(target, key, { value: values[key], configurable: true, writable: true });
    };
    var fire = function (target, type) {
      try { target.dispatchEvent(new ProgressEvent(type)); } catch (error) {}
    };
    var abort = XHR.prototype.abort;
    var generation = function (xhr) { return xhr.__mixdogGeneration || 0; };
    // Drops the request in flight, if any, and makes any reply to it stale.
    var retire = function (xhr) {
      var job = xhr.__mixdogJob;
      xhr.__mixdogGeneration = generation(xhr) + 1;
      if (job && job.handle.id) cancel(job.handle.id);
    };
    XHR.prototype.open = function (method, url) {
      var ref = reference(url);
      retire(this);
      this.__mixdogJob = ref === null ? null : { ref: ref, method: String(method || 'GET').toUpperCase(), handle: {}, sent: false, done: false };
      if (ref === null) return open.apply(this, arguments);
      define(this, { readyState: 1, status: 0, statusText: '', response: '', responseText: '', responseURL: '' });
      delete this.getResponseHeader;
      delete this.getAllResponseHeaders;
      fire(this, 'readystatechange');
    };
    XHR.prototype.abort = function () {
      var job = this.__mixdogJob;
      if (!job) return abort.apply(this, arguments);
      var active = job.sent && !job.done;
      retire(this);
      job.done = true;
      if (active) {
        define(this, { readyState: 4 });
        fire(this, 'readystatechange');
        fire(this, 'abort');
        fire(this, 'loadend');
      }
      define(this, { readyState: 0, status: 0, statusText: '', response: '', responseText: '', responseURL: '' });
      delete this.getResponseHeader;
      delete this.getAllResponseHeaders;
    };
    XHR.prototype.setRequestHeader = function () {
      if (!this.__mixdogJob) return setHeader.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var xhr = this;
      var job = xhr.__mixdogJob;
      if (!job) return send.apply(this, arguments);
      job.sent = true;
      var current = generation(xhr);
      fire(xhr, 'loadstart');
      var answer = readable(job.method) ? request(job.ref, null, job.handle) : Promise.resolve({ ok: false, status: 405 });
      answer.then(function (reply) {
        if (generation(xhr) !== current) return;
        job.done = true;
        var ok = !!reply.ok;
        var body = ok && reply.body ? reply.body : new ArrayBuffer(0);
        var mime = ok ? reply.mime || '' : '';
        var type = xhr.responseType;
        var text = new TextDecoder().decode(body);
        var response = text;
        if (type === 'arraybuffer') response = body;
        else if (type === 'blob') response = new Blob([body], { type: mime });
        else if (type === 'json') { try { response = JSON.parse(text); } catch (error) { response = null; } }
        else if (type === 'document') response = null;
        define(xhr, {
          readyState: 4,
          status: ok ? 200 : reply.status || 404,
          statusText: ok ? 'OK' : 'Not Found',
          response: response,
          responseURL: ''
        });
        if (type === '' || type === 'text') define(xhr, { responseText: text });
        xhr.getResponseHeader = function (name) {
          return mime && String(name).toLowerCase() === 'content-type' ? mime : null;
        };
        xhr.getAllResponseHeaders = function () { return mime ? 'content-type: ' + mime + '\\r\\n' : ''; };
        fire(xhr, 'readystatechange');
        fire(xhr, ok ? 'load' : 'error');
        fire(xhr, 'loadend');
      });
    };
  }
})();`;
}

/** `html` with the bridge first in its head. */
export function withPageFetchBridge(html: string, page: string): string {
  return withHeadScript(html, pageFetchBridgeScript(page));
}

type PageFetcher = (reference: string) => Promise<{ bytes: Uint8Array; mime: string }>;

/** Answers `frame`'s bridge requests with `fetcher` (which resolves and
 *  contains the reference). Only messages from the frame's own window count.
 *  Returns the cleanup. */
export function servePageFetches(frame: HTMLIFrameElement, fetcher: PageFetcher): () => void {
  let inflight = 0;
  let stopped = false;
  const onMessage = (event: MessageEvent): void => {
    const target = frame.contentWindow;
    if (!target || event.source !== target) return;
    const data = event.data as { type?: unknown; id?: unknown; reference?: unknown } | null;
    if (!data || typeof data !== 'object') return;
    if (data.type !== PAGE_FETCH_REQUEST || typeof data.id !== 'number') return;
    const id = data.id;
    const reply = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
      if (stopped) return;
      target.postMessage({ type: PAGE_FETCH_RESPONSE, id, ...message }, '*', transfer);
    };
    if (typeof data.reference !== 'string' || !data.reference || data.reference.length > MAX_REFERENCE_LENGTH) {
      reply({ ok: false, status: 400 });
      return;
    }
    if (inflight >= PAGE_FETCH_MAX_INFLIGHT) {
      reply({ ok: false, status: 429 });
      return;
    }
    inflight += 1;
    fetcher(data.reference)
      .then(
        ({ bytes, mime }) => {
          const body = bytes.slice().buffer as ArrayBuffer;
          reply({ ok: true, status: 200, mime, body }, [body]);
        },
        () => reply({ ok: false, status: 404 })
      )
      .finally(() => {
        inflight -= 1;
      });
  };
  window.addEventListener('message', onMessage);
  return () => {
    stopped = true;
    window.removeEventListener('message', onMessage);
  };
}
