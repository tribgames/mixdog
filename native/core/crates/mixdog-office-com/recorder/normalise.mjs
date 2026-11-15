// What a recording keeps of a file or of a host answer, with everything that differs between two runs of the same
// scenario taken out (record-office-com.mjs compares the hooked run with the unhooked one through these, and the Rust
// harness compares a replay with the fixture through the same rules).
//
//   normaliseFile(path, { tree })   an OOXML file as its parts, a PDF as page count and extracted text, anything else as
//                                   its sha256 and size
//   normaliseOoxml(buffer)          the OOXML part
//   normaliseResponse(value, ctx)   a host answer (parsed JSON) with process ids, window handles, foreground handles,
//                                   timings, the scratch directory, GUIDs and dates replaced by markers
//
// No package is needed except for a PDF, whose text is extracted by the repository's own extractor (the `tree`
// argument is the reference checkout, C:/Project/mixdog, whose node_modules hold it).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** The entries of a ZIP (stored or deflated, no ZIP64) as a Map from name to bytes, in the archive's order. */
export function readZip(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a ZIP archive: no end-of-central-directory record');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('ZIP central directory is damaged');
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`ZIP entry ${name} has no local header`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    if (method === 0) entries.set(name, Buffer.from(data));
    else if (method === 8) entries.set(name, inflateRawSync(data));
    else throw new Error(`ZIP entry ${name} uses compression method ${method}`);
  }
  return entries;
}

const TEXT_PART = /\.(xml|rels|vml|txt|json|csv|htm|html)$/i;
const GUID = /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/g;

/** A text part with the run-to-run noise out: timestamps, editing-session ids, random ids, GUIDs, calcChain ids. */
export function normaliseXml(name, text) {
  let out = text.replace(GUID, (match) => (match.startsWith('{') ? '{<guid>}' : '<guid>'));
  // docProps: the times the application stamped, and the minutes it counted.
  out = out.replace(/(<dcterms:(?:created|modified)\b[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g, '$1<time>$2');
  out = out.replace(/<TotalTime>\d+<\/TotalTime>/g, '<TotalTime>0</TotalTime>');
  // Word: revision-session ids on every paragraph and run, the rsid list of settings.xml, the random paragraph ids.
  out = out.replace(/\bw:rsid(\w*)="[0-9A-Fa-f]{8}"/g, 'w:rsid$1="<rsid>"');
  out = out.replace(/(<w:rsid\b[^>]*\bw:val=")[0-9A-Fa-f]{8}(")/g, '$1<rsid>$2');
  out = out.replace(/\b(w14:(?:paraId|textId))="[0-9A-Fa-f]{8}"/g, '$1="<id>"');
  // Excel: the calculation chain names sheets by internal ids that differ between runs.
  if (/calcChain\.xml$/i.test(name)) out = out.replace(/\bi="\d+"/g, 'i="<i>"');
  return out;
}

/** An OOXML package as `{ kind: 'ooxml', parts }`: text parts as normalised text, the others as sha256 and size. */
export function normaliseOoxml(buffer) {
  const parts = {};
  for (const [name, data] of [...readZip(buffer)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    parts[name] = TEXT_PART.test(name) ? normaliseXml(name, data.toString('utf8')) : { sha256: sha256(data), bytes: data.length };
  }
  return { kind: 'ooxml', parts };
}

/** A PDF as its page count and its text, per page (`tree` is the checkout whose extractor and node_modules are used). */
export async function normalisePdf(buffer, tree) {
  const extractor = await import(pathToFileURL(`${tree}/src/runtime/attachments/pdf-extract.mjs`).href);
  const result = await extractor.inspectPdfBuffer(buffer, { extractText: true, maxPages: 10_000, maxOutputBytes: 64 * 1024 * 1024 });
  const text = String(result.text ?? '').replace(/\r\n/g, '\n');
  return { kind: 'pdf', pages: result.pageCount, text };
}

/** A file as what a recording keeps of it. */
export async function normaliseFile(path, { tree = 'C:/Project/mixdog' } = {}) {
  const buffer = readFileSync(path);
  const extension = extname(path).toLowerCase();
  if (['.docx', '.xlsx', '.pptx', '.docm', '.xlsm', '.pptm', '.dotx', '.xltx', '.potx'].includes(extension)) return normaliseOoxml(buffer);
  if (extension === '.pdf') return normalisePdf(buffer, tree);
  return { kind: 'binary', sha256: sha256(buffer), bytes: buffer.length };
}

const PID_KEY = /(^|[a-z])(pid|processid)$/i;
const HANDLE_KEY = /(hwnd|^foreground|handle)/i;
const TIMING_KEY = /(^|[a-z])(ms|elapsed|duration|ticks)$|^elapsed|^duration/i;
const DATE_TEXT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;
const HEX_GUID = /\b[0-9a-f]{32}\b/g;

function pathPatterns(work) {
  if (!work) return [];
  const backward = work.replace(/\//g, '\\');
  const forward = work.replace(/\\/g, '/');
  return [...new Set([backward, forward])].map((text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
}

/**
 * A host answer with what differs between runs replaced: numbers under process-id, window-handle, foreground and timing
 * keys by `<n>`, the scratch directory (`ctx.work`) by `${work}`, GUIDs and dates by markers, `rcw:<n>` and `hwnd:<n>`
 * object keys by `<key>`. Key order is kept.
 */
export function normaliseResponse(value, ctx = {}) {
  const patterns = pathPatterns(ctx.work);
  const text = (input) => {
    let out = input;
    for (const pattern of patterns) out = out.replace(pattern, () => '${work}');
    out = out.replace(/\b(rcw|hwnd):\d+/g, '$1:<n>').replace(DATE_TEXT, '<date>').replace(HEX_GUID, '<guid>');
    return out.replace(GUID, '<guid>');
  };
  const walk = (node, key) => {
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([name, item]) => [text(name), walk(item, name)]));
    if (typeof node === 'string') return text(node);
    if (typeof node === 'number' && key !== undefined && (PID_KEY.test(key) || HANDLE_KEY.test(key) || TIMING_KEY.test(key))) return '<n>';
    return node;
  };
  return walk(value, undefined);
}
