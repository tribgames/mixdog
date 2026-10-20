// Browser side of remote file previews. Image/audio/video stream over the
// encrypted HTTP media lane when the host offers it (remote-media-lane.ts).
// Otherwise bytes arrive as bounded base64 ranges over the encrypted RPC lane
// and become blob: URLs; local web pages become a self-contained srcdoc
// document. See main/remote-file-preview.ts for the host half.
import type { DesktopApi } from '../shared/contract';
import {
  MAX_VISUALIZE_SOURCE_BYTES,
  REMOTE_PAGE_MAX_BYTES,
  type VisualizePaneSource,
  type VisualizePaneText,
  type VisualizeRemotePaneFile,
} from '../shared/visualize';

import { useSyncExternalStore } from 'react';

// Streamed preview URLs embed the media session: when it changes (reconnect)
// the old URLs are dead, so mounted previews must resolve theirs again.
let mediaSessionEpoch = 0;
const mediaSessionListeners = new Set<() => void>();

/** Called when the authenticated media session is published or revoked. */
export function notifyMediaSessionChanged(): void {
  mediaSessionEpoch += 1;
  for (const listener of [...mediaSessionListeners]) listener();
}

export function subscribeMediaSession(listener: () => void): () => void {
  mediaSessionListeners.add(listener);
  return () => {
    mediaSessionListeners.delete(listener);
  };
}

export const getMediaSessionEpoch = (): number => mediaSessionEpoch;

/** Changes whenever the media session does; list it in the dependencies of an
 *  effect that calls `previewProjectFile` to re-resolve after a reconnect. */
export function useMediaSessionEpoch(): number {
  return useSyncExternalStore(subscribeMediaSession, getMediaSessionEpoch, getMediaSessionEpoch);
}

type Call = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;

/** Raw bytes requested per round trip (host clamps to 4 MiB). */
export const REMOTE_PREVIEW_CHUNK_BYTES = 2 * 1024 * 1024;
/** Largest file previewed whole in the browser; blob URLs hold it in memory. */
const REMOTE_PREVIEW_MAX_FILE_BYTES = 64 * 1024 * 1024;
const PAGE_MAX_BYTES = REMOTE_PAGE_MAX_BYTES;
const PAGE_ASSET_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const PAGE_MAX_ASSETS = 64;
const BLOB_CACHE_LIMIT = 48;

interface RangeResult {
  data: string;
  mime: string;
  offset: number;
  size: number;
  mtimeMs: number;
}

function bytesFromBase64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** Reads a whole file in sequential ranges; refuses anything over `maxBytes`
 *  before the first byte moves (size comes from the first range). */
export async function readRemoteFile(
  call: Call,
  target: [string, string, string | null],
  maxBytes: number
): Promise<{ parts: Uint8Array[]; mime: string; size: number }> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let size = Infinity;
  let mime = 'application/octet-stream';
  while (offset < size) {
    const range = await call<RangeResult>('previewProjectFileRange', [...target, offset, REMOTE_PREVIEW_CHUNK_BYTES]);
    size = range.size;
    mime = range.mime;
    if (size > maxBytes) throw new Error('This file is too large to preview over remote access.');
    const bytes = bytesFromBase64(range.data);
    if (!bytes.length) break;
    parts.push(bytes);
    offset += bytes.length;
  }
  return { parts, mime, size: offset };
}

const EXTERNAL_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Project-relative path of a page reference, or '' when it is external or
 *  would climb out of the project root. */
export function resolvePageReference(pagePath: string, reference: string): string {
  const raw = reference.trim();
  if (!raw || EXTERNAL_REFERENCE.test(raw)) return '';
  let path = raw.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return '';
  }
  const segments: string[] = path.startsWith('/') ? [] : pagePath.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!segments.length) return '';
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join('/');
}

function dataUrl(parts: Uint8Array[], mime: string): string {
  let binary = '';
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 0x8000) {
      binary += String.fromCharCode(...part.subarray(index, index + 0x8000));
    }
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

const textOfParts = (parts: Uint8Array[]): string => new TextDecoder().decode(concat(parts));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Nested `<iframe src>` pages inlined below the top page. */
const PAGE_MAX_FRAME_DEPTH = 2;
/** `@import` chains followed inside stylesheets. */
const CSS_MAX_IMPORT_DEPTH = 4;
/** Largest file one page `fetch`/XHR may read through the bridge. */
export const PAGE_FETCH_MAX_BYTES = 16 * 1024 * 1024;

const CSS_IMPORT = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi;
const CSS_URL = /url\(\s*(["']?)([^"')]+?)\1\s*\)/gi;
// Static `import … from`, bare `import '…'`, `export … from` and string
// literal dynamic `import('…')`.
const MODULE_SPECIFIER =
  /(\bimport\s*\(\s*|\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*[\w$*{}\s,]+?\s*from\s*)(["'])([^"'\n]+)\2/y;
/** A relative or root module specifier (or import map address); anything
 *  else is a bare name or a full URL. */
const RELATIVE_SPECIFIER = /^(?:\.{1,2}\/|\/)/;

/** Where the import map's `imports` send bare `specifier`: its exact key,
 *  else the longest matching `/`-ending prefix key; '' when none does. */
function mappedSpecifier(imports: Record<string, unknown>, specifier: string): string {
  const exact = imports[specifier];
  if (Object.hasOwn(imports, specifier)) return typeof exact === 'string' ? exact : '';
  let prefix = '';
  for (const key of Object.keys(imports)) {
    if (key.endsWith('/') && specifier.startsWith(key) && key.length > prefix.length) prefix = key;
  }
  const target = prefix ? imports[prefix] : '';
  return typeof target === 'string' && target ? target + specifier.slice(prefix.length) : '';
}
// Words after which a `/` starts a regex literal rather than dividing.
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Real module specifiers in `source`: a lexer skips strings, template
 *  literals, comments and regex literals, so import-looking text inside them
 *  never matches. */
function moduleSpecifiers(source: string): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  const braces: boolean[] = []; // true: the `{` of a template `${`
  const n = source.length;
  let i = 0;
  let regexOk = true;
  const skipQuoted = (quote: string): void => {
    i += 1;
    while (i < n && source[i] !== quote && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
    i += 1;
  };
  // Reads template text from `i` up to its end or the next `${`.
  const templateText = (): void => {
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') i += 2;
      else if (source[i] === '$' && source[i + 1] === '{') {
        braces.push(true);
        i += 2;
        regexOk = true;
        return;
      } else i += 1;
    }
    i += 1;
    regexOk = false;
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (/\s/.test(c)) i += 1;
    else if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      skipQuoted(c);
      regexOk = false;
    } else if (c === '`') {
      i += 1;
      templateText();
    } else if (c === '/' && regexOk) {
      i += 1;
      let inClass = false;
      while (i < n && source[i] !== '\n' && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') i += 1;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      regexOk = false;
    } else if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[\w$]/.test(source[i])) i += 1;
      const word = source.slice(start, i);
      let match: RegExpExecArray | null = null;
      if (word === 'import' || word === 'export') {
        let before = start - 1;
        while (before >= 0 && /\s/.test(source[before])) before -= 1;
        if (source[before] !== '.') {
          MODULE_SPECIFIER.lastIndex = start;
          match = MODULE_SPECIFIER.exec(source);
        }
      }
      if (match) {
        found.push(match);
        i = start + match[0].length;
        regexOk = false;
      } else regexOk = REGEX_AFTER_WORD.has(word);
    } else if (/\d/.test(c)) {
      while (i < n && /[\w.]/.test(source[i])) i += 1;
      regexOk = false;
    } else {
      i += 1;
      if (c === '{') {
        braces.push(false);
        regexOk = true;
      } else if (c === '}' && braces.pop()) templateText();
      else regexOk = c !== ')' && c !== ']';
    }
  }
  return found;
}

/** `text` with every match replaced by `replace` (awaited in order, so asset
 *  loads stay sequential and inside the budget). */
async function replaceAsync(
  text: string,
  matches: Iterable<RegExpExecArray | RegExpMatchArray>,
  replace: (match: RegExpExecArray) => Promise<string>
): Promise<string> {
  let out = '';
  let last = 0;
  for (const match of matches) {
    const at = match.index ?? 0;
    out += text.slice(last, at) + (await replace(match as RegExpExecArray));
    last = at + match[0].length;
  }
  return out + text.slice(last);
}

/** The URL and descriptor of each `srcset` candidate (HTML's parsing rules:
 *  a URL runs to whitespace; a trailing comma ends the candidate). */
export function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = [];
  let at = 0;
  while (at < value.length) {
    while (at < value.length && /[\s,]/.test(value[at])) at += 1;
    if (at >= value.length) break;
    let end = at;
    while (end < value.length && !/\s/.test(value[end])) end += 1;
    let url = value.slice(at, end);
    at = end;
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const comma = value.indexOf(',', at);
      descriptor = value.slice(at, comma < 0 ? value.length : comma).trim();
      at = comma < 0 ? value.length : comma + 1;
    }
    out.push({ url, descriptor });
  }
  return out;
}

const textDataUrl = (text: string, mime: string): string => dataUrl([new TextEncoder().encode(text)], mime);

type PageAsset = { parts: Uint8Array[]; mime: string; size: number; path: string };

/** Inlines one page (and the pages its frames show) under one shared budget. */
function createPageInliner(call: Call, projectPath: string, accessToken: string | null) {
  let budget = PAGE_TOTAL_MAX_BYTES;
  let assets = 0;
  const files = new Map<string, Promise<PageAsset | null>>();
  const loadPath = async (path: string): Promise<PageAsset | null> => {
    if (assets >= PAGE_MAX_ASSETS || budget <= 0) return null;
    assets += 1;
    try {
      const file = await readRemoteFile(call, [projectPath, path, accessToken], Math.min(PAGE_ASSET_MAX_BYTES, budget));
      budget -= file.size;
      return { ...file, path };
    } catch {
      // A missing, hidden or oversize asset leaves its reference untouched.
      return null;
    }
  };
  /** The asset `reference` names from the file at `from`; each path loads once. */
  const load = (from: string, reference: string): Promise<PageAsset | null> => {
    const path = resolvePageReference(from, reference);
    return path ? loadFile(path) : Promise.resolve(null);
  };
  const loadFile = (path: string): Promise<PageAsset | null> => {
    let pending = files.get(path);
    if (!pending) {
      pending = loadPath(path);
      files.set(path, pending);
    }
    return pending;
  };

  /** Stylesheet text with `@import`s inlined and `url()`s (fonts, images)
   *  turned into data URLs, each resolved against the sheet's own path. */
  const css = async (text: string, from: string, depth = 0): Promise<string> => {
    const imported = await replaceAsync(text, text.matchAll(CSS_IMPORT), async (match) => {
      const file = depth < CSS_MAX_IMPORT_DEPTH ? await load(from, match[2]) : null;
      if (!file) return match[0];
      const body = await css(textOfParts(file.parts), file.path, depth + 1);
      const media = match[3].trim();
      return media ? `@media ${media}{${body}}` : body;
    });
    return replaceAsync(imported, imported.matchAll(CSS_URL), async (match) => {
      const file = await load(from, match[2]);
      return file ? `url("${dataUrl(file.parts, file.mime)}")` : match[0];
    });
  };

  /** One page's modules. `text` is module source with its relative imports
   *  pointing at data: modules (which cannot resolve relative specifiers
   *  themselves); a cycle is left as is. A bare name the page's import map
   *  `imports` sends to a project file stays bare: `mapped` (after the
   *  page's scripts) makes that file the data: module the map names for it. */
  const moduleGraph = (pagePath: string, imports: Record<string, unknown>) => {
    const modules = new Map<string, Promise<string>>();
    const bare = new Map<string, string>();
    const url = (path: string, chain: readonly string[]): Promise<string> => {
      let pending = modules.get(path);
      if (!pending) {
        pending = loadFile(path).then(async (file) =>
          file ? textDataUrl(await text(textOfParts(file.parts), file.path, [...chain, path]), 'text/javascript') : ''
        );
        modules.set(path, pending);
      }
      return pending;
    };
    const text = (source: string, from: string, chain: readonly string[]): Promise<string> =>
      replaceAsync(source, moduleSpecifiers(source), async (match) => {
        const specifier = match[3];
        if (!RELATIVE_SPECIFIER.test(specifier)) {
          // Map addresses resolve against the page, like the browser does.
          const target = mappedSpecifier(imports, specifier);
          const path = RELATIVE_SPECIFIER.test(target) ? resolvePageReference(pagePath, target) : '';
          if (path && !bare.has(specifier)) bare.set(specifier, path);
          return match[0];
        }
        const path = resolvePageReference(from, specifier);
        if (!path || chain.includes(path)) return match[0];
        const resolved = await url(path, chain);
        return resolved ? `${match[1]}${match[2]}${resolved}${match[2]}` : match[0];
      });
    // One at a time (a module's own bare imports join the queue as it loads),
    // so no load ever waits on one that waits on it.
    const mapped = async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const [name, path] of bare) {
        const resolved = await url(path, []);
        if (resolved) out[name] = resolved;
      }
      return out;
    };
    return { text, mapped };
  };

  const page = async (html: string, pagePath: string, depth: number): Promise<string> => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const link of Array.from(doc.querySelectorAll('link[href]'))) {
      if (!/\bstylesheet\b/i.test(link.getAttribute('rel') || '')) continue;
      const file = await load(pagePath, link.getAttribute('href') || '');
      if (!file) continue;
      const style = doc.createElement('style');
      const media = link.getAttribute('media');
      if (media) style.setAttribute('media', media);
      style.textContent = await css(textOfParts(file.parts), file.path);
      link.replaceWith(style);
    }
    for (const style of Array.from(doc.querySelectorAll('style'))) {
      // Inlined sheets above are already rewritten (their urls are data:).
      if (/url\(|@import/i.test(style.textContent || ''))
        style.textContent = await css(style.textContent || '', pagePath);
    }
    for (const element of Array.from(doc.querySelectorAll('[style]'))) {
      const value = element.getAttribute('style') || '';
      if (/url\(/i.test(value)) element.setAttribute('style', await css(value, pagePath));
    }
    // The page's import map (the first one counts) sends bare names, e.g.
    // `three`, `three/addons/`, to the page's own module files.
    const mapScript = Array.from(doc.querySelectorAll('script:not([src])')).find(
      (script) => (script.getAttribute('type') || '').trim().toLowerCase() === 'importmap'
    );
    let importMap: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(mapScript?.textContent || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) importMap = parsed as Record<string, unknown>;
    } catch {
      // An invalid map is left for the browser to report.
    }
    const imports =
      importMap.imports && typeof importMap.imports === 'object' && !Array.isArray(importMap.imports)
        ? (importMap.imports as Record<string, unknown>)
        : {};
    const modules = moduleGraph(pagePath, imports);
    for (const script of Array.from(doc.querySelectorAll('script'))) {
      const module = (script.getAttribute('type') || '').trim().toLowerCase() === 'module';
      let text = script.textContent || '';
      let from = pagePath;
      if (script.hasAttribute('src')) {
        const file = await load(pagePath, script.getAttribute('src') || '');
        if (!file) continue;
        text = textOfParts(file.parts);
        from = file.path;
        if (!module && script.hasAttribute('defer')) {
          // Inline text ignores `defer` and would run before the document it
          // waits for: the file stays an external (data:) script, still deferred.
          script.setAttribute('src', textDataUrl(text, 'text/javascript'));
          continue;
        }
        script.removeAttribute('src');
      } else if (!module) {
        continue;
      }
      if (module) text = await modules.text(text, from, [from]);
      script.textContent = text.replace(/<\/(script)/gi, '<\\/$1');
    }
    const mapped = await modules.mapped();
    if (mapScript && Object.keys(mapped).length) {
      mapScript.textContent = JSON.stringify({ ...importMap, imports: { ...imports, ...mapped } }).replace(
        /<\/(script)/gi,
        '<\\/$1'
      );
    }
    for (const element of Array.from(
      doc.querySelectorAll('img[src], source[src], audio[src], video[src], track[src], input[type="image"][src]')
    )) {
      const file = await load(pagePath, element.getAttribute('src') || '');
      if (file) element.setAttribute('src', dataUrl(file.parts, file.mime));
    }
    for (const video of Array.from(doc.querySelectorAll('video[poster]'))) {
      const file = await load(pagePath, video.getAttribute('poster') || '');
      if (file) video.setAttribute('poster', dataUrl(file.parts, file.mime));
    }
    for (const element of Array.from(doc.querySelectorAll('img[srcset], source[srcset]'))) {
      const candidates = parseSrcset(element.getAttribute('srcset') || '');
      const rewritten: string[] = [];
      for (const candidate of candidates) {
        const file = await load(pagePath, candidate.url);
        const url = file ? dataUrl(file.parts, file.mime) : candidate.url;
        rewritten.push(candidate.descriptor ? `${url} ${candidate.descriptor}` : url);
      }
      element.setAttribute('srcset', rewritten.join(', '));
    }
    for (const frame of Array.from(doc.querySelectorAll('iframe[src]'))) {
      if (depth >= PAGE_MAX_FRAME_DEPTH) break;
      const file = await load(pagePath, frame.getAttribute('src') || '');
      if (!file || !/html/i.test(file.mime)) continue;
      // The nested page shares the frame's opaque origin and CSP.
      frame.setAttribute('srcdoc', await page(textOfParts(file.parts), file.path, depth + 1));
      frame.removeAttribute('src');
    }
    return `<!doctype html>${doc.documentElement.outerHTML}`;
  };
  return { page };
}

/** A self-contained HTML document for `relPath`: stylesheets (with their
 *  `@import`s, fonts and `url()` images), scripts (module imports included),
 *  media, `srcset`, posters and nested frame pages it references by relative
 *  path are inlined through the same RPC, so the sandboxed frame needs no
 *  network or origin access to the host. */
export async function buildPageSrcdoc(
  call: Call,
  projectPath: string,
  relPath: string,
  accessToken: string | null
): Promise<string> {
  const page = await readRemoteFile(call, [projectPath, relPath, accessToken], PAGE_MAX_BYTES);
  return createPageInliner(call, projectPath, accessToken).page(textOfParts(page.parts), relPath, 0);
}

/** A visualize pane's content for a paired client (main/remote-visualize.ts):
 *  the same bounded range reads and caps as file previews, addressed by tab
 *  and working-directory-relative path. Pages become a self-contained
 *  document with their relative assets inlined, plus a `fetch` the page
 *  bridge serves the page's own requests with; image, audio and video stream
 *  on the encrypted media lane when `laneUrl` yields one that answers;
 *  everything else (and media without the lane) becomes a blob: URL the
 *  caller revokes. */
export async function readRemoteVisualizePane(
  call: Call,
  sessionId: string,
  tabId: string,
  index: number,
  laneUrl?: (assetId: string, variant?: string) => string,
  /** This connection's built pages (none: every page is read). */
  pages?: RemotePageCache
): Promise<VisualizePaneSource> {
  // The host authorizes every load here (containment re-checked), cached or not.
  const meta = await call<VisualizeRemotePaneFile>('visualizePaneFile', [sessionId, tabId, index]);
  // The page builder and the whole-file reader speak the preview range call;
  // route it to the pane's own range method.
  const paneCall: Call = <T>(method: string, params: unknown[] = []) => {
    if (method !== 'previewProjectFileRange') return Promise.reject(new Error(`Unsupported pane call ${method}.`));
    // The pane index scopes `rel` to that pane's root (a kept version's
    // snapshot or the live files).
    return call<T>('visualizePaneRange', [sessionId, tabId, params[1], params[3], params[4], index]);
  };
  if (meta.kind === 'html') {
    // A revision bump with the same content (a reopen, a reload racing an
    // open, a reconnect) reuses the page this connection already built; only
    // the host's content identity keys it.
    const { contentId } = meta;
    const srcdoc =
      pages && contentId
        ? await pages.page([sessionId, tabId, index, meta.rel, contentId].join('\0'), () =>
            buildKeptPage(paneCall, meta.rel, contentId)
          )
        : await buildPageSrcdoc(paneCall, '', meta.rel, null);
    return {
      kind: 'html',
      srcdoc,
      page: meta.rel,
      ...(contentId ? { contentId } : {}),
      // The page's own fetch/XHR, over this load's call (never a cached
      // one): resolved against the page here, contained
      // and typed by the host exactly like an inlined asset.
      fetch: async (reference) => {
        const path = resolvePageReference(meta.rel, reference);
        if (!path) throw new Error('The page may only read its own project files.');
        const file = await readRemoteFile(paneCall, ['', path, null], PAGE_FETCH_MAX_BYTES);
        return { bytes: concat(file.parts), mime: file.mime };
      },
    };
  }
  const streamUrl =
    meta.mediaAssetId && (meta.kind === 'image' || meta.kind === 'audio' || meta.kind === 'video')
      ? laneUrl?.(meta.mediaAssetId, 'original')
      : '';
  if (streamUrl && (await mediaLaneAnswers(streamUrl))) return { kind: meta.kind, url: streamUrl };
  if (meta.size > REMOTE_PREVIEW_MAX_FILE_BYTES)
    throw new Error('This file is too large to preview over remote access.');
  const file = await readRemoteFile(paneCall, ['', meta.rel, null], REMOTE_PREVIEW_MAX_FILE_BYTES);
  return { kind: meta.kind, url: URL.createObjectURL(new Blob(file.parts as BlobPart[], { type: meta.mime })) };
}

const REMOTE_PAGE_CACHE_LIMIT = 6;

/** Built remote HTML pages of one authenticated connection, keyed by tab,
 *  pane and the host's content identity, in use order. `scope` names the
 *  pairing (server, device, keys): another one drops every page, and none
 *  keeps nothing. Only page text is kept; a page's fetch always goes over
 *  the load that asked for it. */
export function createRemotePageCache(scope: () => string | null) {
  let owner: string | null = null;
  const pages = new Map<string, Promise<string>>();
  return {
    clear(): void {
      pages.clear();
    },
    /** The page for `key`, built once per connection; `build` says whether
     *  its result may be kept. */
    page(key: string, build: () => Promise<{ srcdoc: string; keep: boolean }>): Promise<string> {
      const current = scope();
      if (current !== owner) {
        pages.clear();
        owner = current;
      }
      if (current === null) return build().then((page) => page.srcdoc);
      const kept = pages.get(key);
      if (kept) {
        pages.delete(key);
        pages.set(key, kept);
        return kept;
      }
      const built = build();
      const srcdoc = built.then((page) => page.srcdoc);
      pages.set(key, srcdoc);
      while (pages.size > REMOTE_PAGE_CACHE_LIMIT) pages.delete(pages.keys().next().value as string);
      const drop = () => {
        if (pages.get(key) === srcdoc) pages.delete(key);
      };
      void built.then((page) => {
        if (!page.keep) drop();
      }, drop);
      return srcdoc;
    },
  };
}
export type RemotePageCache = ReturnType<typeof createRemotePageCache>;

/** A page built for the cache: kept only when it inlined no other file (it
 *  is only as fresh as those) and was built from exactly the bytes the host
 *  hashed into `contentId`. */
async function buildKeptPage(
  paneCall: Call,
  rel: string,
  contentId: string
): Promise<{ srcdoc: string; keep: boolean }> {
  const parts: Uint8Array[] = [];
  let read = 0;
  let exact = true;
  const recording: Call = async <T>(method: string, params: unknown[] = []) => {
    const value = await paneCall<T>(method, params);
    if (params[1] !== rel || params[3] !== read) {
      exact = false;
    } else {
      const bytes = bytesFromBase64((value as RangeResult).data);
      parts.push(bytes);
      read += bytes.length;
    }
    return value;
  };
  const srcdoc = await buildPageSrcdoc(recording, '', rel, null);
  const subtle = globalThis.crypto?.subtle;
  if (!exact || !subtle) return { srcdoc, keep: false };
  const digest = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(concat(parts))));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { srcdoc, keep: hex === contentId.slice(contentId.lastIndexOf(':') + 1) };
}

/** An HTML pane's source for a paired client's source view: the start of the
 *  page file (at most MAX_VISUALIZE_SOURCE_BYTES) through the pane's own range
 *  method, so containment is checked by the host like any pane read. */
export async function readRemoteVisualizePaneText(
  call: Call,
  sessionId: string,
  tabId: string,
  index: number
): Promise<VisualizePaneText> {
  const meta = await call<VisualizeRemotePaneFile>('visualizePaneFile', [sessionId, tabId, index]);
  if (meta.kind !== 'html') throw new Error('Only HTML pages have a source view.');
  const range = await call<RangeResult>('visualizePaneRange', [
    sessionId,
    tabId,
    meta.rel,
    0,
    MAX_VISUALIZE_SOURCE_BYTES,
    index,
  ]);
  const bytes = bytesFromBase64(range.data);
  return { text: new TextDecoder().decode(bytes), truncated: range.size > bytes.length };
}

/** True when the encrypted media lane really answers for `url`. A relay or
 *  host that cannot (version skew) must leave the preview on the RPC path. */
async function mediaLaneAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
    void response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/** The remote implementations of the preview calls on DesktopApi.
 *  `laneUrl` yields an encrypted-media-lane URL for a host asset id, or ''
 *  when the lane is unavailable. */
export function createRemotePreviewApi(
  call: Call,
  laneUrl?: (assetId: string, variant?: string) => string
): Pick<DesktopApi, 'previewProjectFile' | 'localPageSource' | 'captureFileSnapshot'> {
  // key -> blob URL promise; revoked when evicted so a long session stays bounded.
  const blobs = new Map<string, Promise<string>>();
  return {
    captureFileSnapshot: (projectPath, relPath, accessToken) =>
      call('captureFileSnapshot', [projectPath, relPath, accessToken ?? null]),
    previewProjectFile: async (projectPath, relPath, accessToken) => {
      const target: [string, string, string | null] = [projectPath, relPath, accessToken ?? null];
      const meta = await call<{
        kind: 'image' | 'pdf' | 'audio' | 'video';
        mime: string;
        mtimeMs: number;
        size: number;
        /** Present when the host can serve this file on the media lane. */
        mediaAssetId?: string;
      }>('previewProjectFile', target);
      // Streamed and seekable: no whole-file download, so no size ceiling.
      const streamUrl = meta.mediaAssetId && meta.kind !== 'pdf' ? laneUrl?.(meta.mediaAssetId, 'original') : '';
      if (streamUrl && (await mediaLaneAnswers(streamUrl))) {
        return { url: streamUrl, kind: meta.kind, mime: meta.mime, mtimeMs: meta.mtimeMs, size: meta.size };
      }
      if (meta.size > REMOTE_PREVIEW_MAX_FILE_BYTES) {
        throw new Error('This file is too large to preview over remote access.');
      }
      const key = `${target.join('\0')}\0${meta.mtimeMs}:${meta.size}`;
      let url = blobs.get(key);
      if (url) {
        blobs.delete(key);
      } else {
        url = readRemoteFile(call, target, REMOTE_PREVIEW_MAX_FILE_BYTES).then(({ parts }) =>
          URL.createObjectURL(new Blob(parts as BlobPart[], { type: meta.mime }))
        );
        url.catch(() => blobs.delete(key));
      }
      blobs.set(key, url);
      while (blobs.size > BLOB_CACHE_LIMIT) {
        const oldest = blobs.keys().next().value as string;
        const dropped = blobs.get(oldest);
        blobs.delete(oldest);
        void dropped?.then(
          (value) => URL.revokeObjectURL(value),
          () => {}
        );
      }
      return { url: await url, kind: meta.kind, mime: meta.mime, mtimeMs: meta.mtimeMs, size: meta.size };
    },
    localPageSource: (projectPath, relPath, accessToken) =>
      buildPageSrcdoc(call, projectPath, relPath, accessToken ?? null),
  };
}
