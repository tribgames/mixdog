export const FALLBACK_MODELS = [
  { id: 'composer-2.5', name: 'Composer 2.5', reasoning: false, contextWindow: 200_000 },
  { id: 'claude-fable-5-1-high', name: 'Claude Fable 5.1', reasoning: true, contextWindow: 200_000 },
  { id: 'claude-opus-5-high', name: 'Claude Opus 5', reasoning: true, contextWindow: 200_000 },
  { id: 'claude-sonnet-5-medium', name: 'Claude Sonnet 5', reasoning: true, contextWindow: 200_000 },
  { id: 'gpt-5.6-sol-medium', name: 'GPT-5.6 Sol', reasoning: true, contextWindow: 272_000 },
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', reasoning: true, contextWindow: 1_000_000 },
  { id: 'grok-4.6-high', name: 'Grok 4.6', reasoning: true, contextWindow: 128_000 },
];

export const AUTO_MODEL = {
  id: 'auto',
  name: 'Auto',
  reasoning: false,
  contextWindow: 200_000,
};

export function isCursorAutoModelId(id) {
  const value = String(id || '')
    .trim()
    .toLowerCase();
  return value === 'auto' || value === 'default';
}

export function canonicalCursorModelId(id) {
  const value = String(id || '').trim();
  return isCursorAutoModelId(value) ? 'auto' : value;
}

function autoModelRank(model) {
  return (
    (Array.isArray(model?.parameterDefinitions) && model.parameterDefinitions.length ? 2 : 0) +
    (model?.supportsMaxMode === true || model?.supportsNonMaxMode === true || Number(model?.maxContextWindow) > 0
      ? 1
      : 0)
  );
}

// Cursor still ships Auto as both `auto` and `default`. The picker shows the
// display name, so those two rows look identical unless we fold them first.
export function withCanonicalAutoModels(models) {
  const others = [];
  let auto = null;
  for (const model of models || []) {
    if (isCursorAutoModelId(model?.id)) {
      const aliases = [
        ...new Set(
          [...(Array.isArray(model.aliases) ? model.aliases : []), model.id]
            .map((value) => String(value || '').trim())
            .filter((value) => value && value !== 'auto')
        ),
      ];
      const next = {
        ...model,
        id: 'auto',
        name: model.name || AUTO_MODEL.name,
        ...(aliases.length ? { aliases } : {}),
      };
      if (!auto || autoModelRank(next) >= autoModelRank(auto)) auto = next;
      continue;
    }
    others.push(model);
  }
  return [auto || AUTO_MODEL, ...others];
}

export function isCursorEffortParameterId(id) {
  const key = String(id || '')
    .trim()
    .toLowerCase();
  return key === 'effort' || key === 'reasoning' || key.endsWith('_effort') || key.endsWith('-effort');
}

export function normalizeModels(models) {
  const byId = new Map();
  for (const model of models || []) {
    const rawId = String(model.modelId || '').trim();
    if (!rawId) continue;
    const id = canonicalCursorModelId(rawId);
    const aliases = Array.isArray(model.aliases) ? model.aliases : [];
    byId.set(id, {
      id,
      name: isCursorAutoModelId(rawId)
        ? 'Auto'
        : model.displayName || model.displayNameShort || model.displayModelId || aliases[0] || id,
      reasoning: Boolean(model.thinkingDetails),
      contextWindow: 200_000,
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeParameterizedModels(models) {
  const byId = new Map();
  for (const model of models || []) {
    const rawId = String(model.name || model.serverModelName || '').trim();
    if (!rawId || model.isHidden === true) continue;
    const id = canonicalCursorModelId(rawId);
    const parameterDefinitions = (model.parameterDefinitions || [])
      .map((definition) => {
        const booleanValues = definition.parameterType?.booleanParameter?.values || [];
        const enumValues = definition.parameterType?.enumParameter?.values || [];
        const values = [...booleanValues, ...enumValues]
          .filter((value) => value?.blockedByAdminAllowlist !== true && String(value?.value || '').trim())
          .map((value) => ({
            value: String(value.value),
            label: String(
              value.displayName ||
                (booleanValues.length
                  ? String(value.value) === 'true'
                    ? 'On'
                    : String(value.value) === 'false'
                      ? 'Off'
                      : value.value
                  : value.value)
            ),
            ...(value.markdownTooltip ? { description: value.markdownTooltip } : {}),
          }));
        return {
          id: String(definition.id || '').trim(),
          name: String(definition.name || definition.id || '').trim(),
          kind: booleanValues.length ? 'boolean' : 'enum',
          values,
          ...(definition.markdownTooltip ? { description: definition.markdownTooltip } : {}),
        };
      })
      .filter((definition) => definition.id && definition.values.length);
    const variants = (model.variants || []).map((variant) => ({
      parameters: Object.fromEntries(
        (variant.parameterValues || [])
          .map((value) => [String(value.id || '').trim(), String(value.value ?? '')])
          .filter(([key]) => key)
      ),
      displayName: String(variant.displayNameOutsidePicker || variant.displayName || '').trim(),
      maxMode: variant.isMaxMode === true,
      defaultMax: variant.isDefaultMaxConfig === true,
      defaultNonMax: variant.isDefaultNonMaxConfig === true,
      variantString: String(variant.variantStringRepresentation || '').trim(),
      legacySlug: String(variant.legacySlug || '').trim(),
    }));
    const tooltip = model.tooltipData || {};
    const next = {
      id,
      name: isCursorAutoModelId(rawId) ? 'Auto' : model.clientDisplayName || model.inputboxShortModelName || id,
      description: model.tagline || tooltip.markdownContent || tooltip.secondaryText || '',
      contextWindow: Number(model.contextTokenLimit || model.autoContextMaxTokens || 0) || undefined,
      maxContextWindow:
        Number(model.contextTokenLimitForMaxMode || model.autoContextExtendedMaxTokens || 0) || undefined,
      supportsMaxMode: model.supportsMaxMode === true,
      supportsNonMaxMode: model.supportsNonMaxMode === true,
      supportsVision: model.supportsImages === true,
      supportsReasoning:
        parameterDefinitions.some((definition) => isCursorEffortParameterId(definition.id)) ||
        model.supportsThinking === true,
      parameterDefinitions,
      variants,
      aliases: [
        ...new Set(
          [
            ...(model.legacySlugs || []),
            ...(model.idAliases || []),
            ...variants.flatMap((variant) => (variant.legacySlug ? [variant.legacySlug] : [])),
            ...(rawId !== id ? [rawId] : []),
          ]
            .map((value) => String(value || '').trim())
            .filter((value) => value && value !== id)
        ),
      ],
    };
    const current = byId.get(id);
    if (!current || autoModelRank(next) >= autoModelRank(current)) byId.set(id, next);
  }
  return [...byId.values()];
}

function centsToUsd(value) {
  const cents = Number(value);
  return Number.isFinite(cents) ? Math.round(cents) / 100 : 0;
}

function usagePercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return null;
  const normalized = Math.max(0, Math.min(100, percent));
  return Math.round(normalized * 10_000) / 10_000;
}

export function normalizeCursorUsage(usage = {}, planResponse = {}) {
  const plan = planResponse.planInfo || {};
  const included = usage.planUsage || {};
  const spendLimit = usage.spendLimitUsage || {};
  const resetAt = Number(usage.billingCycleEnd || plan.billingCycleEnd || 0) || null;
  const includedLimitCents = Number(included.limit || plan.includedAmountCents || 0);
  const includedUsedCents = Number(included.totalSpend || 0);
  const includedRemainingCents = Number(included.remaining ?? Math.max(0, includedLimitCents - includedUsedCents));
  const hasIncludedBalance = includedLimitCents > 0 || includedUsedCents > 0 || includedRemainingCents > 0;
  const includedBalance = hasIncludedBalance
    ? {
        source: 'cursor-dashboard',
        remainingUsd: centsToUsd(includedRemainingCents),
        usedUsd: centsToUsd(includedUsedCents),
        limitUsd: centsToUsd(includedLimitCents),
      }
    : null;
  const quotaWindows = [];
  const progressWindows = [
    ['Basic', included.autoPercentUsed],
    ['API', included.apiPercentUsed],
  ].filter(([, value]) => Number.isFinite(Number(value)));
  if (progressWindows.length) {
    for (const [label, value] of progressWindows) {
      quotaWindows.push({
        label,
        source: 'cursor-dashboard',
        usedPct: usagePercent(value),
        ...(resetAt ? { resetAt } : {}),
      });
    }
  } else if (hasIncludedBalance) {
    quotaWindows.push({
      label: plan.planName ? `${plan.planName} included` : 'Included usage',
      source: 'cursor-dashboard',
      limitUsd: includedBalance.limitUsd,
      usedUsd: includedBalance.usedUsd,
      remainingUsd: includedBalance.remainingUsd,
      ...(resetAt ? { resetAt } : {}),
    });
  }
  const extraLimitCents = Number(spendLimit.overallLimit || spendLimit.individualLimit || spendLimit.pooledLimit || 0);
  const extraUsedCents = Number(
    spendLimit.overallUsed || spendLimit.individualUsed || spendLimit.pooledUsed || spendLimit.totalSpend || 0
  );
  const extraRemainingCents = Number(
    spendLimit.overallRemaining || spendLimit.individualRemaining || spendLimit.pooledRemaining || 0
  );
  if (extraLimitCents > 0 || extraUsedCents > 0 || extraRemainingCents > 0) {
    quotaWindows.push({
      label: 'Usage-based spend',
      source: 'cursor-dashboard',
      limitUsd: centsToUsd(extraLimitCents),
      usedUsd: centsToUsd(extraUsedCents),
      remainingUsd: centsToUsd(extraRemainingCents),
      ...(resetAt ? { resetAt } : {}),
    });
  }
  return {
    source: 'cursor-dashboard',
    quotaWindows,
    ...(includedBalance ? { balance: includedBalance } : {}),
    plan: {
      name: plan.planName || '',
      price: plan.price || '',
      includedUsd: centsToUsd(plan.includedAmountCents || includedLimitCents),
      resetAt,
    },
    enabled: usage.enabled === true,
    detail: usage.displayMessage || '',
  };
}
