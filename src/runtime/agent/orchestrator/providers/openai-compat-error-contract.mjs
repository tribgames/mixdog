/**
 * openai-compat-error-contract.mjs — the error contract of the OpenAI-compatible
 * provider boundary: `status`, lowercased `code` (from the wire error's `code`
 * or `type`), `headers`, `retryAfterMs` and `resetAt` when the provider sent
 * them. Evidence is structural only; message text is never parsed.
 */
import { retryAfterMsFromError, typedStatusFrom } from './retry-classifier.mjs';

const lowered = (value) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '');

// Epoch seconds, epoch ms or an ISO date → epoch ms; `resets_in_seconds` is relative.
function resetAtFrom(wire, now) {
  const inSeconds = Number(wire?.resets_in_seconds);
  if (wire?.resets_in_seconds != null && Number.isFinite(inSeconds) && inSeconds >= 0) {
    return now + Math.ceil(inSeconds * 1000);
  }
  const raw = wire?.resets_at ?? wire?.reset_at ?? wire?.metadata?.resets_at;
  if (raw == null || raw === '') return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

/** Stamp the boundary contract onto a provider error in place and return it. */
export function applyCompatErrorContract(err, detail = err?.error ?? err?.providerError, now = Date.now()) {
  if (!err || typeof err !== 'object') return err;
  try {
    const wire = detail && typeof detail === 'object' ? detail : null;
    const status = typedStatusFrom(err, err.response, wire);
    if (status && !(Number(err.status) >= 100)) err.status = status;
    const wireCode = lowered(wire?.code) || lowered(wire?.type) || lowered(err.type);
    // Keep an errno / SDK-local code (ECONNRESET, ...) that is not the wire code.
    if (wireCode && (typeof err.code !== 'string' || !err.code.trim() || lowered(err.code) === wireCode)) {
      err.code = wireCode;
    }
    if (!err.headers && err.response?.headers) err.headers = err.response.headers;
    if (!Number.isFinite(err.retryAfterMs)) {
      const retryAfterMs = retryAfterMsFromError(err);
      if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
    }
    if (!Number.isFinite(err.resetAt)) {
      const resetAt = resetAtFrom(wire, now);
      if (resetAt) err.resetAt = resetAt;
    }
  } catch {
    /* the contract is best-effort; the original error stays authoritative */
  }
  return err;
}
