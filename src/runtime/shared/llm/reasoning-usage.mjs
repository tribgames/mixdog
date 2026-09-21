// Generation usage reported by the provider, never an estimate of replay bytes.
// Missing is not zero. A mixed aggregate keeps the reported subtotal and marks
// it incomplete instead of inventing usage for providers that omit the field.
function tokenCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function reasoningUsage(usage) {
  if (usage && Object.hasOwn(usage, 'reasoningTokens')) {
    const reasoningTokens = tokenCount(usage.reasoningTokens);
    return {
      reasoningTokens,
      reasoningTokensComplete: reasoningTokens !== null && usage.reasoningTokensComplete !== false,
    };
  }
  const raw = usage?.raw ?? usage;
  const values = [
    raw?.output_tokens_details?.reasoning_tokens,
    raw?.output_tokens_details?.thinking_tokens,
    raw?.completion_tokens_details?.reasoning_tokens,
    raw?.completion_tokens_details?.thinking_tokens,
    raw?.thinking_tokens,
    raw?.thinkingTokens,
    raw?.thoughtsTokenCount,
    raw?.thoughts_token_count,
  ];
  const reasoningTokens = values.map(tokenCount).find((value) => value !== null) ?? null;
  const measured = { reasoningTokens, reasoningTokensComplete: reasoningTokens !== null };
  return raw?.warmup_usage ? combineReasoningUsage(measured, raw.warmup_usage) : measured;
}

export function combineReasoningUsage(left, right) {
  const a = reasoningUsage(left);
  const b = reasoningUsage(right);
  return {
    reasoningTokens:
      a.reasoningTokens === null && b.reasoningTokens === null
        ? null
        : (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    reasoningTokensComplete: a.reasoningTokensComplete && b.reasoningTokensComplete,
  };
}
