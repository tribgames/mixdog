import { normalizeToolEnvelope } from '../../src/runtime/agent/orchestrator/session/tool-envelope.mjs';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertOk(name, result, pattern = null) {
  const text = String(normalizeToolEnvelope(result).result || '');
  if (!text || /^Error[\s:[]/.test(text)) {
    throw new Error(`${name} failed:\n${text}`);
  }
  if (pattern && !pattern.test(text)) {
    throw new Error(`${name} returned unexpected output:\n${text.slice(0, 1000)}`);
  }
  return text;
}

export async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
