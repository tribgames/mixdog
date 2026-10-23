// Reviewed Devin model families: logical models the Cascade catalog serves as
// one wire uid per effort tier. Each family lists its member uids in default
// priority order, the uid each effort routes to ('off' = thinking disabled),
// and its effort ladder. Families the server also declares through
// `modelFamilyMetadata` are collapsed from that live metadata first; this
// table then covers accounts and models that ship none.

const SUFFIX_ROUTE = Object.freeze({
  none: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
});

// `${base}-${tier}${lane}` members for every tier, routed by their tier.
function ladder(base, tiers, lane = '') {
  const members = tiers.map((tier) => `${base}-${tier}${lane}`);
  const routing = Object.fromEntries(tiers.map((tier, index) => [SUFFIX_ROUTE[tier], members[index]]));
  return { members, routing };
}

// `${PREFIX}_${TIER}` enum-style members (e.g. MODEL_GPT_5_2_HIGH).
function enumLadder(prefix, tiers) {
  const members = tiers.map((tier) => `${prefix}_${tier.toUpperCase()}`);
  const routing = Object.fromEntries(tiers.map((tier, index) => [SUFFIX_ROUTE[tier], members[index]]));
  return { members, routing };
}

function family(id, name, { members, routing }, { efforts, requiresEffort = false, defaultLevel, defaultMember } = {}) {
  return Object.freeze({
    id,
    name,
    members,
    routing,
    ...(defaultMember ? { defaultMember } : {}),
    thinking: {
      mode: 'effort',
      efforts,
      ...(defaultLevel ? { defaultLevel } : {}),
      ...(requiresEffort ? { requiresEffort: true } : {}),
    },
  });
}

const CLAUDE_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE = { efforts: CLAUDE_TIERS, requiresEffort: true };
const GPT_TIERS = ['none', 'low', 'medium', 'high', 'xhigh'];
const GPT = { efforts: ['low', 'medium', 'high', 'xhigh'] };
const GPT_REQUIRED = { efforts: ['low', 'medium', 'high', 'xhigh'], requiresEffort: true };
const GPT_56_TIERS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const GPT_56 = { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
const FLASH_TIERS = ['minimal', 'low', 'medium', 'high'];
const FLASH = { efforts: FLASH_TIERS, requiresEffort: true };

export const DEVIN_REVIEWED_FAMILIES = Object.freeze([
  family('claude-opus-5', 'Claude Opus 5', ladder('claude-opus-5', CLAUDE_TIERS), CLAUDE),
  family('claude-opus-5-fast', 'Claude Opus 5 Fast', ladder('claude-opus-5', CLAUDE_TIERS, '-fast'), CLAUDE),
  family('claude-fable-5', 'Claude Fable 5', ladder('claude-5-fable', CLAUDE_TIERS), CLAUDE),
  family('claude-sonnet-5', 'Claude Sonnet 5', ladder('claude-sonnet-5', CLAUDE_TIERS), CLAUDE),
  family('claude-opus-4-7', 'Claude Opus 4.7', ladder('claude-opus-4-7', CLAUDE_TIERS), CLAUDE),
  family('claude-opus-4-7-fast', 'Claude Opus 4.7 Fast', ladder('claude-opus-4-7', CLAUDE_TIERS, '-fast'), CLAUDE),
  family('claude-opus-4-8', 'Claude Opus 4.8', ladder('claude-opus-4-8', CLAUDE_TIERS), CLAUDE),
  family('claude-opus-4-8-fast', 'Claude Opus 4.8 Fast', ladder('claude-opus-4-8', CLAUDE_TIERS, '-fast'), CLAUDE),
  family('gpt-5-2', 'GPT-5.2', enumLadder('MODEL_GPT_5_2', GPT_TIERS), GPT),
  family('gpt-5-3-codex', 'GPT-5.3 Codex', ladder('gpt-5-3-codex', GPT_TIERS.slice(1)), GPT_REQUIRED),
  family(
    'gpt-5-3-codex-fast',
    'GPT-5.3 Codex Fast',
    ladder('gpt-5-3-codex', GPT_TIERS.slice(1), '-priority'),
    GPT_REQUIRED
  ),
  family('gpt-5-4', 'GPT-5.4', ladder('gpt-5-4', GPT_TIERS), GPT),
  family('gpt-5-4-fast', 'GPT-5.4 Fast', ladder('gpt-5-4', GPT_TIERS, '-priority'), GPT),
  family('gpt-5-4-mini', 'GPT-5.4 Mini', ladder('gpt-5-4-mini', GPT_TIERS.slice(1)), GPT_REQUIRED),
  family('gpt-5-5', 'GPT-5.5', ladder('gpt-5-5', GPT_TIERS), GPT),
  family('gpt-5-5-fast', 'GPT-5.5 Fast', ladder('gpt-5-5', GPT_TIERS, '-priority'), GPT),
  family('gpt-5-6-luna', 'GPT-5.6 Luna', ladder('gpt-5-6-luna', GPT_56_TIERS), GPT_56),
  family('gpt-5-6-luna-fast', 'GPT-5.6 Luna Fast', ladder('gpt-5-6-luna', GPT_56_TIERS, '-priority'), GPT_56),
  family('gpt-5-6-sol', 'GPT-5.6 Sol', ladder('gpt-5-6-sol', GPT_56_TIERS), GPT_56),
  family('gpt-5-6-sol-fast', 'GPT-5.6 Sol Fast', ladder('gpt-5-6-sol', GPT_56_TIERS, '-priority'), GPT_56),
  family('gpt-5-6-terra', 'GPT-5.6 Terra', ladder('gpt-5-6-terra', GPT_56_TIERS), GPT_56),
  family('gpt-5-6-terra-fast', 'GPT-5.6 Terra Fast', ladder('gpt-5-6-terra', GPT_56_TIERS, '-priority'), GPT_56),
  family('kimi-k3', 'Kimi K3', ladder('kimi-k3', ['low', 'high', 'max']), {
    efforts: ['low', 'high', 'max'],
    requiresEffort: true,
  }),
  family(
    'swe-1-7',
    'SWE-1.7',
    { members: ['swe-1-7-medium', 'swe-1-7'], routing: { medium: 'swe-1-7-medium', max: 'swe-1-7' } },
    { efforts: ['medium', 'max'], requiresEffort: true }
  ),
  family('grok-4-5', 'Grok 4.5', ladder('grok-4-5', ['low', 'medium', 'high']), {
    efforts: ['low', 'medium', 'high'],
    requiresEffort: true,
  }),
  family('inkling', 'Inkling', ladder('inkling', GPT_56_TIERS), GPT_56),
  family('gemini-3-1-pro', 'Gemini 3.1 Pro', ladder('gemini-3-1-pro', ['low', 'high']), {
    efforts: ['low', 'high'],
    requiresEffort: true,
  }),
  family('gemini-3-5-flash', 'Gemini 3.5 Flash', ladder('gemini-3-5-flash', FLASH_TIERS), FLASH),
  family('gemini-3-6-flash', 'Gemini 3.6 Flash', ladder('gemini-3-6-flash', FLASH_TIERS), FLASH),
  family('gemini-3-flash', 'Gemini 3 Flash', enumLadder('MODEL_GOOGLE_GEMINI_3_0_FLASH', FLASH_TIERS), FLASH),
  family(
    'glm-5-2',
    'GLM-5.2',
    { members: ['glm-5-2', 'glm-5-2-none', 'glm-5-2-max'], routing: { high: 'glm-5-2', xhigh: 'glm-5-2' } },
    { efforts: ['high', 'xhigh'], requiresEffort: true }
  ),
  family(
    'glm-5-2-1m',
    'GLM-5.2 1M',
    {
      members: ['glm-5-2-none-1m', 'glm-5-2-1m', 'glm-5-2-max-1m'],
      routing: { off: 'glm-5-2-none-1m', high: 'glm-5-2-1m', xhigh: 'glm-5-2-max-1m' },
    },
    { efforts: ['high', 'xhigh'] }
  ),
  family(
    'gemini-3-7-flash',
    'Gemini 3.7 Flash',
    {
      members: ['gemini-3-7-flash-medium', 'gemini-3-7-flash-minimal', 'gemini-3-7-flash-low', 'gemini-3-7-flash-high'],
      routing: ladder('gemini-3-7-flash', FLASH_TIERS).routing,
    },
    { ...FLASH, defaultLevel: 'medium', defaultMember: 'gemini-3-7-flash-medium' }
  ),
  family(
    'swe-1-7-lightning',
    'SWE-1.7 Lightning',
    {
      members: ['swe-1-7-lightning-medium', 'swe-1-7-lightning'],
      routing: { medium: 'swe-1-7-lightning-medium', max: 'swe-1-7-lightning' },
    },
    {
      efforts: ['medium', 'max'],
      requiresEffort: true,
      defaultLevel: 'medium',
      defaultMember: 'swe-1-7-lightning-medium',
    }
  ),
  family(
    'grok-4-6',
    'Grok 4.6',
    {
      members: ['grok-4-6-medium', 'grok-4-6-low', 'grok-4-6-high', 'grok-4-6-xhigh'],
      routing: ladder('grok-4-6', ['low', 'medium', 'high', 'xhigh']).routing,
    },
    {
      efforts: ['low', 'medium', 'high', 'xhigh'],
      requiresEffort: true,
      defaultLevel: 'medium',
      defaultMember: 'grok-4-6-medium',
    }
  ),
  ...['flash', 'pro'].map((size) =>
    family(
      `deepseek-v4-${size}`,
      `DeepSeek V4 ${size === 'pro' ? 'Pro' : 'Flash'}`,
      {
        members: [`deepseek-v4-${size}-high`, `deepseek-v4-${size}-low`, `deepseek-v4-${size}-max`],
        routing: ladder(`deepseek-v4-${size}`, ['low', 'high', 'max']).routing,
      },
      {
        efforts: ['low', 'high', 'max'],
        requiresEffort: true,
        defaultLevel: 'high',
        defaultMember: `deepseek-v4-${size}-high`,
      }
    )
  ),
  family(
    'nemotron-3-ultra',
    'Nemotron 3 Ultra',
    {
      members: ['nemotron-3-ultra-high', 'nemotron-3-ultra-none', 'nemotron-3-ultra-medium'],
      routing: ladder('nemotron-3-ultra', ['none', 'medium', 'high']).routing,
    },
    { efforts: ['medium', 'high'], defaultLevel: 'high', defaultMember: 'nemotron-3-ultra-high' }
  ),
  // A single-uid rename: no effort surface.
  Object.freeze({ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', members: ['MODEL_PRIVATE_11'], routing: {} }),
]);
