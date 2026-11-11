// The files of a sensitive-writes run (record-sensitive-writes.mjs, replay-sensitive-writes.mjs): the search of every file for
// the scenario's sensitive values in each encoding a writer uses, and the normalisation of run-specific ids and times.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

export function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/**
 * The byte patterns that spell `value` in a file: UTF-8 as typed; JSON-escaped (`JSON.stringify`, and with every
 * non-alphanumeric character as `\uXXXX`, as an HTML-safe writer escapes it); UTF-16LE and UTF-16BE (a SQLite text in a
 * UTF-16 database, a Windows wide string); base64 and base64url at each of the three byte alignments the value can have
 * inside a longer encoded text (the characters that depend on the neighbouring bytes are left out).
 */
export function spellings(value) {
  const bytes = Buffer.from(value, 'utf8');
  const le = Buffer.from(value, 'utf16le');
  const out = [
    { encoding: 'utf8', bytes },
    { encoding: 'json', bytes: Buffer.from(JSON.stringify(value).slice(1, -1), 'utf8') },
    { encoding: 'json-unicode', bytes: Buffer.from([...value].map((c) => (/[A-Za-z0-9]/.test(c) ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)).join(''), 'utf8') },
    { encoding: 'utf16le', bytes: le },
    { encoding: 'utf16be', bytes: Buffer.from(le).swap16() },
  ];
  for (let lead = 0; lead < 3; lead += 1) {
    const encoded = Buffer.concat([Buffer.alloc(lead), bytes]).toString('base64').replace(/=+$/, '');
    const from = lead ? 4 : 0;
    const total = lead + bytes.length;
    const to = total % 3 ? Math.floor(total / 3) * 4 : encoded.length;
    const stable = encoded.slice(from, to);
    if (stable.length >= 4) {
      out.push({ encoding: `base64+${lead}`, bytes: Buffer.from(stable, 'latin1') });
      out.push({ encoding: `base64url+${lead}`, bytes: Buffer.from(stable.replaceAll('+', '-').replaceAll('/', '_'), 'latin1') });
    }
  }
  const seen = new Set();
  return out.filter((s) => (seen.has(s.bytes.toString('latin1')) ? false : seen.add(s.bytes.toString('latin1'))));
}

/** Every place one of `files` (by default every file under `root`) holds one of `values`: `{ file, offset, encoding, value }`,
 *  in file order, `file` relative to `root`. */
export function scanSecrets(root, values, files = walk(root)) {
  const hits = [];
  for (const file of files) {
    const data = readFileSync(file);
    for (const value of values) {
      for (const { encoding, bytes } of spellings(value)) {
        for (let at = data.indexOf(bytes); at >= 0; at = data.indexOf(bytes, at + 1)) hits.push({ file: relative(root, file).split(sep).join('/'), offset: at, encoding, value });
      }
    }
  }
  return hits;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const EPOCH_MS = /(?<![\d.])1[6-9]\d{11}(?:\.\d+)?(?![\d])/g;
// Random ids that are not uuids: a session log's `logId` (12 random bytes as hex) and a session's scratch folder `s.<16 hex>`.
const LOG_ID = /(\\*"logId\\*":\\*")([0-9a-f]{24})/g;
const SCRATCH = /\bs\.[0-9a-f]{16}\b|\bmsg_[0-9a-f]{32}\b/g;
// Measured values (a duration on this machine's clock: a key ending in `Ms` or `_ms`, or `duration`; a process id: ending in
// `Pid`; a file's size, `storageSize`, which follows when the saves ran): `<measured>`, in plain and escaped JSON. Epoch times
// are `<ms>` before this runs.
// The trace's `totalBytes` and `messagesBytes` are sizes of the messages, which hold a measured `elapsedMs`.
// The compaction record's token estimates (`last*Tokens`, `currentEstimatedTokens`, a check's `pressure` and `est`) count a
// recovery reminder that names the session's archive path, whose session id holds the process id (its length varies).
const MEASURED_KEY = /(?:Ms|_ms|Pid|_bytes)$|^(?:duration|storageSize|requestOutputTokens|totalBytes|messagesBytes|last\w*Tokens|currentEstimatedTokens|pressure|est)$/;
// A hash over a provider projection that holds measured values (a message's `elapsedMs`): `<measured>`.
const MEASURED_HASH_KEY = /^contextPressureBaseline\w*Signature$/;
const MEASURED = /(\\*"([A-Za-z_]*)\\*":)\d+(?:\.\d+)?/g;
/** Files the bundled PostgreSQL writes itself (its cluster and its log): named only, never compared, always searched. */
const POSTGRES = /^mixdog_data_dir\/(?:pgdata\/|pg\.log$)/;
/** The session summary index: a base and a delta log whose split depends on when the debounced flushes ran; compared as
 *  the index a reader folds from them (`summaryIndex`), each file named only. */
const SUMMARY = /^mixdog_data_dir\/session-summaries\.(?:json|log)$/;
/** A session's log: its record split depends on when the debounced saves and the redaction rewrite ran; compared as the
 *  session a reader loads from it (`sessionLog`), the file named only. */
const SESSION_LOG = /^mixdog_data_dir\/sessions\/[^/]+\.log\.jsonl$/;
/** Files that are not data: the PostgreSQL runtime Node downloads and the patch tool it unpacks (named only). */
const ARTIFACT = /^[0-9a-f]{64}\.txt$/;
const PROGRAMS = /^mixdog_data_dir\/(?:runtime\/|patch-bin\/)/;

const isText = (data) => !data.includes(0) && Buffer.from(data.toString('utf8'), 'utf8').equals(data);

/**
 * The files under `profile`, normalised: names and texts with the session id as `<session>`, the workspace as `<ws>`, the
 * profile as `<profile>` (each in its plain, forward-slash and JSON-escaped spelling), every uuid as `<id:N>` by first
 * appearance (file order, names before contents), every ISO time as `<iso>` and every epoch time in ms as `<ms>`. A binary file
 * is `{ binary: bytes }`. `mask(text)` applies the same substitutions (the same id numbering) to other text of the run.
 * `aliases`: further [setup name, recorded name] pairs read first (a provider the two runs configure under different ids, a data
 * folder they lay out differently), the recorded name in the same spelling as the setup name.
 */
export function normalizeTree(profile, { sessionId, workspace, aliases = [] }) {
  const ids = new Map();
  const paths = [
    ...aliases,
    [workspace, '<ws>'],
    [profile, '<profile>'],
  ].flatMap(([path, name]) => [
    [JSON.stringify(path).slice(1, -1), JSON.stringify(name).slice(1, -1)],
    [path, name],
    [path.split(sep).join('/'), name.split(sep).join('/')],
  ]);
  const idOf = (id) => {
    const key = id.toLowerCase();
    if (!ids.has(key)) ids.set(key, `<id:${ids.size}>`);
    return ids.get(key);
  };
  // A tool-results file is named by the sha256 of its raw text, which holds times: it is named instead by a hash of its text
  // without the run's names (session, paths, ids), other such hashes and digits, `<sha:…>`, in names and in the texts that refer
  // to it.
  const artifacts = [];
  for (const file of walk(profile)) {
    const name = basename(file);
    if (!ARTIFACT.test(name) || !relative(profile, file).split(sep).includes('tool-results')) continue;
    let stable = readFileSync(file, 'utf8').split(sessionId).join('');
    for (const [path, named] of paths) stable = stable.split(path).join(named);
    stable = stable.replace(UUID, '').replace(SCRATCH, '').replace(/[0-9a-f]{64}/g, '').replace(/\d+/g, '');
    artifacts.push([name.slice(0, 64), `<sha:${createHash('sha256').update(stable).digest('hex').slice(0, 16)}>`]);
  }
  const mask = (text) => {
    let out = text.split(sessionId).join('<session>');
    for (const [path, name] of paths) out = out.split(path).join(name);
    for (const [hash, name] of artifacts) out = out.split(hash).join(name);
    out = out.replace(UUID, idOf).replace(LOG_ID, (_, key, id) => `${key}${idOf(id)}`).replace(SCRATCH, idOf);
    return out.replace(ISO, '<iso>').replace(EPOCH_MS, '<ms>').replace(MEASURED, (whole, prefix, key) => (MEASURED_KEY.test(key) ? `${prefix}<measured>` : whole));
  };
  const files = {};
  const all = walk(profile);
  const names = all.map((file) => mask(relative(profile, file).split(sep).join('/')));
  for (const [i, file] of all.entries()) {
    if (POSTGRES.test(names[i])) files[names[i]] = { postgres: true };
    else if (PROGRAMS.test(names[i])) files[names[i]] = { program: true };
    else if (SUMMARY.test(names[i])) files[names[i]] = { summaryIndex: true };
    else if (SESSION_LOG.test(names[i])) files[names[i]] = { sessionLog: true };
    else {
      const data = readFileSync(file);
      files[names[i]] = isText(data) ? mask(data.toString('utf8')) : { binary: data.length };
    }
  }
  // A JSON value masked node by node, so it stays JSON: strings through `mask`, an epoch number as "<ms>", a measured key's
  // number as "<measured>".
  const maskValue = (value, key = '') => {
    if (typeof value === 'string') return MEASURED_HASH_KEY.test(key) ? '<measured>' : mask(value);
    if (typeof value === 'number') {
      if (MEASURED_KEY.test(key) && !/^1[6-9]\d{11}/.test(String(value))) return '<measured>';
      return /^1[6-9]\d{11}(?:\.\d+)?$/.test(String(value)) ? '<ms>' : value;
    }
    if (Array.isArray(value)) return value.map((item) => maskValue(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskValue(v, k)]));
    return value;
  };
  return {
    files,
    mask,
    maskValue,
    names: { session: '<session>', workspace: '<ws>', profile: '<profile>', ids: '<id:N> (uuids, session log ids, scratch folders, message ids msg_<32 hex>)', iso: '<iso>', epochMs: '<ms>', artifacts: '<sha:N> (a tool-results file name, the sha256 of a text holding times: a hash of the text without digits and 64-hex names)', measured: 'the number of a key ending in Ms, _ms, Pid or _bytes, or named duration, storageSize or requestOutputTokens (the count of the usage readout, which follows when the saves ran), totalBytes or messagesBytes (the trace\'s sizes of messages holding a measured elapsedMs), the compaction record\'s token estimates (last*Tokens, currentEstimatedTokens, pressure, est: over a reminder naming the session id, whose process id varies in length),and a loaded session\'s contextPressureBaseline*Signature hashes (over text holding measured values), as <measured>', postgres: 'pgdata/ and pg.log: named only', programs: 'runtime/ and patch-bin/: named only', summaryIndex: 'session-summaries.json and .log: named only, compared folded', sessionLog: 'sessions/<id>.log.jsonl: named only, compared as the loaded session' },
  };
}
