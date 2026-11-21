import { REMOTE_PAGE_MAX_BYTES } from '../shared/visualize';
import { concat, readRemoteFile, type Call } from './remote-file-range';
import { mappedSpecifier, moduleSpecifiers, RELATIVE_SPECIFIER } from './remote-page-module-specifiers';

const PAGE_ASSET_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const PAGE_MAX_ASSETS = 64;
/** Nested `<iframe src>` pages inlined below the top page. */
const PAGE_MAX_FRAME_DEPTH = 2;
/** `@import` chains followed inside stylesheets. */
const CSS_MAX_IMPORT_DEPTH = 4;

const EXTERNAL_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi;
const CSS_URL = /url\(\s*(["']?)([^"')]+?)\1\s*\)/gi;

type PageAsset = { parts: Uint8Array[]; mime: string; size: number; path: string };
type LoadAsset = (from: string, reference: string) => Promise<PageAsset | null>;
type InlineCss = (text: string, from: string, depth?: number) => Promise<string>;
interface PageContext {
  load: LoadAsset;
  loadFile: (path: string) => Promise<PageAsset | null>;
  css: InlineCss;
}

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

const assetUrl = (file: PageAsset): string => dataUrl(file.parts, file.mime);
const textDataUrl = (text: string, mime: string): string => dataUrl([new TextEncoder().encode(text)], mime);

const textOfParts = (parts: Uint8Array[]): string => new TextDecoder().decode(concat(parts));

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
function parseSrcset(value: string): { url: string; descriptor: string }[] {
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

const inertScriptText = (text: string): string => text.replace(/<\/(script)/gi, '<\\/$1');

/** Loads project files for one page under one shared asset count and byte
 *  budget; each path is fetched once. */
function createAssetLoader(call: Call, projectPath: string, accessToken: string | null) {
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
      return null;
    }
  };
  const loadFile = (path: string): Promise<PageAsset | null> => {
    let pending = files.get(path);
    if (!pending) {
      pending = loadPath(path);
      files.set(path, pending);
    }
    return pending;
  };
  const load: LoadAsset = (from, reference) => {
    const path = resolvePageReference(from, reference);
    return path ? loadFile(path) : Promise.resolve(null);
  };
  return { load, loadFile };
}

/** Stylesheet text with `@import`s inlined and `url()`s (fonts, images)
 *  turned into data URLs, each resolved against the sheet's own path. */
function createCssInliner(load: LoadAsset): InlineCss {
  const css: InlineCss = async (text, from, depth = 0) => {
    const imported = await replaceAsync(text, text.matchAll(CSS_IMPORT), async (match) => {
      const file = depth < CSS_MAX_IMPORT_DEPTH ? await load(from, match[2]) : null;
      if (!file) return match[0];
      const body = await css(textOfParts(file.parts), file.path, depth + 1);
      const media = match[3].trim();
      return media ? `@media ${media}{${body}}` : body;
    });
    return replaceAsync(imported, imported.matchAll(CSS_URL), async (match) => {
      const file = await load(from, match[2]);
      return file ? `url("${assetUrl(file)}")` : match[0];
    });
  };
  return css;
}

/** `text` rewrites a module's relative imports to data: modules, which cannot
 *  resolve relative specifiers themselves. */
function createModuleGraph(loadFile: PageContext['loadFile'], pagePath: string, imports: Record<string, unknown>) {
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
  const mapped = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const [name, path] of bare) {
      const resolved = await url(path, []);
      if (resolved) out[name] = resolved;
    }
    return out;
  };
  return { text, mapped };
}

async function inlineStyles(doc: Document, pagePath: string, { load, css }: PageContext): Promise<void> {
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
    if (/url\(|@import/i.test(style.textContent || ''))
      style.textContent = await css(style.textContent || '', pagePath);
  }
  for (const element of Array.from(doc.querySelectorAll('[style]'))) {
    const value = element.getAttribute('style') || '';
    if (/url\(/i.test(value)) element.setAttribute('style', await css(value, pagePath));
  }
}

const isScriptType = (script: Element, type: string): boolean =>
  (script.getAttribute('type') || '').trim().toLowerCase() === type;

/** The page's import map (the first one counts) and its `imports` table. */
function readImportMap(doc: Document) {
  const script = Array.from(doc.querySelectorAll('script:not([src])')).find((candidate) =>
    isScriptType(candidate, 'importmap')
  );
  let map: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(script?.textContent || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, unknown>;
  } catch {
    map = {};
  }
  const imports =
    map.imports && typeof map.imports === 'object' && !Array.isArray(map.imports)
      ? (map.imports as Record<string, unknown>)
      : {};
  return { script, map, imports };
}

async function inlineScripts(doc: Document, pagePath: string, { load, loadFile }: PageContext): Promise<void> {
  const importMap = readImportMap(doc);
  const modules = createModuleGraph(loadFile, pagePath, importMap.imports);
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    const module = isScriptType(script, 'module');
    let text = script.textContent || '';
    let from = pagePath;
    if (script.hasAttribute('src')) {
      const file = await load(pagePath, script.getAttribute('src') || '');
      if (!file) continue;
      text = textOfParts(file.parts);
      from = file.path;
      if (!module && script.hasAttribute('defer')) {
        // Inline text ignores `defer` and would run before the document it waits for.
        script.setAttribute('src', textDataUrl(text, 'text/javascript'));
        continue;
      }
      script.removeAttribute('src');
    } else if (!module) {
      continue;
    }
    if (module) text = await modules.text(text, from, [from]);
    script.textContent = inertScriptText(text);
  }
  const mapped = await modules.mapped();
  if (importMap.script && Object.keys(mapped).length) {
    importMap.script.textContent = inertScriptText(
      JSON.stringify({ ...importMap.map, imports: { ...importMap.imports, ...mapped } })
    );
  }
}

async function inlineMedia(doc: Document, pagePath: string, load: LoadAsset): Promise<void> {
  for (const element of Array.from(
    doc.querySelectorAll('img[src], source[src], audio[src], video[src], track[src], input[type="image"][src]')
  )) {
    const file = await load(pagePath, element.getAttribute('src') || '');
    if (file) element.setAttribute('src', assetUrl(file));
  }
  for (const video of Array.from(doc.querySelectorAll('video[poster]'))) {
    const file = await load(pagePath, video.getAttribute('poster') || '');
    if (file) video.setAttribute('poster', assetUrl(file));
  }
  for (const element of Array.from(doc.querySelectorAll('img[srcset], source[srcset]'))) {
    const rewritten: string[] = [];
    for (const candidate of parseSrcset(element.getAttribute('srcset') || '')) {
      const file = await load(pagePath, candidate.url);
      const url = file ? assetUrl(file) : candidate.url;
      rewritten.push(candidate.descriptor ? `${url} ${candidate.descriptor}` : url);
    }
    element.setAttribute('srcset', rewritten.join(', '));
  }
}

async function inlineFrames(
  doc: Document,
  pagePath: string,
  load: LoadAsset,
  depth: number,
  page: (html: string, pagePath: string, depth: number) => Promise<string>
): Promise<void> {
  if (depth >= PAGE_MAX_FRAME_DEPTH) return;
  for (const frame of Array.from(doc.querySelectorAll('iframe[src]'))) {
    const file = await load(pagePath, frame.getAttribute('src') || '');
    if (!file || !/html/i.test(file.mime)) continue;
    frame.setAttribute('srcdoc', await page(textOfParts(file.parts), file.path, depth + 1));
    frame.removeAttribute('src');
  }
}

/** Inlines one page (and the pages its frames show) under one shared budget. */
function createPageInliner(call: Call, projectPath: string, accessToken: string | null) {
  const { load, loadFile } = createAssetLoader(call, projectPath, accessToken);
  const context: PageContext = { load, loadFile, css: createCssInliner(load) };
  const page = async (html: string, pagePath: string, depth: number): Promise<string> => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    await inlineStyles(doc, pagePath, context);
    await inlineScripts(doc, pagePath, context);
    await inlineMedia(doc, pagePath, load);
    await inlineFrames(doc, pagePath, load, depth, page);
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
  const page = await readRemoteFile(call, [projectPath, relPath, accessToken], REMOTE_PAGE_MAX_BYTES);
  return createPageInliner(call, projectPath, accessToken).page(textOfParts(page.parts), relPath, 0);
}
