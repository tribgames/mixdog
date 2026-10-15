/**
 * Sandboxed previews run page scripts in an opaque origin (`sandbox
 * allow-scripts`, no allow-same-origin). There, merely touching
 * `window.localStorage` / `sessionStorage` throws a SecurityError, which kills
 * the typical generated "tabs" page before it wires anything up. The shim is
 * a tiny inline script, injected first in the document, that replaces a
 * storage which throws with an in-memory Storage for the document's lifetime.
 * A storage that works is left alone. Sandbox and CSP isolation are untouched.
 */

// Plain ES5 text run inside the previewed page (no `</script` inside).
const SHIM_SOURCE = `(function () {
  function broken(name) {
    try { window[name].getItem('__mixdog_probe__'); return false; } catch (error) { return true; }
  }
  function create() {
    var data = Object.create(null);
    var keys = [];
    function need(given, wanted, method) {
      if (given < wanted) {
        throw new TypeError("Failed to execute '" + method + "' on 'Storage': " + wanted + ' argument(s) required, but only ' + given + ' present.');
      }
    }
    function text(value) {
      if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
      return String(value);
    }
    var api = {
      getItem: function (key) {
        need(arguments.length, 1, 'getItem');
        key = text(key);
        return key in data ? data[key] : null;
      },
      setItem: function (key, value) {
        need(arguments.length, 2, 'setItem');
        // Both conversions happen before any state changes: a throwing
        // toString leaves no phantom key.
        key = text(key);
        value = text(value);
        if (!(key in data)) keys.push(key);
        data[key] = value;
      },
      removeItem: function (key) {
        need(arguments.length, 1, 'removeItem');
        key = text(key);
        if (key in data) { delete data[key]; keys.splice(keys.indexOf(key), 1); }
      },
      clear: function () { data = Object.create(null); keys = []; },
      key: function (index) {
        need(arguments.length, 1, 'key');
        var found = keys[index >>> 0];
        return found === undefined ? null : found;
      }
    };
    Object.defineProperty(api, 'length', { get: function () { return keys.length; }, configurable: true });
    if (typeof Proxy !== 'function') return api;
    return new Proxy(api, {
      get: function (target, prop) {
        if (typeof prop === 'string' && !(prop in target)) return prop in data ? data[prop] : undefined;
        return target[prop];
      },
      set: function (target, prop, value) {
        if (typeof prop === 'string') api.setItem(prop, value);
        return true;
      },
      deleteProperty: function (target, prop) {
        if (typeof prop === 'string') api.removeItem(prop);
        return true;
      },
      has: function (target, prop) { return prop in target || (typeof prop === 'string' && prop in data); },
      ownKeys: function () { return keys.slice(); },
      getOwnPropertyDescriptor: function (target, prop) {
        if (typeof prop === 'string' && prop in data) {
          return { value: data[prop], writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      }
    });
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    if (!broken(name)) return;
    var store = create();
    try {
      Object.defineProperty(window, name, { get: function () { return store; }, configurable: true, enumerable: true });
    } catch (error) {}
  });
})();`;

/** The inline script text (an IIFE) that installs the in-memory storages. */
export function sandboxStorageShimScript(): string {
  return SHIM_SOURCE;
}

/** Index just past the `>` that closes the start tag whose attributes begin
 *  at `from`, skipping quoted attribute values; -1 when it never closes. */
function startTagEnd(html: string, from: number): number {
  let i = from;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '>') return i + 1;
    i += 1;
    if (ch !== '=') continue;
    while (/\s/.test(html[i] ?? '')) i += 1;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      if (close < 0) return -1;
      i = close + 1;
    }
  }
  return -1;
}

/** Where a script must go to run before any page content: just inside
 *  `<head>`; with no head before the first content, after the prelude
 *  (BOM, comments, doctype, `<html>`), so it never precedes the doctype.
 *  Scans tag by tag, so `<head>` text in comments, in script bodies or in
 *  attribute values is never mistaken for the real tag. */
function headInsertionPoint(html: string): number {
  let safe = html.startsWith('\uFEFF') ? 1 : 0;
  let i = safe;
  while (i < html.length) {
    if (/\s/.test(html[i])) {
      i += 1;
    } else if (html.startsWith('<!--', i)) {
      // A comment ends at the first `-->` or `--!>`; `<!-->` and `<!--->` are
      // complete (abrupt) comments in HTML parsing.
      const dash = html.indexOf('-->', i + 4);
      const bang = html.indexOf('--!>', i + 4);
      let close = -1;
      if (dash >= 0 && (bang < 0 || dash < bang)) close = dash + 3;
      else if (bang >= 0) close = bang + 4;
      if (html.startsWith('<!-->', i)) close = i + 5;
      else if (html.startsWith('<!--->', i)) close = i + 6;
      if (close < 3) return safe;
      safe = i = close;
    } else if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const close = html.indexOf('>', i);
      if (close < 0) return safe;
      if (/^<!doctype/i.test(html.slice(i, i + 9))) safe = close + 1;
      i = close + 1;
    } else if (html.startsWith('</', i)) {
      const close = html.indexOf('>', i);
      if (close < 0) return safe;
      i = close + 1;
    } else if (html[i] === '<' && /[a-z]/i.test(html[i + 1] ?? '')) {
      const name = /^[^\s/>]+/.exec(html.slice(i + 1, i + 40))?.[0].toLowerCase();
      const end = startTagEnd(html, i + 1 + (name?.length ?? 0));
      if (end < 0) return safe;
      if (name === 'head') return end;
      // Anything but <html> is page content: head is missing or too late.
      if (name !== 'html') return safe;
      safe = i = end;
    } else {
      return safe;
    }
  }
  return safe;
}

/** `html` with `script` as an inline `<script>` placed before any page content. */
export function withHeadScript(html: string, script: string): string {
  const at = headInsertionPoint(html);
  return `${html.slice(0, at)}<script>${script}</script>${html.slice(at)}`;
}

/** `html` with the storage shim first in its head. */
export function withSandboxStorageShim(html: string): string {
  return withHeadScript(html, SHIM_SOURCE);
}
