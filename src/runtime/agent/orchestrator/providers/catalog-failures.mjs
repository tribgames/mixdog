// The latest catalog failure of each provider, kept so a view that lists a
// provider's models can say WHY the list is empty (expired key, spent credits,
// timeout) instead of showing a silent 0/0. Cleared by the provider's next
// answer and by an account change.
import { safeErrorDetails } from '../../../shared/error-presentation.mjs';
import { providerErrorKind } from './provider-error-kind.mjs';

const MESSAGE_LIMIT = 300;
const failures = new Map();

/** Records a provider's catalog failure (`error`) or its recovery (no error). */
export function recordProviderCatalogOutcome(name, error) {
  if (!error) {
    failures.delete(name);
    return;
  }
  const reason = typeof error.providerError?.message === 'string' ? error.providerError.message : '';
  const text = safeErrorDetails(reason ? `${error.message}: ${reason}` : error.message);
  failures.set(name, {
    // Plain text, never a JSON envelope: describeError reads the kind below.
    message: text.replace(/\s+/g, ' ').slice(0, MESSAGE_LIMIT),
    errorKind: providerErrorKind(error),
    at: Date.now(),
  });
}

/** `{ message, errorKind, at }` of the provider's latest failure, or null. */
export function providerCatalogFailure(name) {
  return failures.get(name) ?? null;
}

export function clearProviderCatalogFailures() {
  failures.clear();
}
