import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  cleanSessionPreview,
  isSessionPreviewNoise,
  sessionMessageText,
} from './session-text.mjs';

// Title generation runs beside the main turn and may include a cold provider
// start. Keep it bounded, but allow enough time for the first-turn title to
// become the shared label instead of routinely falling back until turn three.
export const SESSION_TITLE_TIMEOUT_MS = 10_000;

const KOREAN_GREETING_TITLE = new Set([
  'ㅎㅇ',
  '하이',
  '안녕',
  '안녕하세요',
  '헬로',
  '반가워',
  '반갑습니다',
]);
const ENGLISH_GREETING_TITLE = new Set(['hi', 'hello', 'hey']);

function hasMeaningfulTitleText(value) {
  return /[\p{L}\p{N}]/u.test(String(value || ''));
}

function compactTitle(value, maximum = 32) {
  const line = String(value || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/^["'`#*\s]+|["'`\s.]+$/g, ''))
    .find(Boolean) || '';
  const text = cleanSessionPreview(line, Math.max(maximum * 4, 128));
  if (!hasMeaningfulTitleText(text)) return '';
  if (text.length <= maximum) return text;
  const clipped = text.slice(0, maximum - 1);
  const boundary = clipped.lastIndexOf(' ');
  const head = boundary >= Math.floor(maximum * 0.6) ? clipped.slice(0, boundary) : clipped;
  return `${head.trimEnd()}…`;
}

function titleMessageText(message, role) {
  if (!message || typeof message !== 'object') return '';
  if (message.internal === true || message.synthetic === true) return '';
  const raw = sessionMessageText(message.content ?? message.text);
  if (!raw || (role === 'user' && isSessionPreviewNoise(raw))) return '';
  const visible = cleanSessionPreview(
    raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, ''),
    4_000,
  );
  return hasMeaningfulTitleText(visible) ? visible : '';
}

export function firstTurnTitleSource(prompt) {
  const raw = sessionMessageText(prompt);
  if (!raw || isSessionPreviewNoise(raw)) return '';
  const visible = cleanSessionPreview(raw, 4_000);
  return hasMeaningfulTitleText(visible) ? visible : '';
}

/** The first three COMPLETED human exchanges. Tool calls/results, system rows,
 * reasoning, injected context and intermediate assistant preambles are
 * excluded; only the final visible assistant text before the next user stays.
 * A session that moved past turn three (e.g. because an earlier attempt timed
 * out) still titles from its first three exchanges instead of never. */
export function thirdTurnTitleSource(messages) {
  const turns = [];
  let current = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String(message?.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    const text = titleMessageText(message, role);
    if (!text) continue;
    if (role === 'user') {
      if (current) turns.push(current);
      current = { user: text, assistant: '' };
    } else if (current) {
      current.assistant = text;
    }
  }
  if (current) turns.push(current);
  const completed = turns.filter((turn) => turn.user && turn.assistant);
  if (completed.length < 3) return '';
  return completed
    .slice(0, 3)
    .flatMap((turn) => [`User: ${turn.user}`, `Assistant: ${turn.assistant}`])
    .join('\n');
}

function greetingTitle(source) {
  const normalized = String(source || '').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  if (KOREAN_GREETING_TITLE.has(normalized)) return '인사';
  if (ENGLISH_GREETING_TITLE.has(normalized)) return 'Greeting';
  return '';
}

export function resolvedSystemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch {
    return '';
  }
}

/** Shared session controller used by every lead surface (TUI and desktop). */
export function createSessionTitleController(deps = {}) {
  const firstAttempts = new Set();
  const thirdAttempts = new Set();
  const active = new Map();
  const timeoutMs = Number.isFinite(Number(deps.timeoutMs))
    ? Math.max(1, Number(deps.timeoutMs))
    : SESSION_TITLE_TIMEOUT_MS;
  let disposed = false;

  const log = (line) => {
    const message = `[mixdog] llm-title ${line}`;
    try { deps.log?.(message); } catch {}
    if (!deps.log) {
      try { process.stderr.write(`${message}\n`); } catch {}
    }
    try {
      const root = String(deps.dataRoot?.() || '');
      if (root) void appendFile(join(root, 'llm-title.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
        .catch(() => undefined);
    } catch { /* diagnostics must never break titling */ }
  };

  const promote = async (sessionId, title, stage) => {
    if (disposed || !title) return false;
    return await deps.promoteGeneratedTitle?.(sessionId, title, stage) === true;
  };

  const generate = async (sessionId, source, stage) => {
    const abort = new AbortController();
    const key = `${sessionId}:${stage}`;
    active.set(key, abort);
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Session title generation timed out.');
          abort.abort(error);
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      });
      const raw = await Promise.race([
        Promise.resolve().then(async () => {
          const complete = deps.generateSessionTitle
            || (await import('../runtime/agent/orchestrator/agent-runtime/title-completion.mjs'))
              .generateSessionTitle;
          if (disposed) return '';
          return complete(source, {
            signal: abort.signal,
            locale: String(deps.systemLocale?.() || resolvedSystemLocale()),
          });
        }),
        timeout,
      ]);
      const title = compactTitle(raw);
      log(`generated id=${sessionId} stage=${stage} title=${JSON.stringify(title)}`);
      if (title) await promote(sessionId, title, stage);
    } finally {
      if (timer) clearTimeout(timer);
      if (active.get(key) === abort) active.delete(key);
    }
  };

  const run = (sessionId, source, stage, attempts) => {
    log(`start id=${sessionId} stage=${stage} chars=${source.length}`);
    void generate(sessionId, source, stage).catch((error) => {
      // Release the one-shot marker: a timed-out/failed generation may retry
      // on the next trigger (next completed turn for stage three).
      attempts?.delete(sessionId);
      log(`failed id=${sessionId} stage=${stage} error=${error instanceof Error ? (error.stack || error.message) : String(error)}`);
    });
  };

  function scheduleFirst(session, prompt) {
    const sessionId = String(session?.id || '');
    if (disposed || !sessionId || firstAttempts.has(sessionId)
      || session?.titleLocked === true
      || session?.generatedTitleStage === 'first' || session?.generatedTitleStage === 'third') return false;
    const priorMeaningfulUser = (Array.isArray(session?.messages) ? session.messages : [])
      .some((message) => message?.role === 'user' && titleMessageText(message, 'user'));
    if (priorMeaningfulUser) return false;
    const source = firstTurnTitleSource(prompt);
    if (!source) return false;
    firstAttempts.add(sessionId);
    const greeting = greetingTitle(source);
    if (greeting) {
      log(`generated id=${sessionId} stage=first title=${JSON.stringify(greeting)} deterministic=greeting`);
      void promote(sessionId, greeting, 'first').catch((error) => {
        firstAttempts.delete(sessionId);
        log(`failed id=${sessionId} stage=first error=${error instanceof Error ? (error.stack || error.message) : String(error)}`);
      });
      return true;
    }
    run(sessionId, source, 'first', firstAttempts);
    return true;
  }

  function observeThird(session) {
    const sessionId = String(session?.id || '');
    if (disposed || !sessionId || thirdAttempts.has(sessionId)
      || session?.titleLocked === true
      || session?.generatedTitleStage === 'third') return false;
    const source = thirdTurnTitleSource(session?.messages);
    if (!source) return false;
    thirdAttempts.add(sessionId);
    run(sessionId, source, 'third', thirdAttempts);
    return true;
  }

  function disposeAll() {
    disposed = true;
    for (const abort of active.values()) {
      abort.abort(new Error('Session title generation disposed.'));
    }
    active.clear();
  }

  return { scheduleFirst, observeThird, disposeAll };
}
