import type { WebContents } from 'electron';

/** Chromium's JSON viewer puts a fixed "Pretty-print" checkbox bar (a closed
 *  shadow root inside this container) over the top of a JSON document. The
 *  pane shows no strip of its own: hide it and pretty-print the text itself. */
export const JSON_VIEWER_BAR_CSS = 'body > pre + .json-formatter-container { display: none !important; }';

const MAX_PRETTY_CHARS = 5_000_000;
/** Indentation grows with nesting, so the input limit alone does not bound the
 *  output (4,001 characters of nested brackets indent to 8,008,001). Nesting
 *  deeper than this, or output beyond the budget, is left as it was. */
const MAX_PRETTY_DEPTH = 64;
const MAX_PRETTY_OUTPUT_CHARS = 5_000_000;

/** Runs in the page: a document that is one <pre> of JSON text becomes its
 *  indented form. Anything else (not JSON, too large or too deep to indent
 *  within budget, a normal page) is left.
 *  Only the whitespace between tokens changes: numbers and strings keep their
 *  original spelling (a parse/stringify round trip would round big integers). */
export const JSON_PRETTY_PRINT_SCRIPT = `(() => {
  const body = document.body;
  const pre = body && body.firstElementChild;
  if (!pre || pre.tagName !== 'PRE' || body.children.length > 2) return;
  if (!/json|text\\/plain/.test(document.contentType)) return;
  const text = pre.textContent || '';
  if (text.length > ${MAX_PRETTY_CHARS}) return;
  try {
    JSON.parse(text);
  } catch {
    return;
  }
  const space = (c) => c === ' ' || c === '\\n' || c === '\\r' || c === '\\t';
  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = () => '\\n' + '  '.repeat(depth);
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (space(c)) {
      continue;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '{' || c === '[') {
      let next = i + 1;
      while (next < text.length && space(text[next])) next += 1;
      if (text[next] === (c === '{' ? '}' : ']')) {
        out += c + text[next];
        i = next;
      } else {
        depth += 1;
        if (depth > ${MAX_PRETTY_DEPTH}) return;
        out += c + newline();
      }
    } else if (c === '}' || c === ']') {
      depth -= 1;
      out += newline() + c;
    } else if (c === ',') {
      out += ',' + newline();
    } else if (c === ':') {
      out += ': ';
    } else {
      out += c;
    }
    if (out.length > ${MAX_PRETTY_OUTPUT_CHARS}) return;
  }
  if (out !== text) pre.textContent = out;
})()`;

/** On every document: hide the viewer's bar and show the JSON indented. */
export function injectJsonViewerTweaks(
  guest: Pick<WebContents, 'on' | 'insertCSS' | 'executeJavaScript' | 'isDestroyed'>
): void {
  guest.on('dom-ready', () => {
    if (guest.isDestroyed()) return;
    void guest.insertCSS(JSON_VIEWER_BAR_CSS).catch(() => {});
    void guest.executeJavaScript(JSON_PRETTY_PRINT_SCRIPT).catch(() => {});
  });
}
