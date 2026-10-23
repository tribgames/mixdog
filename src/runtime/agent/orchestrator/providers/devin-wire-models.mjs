// Devin model discovery (GetCliModelConfigs) and catalog normalization.
import { DEVIN_REVIEWED_FAMILIES } from './devin-wire-families.mjs';
import { DEVIN_ENUMS } from './devin-wire-protobuf.mjs';
import { DEVIN_DEFAULT_BASE_URL, devinRequestMetadata, normalizeDevinSessionToken } from './devin-wire-session.mjs';
import { DevinWireError, devinUnary } from './devin-wire-transport.mjs';

export const DEVIN_GET_CLI_MODEL_CONFIGS_PATH = '/exa.api_server_pb.ApiServerService/GetCliModelConfigs';
export const DEVIN_DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEVIN_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

const { DisplayOption } = DEVIN_ENUMS;
// Requested for completeness, never surfaced.
const INTERNAL_DISPLAYS = new Set([DisplayOption.QUICK_REVIEW, DisplayOption.INTERNAL_DEFAULT]);
// These lanes advertise images but their backend drops them silently.
const IMAGE_BLIND_UIDS = new Set(['swe-1-6', 'swe-1-6-fast']);

const REASONING_LABEL_RE = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_RE = /\bno thinking\b/i;

function supportsReasoning(config) {
  const features = config.modelInfo?.modelFeatures;
  if (features) return features.supportsThinking === true;
  const label = String(config.label || '');
  return !NO_REASONING_LABEL_RE.test(label) && REASONING_LABEL_RE.test(label);
}

// Router slots (`adaptive`) and harness-backed composites (`fusion`, Fusion
// pairings) dispatch to other models; they are never effort tiers.
function isRouter(config) {
  return config.modelInfo?.displayOption === DisplayOption.MODEL_ROUTER || config.modelInfo?.isModelRouter === true;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// Effort tiers least to most intensive. Routing keys add 'off' (thinking
// disabled), which rows expose under Mixdog's name 'none'.
const THINKING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ROUTING_KEYS = Object.freeze(['off', ...THINKING_EFFORTS]);
// Ladder of an automatically paired `X` / `X-thinking` family.
const PAIR_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high']);

const { ModelDimensionKind } = DEVIN_ENUMS;
const COST_DENOMINATOR_RE = /(\d+(?:\.\d+)?)\s*([kmb])?/i;
const COST_DENOMINATOR_SCALE = Object.freeze({ k: 1_000, m: 1_000_000, b: 1_000_000_000 });

function costDenominatorTokens(denominator) {
  const match = COST_DENOMINATOR_RE.exec(String(denominator || ''));
  if (match === null) return 1_000_000;
  const scale = match[2] === undefined ? 1 : (COST_DENOMINATOR_SCALE[match[2].toLowerCase()] ?? 1);
  const tokens = Number(match[1]) * scale;
  return tokens > 0 ? tokens : 1_000_000;
}

// Per-million-token rates from cost dimensions. Composite configs append their
// components' cards after a `Sidekick` marker; reading stops there.
function modelCost(config) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const dimension of config.modelDimensions || []) {
    const label = String(dimension.label || '')
      .trim()
      .toLowerCase();
    if (label === 'sidekick') break;
    if (dimension.kind !== ModelDimensionKind.COST && dimension.kind !== ModelDimensionKind.COST_FUZZY) continue;
    // Float32 values: round off the noise at sub-cent precision.
    const perMillion =
      Math.round(((Number(dimension.value || 0) * 1_000_000) / costDenominatorTokens(dimension.denominator)) * 1e6) /
      1e6;
    if (label === 'input') cost.input = perMillion;
    else if (label === 'cached input') cost.cacheRead = perMillion;
    else if (label === 'output') cost.output = perMillion;
  }
  return cost;
}

// One config as an uncollapsed model keyed on its wire uid.
function modelSpec(config, uid, assignModelRouter) {
  const features = config.modelInfo?.modelFeatures;
  const supportsImages =
    (features ? features.supportsImages === true : config.supportsImages === true) && !IMAGE_BLIND_UIDS.has(uid);
  return {
    id: uid,
    name: String(config.label || '').trim() || uid,
    description: String(config.description || '').trim(),
    reasoning: supportsReasoning(config),
    input: supportsImages ? ['text', 'image'] : ['text'],
    // Router configs ship no features; Cascade serves only tool-calling models.
    supportsTools: features ? features.supportsToolCalls === true : true,
    supportsParallelToolCalls: features?.supportsParallelToolCalls === true,
    cost: modelCost(config),
    contextWindow: positive(config.maxTokens) || DEVIN_DEFAULT_CONTEXT_WINDOW,
    maxTokens: positive(config.modelInfo?.maxOutputTokens) || DEVIN_DEFAULT_MAX_OUTPUT_TOKENS,
    ...(assignModelRouter ? { router: true } : {}),
    // Presentation flags, kept only when the server sets them.
    ...(config.isNew ? { isNew: true } : {}),
    ...(config.isBeta ? { isBeta: true } : {}),
    ...(config.isRecommended ? { isRecommended: true } : {}),
  };
}

// Lead chat uid of a Fusion pairing `fusion-<lead>[-fast]-sidekick-<sidekick>`:
// an exact live lead wins, else `-fast` prefers the `-priority` lane, then the
// standard lane. undefined = not a pairing; null = pairing with no live lead.
function fusionLeadUid(uid, liveConfigs) {
  if (!uid.startsWith('fusion-')) return undefined;
  const cut = uid.indexOf('-sidekick-');
  if (cut <= 'fusion-'.length) return undefined;
  const lead = uid.slice('fusion-'.length, cut);
  if (liveConfigs.has(lead)) return lead;
  if (lead.endsWith('-fast')) {
    const base = lead.slice(0, -'-fast'.length);
    if (liveConfigs.has(`${base}-priority`)) return `${base}-priority`;
    if (liveConfigs.has(base)) return base;
  }
  return null;
}

// Only the lead runs a Fusion pairing, so the row budgets against the lead.
function routeFusionLead(spec, lead) {
  spec.requestModelId = lead.id;
  for (const key of ['reasoning', 'input', 'supportsTools', 'supportsParallelToolCalls', 'cost', 'contextWindow']) {
    spec[key] = lead[key];
  }
  spec.maxTokens = lead.maxTokens;
}

const FAMILY_EFFORT_KEYS = new Set(['effort', 'reasoning effort']);
const FAMILY_EFFORT_BY_NAME = Object.freeze({
  none: 'off',
  nothinking: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
});

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Files a config under its server-declared family lane (`modelFamilyMetadata`).
// Fast service and 1M context are separate lanes; effort is the lane's axis.
function collectFamilyLane(lanes, config, uid) {
  const metadata = config.modelFamilyMetadata;
  if (!metadata) return;
  const label = String(metadata.modelFamilyLabel || '').trim();
  if (!label) return;
  let effort;
  let thinking;
  let fast = false;
  let oneMillionContext = false;
  for (const entry of metadata.entries || []) {
    const value = entry.value;
    if (value === undefined) continue;
    const key = String(entry.key || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const order = value.order ?? 0;
    if (key === 'fast mode') fast = order === 1;
    else if (key === 'thinking') thinking = order === 1;
    else if (key === '1m context') oneMillionContext = order === 1;
    else if (FAMILY_EFFORT_KEYS.has(key)) {
      effort =
        FAMILY_EFFORT_BY_NAME[
          String(value.name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '')
        ];
    }
  }
  // Paired non-thinking/thinking configs share an effort label; the explicit
  // Thinking axis decides which one is the off route.
  if (thinking === false) effort = 'off';
  const baseId = slug(label);
  if (!baseId) return;
  const laneId = `${baseId}${oneMillionContext ? '-1m' : ''}${fast ? '-fast' : ''}`;
  let lane = lanes.get(laneId);
  if (!lane) {
    lane = {
      id: laneId,
      name: `${label}${oneMillionContext ? ' 1M' : ''}${fast ? ' Fast' : ''}`,
      members: [],
      routing: {},
    };
    lanes.set(laneId, lane);
  }
  lane.members.push(uid);
  if (lane.defaultMember === undefined && (config.isDefaultModelInFamily || metadata.isDefaultModelInFamily)) {
    lane.defaultMember = uid;
  }
  if (effort !== undefined && lane.routing[effort] === undefined) lane.routing[effort] = uid;
}

// Lanes with an effort ladder become families; the server default member is
// hoisted first. A lane with only an off route stays uncollapsed.
function dynamicFamilies(lanes) {
  const families = [];
  for (const lane of lanes) {
    const efforts = THINKING_EFFORTS.filter((effort) => lane.routing[effort] !== undefined);
    if (!efforts.length) continue;
    const { defaultMember } = lane;
    const members =
      defaultMember === undefined
        ? lane.members
        : [defaultMember, ...lane.members.filter((uid) => uid !== defaultMember)];
    const defaultLevel =
      defaultMember === undefined ? undefined : efforts.find((effort) => lane.routing[effort] === defaultMember);
    families.push({
      id: lane.id,
      name: lane.name,
      members,
      routing: lane.routing,
      ...(defaultMember !== undefined ? { defaultMember } : {}),
      thinking: {
        mode: 'effort',
        efforts,
        ...(defaultLevel !== undefined ? { defaultLevel } : {}),
        // No wire uid serves the family with thinking off: effort is mandatory.
        ...(lane.routing.off === undefined ? { requiresEffort: true } : {}),
      },
    });
  }
  return families;
}

function isCollapsedSpec(spec) {
  return spec !== undefined && (spec.requestModelId !== undefined || spec.thinking?.effortRouting !== undefined);
}

// Points an already-collapsed model at the family's declared default member
// when that member is one of its live routes.
function reconcileDefaultMember(spec, family, presentMembers) {
  const { defaultMember } = family;
  if (defaultMember === undefined || defaultMember === spec.id) return spec;
  const target =
    presentMembers === undefined || presentMembers.has(defaultMember)
      ? defaultMember
      : family.members.find((id) => presentMembers.has(id));
  if (target === undefined || spec.requestModelId === target) return spec;
  const routing = spec.thinking?.effortRouting;
  if (!routing) return spec;
  return ROUTING_KEYS.some((key) => routing[key] === target) ? { ...spec, requestModelId: target } : spec;
}

// Replaces each family's live members with one logical model at the position
// of the family's first occurrence; other models pass through in order.
function collapseFamilies(specs, families) {
  const byId = new Map();
  for (const spec of specs) if (!byId.has(spec.id)) byId.set(spec.id, spec);
  const replacement = new Map();
  const familyIdBySpecId = new Map();

  for (const family of families) {
    const existing = byId.get(family.id);
    const existingCollapsed = isCollapsedSpec(existing);
    const rawPresent = family.members.filter((id) => byId.has(id) && !(id === family.id && existingCollapsed));
    if (!rawPresent.length) {
      // Already collapsed upstream of this table: only the default may move.
      if (existingCollapsed) {
        const refreshed = reconcileDefaultMember(existing, family);
        if (refreshed !== existing) {
          familyIdBySpecId.set(family.id, family.id);
          replacement.set(family.id, refreshed);
        }
      }
      continue;
    }
    for (const id of rawPresent) familyIdBySpecId.set(id, family.id);
    if (existing) familyIdBySpecId.set(family.id, family.id);
    const presentSet = new Set(rawPresent);
    if (existingCollapsed) {
      // Mixed input: the collapsed model wins and raw members are dropped.
      replacement.set(family.id, reconcileDefaultMember(existing, family, presentSet));
      continue;
    }
    const memberSpecs = rawPresent.map((id) => byId.get(id));
    const [firstMember] = memberSpecs;
    const routing = {};
    let hasRouting = false;
    let hasEffortRoute = false;
    for (const key of ROUTING_KEYS) {
      const target = family.routing[key];
      if (target === undefined || !presentSet.has(target)) continue;
      routing[key] = target;
      hasRouting = true;
      if (key !== 'off') hasEffortRoute = true;
    }
    // Routing efforts to a live member means the family reasons.
    const reasoning = memberSpecs.some((spec) => spec.reasoning) || hasEffortRoute;
    const thinking = family.thinking ? { ...family.thinking } : undefined;
    if (thinking && hasRouting) thinking.effortRouting = routing;
    const input = [];
    if (memberSpecs.some((spec) => spec.input.includes('text'))) input.push('text');
    if (memberSpecs.some((spec) => spec.input.includes('image'))) input.push('image');
    const collapsed = {
      ...firstMember,
      id: family.id,
      name: family.name,
      reasoning,
      input,
      contextWindow: Math.max(...memberSpecs.map((spec) => spec.contextWindow)),
      maxTokens: Math.max(...memberSpecs.map((spec) => spec.maxTokens)),
    };
    if (memberSpecs.some((spec) => spec.isProviderDefault === true)) collapsed.isProviderDefault = true;
    const defaultWireId =
      family.defaultMember !== undefined && presentSet.has(family.defaultMember) ? family.defaultMember : rawPresent[0];
    if (defaultWireId === family.id) delete collapsed.requestModelId;
    else collapsed.requestModelId = defaultWireId;
    // A single-uid family keeps `reasoning` but has no tier to select.
    if (reasoning && thinking) collapsed.thinking = thinking;
    else delete collapsed.thinking;
    replacement.set(family.id, collapsed);
  }

  if (!replacement.size) return [...specs];
  const emitted = new Set();
  const out = [];
  for (const spec of specs) {
    const familyId = familyIdBySpecId.get(spec.id);
    if (familyId === undefined) {
      out.push(spec);
      continue;
    }
    if (emitted.has(familyId)) continue;
    emitted.add(familyId);
    const familySpec = replacement.get(familyId);
    if (familySpec) out.push(familySpec);
  }
  return out;
}

// Member -> family id for the reviewed table (case-insensitive; a member that
// is its own family id is not an alias), plus the set of family ids.
const REVIEWED_MEMBER_FAMILY = new Map();
const REVIEWED_FAMILY_IDS = new Set();
for (const family of DEVIN_REVIEWED_FAMILIES) {
  REVIEWED_FAMILY_IDS.add(family.id);
  for (const member of family.members) {
    const key = member.toLowerCase();
    if (member !== family.id && !REVIEWED_MEMBER_FAMILY.has(key)) REVIEWED_MEMBER_FAMILY.set(key, family.id);
  }
}
const isReviewedClaim = (id) => REVIEWED_MEMBER_FAMILY.has(id.toLowerCase()) || REVIEWED_FAMILY_IDS.has(id);

const PAIR_TOKENS = Object.freeze(['thinking', 'reasoning', 'reasoner']);
const isTokenChar = (code) => (code >= 48 && code <= 57) || (code >= 97 && code <= 122);

// Bare twin id of a thinking variant: a trailing `-thinking`, else the first
// `-thinking` / `-reasoning` / `-reasoner` token that is not negated
// (`non-thinking`, `no-thinking`) and not part of a longer word.
function thinkingTwinBaseId(id) {
  const lower = id.toLowerCase();
  if (lower.endsWith('-thinking')) return id.slice(0, -'-thinking'.length) || undefined;
  for (const token of PAIR_TOKENS) {
    const needle = `-${token}`;
    let from = 0;
    while (from < lower.length) {
      const index = lower.indexOf(needle, from);
      if (index === -1) break;
      const end = index + needle.length;
      let wordStart = index;
      while (wordStart > 0 && isTokenChar(lower.charCodeAt(wordStart - 1))) wordStart--;
      const preceding = lower.slice(wordStart, index);
      if (!isTokenChar(lower.charCodeAt(end)) && preceding !== 'non' && preceding !== 'no') {
        const stripped = id.slice(0, index) + id.slice(end);
        return stripped || undefined;
      }
      from = index + 1;
    }
  }
  return undefined;
}

// Every live `X` + `X-thinking` pair not claimed by the reviewed table, unless
// both carry real, different prices (distinct SKUs). Off routes to `X`, every
// effort to the thinking twin.
function thinkingPairFamilies(specs) {
  const byId = new Map();
  for (const spec of specs) if (!byId.has(spec.id)) byId.set(spec.id, spec);
  const families = [];
  for (const spec of specs) {
    const baseId = thinkingTwinBaseId(spec.id);
    if (baseId === undefined || baseId === spec.id) continue;
    const base = byId.get(baseId);
    if (!base || isReviewedClaim(spec.id) || isReviewedClaim(baseId)) continue;
    const priced = (cost) => cost.input !== 0 || cost.output !== 0;
    if (
      priced(spec.cost) &&
      priced(base.cost) &&
      ['input', 'output', 'cacheRead', 'cacheWrite'].some((key) => spec.cost[key] !== base.cost[key])
    ) {
      continue;
    }
    // A surface already carried by either twin wins. Otherwise no per-class
    // ladder applies: Devin trusts only the thinking surface its catalog
    // reports, and raw configs report none, so every class gets the fallback.
    const baked = spec.thinking ?? base.thinking;
    let surface = { mode: 'budget', efforts: PAIR_EFFORTS };
    if (baked?.efforts?.length) {
      const { effortRouting: _routing, requiresEffort: _required, ...rest } = baked;
      surface = rest;
    }
    const routing = { off: base.id };
    for (const effort of surface.efforts) routing[effort] = spec.id;
    families.push({ id: base.id, name: base.name, members: [base.id, spec.id], routing, thinking: surface });
  }
  return families;
}

function toRow(spec) {
  const row = {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxTokens,
    supportsVision: spec.input.includes('image'),
    supportsTools: spec.supportsTools,
    supportsParallelToolCalls: spec.supportsParallelToolCalls,
    supportsReasoning: spec.reasoning,
    reasoning: spec.reasoning,
    uid: spec.requestModelId ?? spec.id,
  };
  const thinking = spec.thinking;
  if (thinking?.efforts?.length) {
    const routing = thinking.effortRouting || {};
    // Efforts whose member the account does not serve run on the default uid.
    const levels = [...(routing.off ? ['off'] : []), ...thinking.efforts];
    row.reasoningLevels = levels.map((level) => (level === 'off' ? 'none' : level));
    row.effortUids = Object.fromEntries(
      levels.map((level) => [level === 'off' ? 'none' : level, routing[level] ?? row.uid])
    );
    if (thinking.defaultLevel) row.defaultEffort = thinking.defaultLevel;
    if (thinking.requiresEffort) row.requiresEffort = true;
  }
  if (spec.router) row.router = true;
  if (spec.isProviderDefault) row.isDefault = true;
  for (const flag of ['isNew', 'isBeta', 'isRecommended']) if (spec[flag]) row[flag] = true;
  return row;
}

// Catalog rows for the account, sorted by id. Each enabled, visible uid
// becomes a model; effort siblings collapse into one logical model, from
// server family metadata first, then the reviewed family table, then live
// `X` / `X-thinking` pairs. `defaultModelUid` (the account's starting model,
// carried on fetchDevinModels' result) marks the default row and, when it is
// one effort tier of a family, that family's default effort and uid.
export function normalizeDevinModels(configs, { defaultModelUid = configs?.defaultModelUid } = {}) {
  const accountDefaultUid = String(defaultModelUid || '').trim();
  const liveConfigs = new Map();
  for (const config of configs || []) {
    const uid = String(config?.modelUid || '').trim();
    if (config && config.disabled !== true && uid && !liveConfigs.has(uid)) liveConfigs.set(uid, config);
  }
  const specs = [];
  const seen = new Set();
  const lanes = new Map();
  for (const config of configs || []) {
    if (!config || config.disabled === true) continue;
    const displayOption = config.modelInfo?.displayOption ?? DisplayOption.UNSPECIFIED;
    if (INTERNAL_DISPLAYS.has(displayOption)) continue;
    const uid = String(config.modelUid || '').trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const router = isRouter(config);
    // Harness-less routers (`adaptive`) need AssignModel; harness-backed
    // composites (`fusion`) are themselves chat uids.
    const assignModelRouter = router && (config.modelInfo?.harnessUids?.length ?? 0) === 0;
    // A Fusion pairing chats on its lead uid; without a live lead it is unservable.
    const lead = fusionLeadUid(uid, liveConfigs);
    if (lead === null) continue;
    const spec = modelSpec(config, uid, assignModelRouter);
    if (lead !== undefined) routeFusionLead(spec, modelSpec(liveConfigs.get(lead), lead, false));
    if (uid === accountDefaultUid) spec.isProviderDefault = true;
    specs.push(spec);
    // A router dispatches; it is never an effort tier of a family.
    if (!router) collectFamilyLane(lanes, config, uid);
  }

  const declared = dynamicFamilies(lanes.values());
  let models = declared.length ? collapseFamilies(specs, declared) : specs;
  models = collapseFamilies(models, DEVIN_REVIEWED_FAMILIES);
  const pairs = thinkingPairFamilies(models);
  if (pairs.length) models = collapseFamilies(models, pairs);

  // The account default outranks its family's own default when an effort
  // routes to it: the family starts on that uid and effort.
  const index = models.findIndex((spec) => spec.isProviderDefault && spec.thinking?.effortRouting);
  if (index !== -1) {
    const family = models[index];
    const effort = THINKING_EFFORTS.find((level) => family.thinking.effortRouting[level] === accountDefaultUid);
    if (effort !== undefined) {
      const next = { ...family, thinking: { ...family.thinking, defaultLevel: effort } };
      if (family.id === accountDefaultUid) delete next.requestModelId;
      else next.requestModelId = accountDefaultUid;
      models[index] = next;
    }
  }
  return models.map(toRow).sort((a, b) => a.id.localeCompare(b.id));
}

// Whole-discovery deadline, shared by the native and legacy requests.
export const DEVIN_DISCOVERY_TIMEOUT_MS = 5_000;
// The two-row fallback seed native discovery returns for seats it cannot serve.
const SEED_UIDS = new Set(['swe-1-6', 'swe-1-6-fast']);

// Raw ClientModelConfig objects for the account; the array carries the
// account's starting model as `defaultModelUid` when the server names one,
// which normalizeDevinModels picks up. Discovery authenticates with
// the session token (not the user JWT). The native dev-channel identity is
// asked first; when it fails, returns nothing usable, or returns only the
// fallback seed, the legacy editor identity with the raw token is asked, and
// its catalog wins only when native failed or it is strictly larger.
// Throws when both fail; an empty array means both answered with no models.
export async function fetchDevinModels({ sessionToken, fetchFn = fetch, signal, baseUrl = DEVIN_DEFAULT_BASE_URL }) {
  const token = String(sessionToken || '');
  if (!token) {
    throw new DevinWireError('Devin session token is missing', { code: 'unauthenticated', status: 401 });
  }
  const timeout = AbortSignal.timeout(DEVIN_DISCOVERY_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // One catalog attempt: { configs, rows } on success, { error } on failure.
  const attempt = async (metadata) => {
    try {
      const response = await devinUnary({
        baseUrl,
        path: DEVIN_GET_CLI_MODEL_CONFIGS_PATH,
        requestType: 'GetCliModelConfigsRequest',
        responseType: 'GetCliModelConfigsResponse',
        message: { metadata },
        fetchFn,
        signal: requestSignal,
      });
      const configs = response.clientModelConfigs || [];
      const defaultModelUid = String(response.defaultOverrideModelConfig?.modelUid || '').trim();
      if (defaultModelUid) configs.defaultModelUid = defaultModelUid;
      return { configs, rows: normalizeDevinModels(configs).length };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) {
        return {
          error: new DevinWireError(`Devin model discovery timed out after ${DEVIN_DISCOVERY_TIMEOUT_MS} ms`, {
            code: 'unavailable',
            retryable: true,
          }),
        };
      }
      return { error };
    }
  };

  const native = await attempt(
    devinRequestMetadata({ apiKey: normalizeDevinSessionToken(token), client: 'discovery' })
  );
  const nativeSeedOnly = native.rows > 0 && normalizeDevinModels(native.configs).every((row) => SEED_UIDS.has(row.id));
  if (native.rows > 0 && !nativeSeedOnly) return native.configs;

  const legacy = await attempt(devinRequestMetadata({ apiKey: token, client: 'legacy' }));
  const chosen = !legacy.error && (native.error || legacy.rows > native.rows) ? legacy : native;
  if (chosen.error) throw chosen.error;
  return chosen.configs;
}
