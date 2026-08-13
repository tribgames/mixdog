/**
 * Content-addressed prompt attachment store.
 *
 * Renderer/TUI inputs carry the bytes exactly once to the daemon intake. From
 * that boundary onward queues, checkpoints, session JSON, live-share frames,
 * and desktop snapshots carry only a sha256 reference plus byte-free metadata.
 * Provider lowering resolves the reference at the last possible boundary.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {
  readdir,
  readFile as readFileAsync,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { inspectPdfBuffer } from './pdf-extract.mjs';

const ATTACHMENT_REF_RE = /^[a-f0-9]{64}$/;
const TEXT_TOKEN_RE = /\[(?:Pasted text|File) #(\d+)[^\]\r\n]*\]/g;
const TEXT_REFERENCE_THRESHOLD_BYTES = 800;
export const MAX_PROMPT_TEXT_BYTES = 1024 * 1024;
export const MAX_PROMPT_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_PDF_PAGES = 100;
export const ATTACHMENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENT_BLOB_BYTES = 64 * 1024 * 1024;
export const ATTACHMENT_GC_MIN_AGE_MS = Math.max(
  60_000,
  Number(process.env.MIXDOG_ATTACHMENT_GC_MIN_AGE_MS) || 7 * 24 * 60 * 60 * 1000,
);
const ATTACHMENT_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ATTACHMENT_GC_START_DELAY_MS = 5_000;

const bufferCache = new Map();
let bufferCacheBytes = 0;
let cacheHits = 0;
let cacheMisses = 0;
let attachmentGcTimer = null;
let lastAttachmentGcAt = 0;

function attachmentsDir() {
  return join(resolvePluginData(), 'prompt-attachments', 'sha256');
}

function attachmentPath(ref) {
  const value = String(ref || '');
  if (!ATTACHMENT_REF_RE.test(value)) throw new TypeError('prompt attachment reference is invalid');
  return join(attachmentsDir(), value.slice(0, 2), value);
}

function rememberBuffer(path, buffer) {
  const existing = bufferCache.get(path);
  if (existing) {
    bufferCacheBytes -= existing.length;
    bufferCache.delete(path);
  }
  if (buffer.length > ATTACHMENT_CACHE_MAX_BYTES) return;
  bufferCache.set(path, buffer);
  bufferCacheBytes += buffer.length;
  while (bufferCacheBytes > ATTACHMENT_CACHE_MAX_BYTES && bufferCache.size > 0) {
    const oldest = bufferCache.keys().next().value;
    const evicted = bufferCache.get(oldest);
    bufferCache.delete(oldest);
    bufferCacheBytes -= evicted?.length || 0;
  }
}

function saveBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('prompt attachment is empty');
  }
  if (buffer.length > MAX_ATTACHMENT_BLOB_BYTES) {
    throw new RangeError('prompt attachment exceeds the 64 MiB input limit');
  }
  const attachmentRef = createHash('sha256').update(buffer).digest('hex');
  const target = attachmentPath(attachmentRef);
  let existingValid = false;
  if (existsSync(target)) {
    try {
      const current = readFileSync(target);
      existingValid = current.length === buffer.length
        && createHash('sha256').update(current).digest('hex') === attachmentRef;
    } catch {}
    if (!existingValid) {
      try { unlinkSync(target); } catch {}
    }
  }
  if (!existingValid) {
    mkdirSync(join(attachmentsDir(), attachmentRef.slice(0, 2)), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temp, buffer, { mode: 0o600 });
    try {
      renameSync(temp, target);
    } catch (error) {
      let racedValid = false;
      try {
        const current = readFileSync(target);
        racedValid = current.length === buffer.length
          && createHash('sha256').update(current).digest('hex') === attachmentRef;
      } catch {}
      if (!racedValid) throw error;
    } finally {
      try { unlinkSync(temp); } catch {}
    }
  } else {
    // Reusing old content creates a fresh reference before its queue/session
    // record is durable. Refresh mtime so the GC safety window protects that
    // cross-process publication race.
    try {
      const now = new Date();
      utimesSync(target, now, now);
    } catch {}
  }
  rememberBuffer(target, buffer);
  scheduleAttachmentGc();
  return { attachmentRef, sizeBytes: buffer.length };
}

export function isAttachmentReference(value) {
  return Boolean(value && typeof value === 'object'
    && ATTACHMENT_REF_RE.test(String(value.attachmentRef || '')));
}

export function readAttachmentBuffer(value) {
  const ref = typeof value === 'string' ? value : value?.attachmentRef;
  const path = attachmentPath(ref);
  const cached = bufferCache.get(path);
  if (cached) {
    cacheHits += 1;
    bufferCache.delete(path);
    bufferCache.set(path, cached);
    return cached;
  }
  cacheMisses += 1;
  const info = statSync(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ATTACHMENT_BLOB_BYTES) {
    throw new Error('prompt attachment blob is invalid');
  }
  const buffer = readFileSync(path);
  if (createHash('sha256').update(buffer).digest('hex') !== ref) {
    throw new Error('prompt attachment integrity check failed');
  }
  rememberBuffer(path, buffer);
  return buffer;
}

export function readAttachmentBase64(value) {
  return readAttachmentBuffer(value).toString('base64');
}

export function readAttachmentText(value) {
  return readAttachmentBuffer(value).toString('utf8');
}

export function attachmentTextForPart(part) {
  if (!isAttachmentReference(part)) return typeof part?.text === 'string' ? part.text : '';
  const text = readAttachmentText(part);
  if (part.textKind !== 'file') return text;
  const safeName = String(part.filename || 'attachment').replace(/[<>"']/g, '_');
  return `<file name="${safeName}">\n${text}\n</file>`;
}

function materializeText(text, metadata = {}) {
  const value = String(text ?? '');
  const bytes = Buffer.from(value, 'utf8');
  const ref = saveBuffer(bytes);
  return {
    type: 'text',
    ...ref,
    ...(metadata.textKind ? { textKind: metadata.textKind } : {}),
    ...(metadata.filename ? { filename: String(metadata.filename).slice(0, 200) } : {}),
    ...(metadata.mimeType ? { mimeType: String(metadata.mimeType).slice(0, 100) } : {}),
  };
}

function materializePastedTexts(pastedTexts) {
  if (!pastedTexts || typeof pastedTexts !== 'object') return { refs: {}, options: null };
  const refs = {};
  const options = {};
  for (const [key, raw] of Object.entries(pastedTexts)) {
    if (!raw || typeof raw !== 'object') continue;
    let refPart = null;
    if (isAttachmentReference(raw)) {
      refPart = {
        type: 'text',
        attachmentRef: raw.attachmentRef,
        sizeBytes: Number(raw.sizeBytes) || 0,
        ...(raw.source === 'file' ? { textKind: 'file' } : {}),
        ...(raw.filename ? { filename: raw.filename } : {}),
        ...(raw.mimeType ? { mimeType: raw.mimeType } : {}),
      };
    } else if (typeof raw.text === 'string') {
      refPart = materializeText(raw.text, {
        textKind: raw.source === 'file' ? 'file' : 'paste',
        filename: raw.filename,
        mimeType: raw.mimeType,
      });
    }
    if (!refPart) continue;
    refs[String(raw.id ?? key)] = refPart;
    const { text: _text, ...meta } = raw;
    options[key] = {
      ...meta,
      attachmentRef: refPart.attachmentRef,
      sizeBytes: refPart.sizeBytes,
      chars: Number(raw.chars) || (typeof raw.text === 'string' ? raw.text.length : 0),
    };
  }
  return { refs, options: Object.keys(options).length ? options : null };
}

function expandTextTokens(text, textRefs) {
  const value = String(text ?? '');
  TEXT_TOKEN_RE.lastIndex = 0;
  let match;
  let offset = 0;
  const out = [];
  while ((match = TEXT_TOKEN_RE.exec(value)) !== null) {
    const ref = textRefs[String(match[1])];
    if (!ref) continue;
    if (match.index > offset) out.push({ type: 'text', text: value.slice(offset, match.index) });
    out.push(ref);
    offset = match.index + match[0].length;
  }
  if (offset === 0) return null;
  if (offset < value.length) out.push({ type: 'text', text: value.slice(offset) });
  return out;
}

function materializeInlinePart(part) {
  if (!part || typeof part !== 'object' || isAttachmentReference(part)) return part;
  if (part.type === 'image' && typeof part.data === 'string' && part.data) {
    const { data, ...metadata } = part;
    return { ...metadata, ...saveBuffer(Buffer.from(data, 'base64')) };
  }
  if (part.type === 'file' && typeof part.data === 'string' && part.data) {
    const { data, ...metadata } = part;
    return { ...metadata, ...saveBuffer(Buffer.from(data, 'base64')) };
  }
  if (part.type === 'text' && typeof part.text === 'string'
    && Buffer.byteLength(part.text, 'utf8') >= TEXT_REFERENCE_THRESHOLD_BYTES) {
    return materializeText(part.text, part);
  }
  return part;
}

function materializePromptContent(prompt, textRefs) {
  if (typeof prompt === 'string') {
    const expanded = expandTextTokens(prompt, textRefs);
    if (expanded) return expanded.map(materializeInlinePart);
    if (Buffer.byteLength(prompt, 'utf8') >= TEXT_REFERENCE_THRESHOLD_BYTES) {
      return [materializeText(prompt)];
    }
    return prompt;
  }
  if (!Array.isArray(prompt)) return prompt;
  const out = [];
  for (const part of prompt) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      const expanded = expandTextTokens(part.text, textRefs);
      if (expanded) {
        out.push(...expanded.map(materializeInlinePart));
        continue;
      }
    }
    out.push(materializeInlinePart(part));
  }
  return out;
}

function promptTextBytes(content) {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => {
    if (part?.type !== 'text') return sum;
    if (isAttachmentReference(part)) return sum + (Number(part.sizeBytes) || 0);
    return sum + Buffer.byteLength(String(part?.text || ''), 'utf8');
  }, 0);
}

function materializePastedImages(pastedImages, imageParts) {
  if (!pastedImages || typeof pastedImages !== 'object') return null;
  const out = {};
  let imageIndex = 0;
  for (const [key, raw] of Object.entries(pastedImages)) {
    if (!raw || typeof raw !== 'object') continue;
    let ref = isAttachmentReference(raw) ? raw : null;
    if (!ref && typeof raw.content === 'string' && raw.content) {
      ref = saveBuffer(Buffer.from(raw.content, 'base64'));
    }
    if (!ref) ref = imageParts[imageIndex] || null;
    imageIndex += 1;
    const { content: _content, ...meta } = raw;
    out[key] = {
      ...meta,
      ...(ref ? {
        attachmentRef: ref.attachmentRef,
        sizeBytes: Number(ref.sizeBytes) || Number(raw.sizeBytes) || 0,
      } : {}),
    };
  }
  return Object.keys(out).length ? out : null;
}

export function materializePromptSubmission(prompt, options = {}) {
  const textState = materializePastedTexts(options?.pastedTexts);
  const materializedPrompt = materializePromptContent(prompt, textState.refs);
  if (promptTextBytes(materializedPrompt) > MAX_PROMPT_TEXT_BYTES) {
    throw new RangeError('prompt text exceeds the 1 MiB input limit');
  }
  const imageParts = (Array.isArray(materializedPrompt) ? materializedPrompt : [])
    .filter((part) => part?.type === 'image' && isAttachmentReference(part));
  return {
    prompt: materializedPrompt,
    options: {
      ...(options || {}),
      ...(options?.pastedImages
        ? { pastedImages: materializePastedImages(options.pastedImages, imageParts) }
        : {}),
      ...(options?.pastedTexts ? { pastedTexts: textState.options } : {}),
    },
  };
}

const NATIVE_PDF_PROVIDERS = new Set([
  'anthropic',
  'anthropic-oauth',
  'gemini',
  'openai',
  'openai-oauth',
]);

export function providerSupportsNativePdf(provider) {
  return NATIVE_PDF_PROVIDERS.has(String(provider || '').trim().toLowerCase());
}

/**
 * Provider-aware PDF intake. Native document providers retain the original
 * content-addressed PDF after validating its page count. Providers whose
 * OpenAI-compatible wire contract has no portable file block receive bounded,
 * page-labelled text instead.
 */
export async function preparePromptSubmissionForProvider(intake, provider) {
  const prompt = intake?.prompt;
  if (!Array.isArray(prompt)) return intake;
  const nativePdf = providerSupportsNativePdf(provider);
  let remainingTextBytes = Math.max(0, MAX_PROMPT_TEXT_BYTES - promptTextBytes(prompt));
  let changed = false;
  const prepared = [];
  for (const part of prompt) {
    const mimeType = String(part?.mimeType || part?.mediaType || '').toLowerCase();
    if (part?.type !== 'file' || mimeType !== 'application/pdf' || !isAttachmentReference(part)) {
      prepared.push(part);
      continue;
    }
    const bytes = Number(part.sizeBytes) || readAttachmentBuffer(part).length;
    if (bytes > MAX_PROMPT_PDF_BYTES) {
      throw new RangeError(`PDF exceeds the ${MAX_PROMPT_PDF_BYTES / 1024 / 1024} MiB input limit`);
    }
    if (!nativePdf && remainingTextBytes < 256) {
      throw new RangeError('PDF text cannot fit within the 1 MiB prompt text limit');
    }
    const inspected = await inspectPdfBuffer(readAttachmentBuffer(part), {
      extractText: !nativePdf,
      maxPages: MAX_PROMPT_PDF_PAGES,
      maxOutputBytes: Math.max(256, remainingTextBytes),
    });
    changed = true;
    if (nativePdf) {
      prepared.push({ ...part, pageCount: inspected.pageCount });
      continue;
    }
    const textPart = materializeText(inspected.text, {
      textKind: 'file',
      filename: part.filename || 'attachment.pdf',
      mimeType: 'text/plain',
    });
    remainingTextBytes = Math.max(0, remainingTextBytes - textPart.sizeBytes);
    prepared.push({ ...textPart, sourceMimeType: 'application/pdf', pageCount: inspected.pageCount });
  }
  if (!changed) return intake;
  return { ...intake, prompt: prepared };
}

export function hydratePastedAttachments(pastedImages, pastedTexts) {
  const images = pastedImages && typeof pastedImages === 'object'
    ? Object.fromEntries(Object.entries(pastedImages).map(([key, raw]) => {
      if (!raw || typeof raw !== 'object' || !isAttachmentReference(raw)) return [key, raw];
      return [key, { ...raw, content: readAttachmentBase64(raw) }];
    }))
    : null;
  const texts = pastedTexts && typeof pastedTexts === 'object'
    ? Object.fromEntries(Object.entries(pastedTexts).map(([key, raw]) => {
      if (!raw || typeof raw !== 'object' || !isAttachmentReference(raw)) return [key, raw];
      return [key, { ...raw, text: readAttachmentText(raw) }];
    }))
    : null;
  return { pastedImages: images, pastedTexts: texts };
}

export function attachmentStoreCacheStats() {
  return {
    entries: bufferCache.size,
    bytes: bufferCacheBytes,
    maxBytes: ATTACHMENT_CACHE_MAX_BYTES,
    hits: cacheHits,
    misses: cacheMisses,
  };
}

function dropCachedAttachment(path) {
  const cached = bufferCache.get(path);
  if (!cached) return;
  bufferCache.delete(path);
  bufferCacheBytes -= cached.length;
}

async function persistedAttachmentReferencePaths() {
  const root = resolvePluginData();
  const paths = [];
  for (const dirname of ['sessions', 'turn-checkpoints']) {
    const dir = join(root, dirname);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) paths.push(join(dir, entry.name));
    }
  }
  paths.push(join(root, 'session-pending-messages.json'));
  return paths;
}

export async function collectPromptAttachments({
  now = Date.now(),
  minAgeMs = ATTACHMENT_GC_MIN_AGE_MS,
} = {}) {
  const referenced = new Set();
  let referenceFiles = 0;
  for (const path of await persistedAttachmentReferencePaths()) {
    let raw;
    try {
      raw = await readFileAsync(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      // A partial reference census must never authorize deletion.
      return { deleted: 0, referenced: 0, fresh: 0, scanned: 0, incomplete: true };
    }
    referenceFiles += 1;
    const regex = /"attachmentRef"\s*:\s*"([a-f0-9]{64})"/g;
    let match;
    while ((match = regex.exec(raw)) !== null) referenced.add(match[1]);
  }

  const cutoff = Number(now) - Math.max(0, Number(minAgeMs) || 0);
  let prefixes;
  try {
    prefixes = await readdir(attachmentsDir(), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { deleted: 0, referenced: referenced.size, fresh: 0, scanned: 0, referenceFiles };
    }
    return { deleted: 0, referenced: referenced.size, fresh: 0, scanned: 0, referenceFiles, incomplete: true };
  }
  let deleted = 0;
  let fresh = 0;
  let scanned = 0;
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
    const dir = join(attachmentsDir(), prefix.name);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !ATTACHMENT_REF_RE.test(entry.name)) continue;
      scanned += 1;
      if (referenced.has(entry.name)) continue;
      const path = join(dir, entry.name);
      try {
        const first = await stat(path);
        if (first.mtimeMs > cutoff) {
          fresh += 1;
          continue;
        }
        // Re-stat immediately before unlink so a concurrent intake mtime touch
        // wins unless it races the final filesystem operation itself.
        const latest = await stat(path);
        if (latest.mtimeMs > cutoff || latest.mtimeMs !== first.mtimeMs) {
          fresh += 1;
          continue;
        }
        await unlink(path);
        dropCachedAttachment(path);
        deleted += 1;
      } catch (error) {
        if (error?.code !== 'ENOENT') fresh += 1;
      }
    }
  }
  return { deleted, referenced: referenced.size, fresh, scanned, referenceFiles };
}

function armAttachmentGc(delayMs) {
  if (attachmentGcTimer) return;
  attachmentGcTimer = setTimeout(() => {
    attachmentGcTimer = null;
    void collectPromptAttachments()
      .catch(() => undefined)
      .finally(() => {
        lastAttachmentGcAt = Date.now();
        armAttachmentGc(ATTACHMENT_GC_INTERVAL_MS);
      });
  }, Math.max(ATTACHMENT_GC_START_DELAY_MS, Number(delayMs) || 0));
  attachmentGcTimer.unref?.();
}

function scheduleAttachmentGc() {
  if (attachmentGcTimer) return;
  const elapsed = Date.now() - lastAttachmentGcAt;
  armAttachmentGc(lastAttachmentGcAt === 0
    ? ATTACHMENT_GC_START_DELAY_MS
    : ATTACHMENT_GC_INTERVAL_MS - elapsed);
}

scheduleAttachmentGc();
