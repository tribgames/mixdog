/**
 * Script detection for visualize pages on a paired remote client. A page the
 * agent wrote in the user's project first renders with scripts disabled when
 * it can run any; only the user's tap on "Run" lets them execute.
 */

/** Character references an attribute value may spell `javascript:` with. */
function decodeReferences(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_all, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 32))
    .replace(/&#(\d+);?/g, (_all, dec: string) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff) || 32))
    .replace(/&colon;/gi, ':')
    .replace(/&(?:tab|newline);/gi, '');
}

/** True when `html` may run script or embed active content: any `<script`, an
 *  inline event handler attribute, a `javascript:` URL, a meta refresh, or an
 *  `<iframe>`/`<object>`/`<embed>`. Over-approximates on purpose (prose that
 *  mentions them counts too). It only decides whether the "Run" prompt is
 *  shown; whether scripts run is `remotePageGate`, which fails closed. */
export function htmlRunsScripts(html: string): boolean {
  if (/<(?:script|iframe|object|embed)\b/i.test(html)) return true;
  if (/<[a-z][^>]*[\s"'/]on[a-z]+\s*=/i.test(html)) return true;
  if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html)) return true;
  // Whitespace and control characters inside the scheme are ignored by URL parsers.
  return /javascript\s*:/i.test(decodeReferences(html).replace(/[\u0000-\u0020]+/g, ''));
}

/** `html` without `<meta http-equiv>` tags (of any spelling, entity-encoded
 *  values included), notably refresh redirects, which a frame without script
 *  would still follow (to any address). */
export function withoutMetaRefresh(html: string): string {
  // A real HTML parse (the renderer's own), not tag regexes: quoted `>` and
  // entity/case spellings cannot hide a tag from the parser the frame uses.
  // Fails closed: with no parser nothing of the page is passed on.
  const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!Parser) return '';
  const doc = new Parser().parseFromString(html, 'text/html');
  for (const meta of Array.from(doc.querySelectorAll('meta[http-equiv]'))) meta.remove();
  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : '';
  return doctype + doc.documentElement.outerHTML;
}

/** How a remote client renders a page it fetched: scripts run only after the
 *  user's tap on "Run" for this tab (`runTapped`), whatever detection says.
 *  `prompt` (which "Run" bar to show, if any) is never a security decision:
 *  'scripts' when the page can run script or has `data-choice` picks (which
 *  need the page's feedback script), else 'comments' when Comment mode is on
 *  (`commenting`). Until Run the page is markup and styles only. */
export function remotePageGate(
  html: string,
  runTapped: boolean,
  commenting = false
): { runScripts: boolean; prompt: 'scripts' | 'comments' | null; srcdoc: string } {
  if (runTapped) return { runScripts: true, prompt: null, srcdoc: html };
  const prompt = htmlRunsScripts(html) || /data-choice/i.test(html) ? 'scripts' : commenting ? 'comments' : null;
  return { runScripts: false, prompt, srcdoc: withoutMetaRefresh(html) };
}
