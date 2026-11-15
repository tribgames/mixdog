// Recording fakes for the Node half of the relay twin harness. Each fake
// writes every call as one stdout line '[twin] <json>' (see relay-host.mjs for
// the line shapes) and answers what the scenario scripted in its `answers`
// list: the n-th call takes the n-th answer, the last answer repeats, and an
// empty list means success. Any answer may carry `delayMs`, the time the fake
// waits before answering (webPushFetch rejects meanwhile when the sender aborts).
import { createHash } from 'node:crypto';

/** One '[twin] <json>' stdout line. */
export function recordTwin(value) {
  process.stdout.write(`[twin] ${JSON.stringify(value)}\n`);
}

function answerSequence(answers) {
  const list = Array.isArray(answers) ? answers : [];
  let index = 0;
  return async () => {
    const answer = list.length ? list[Math.min(index, list.length - 1)] : {};
    index += 1;
    const delayMs = Number(answer?.delayMs) || 0;
    if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    return answer ?? {};
  };
}

function rejection(answer) {
  const error = new Error(String(answer.throw));
  if (answer.code !== undefined) error.code = answer.code;
  return error;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function recordedAttachment(attachment) {
  const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(String(attachment.content ?? ''));
  const { content: _content, ...rest } = attachment;
  return { ...rest, bytes: content.length, sha256: sha256(content) };
}

/** `feedbackSender(mail)` of createFeedbackService. Answers: `{}` resolves,
 *  `{throw:'msg', code?}` rejects. Records
 *  {"fake":"feedbackSender","call":"send","mail":{...}} (attachment content is
 *  recorded as its byte length and sha256) and {"fake":"feedbackSender","call":"close"}. */
export function createFeedbackSender(spec = {}) {
  const next = answerSequence(spec.answers);
  const send = async (mail) => {
    const { attachments, ...rest } = mail;
    recordTwin({
      fake: 'feedbackSender',
      call: 'send',
      mail: { ...rest, ...(attachments ? { attachments: attachments.map(recordedAttachment) } : {}) },
    });
    const answer = await next();
    if (answer.throw !== undefined) throw rejection(answer);
  };
  send.close = () => recordTwin({ fake: 'feedbackSender', call: 'close' });
  return send;
}

/** The `nativePush` delivery service (lib/native-push.mjs shape): `platforms`
 *  and `send(message)` resolving `{ok,status,invalid?,error?}`, plus `close()`.
 *  Answers are the result objects, default `{ok:true,status:200}`. Records
 *  {"fake":"nativePush","call":"send","message":{...}} and call "close". */
export function createNativePushFake(spec = {}) {
  const next = answerSequence(spec.answers);
  return {
    platforms: Array.isArray(spec.platforms) ? [...spec.platforms] : [],
    async send(message) {
      recordTwin({ fake: 'nativePush', call: 'send', message });
      const answer = await next();
      return Object.keys(answer).length ? answer : { ok: true, status: 200 };
    },
    close() {
      recordTwin({ fake: 'nativePush', call: 'close' });
    },
  };
}

/** `webPushFetch(url, init)`, the fetch the Web Push sender posts through.
 *  Answers: `{status}` (default 201), or `{throw:'msg'}` for a network error.
 *  Records {"fake":"webPushFetch","call":"fetch","url","method","headers",
 *  "redirect","bodyBytes","bodyBase64"}; the Authorization JWT is recorded
 *  as sent, the runner normalises it. */
export function createWebPushFetch(spec = {}) {
  const next = answerSequence(spec.answers);
  return async (url, init = {}) => {
    const body = init.body ? Buffer.from(init.body) : Buffer.alloc(0);
    recordTwin({
      fake: 'webPushFetch',
      call: 'fetch',
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      redirect: init.redirect ?? null,
      bodyBytes: body.length,
      bodyBase64: body.toString('base64'),
    });
    // An answer delayed past the sender's timeout rejects as fetch does on abort.
    const { signal } = init;
    const aborted = new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new Error('This operation was aborted'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    aborted.catch(() => {});
    const answer = signal ? await Promise.race([next(), aborted]) : await next();
    if (answer.throw !== undefined) throw rejection(answer);
    return { status: Number.isInteger(answer.status) ? answer.status : 201 };
  };
}
