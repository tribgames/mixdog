// Durable feedback queue: a receipt is acknowledged only after the record is on
// disk (private files under <dataDir>/feedback), then mailed immediately and
// retried with bounded backoff, across restarts, until the mail is accepted.
// Only the submitted kind/message/optional reply-to are kept; nothing about the
// caller (IP, headers, user agent) is stored.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES,
  feedbackAttachmentBytes,
  normalizeFeedbackAttachments,
} from './feedback-attachments.mjs';
import { RateLimiter } from './rate-limit.mjs';

export const FEEDBACK_KINDS = ['bug', 'suggestion', 'other'];
export const MAX_FEEDBACK_TEXT_BODY_BYTES = 32_768;
// Text envelope + base64 of the total attachment cap + names/JSON overhead.
export const MAX_FEEDBACK_BODY_BYTES =
  MAX_FEEDBACK_TEXT_BODY_BYTES + Math.ceil(FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES / 3) * 4 + 4096;
export const MAX_FEEDBACK_MESSAGE_CHARS = 8000;
export const MAX_FEEDBACK_EMAIL_CHARS = 254;
export const DEFAULT_FEEDBACK_TO = 'support@tribgames.com';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>(),;:\\"]+@[^\s@<>(),;:\\"]+\.[^\s@<>(),;:\\"]+$/;
const RECORD_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

export const FEEDBACK_DEFAULTS = {
  maxPending: 500,
  maxRecords: 5000,
  baseDelayMs: 30_000,
  maxDelayMs: 60 * 60_000,
  ipLimit: 10,
  ipWindowMs: 10 * 60_000,
  globalLimit: 120,
  globalWindowMs: 60 * 60_000,
  smtpTimeoutMs: 15_000,
  // Raw bytes of attachments held by undelivered records (memory and disk).
  maxPendingAttachmentBytes: 48 * 1024 * 1024,
};

export class FeedbackError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Validate and normalise a request body; throws FeedbackError(400). */
export function normalizeFeedback(body) {
  const bad = () => new FeedbackError(400, 'invalid_feedback');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad();
  const { id, kind, message, replyTo } = body;
  if (typeof id !== 'string' || !UUID.test(id)) throw bad();
  if (!FEEDBACK_KINDS.includes(kind)) throw bad();
  if (typeof message !== 'string') throw bad();
  const text = message.trim();
  if (!text || text.length > MAX_FEEDBACK_MESSAGE_CHARS) throw bad();
  let reply = '';
  // undefined or blank means absent; null and non-strings are rejected.
  if (replyTo !== undefined) {
    if (typeof replyTo !== 'string') throw bad();
    reply = replyTo.trim();
    if (reply.length > MAX_FEEDBACK_EMAIL_CHARS || (reply && !EMAIL.test(reply))) throw bad();
  }
  let attachments;
  try {
    attachments = normalizeFeedbackAttachments(body.attachments);
  } catch {
    throw bad();
  }
  return { id: id.toLowerCase(), kind, message: text, replyTo: reply, attachments };
}

// Attachment-free payloads hash exactly as before; attachments (name, type and
// content digest) extend the hashed tuple only when present.
function payloadHash({ kind, message, replyTo, attachments = [] }) {
  const parts = [kind, message, replyTo];
  if (attachments.length) {
    parts.push(
      attachments.map((a) => [a.name, a.mimeType, createHash('sha256').update(a.data).digest('hex')]),
    );
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** SMTP settings from env, or null when mail is not configured. */
export function feedbackMailConfig(env = {}) {
  const user = String(env.SMTP_USER || '').trim();
  const pass = String(env.SMTP_PASSWORD || '');
  if (!user || !pass) return null;
  return {
    host: String(env.SMTP_HOST || '').trim() || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT) || 465,
    user,
    pass,
    to: String(env.FEEDBACK_TO || '').trim() || DEFAULT_FEEDBACK_TO,
  };
}

async function nodemailerSender(config, timeoutMs) {
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.pass },
    tls: { rejectUnauthorized: true },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    dnsTimeout: timeoutMs,
  });
  const send = (mail) => transport.sendMail(mail);
  send.close = () => transport.close();
  return send;
}

/**
 * Options (all optional): env, sender(mail) (test injection; makes mail
 * "configured"), now(), setTimer(fn, ms), clearTimer(handle), plus any key of
 * FEEDBACK_DEFAULTS.
 */
export async function createFeedbackService({
  dataDir,
  env = {},
  sender = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  fs: fsOverrides = {},
  ...overrides
} = {}) {
  const opts = { ...FEEDBACK_DEFAULTS, ...overrides };
  const fs = { mkdir, readdir, readFile, rename, unlink, writeFile, ...fsOverrides };
  const dir = join(dataDir, 'feedback');
  const config = feedbackMailConfig(env);
  const from = config?.user || 'feedback@localhost';
  const to = config?.to || DEFAULT_FEEDBACK_TO;
  let send = sender;
  if (!send && config) send = await nodemailerSender(config, opts.smtpTimeoutMs);

  const records = new Map(); // id -> record
  const sending = new Set(); // ids with a send in flight
  const inflight = new Set(); // promises, awaited on close
  const ipLimiter = new RateLimiter(opts.ipLimit, opts.ipWindowMs);
  const globalLimiter = new RateLimiter(opts.globalLimit, opts.globalWindowMs, 1);
  let storageOk = true;
  let closed = false;
  let timer = null;

  const pathOf = (id) => join(dir, `${id}.json`);

  // Diagnostics carry an id/file name and an error code only: never payload or secrets.
  const diag = (what, error) => console.error(`[relay] feedback ${what} code=${error?.code || 'error'}`);

  async function persist(record) {
    const target = pathOf(record.id);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record), { mode: 0o600, flush: true });
    await fs.rename(tmp, target);
  }

  const num = (v) => Number.isFinite(v) && v >= 0;
  const text = (v) => typeof v === 'string';
  function validRecord(name, data) {
    if (!data || name !== `${data.id}.json` || !text(data.hash) || !num(data.sentAt)) return false;
    if (!num(data.createdAt) || !num(data.attempts) || !num(data.nextAttemptAt)) return false;
    if (data.sentAt) return true;
    const p = data.payload;
    if (!(Boolean(p) && FEEDBACK_KINDS.includes(p.kind) && text(p.message) && text(p.replyTo))) return false;
    if (p.attachments === undefined) return true; // legacy record
    try {
      return normalizeFeedbackAttachments(p.attachments).length === p.attachments.length;
    } catch {
      return false;
    }
  }

  const recordBytes = (r) => (r.sentAt || !r.payload.attachments ? 0 : feedbackAttachmentBytes(r.payload.attachments));
  const pendingAttachmentBytes = () => {
    let n = 0;
    for (const r of records.values()) n += recordBytes(r);
    return n;
  };

  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(dir)) {
      if (!RECORD_FILE.test(name)) continue;
      let data = null;
      try {
        data = JSON.parse(await fs.readFile(join(dir, name), 'utf8'));
      } catch (error) {
        diag(`record unreadable file=${name}`, error);
        storageOk = false;
        continue;
      }
      if (validRecord(name, data)) records.set(data.id, data);
      else {
        console.error(`[relay] feedback record corrupt file=${name}`);
        storageOk = false;
      }
    }
  } catch (error) {
    diag('storage unavailable', error);
    storageOk = false;
  }

  const pendingCount = () => {
    let n = 0;
    for (const r of records.values()) if (!r.sentAt) n++;
    return n;
  };

  // Frees one delivered record: the file must be gone before the record is
  // forgotten, so a failed unlink can never let the disk outgrow the cap.
  async function pruneSent() {
    let oldest = null;
    for (const r of records.values()) {
      if (r.sentAt && !sending.has(r.id) && (!oldest || r.sentAt < oldest.sentAt)) oldest = r;
    }
    if (!oldest) return false;
    try {
      await fs.unlink(pathOf(oldest.id));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        diag('prune failed', error);
        throw new FeedbackError(503, 'feedback_unavailable');
      }
    }
    records.delete(oldest.id);
    return true;
  }

  function arm() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (closed || !send) return;
    let next = Infinity;
    for (const r of records.values()) if (!r.sentAt && !sending.has(r.id)) next = Math.min(next, r.nextAttemptAt);
    // Records enter `records` only after their first write is durable.
    if (next === Infinity) return;
    timer = setTimer(pump, Math.max(0, next - now()));
    timer?.unref?.();
  }

  function pump() {
    timer = null;
    if (closed || !send) return;
    for (const r of records.values()) if (!r.sentAt && !sending.has(r.id) && r.nextAttemptAt <= now()) deliver(r);
    arm();
  }

  function deliver(record) {
    if (closed || !send || record.sentAt || sending.has(record.id)) return;
    sending.add(record.id);
    const task = (async () => {
      try {
        const { kind, message, replyTo, attachments } = record.payload;
        await send({
          from,
          to,
          ...(replyTo ? { replyTo } : {}),
          subject: `[Mixdog feedback] ${kind} ${record.id}`,
          text: message,
          ...(attachments?.length
            ? {
                attachments: attachments.map((a) => ({
                  filename: a.name,
                  content: Buffer.from(a.data, 'base64'),
                  contentType: a.mimeType,
                  contentDisposition: 'attachment',
                })),
              }
            : {}),
          messageId: `<${record.id}@feedback.mixdog>`,
        });
        record.sentAt = now();
        delete record.payload;
      } catch (error) {
        record.attempts += 1;
        const delay = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** Math.min(record.attempts - 1, 30));
        record.nextAttemptAt = now() + delay;
        console.error(`[relay] feedback send failed id=${record.id} code=${error?.code || 'error'}`);
      }
      try {
        await persist(record);
      } catch (error) {
        // In-memory state still prevents a resend in this process.
        diag(`state persist failed id=${record.id}`, error);
      }
    })().finally(() => {
      sending.delete(record.id);
      inflight.delete(task);
      arm();
    });
    inflight.add(task);
  }

  function checkRate(ip) {
    if (!ipLimiter.allow(ip) || !globalLimiter.allow('global')) throw new FeedbackError(429, 'rate_limited');
  }

  /** Store then enqueue; resolves {id,status} or throws FeedbackError. */
  // Submissions run one at a time so capacity and idempotency checks stay
  // valid across the awaits below; close() waits for the ones in progress.
  const submissions = new Set();
  let tail = Promise.resolve();
  function submit(body) {
    const input = normalizeFeedback(body);
    const task = tail.then(() => admit(input));
    tail = task.catch(() => {});
    submissions.add(task);
    const forget = () => submissions.delete(task);
    task.then(forget, forget);
    return task;
  }

  async function admit(input) {
    if (!send || !storageOk || closed) throw new FeedbackError(503, 'feedback_unavailable');
    const hash = payloadHash(input);
    const existing = records.get(input.id);
    if (existing) {
      if (existing.hash !== hash) throw new FeedbackError(409, 'conflict');
      return { id: input.id, status: 'accepted' };
    }
    if (pendingCount() >= opts.maxPending) throw new FeedbackError(503, 'feedback_busy');
    if (
      input.attachments.length &&
      pendingAttachmentBytes() + feedbackAttachmentBytes(input.attachments) > opts.maxPendingAttachmentBytes
    ) {
      throw new FeedbackError(503, 'feedback_busy');
    }
    while (records.size >= opts.maxRecords) {
      if (!(await pruneSent())) throw new FeedbackError(503, 'feedback_busy');
    }
    const record = {
      id: input.id,
      hash,
      payload: {
        kind: input.kind,
        message: input.message,
        replyTo: input.replyTo,
        ...(input.attachments.length ? { attachments: input.attachments } : {}),
      },
      createdAt: now(),
      attempts: 0,
      nextAttemptAt: now(),
      sentAt: 0,
    };
    try {
      await persist(record);
    } catch (error) {
      diag(`persist failed id=${record.id}`, error);
      fs.unlink(`${pathOf(record.id)}.tmp`).catch(() => {});
      throw new FeedbackError(503, 'feedback_unavailable');
    }
    records.set(record.id, record);
    deliver(record);
    return { id: record.id, status: 'accepted' };
  }

  pump();

  return {
    submit,
    checkRate,
    pump,
    get configured() {
      return Boolean(send);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      await Promise.allSettled([...submissions]);
      while (inflight.size) await Promise.allSettled([...inflight]);
      try {
        send?.close?.();
      } catch {
        /* already closed */
      }
    },
  };
}
