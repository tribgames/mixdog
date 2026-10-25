// The failed-turn record shared by the live turn close (tui/session/turn.mjs)
// and the durable turn end (manager/ask-turn-failure.mjs), so a reopened
// session shows the same failure, reason and quota stop as the live one.
import { errText } from '../../../shared/err-text.mjs';
import { safeErrorDetails } from '../../../shared/error-presentation.mjs';
import { providerDisplayName } from '../../../shared/provider-display-name.mjs';
import { providerErrorKind } from '../providers/provider-error-kind.mjs';
import { toolErrorDisplay } from './transcript-restore/tool-result-text.mjs';

/**
 * `{ providerKind, errorKind, quota, detail, errorDetails }` for one turn
 * error. `quota` is null unless the pool validated an exhaustion or the
 * provider named the real reset time; `route` fills its provider/model.
 */
export function turnFailureRecord(error, route = {}) {
  // Presentation only: legacy untyped failure text may still name a usage limit.
  const providerKind = providerErrorKind(error, { legacyQuotaWording: true });
  const errorKind = {
    kind: providerKind.kind,
    code: providerKind.code,
    status: providerKind.status,
    retryAfterMs: providerKind.retryAfterMs,
    resetAt: providerKind.resetAt,
  };
  const exhausted = error?.quotaExhausted;
  const resetKnown = providerKind.kind === 'quota_exhausted' && Number.isFinite(providerKind.resetAt);
  let quota = null;
  if ((exhausted && typeof exhausted === 'object') || resetKnown) {
    const source = exhausted && typeof exhausted === 'object' ? exhausted : {};
    let resetAt = null;
    if (Number.isFinite(source.resetAt)) resetAt = source.resetAt;
    else if (Number.isFinite(providerKind.resetAt)) resetAt = providerKind.resetAt;
    quota = {
      provider: String(source.provider || route.provider || ''),
      model: String(source.model || route.model || ''),
      resetAt,
    };
  }
  return {
    providerKind,
    errorKind,
    quota,
    // The provider is named from the turn's own route, never from the error.
    detail: toolErrorDisplay(error, 'turn', {
      providerLabel: route.provider ? providerDisplayName(route.provider) : undefined,
    }).replace(/^Error:\s*/i, ''),
    errorDetails: safeErrorDetails(errText(error)),
  };
}
