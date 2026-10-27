/**
 * Attachments and artifacts handed between bots and agents — one mechanism
 * for every direction: a bot or agent forwarding files to another session
 * (`session` send/create, the `agent` tool, group-room speech) and a target
 * turn's produced files coming back with its report (task-session reports,
 * agent completions, room speech).
 *
 * Forward: `resolveHandoffAttachments` turns `attachments` references — an
 * attachment id this conversation already shows (a user's upload, a report's
 * artifact) or a file path inside the caller's own folders — into the stored
 * reference parts a desktop prompt carries (attachments/store.mjs), so the
 * target turn receives real images and files under the composer's limits.
 *
 * Return: `collectTurnArtifacts` gathers the files a finished turn produced
 * (its edits and patches, media/office/visualize outputs, and every file its
 * final reply names), keeps those inside the target's folders, stores the
 * attachable ones and lists the rest as paths.
 *
 * Every path is resolved through its links and must lie inside an allowed
 * root; credential/secret files (runtime/shared/sensitive-path-rules.mjs) are
 * never attached.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { readAttachmentBuffer, storeAttachmentBuffer } from '../runtime/attachments/store.mjs';
import { SUPPORTED_IMAGE_MIME_TYPES, isPdfBuffer } from '../runtime/attachments/limits.mjs';
import { ROOM_ROW_SOURCE } from '../runtime/agent/orchestrator/session/agent-room.mjs';
import { isSensitiveLocalPath } from '../runtime/shared/sensitive-path-rules.mjs';
import { normalizeMessageAttachments } from '../runtime/shared/transcript-metadata.mjs';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';

/** The desktop composer's limits (apps/desktop/src/shared/prompt-limits.ts,
 *  renderer/composer-support.tsx), in bytes. */
export const HANDOFF_LIMITS = Object.freeze({
  count: 8,
  imageBytes: 12_000_000,
  imageTotal: 22_500_000,
  documentBytes: 20 * 1024 * 1024,
  documentTotal: 21_000_000,
  textBytes: 750_000,
  textTotal: 850_000,
});

const ATTACHMENT_ID = /^[a-f0-9]{64}$/;
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const DOCUMENT_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};
const TEXT_TYPES = {
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
const TEXT_EXTENSIONS = new Set([
  ...Object.keys(TEXT_TYPES),
  ...'.mdx .txt .log .jsonl .yaml .yml .toml .xml .tsv .js .jsx .mjs .cjs .ts .tsx .mts .cts .py .rb .rs .go .java .kt .swift .cs .cpp .cc .c .h .hh .hpp .sh .zsh .ps1 .bat .cmd .sql .css .scss .sass .vue .svelte .ini .conf .cfg .gql .graphql'.split(
    ' '
  ),
]);

const samePlatformPath = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);

function realOrNull(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** The folders a session may hand files from and report artifacts in: its
 *  working directory and Project (worktree) roots, through their links. A
 *  filesystem root never counts. */
export function sessionRoots(session, cwd = '') {
  const candidates = [
    cwd,
    session?.cwd,
    session?.workspace?.projectPath,
    session?.workspace?.worktreePath,
    session?.desktopSession?.projectPath,
  ];
  const roots = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const real = realOrNull(resolve(candidate));
    if (!real || dirname(real) === real) continue;
    if (!roots.some((root) => samePlatformPath(root) === samePlatformPath(real))) roots.push(real);
  }
  return roots;
}

function within(root, path) {
  const base = samePlatformPath(root);
  const target = samePlatformPath(path);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/** `{ kind: 'image' | 'file' | 'text', mimeType }` of a file name and its first
 *  bytes; null when it is none of the types a prompt can carry. */
function classify(name, head) {
  const ext = extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return { kind: 'image', mimeType: IMAGE_TYPES[ext] };
  if (DOCUMENT_TYPES[ext] || isPdfBuffer(head)) {
    return { kind: 'file', mimeType: isPdfBuffer(head) ? 'application/pdf' : DOCUMENT_TYPES[ext] };
  }
  if (TEXT_EXTENSIONS.has(ext) || (!ext && head.length && !head.includes(0))) {
    return { kind: 'text', mimeType: TEXT_TYPES[ext] || 'text/plain' };
  }
  return null;
}

/** The limit `kind` keeps per file and in total. */
function limitsOf(kind) {
  if (kind === 'image') return { each: HANDOFF_LIMITS.imageBytes, total: HANDOFF_LIMITS.imageTotal, key: 'image' };
  if (kind === 'text') return { each: HANDOFF_LIMITS.textBytes, total: HANDOFF_LIMITS.textTotal, key: 'text' };
  return { each: HANDOFF_LIMITS.documentBytes, total: HANDOFF_LIMITS.documentTotal, key: 'file' };
}

/** A stored reference part of one attachment, as a desktop prompt carries it. */
function referencePart({ kind, attachmentRef, mimeType, name, size }) {
  const common = { attachmentRef, sizeBytes: size, mimeType, filename: name };
  if (kind === 'image') return { type: 'image', ...common };
  if (kind === 'text') return { type: 'text', textKind: 'file', ...common };
  return { type: 'file', ...common };
}

/** Only the reference fields of `parts` (never inline bytes or paths): the
 *  form a forwarded prompt may carry, whoever built the parts. */
export function sanitizeHandoffParts(parts) {
  const out = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (out.length >= HANDOFF_LIMITS.count) break;
    if (!part || !['image', 'file', 'text'].includes(part.type)) continue;
    if (!ATTACHMENT_ID.test(String(part.attachmentRef ?? ''))) continue;
    out.push(
      referencePart({
        kind: part.type,
        attachmentRef: part.attachmentRef,
        mimeType: String(part.mimeType || (part.type === 'image' ? 'image/png' : 'application/octet-stream')).slice(
          0,
          100
        ),
        name: String(part.filename || 'attachment').slice(0, 200),
        size: Number.isFinite(part.sizeBytes) && part.sizeBytes >= 0 ? part.sizeBytes : 0,
      })
    );
  }
  return out;
}

/** The prompt a forwarded turn submits: plain text, or text plus the
 *  attachment parts. */
export function handoffContent(text, parts) {
  const clean = sanitizeHandoffParts(parts);
  const body = String(text ?? '');
  return clean.length ? [{ type: 'text', text: body }, ...clean] : body;
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
        .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
        .join('\n');

/** The attachments a conversation already shows, by id, newest last: only
 *  what the runtime itself recorded in structured fields — a user message's
 *  stored reference parts and attachment records (intake, a forwarded
 *  turn's authorized parts, a task report's returned files) and a room
 *  speech row's stored files. Text never names one: a model can print any
 *  id. Only these may be forwarded by id or name. */
export function conversationAttachments(messages) {
  const found = new Map();
  const add = (id, info) => {
    if (!ATTACHMENT_ID.test(String(id || ''))) return;
    const kind = ['image', 'file', 'text'].includes(info.kind) ? info.kind : 'file';
    // A later occurrence moves the id to the end: iteration order is recency.
    found.delete(id);
    found.set(id, {
      id,
      kind,
      name: String(info.name || 'attachment').slice(0, 200),
      mimeType: String(info.mimeType || (kind === 'image' ? 'image/png' : 'application/octet-stream')).slice(0, 100),
    });
  };
  const partInfo = (part) => ({
    kind: part.type === 'image' ? 'image' : part.type === 'text' ? 'text' : 'file',
    name: part.filename || part.name,
    mimeType: part.mimeType || part.mediaType,
  });
  for (const message of Array.isArray(messages) ? messages : []) {
    const user = message?.role === 'user';
    const speech = message?.meta?.source === ROOM_ROW_SOURCE && message.meta.room?.kind === 'speech';
    // Assistant and tool messages hold what a model or tool wrote: never trusted.
    if (!user && !speech) continue;
    const parts = [
      ...(user && Array.isArray(message.content) ? message.content : []),
      ...(Array.isArray(message.meta?.room?.parts) ? message.meta.room.parts : []),
    ];
    for (const part of parts) {
      if (!part || typeof part !== 'object' || !['image', 'file', 'text'].includes(part.type)) continue;
      if (!part.attachmentRef || (part.type === 'text' && !part.textKind)) continue;
      add(part.attachmentRef, partInfo(part));
    }
    for (const record of normalizeMessageAttachments(message.meta?.transcript?.attachments)) add(record.id, record);
  }
  return found;
}

function handoffError(surface, message) {
  return new Error(`${surface}: ${message}`);
}

/** Whether the canonical path `real` names exactly the file `opened` (the
 *  fstat of an open handle): every directory on the way is a real directory,
 *  never a link, and the final entry is that same file (device, file id and
 *  birth time). Node has no portable path-of-handle, so a link or file
 *  swapped in after the open fails this instead. */
function samePathAndHandle(real, opened) {
  const chain = [];
  for (let current = real; dirname(current) !== current; current = dirname(current)) chain.unshift(current);
  for (let index = 0; index < chain.length; index += 1) {
    let info;
    try {
      info = lstatSync(chain[index], { bigint: true });
    } catch {
      return false;
    }
    if (info.isSymbolicLink()) return false;
    const last = index === chain.length - 1;
    if (!last && !info.isDirectory()) return false;
    if (last) {
      return (
        info.isFile() && info.dev === opened.dev && info.ino === opened.ino && info.birthtimeNs === opened.birthtimeNs
      );
    }
  }
  return false;
}

/**
 * Open `raw` (absolute, or relative to `cwd`) once and validate the OPEN
 * handle: a regular file whose canonical path lies inside `roots`, is no
 * credential/secret file, and still names that very handle. Returns `{ fd,
 * path, size }` (the caller closes `fd` and reads only through it); throws
 * with the reason otherwise, the handle closed.
 */
function openContained(raw, { cwd, roots, surface }) {
  const value = String(raw ?? '').trim();
  if (!value || value.includes('\0')) throw handoffError(surface, 'an attachment path is empty or invalid');
  const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd || process.cwd(), value);
  let fd;
  try {
    fd = openSync(absolute, 'r');
  } catch {
    throw handoffError(surface, `attachment "${value}" does not exist`);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw handoffError(surface, `attachment "${value}" is not a file`);
    const real = realOrNull(absolute);
    if (!real) throw handoffError(surface, `attachment "${value}" does not exist`);
    if (!roots.some((root) => within(root, real))) {
      throw handoffError(surface, `attachment "${value}" is outside this session's folders`);
    }
    const extraData = [resolvePluginData()];
    if (isSensitiveLocalPath(absolute, { extraData }) || isSensitiveLocalPath(real, { extraData })) {
      throw handoffError(surface, `attachment "${value}" can hold credentials or secrets and is never attached`);
    }
    if (!samePathAndHandle(real, opened)) {
      throw handoffError(surface, `attachment "${value}" changed while it was opened`);
    }
    return { fd, path: real, size: Number(opened.size), opened, value };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** The first `length` bytes of `fd`. */
function readHead(fd, length = 4096) {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, 0);
  return buffer.subarray(0, read);
}

/** All bytes of `fd` when there are at most `cap`, else null: at most
 *  `cap + 1` bytes are ever read, whatever the file claims or grows to. */
function readCapped(fd, cap) {
  const chunks = [];
  let total = 0;
  const chunk = Buffer.alloc(Math.min(cap + 1, 1 << 20));
  for (;;) {
    const read = readSync(fd, chunk, 0, Math.min(chunk.length, cap + 1 - total), total);
    if (read === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, read)));
    total += read;
    if (total > cap) return null;
  }
  return Buffer.concat(chunks, total);
}

/** The handle checks, for tests. */
export const handoffFileChecks = Object.freeze({
  samePathAndHandle,
  readCapped,
  // `afterRead(path)` runs between the read and the re-check (a test's swap).
  readContained: (raw, options) => readContained(raw, options),
});

/** `{ path, name, type, bytes, size }` of one contained file, read once
 *  through its validated handle: `bytes` null when it is over its kind's
 *  per-file limit or of no type a prompt carries. */
function readContained(raw, options) {
  const file = openContained(raw, options);
  try {
    const name = basename(file.path);
    const type = classify(name, readHead(file.fd));
    const bytes = type ? readCapped(file.fd, limitsOf(type.kind).each) : null;
    options.afterRead?.(file.path);
    // The same checks again after the read: a path re-pointed (a link or
    // file swapped in) while it was read is rejected. Residual window: a swap
    // made and undone between two checks still passes. Accepted: an agent
    // that can do that already has a shell, so this is no hard boundary.
    if (!samePathAndHandle(file.path, file.opened)) {
      throw handoffError(options.surface, `attachment "${file.value}" changed while it was read`);
    }
    return { path: file.path, name, type, bytes, size: bytes ? bytes.length : file.size };
  } finally {
    closeSync(file.fd);
  }
}

/** Running totals per kind against HANDOFF_LIMITS. */
function createBudget() {
  const totals = { image: 0, text: 0, file: 0 };
  return {
    /** Whether `size` bytes of `kind` fit; counts them when they do. */
    take(kind, size) {
      const { each, total, key } = limitsOf(kind);
      if (size > each || totals[key] + size > total) return false;
      totals[key] += size;
      return true;
    },
  };
}

/**
 * The prompt parts for `refs` (the tool's `attachments`): each an attachment
 * this conversation shows (`messages`), by its id or its file name (the
 * newest of that name), or a file path inside `roots`.
 * Returns `{ parts, records }`; throws on an unknown id, a path outside the
 * roots, a secret file, an unsupported type or a limit, naming the reference.
 */
export function resolveHandoffAttachments(refs, { messages = [], roots = [], cwd = '', surface = 'session' } = {}) {
  if (refs == null) return { parts: [], records: [] };
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string')) {
    throw handoffError(surface, 'attachments must be a list of attachment ids or file paths');
  }
  const list = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (list.length > HANDOFF_LIMITS.count) {
    throw handoffError(surface, `at most ${HANDOFF_LIMITS.count} attachments can be passed at once`);
  }
  const known = conversationAttachments(messages);
  // An upload the model knows only by the name its prompt showed
  // (`[Image: source: photo.png …]`): the newest attachment of that name.
  const named = (ref) => [...known.values()].findLast((record) => record.name === ref) || null;
  const budget = createBudget();
  const parts = [];
  const records = [];
  for (const ref of list) {
    let entry;
    const record = ATTACHMENT_ID.test(ref) ? known.get(ref) : named(ref);
    if (ATTACHMENT_ID.test(ref) && !record)
      throw handoffError(surface, `attachment ${ref} is not in this conversation`);
    if (record) {
      let bytes;
      try {
        bytes = readAttachmentBuffer(record.id);
      } catch {
        throw handoffError(surface, `attachment "${ref}" is no longer stored`);
      }
      entry = { ...record, attachmentRef: record.id, size: bytes.length };
    } else {
      const { name, type, bytes } = readContained(ref, { cwd, roots, surface });
      if (!type) throw handoffError(surface, `attachment "${ref}" is not an image, PDF, Office or text file`);
      if (!bytes) throw handoffError(surface, `attachment "${ref}" is larger than the attachment limit`);
      if (type.kind === 'image' && !SUPPORTED_IMAGE_MIME_TYPES.has(type.mimeType)) {
        throw handoffError(surface, `attachment "${ref}" is not a PNG, JPEG, GIF or WebP image`);
      }
      entry = { ...type, name, size: bytes.length, attachmentRef: storeAttachmentBuffer(bytes).attachmentRef };
    }
    if (!budget.take(entry.kind, entry.size)) {
      throw handoffError(surface, `attachment "${entry.name}" exceeds the attachment size limits`);
    }
    parts.push(referencePart(entry));
    records.push({
      id: entry.attachmentRef,
      attachmentRef: entry.attachmentRef,
      kind: entry.kind,
      name: entry.name,
      mimeType: entry.mimeType,
      size: entry.size,
    });
  }
  return { parts, records };
}

// ── Return path: what a finished turn produced ────────────────────────────

const OFFICE_WRITE_ACTIONS = new Set([
  'author',
  'create',
  'batch',
  'render',
  'save',
  'finalize',
  'secure',
  'commit',
  'refine',
  'design',
]);
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;
const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)>?\s*\)/g;
const BACKTICK_PATH = /`([^`\s]+\.[A-Za-z0-9]{1,8})`/g;
const ABSOLUTE_PATH = /(?:^|[\s(])((?:[A-Za-z]:[\\/]|\/)[^\s"'<>|*?()[\]`]+\.[A-Za-z0-9]{1,8})/g;

function callArgs(call) {
  let args = call?.function?.arguments ?? call?.arguments ?? call?.input;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args && typeof args === 'object' ? args : {};
}

/** The paths one tool call wrote or produced; `written`: only those it
 *  actually created or modified (opening a file in visualize does neither). */
function toolCallOutputs(call, written) {
  const name = String(call?.function?.name || call?.name || '');
  const args = callArgs(call);
  const text = (value) => (typeof value === 'string' && value.trim() ? [value.trim()] : []);
  if (name === 'edit') return text(args.file_path);
  if (name === 'apply_patch') return [...String(args.patch || '').matchAll(PATCH_FILE)].map((match) => match[1].trim());
  if (name === 'media') return ['generate', 'status'].includes(args.action) ? text(args.path) : [];
  if (name === 'office') return OFFICE_WRITE_ACTIONS.has(args.action) ? [...text(args.output), ...text(args.path)] : [];
  if (name === 'visualize') {
    const input = args.input && typeof args.input === 'object' ? args.input : {};
    const targets = !written && args.action === 'open' && Array.isArray(input.targets) ? input.targets : [];
    return [
      ...text(input.output),
      ...targets.filter((target) => typeof target === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target)),
    ];
  }
  return [];
}

/** File references in a reply's text: markdown link targets, backticked
 *  file names and absolute paths. URLs never count. */
function replyPaths(text) {
  const found = [];
  const add = (raw) => {
    let value = String(raw || '').trim();
    if (!value || /^(?:https?|mailto|data):/i.test(value)) return;
    value = value
      .replace(/^file:\/\/\/?/i, '')
      .replace(/#.*$/, '')
      .replace(/:\d+(?::\d+)?$/, '');
    try {
      value = decodeURI(value);
    } catch {}
    if (value) found.push(value);
  };
  for (const match of text.matchAll(MARKDOWN_LINK)) add(match[1]);
  for (const match of text.matchAll(BACKTICK_PATH)) add(match[1]);
  for (const match of text.matchAll(ABSOLUTE_PATH)) add(match[1]);
  return found;
}

/** The messages of one turn: from the user message that took submission
 *  `runId` (or, with `since`, the first user message at or after it) to the
 *  end; `messages` itself when neither finds one. */
export function turnSlice(messages, { runId = '', since = 0 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let start = -1;
  if (runId) {
    start = list.findIndex((message) => {
      if (message?.role !== 'user') return false;
      const meta = message.meta || {};
      const transcript = meta.transcript || {};
      return [
        transcript.checkpointId,
        ...(Array.isArray(transcript.submissionIds) ? transcript.submissionIds : []),
        ...(Array.isArray(meta.submissionIds) ? meta.submissionIds : []),
      ].includes(runId);
    });
  } else if (since > 0) {
    start = list.findIndex((message) => message?.role === 'user' && Number(message?.meta?.transcript?.at) >= since);
  }
  return start >= 0 ? list.slice(start) : runId || since > 0 ? [] : list;
}

/** The candidate artifact paths of a turn's messages, most relevant first:
 *  what its final reply names, then media/office/visualize outputs, then the
 *  files it edited. `written`: only the files it created or modified (no
 *  reply paths, no visualize open targets). */
export function turnArtifactCandidates(messages, { written = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const reply = list.findLast((message) => message?.role === 'assistant' && textOf(message.content).trim());
  const produced = [];
  const edited = [];
  for (const message of list) {
    if (message?.role !== 'assistant') continue;
    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : Array.isArray(message.toolCalls)
        ? message.toolCalls
        : [];
    for (const call of calls) {
      const name = String(call?.function?.name || call?.name || '');
      (name === 'edit' || name === 'apply_patch' ? edited : produced).push(...toolCallOutputs(call, written));
    }
  }
  return [...(!written && reply ? replyPaths(textOf(reply.content)) : []), ...produced, ...edited];
}

/**
 * The files `messages` (one turn, turnSlice) produced, inside `roots`:
 * `{ files, omitted }`, each file `{ path, name, kind, mimeType, size, id? }`
 * — `id` (the attachment-store reference) when it fits a prompt's types and
 * limits, else a path-only entry. Secret files, folders and anything outside
 * the roots are left out silently; at most HANDOFF_LIMITS.count are kept.
 */
export function collectTurnArtifacts(messages, { cwd = '', roots = [] } = {}) {
  const files = [];
  let omitted = 0;
  const budget = createBudget();
  for (const { file } of readableCandidates(turnArtifactCandidates(messages), { cwd, roots })) {
    if (files.length >= HANDOFF_LIMITS.count) {
      omitted += 1;
      continue;
    }
    const { type, bytes } = file;
    const entry = pathEntry(file);
    const storable = bytes && (type.kind !== 'image' || SUPPORTED_IMAGE_MIME_TYPES.has(type.mimeType));
    if (storable && budget.take(type.kind, bytes.length)) {
      try {
        entry.id = storeAttachmentBuffer(bytes).attachmentRef;
      } catch {}
    }
    files.push(entry);
  }
  return { files, omitted };
}

/**
 * The files `messages` (one turn) created or modified, inside `roots`, that
 * `report` (the text handed to the Lead) does not name: `{ files, omitted }`
 * as path-only entries, which the Lead forwards by path. Nothing is stored.
 */
export function collectUnreportedWrites(messages, { cwd = '', roots = [], report }) {
  const found = [...readableCandidates(turnArtifactCandidates(messages, { written: true }), { cwd, roots })];
  const unnamed = found.filter((item) => !reportNames(report, item, found, cwd));
  return {
    files: unnamed.slice(0, HANDOFF_LIMITS.count).map(({ file }) => pathEntry(file)),
    omitted: Math.max(0, unnamed.length - HANDOFF_LIMITS.count),
  };
}

const lexicalKey = (path, cwd) => samePlatformPath(resolve(cwd || process.cwd(), path));

const pathEntry = (file) => ({
  path: file.path,
  name: file.name,
  kind: file.type?.kind || 'file',
  mimeType: file.type?.mimeType || 'application/octet-stream',
  size: file.size,
});

/** The distinct files among `candidates` that can be read inside `roots`, with
 *  their lexical and canonical keys. A candidate is a lexical path; its
 *  canonical form dedupes after the read. */
function* readableCandidates(candidates, { cwd, roots }) {
  const seen = new Set();
  for (const candidate of candidates) {
    const lexical = lexicalKey(candidate, cwd);
    if (seen.has(lexical)) continue;
    seen.add(lexical);
    let file;
    try {
      file = readContained(candidate, { cwd, roots, surface: 'artifact' });
    } catch {
      continue;
    }
    const key = samePlatformPath(file.path);
    if (key !== lexical && seen.has(key)) continue;
    seen.add(key);
    yield { file, lexical, key };
  }
}

/** Whether `report` names the produced file `item` among `found`: by its full
 *  path or a cwd-relative path resolving to it exactly, or by its bare file name
 *  when no other produced file shares that name. */
function reportNames(report, { file, lexical, key }, found, cwd) {
  const flat = (value) => String(value).replaceAll('\\', '/');
  const filePath = flat(file.path);
  if (flat(report).includes(filePath)) return true;
  const plain = report
    .split(/[\s`"'<>()[\],;|]+/)
    .map((token) => token.replace(/:\d+(?::\d+)?$/, '').replace(/[.:!?]+$/, ''))
    .filter((token) => /\.[A-Za-z0-9]{1,8}$/.test(token) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(token));
  const refs = new Set([...replyPaths(report), ...plain]);
  const unique = found.filter((other) => other.file.name === file.name).length === 1;
  for (const ref of refs) {
    const normalized = flat(ref).replace(/^(?:\.\/)+/, '');
    if (!normalized.includes('/')) {
      if (unique && normalized === file.name) return true;
      continue;
    }
    const refKey = lexicalKey(ref, cwd);
    if (refKey === lexical || refKey === key) return true;
  }
  return false;
}
