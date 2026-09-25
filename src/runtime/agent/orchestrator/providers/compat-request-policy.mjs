// Shared request controls for Chat Completions and Responses gateways.
import { retryDelayLabel } from './retry-classifier.mjs';
import { providerRetryStatusText } from '../../../shared/err-text.mjs';

// withRetry onRetry for the compat stream sends: one stderr line plus a
// display-only 'reconnecting' stage for the UI.
export function compatStreamRetryReporter(label, opts) {
  return ({ attempt, maxAttempts, lastErr, delayMs, delayReason }) => {
    const delayLabel = retryDelayLabel(delayMs, delayReason);
    process.stderr.write(
      `[${label}] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`
    );
    try {
      opts.onStageChange?.('reconnecting', {
        attempt: attempt + 1,
        max: maxAttempts,
        waitMs: delayMs,
        classifier: lastErr?.retryClassifier || lastErr?.code || null,
        message: providerRetryStatusText(lastErr, { attempt: attempt + 1, maxAttempts, delayMs }),
      });
    } catch {
      /* display-only */
    }
  };
}

export function applyCompatToolChoice(body, opts = {}) {
  if (body.tools?.length && opts.toolChoice === 'none') body.tool_choice = 'none';
  return body;
}

export function compatResponsesReplayProvider(provider) {
  return `compat-responses:${provider}`;
}

// Older gateway transcripts used the public OpenAI replay tag. Their opaque
// items have no trustworthy origin, so inheritance keeps the flattened
// conversation instead. Newly scoped envelopes remain available to their owner.
export function inheritedCompatReplayMessages(messages, sourceProvider) {
  if (sourceProvider !== 'opencode-go') return messages;
  return messages.map((message) => {
    if (message?.providerReplay?.provider !== 'openai-responses') return message;
    const { providerReplay: _legacyReplay, ...rest } = message;
    return rest;
  });
}
