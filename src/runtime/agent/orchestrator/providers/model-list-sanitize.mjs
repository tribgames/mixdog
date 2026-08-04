// Shared model-list sanitizer. Providers return raw /models catalogs that mix
// chat models with embeddings/tts/image/etc, keep long-deprecated legacy
// families, and expose the same model under many dated snapshot ids. This
// module narrows a provider's enriched model list down to current,
// chat-capable, coding-relevant models WITHOUT touching selection or
// default-model logic. Conservative by design: when a row's family/mode is
// unknown, KEEP it.
//
// Usage: `sanitizeModelList(await enrichModels(models), { provider })`.
// Input rows are the enriched shape ({ id, mode?, created?, ... }); output is
// a filtered + deduped subset of the SAME row objects (never mutated).

import { getModelsDevProviderModelsSync, getModelsDevRowSync } from './model-catalog.mjs';

// Id-level fallback for coding-unfit SKUs when the catalog row is missing.
// search-preview (grounded-search) and audio/realtime preview SKUs are
// unwanted for a coding agent even when chat-capable. This is applied
// regardless of an explicit mode:'chat' (unlike NON_CHAT_RE).
const CODING_UNFIT_ID_RE = /-search(-preview)?(\b|-|$)|-(audio|realtime)-preview/i;

// Known hosted providers get the full id-heuristic + legacy + dedupe
// treatment. Anything else (ollama/lmstudio/llamacpp/local, or any unknown
// custom provider name openai-compat forwards) is treated as CUSTOM: only the
// enriched-mode drop applies — no id regex, no legacy filter, no dedupe.
const HOSTED_PROVIDERS = new Set([
  'openai', 'openai-oauth', 'openai-ws', 'anthropic', 'anthropic-oauth',
  'gemini', 'google', 'xai', 'grok-oauth', 'deepseek', 'groq', 'mistral',
  'opencode-go', 'azure',
]);

// (a) Non-chat modality ids. Matched as whole word-ish tokens on the id so we
// don't nuke unrelated substrings. NOTE: 'search'/'voice' intentionally
// excluded — chat SKUs like *-search-preview exist.
const NON_CHAT_RE = new RegExp(
  '(^|[-_/\\s])(' +
    [
      'embed', 'embedding', 'embeddings',
      'tts', 'stt', 'whisper', 'audio', 'speech', 'voice',
      'image', 'images', 'video', 'videos',
      'moderation', 'moderations', 'rerank', 'reranker', 'similarity',
      'dall[-_]?e', 'sora', 'imagen', 'imagine', 'veo', 'kling', 'runway',
      'realtime', 'transcribe', 'transcription', 'diarize',
      'guard', 'safety', 'classifier',
      'robotics', 'computer[-_]?use',
    ].join('|') +
    ')([-_/\\s]|$)',
  'i',
);

// (a2) Whole-id non-LLM SKUs that don't carry a modality token in a matchable
// position. These are exact families that OpenAI/others expose via /v1/models
// but are never chat/completion LLMs (image gen, TTS, embeddings, moderation).
// Anchored to the full id so version/date siblings all match.
const NON_LLM_ID_PATTERNS = [
  /^tts(\b|-)/i,                       // tts-1, tts-1-hd
  /^whisper(\b|-)/i,                   // whisper-1
  /^dall[-_]?e(\b|-)/i,                // dall-e-2, dall-e-3
  /^(text-)?embedding/i,              // text-embedding-3-large, embedding-*
  /^text-embedding-ada/i,             // text-embedding-ada-002
  /^text-moderation(\b|-)/i,          // text-moderation-*
  /^omni-moderation(\b|-)/i,          // omni-moderation-latest
  /^gpt-image(\b|-)/i,                // gpt-image-1, gpt-image-2
  /^chatgpt-image(\b|-)/i,            // chatgpt-image-latest
  /^gpt-(4o|4o-mini|realtime|audio)?-?(tts|transcribe)(\b|-)/i, // gpt-4o-*-tts / -transcribe
  /^gpt-audio(\b|-)/i,               // gpt-audio, gpt-audio-mini, gpt-audio-1.5
  /^gpt-realtime(\b|-)/i,            // gpt-realtime*, gpt-realtime-mini
  /-tts(\b|-)/i,                      // any *-tts SKU
  // Purpose-specific SKUs that report mode:'chat' but are never useful for a
  // coding agent (embodied/robotics, browser computer-use, audio-native,
  // customtools picker-duplicate variants).
  /(^|-)robotics(\b|-)/i,             // gemini-robotics-er-*
  /computer[-_]?use/i,                // gemini-2.5-computer-use-preview-*
  /native[-_]?audio/i,                // gemini-2.5-flash-native-audio-*
  /-customtools(\b|-|$)/i,            // gemini-3.1-pro-preview-customtools
  /^codex-auto-review$/i,             // Codex backend auto-review model, not a picker choice
  /^grok-build$/i,                    // proxy alias duplicating grok-build-0.1 (exact — 0.1 stays)
];

function _isNonLlmId(lid) {
  return NON_LLM_ID_PATTERNS.some((re) => re.test(lid));
}

// (b) Legacy / deprecated families not useful for a coding agent. Current
// families (gpt-5.x, gpt-4.1, o1-pro, o3+, claude-4.x, gemini-2/3, grok-4,
// deepseek-v*) must NOT match. Anything not matched here is kept. Each entry
// is a full-id-anchored pattern with an explicit trailing boundary so version
// siblings (grok-4.20-beta, gpt-4.1) survive.
const LEGACY_PATTERNS = [
  // OpenAI legacy — gpt-4 legacy = gpt-4o*, gpt-4-turbo/32k/0*, bare gpt-4.
  // gpt-4.1* is CURRENT and deliberately not matched.
  /^gpt-4(o|-turbo|-32k|-\d|$)/i,
  /^chatgpt-4o(\b|-)/i,
  /^gpt-3(\.5)?(\b|-)/i,
  /^(text-)?(davinci|babbage|curie|ada)(\b|-)/i,
  // o1 legacy = o1, o1-mini, o1-preview. o1-pro is CURRENT, not matched.
  /^o1(-mini|-preview|-\d|$)/i,
  /^o3-mini(\b|-)/i,
  // Anthropic legacy
  /^claude-(1|2|3|instant)(\b|-|\.)/i,
  // Gemini legacy — gemini-1*, gemini-pro. gemini-2/3 not matched.
  /^gemini-1(\b|-|\.)/i,
  /^gemini-2\.0(\b|-|\.)/i,
  /^gemini-pro(\b|-)/i,
  // Grok legacy — grok-1/2/3 and grok-beta. The digit boundary stops grok-3
  // from catching grok-4.20-beta.
  /^grok-(1|2|3)(\b|-|\.)/i,
  /^grok-beta(\b|-)/i,
];

function _isLegacy(lid) {
  return LEGACY_PATTERNS.some((re) => re.test(lid));
}

function _isNonChatMode(row) {
  const mode = typeof row?.mode === 'string' ? row.mode.trim().toLowerCase() : '';
  if (!mode) return false; // unknown -> keep
  return !['chat', 'completion', 'responses', 'messages'].includes(mode);
}

// (c) Canonical key: strip ONLY unambiguous date suffixes: -YYYY-MM-DD and
// -20YYMMDD (8-digit starting 20). Generic -0xxx is NOT stripped here — it
// collides with version ids (grok-4.20-0309, custom foo-0123). MMDD-style
// collapse is handled separately and conditionally.
function _canonicalKey(id) {
  let key = String(id || '').trim().toLowerCase();
  key = key.replace(/-\d{4}-\d{2}-\d{2}$/, ''); // -YYYY-MM-DD
  key = key.replace(/-20\d{6}$/, '');           // -20YYMMDD
  return key;
}

function _isDated(id) {
  return _canonicalKey(id) !== String(id || '').trim().toLowerCase();
}

// MMDD-style suffix (-0309): only collapse when the undated alias exists in
// the same list AND both rows share identical context/output limits.
function _mmddBase(id) {
  const lid = String(id || '').trim().toLowerCase();
  const m = lid.match(/^(.*)-0\d{3}$/);
  return m ? m[1] : null;
}
function _sameLimits(a, b) {
  const cw = (r) => Number(r?.contextWindow) || 0;
  const ot = (r) => Number(r?.outputTokens) || 0;
  return cw(a) === cw(b) && ot(a) === ot(b);
}

// ── Data-driven auto-staleness (models.dev release_date + family) ────────────
// Parse a models.dev release_date ("YYYY-MM-DD" or "YYYY-MM") to a UTC epoch.
function _releaseEpoch(row) {
  const rd = row && typeof row.release_date === 'string' ? row.release_date.trim() : '';
  if (!rd) return null;
  const m = rd.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] || '01'));
  return Number.isFinite(t) ? t : null;
}

function _stalenessFamily(row, id) {
  const modelId = String(id || row?.id || row?.name || '').trim().toLowerCase();
  const claude = modelId.match(/(?:^|\/)claude-(opus|sonnet|haiku|fable)(?:-|$)/);
  if (claude) return `claude-${claude[1]}`;
  const family = row && typeof row.family === 'string' ? row.family.trim().toLowerCase() : '';
  return family || null;
}

function _staleMonths() {
  const raw = process.env.MIXDOG_MODEL_STALE_MONTHS;
  if (raw == null || raw === '') return 12;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 12;
}

// Apply catalog-driven staleness to the already-filtered `kept` rows.
// Rules (see slice brief): (1) family supersession by newer release_date,
// (2) absolute cut older than N months. Both consult the provider's
// models.dev catalog; rows not found in the catalog are KEPT (fallback to the
// static LEGACY_PATTERNS already applied earlier). Catalog cold → no-op.
// Guards: never empty a family via supersession; if the absolute cut would
// empty the whole provider list, skip the cut entirely.
function _applyAutoStaleness(kept, provider, testCatalog) {
  const catModels = getModelsDevProviderModelsSync(provider, testCatalog);
  if (!catModels || typeof catModels !== 'object') return kept; // cold/unavailable → skip

  // Enrich each kept row with its catalog row (by id), if any.
  const meta = kept.map((row) => {
    const cr = catModels[row.id] || null;
    return {
      row,
      cat: cr,
      family: cr ? _stalenessFamily(cr, row.id) : null,
      epoch: cr ? _releaseEpoch(cr) : null,
    };
  });

  // (1) Family supersession: within a family, drop a row when the catalog has
  // ANY model (kept or not) in the same family with a strictly newer date.
  // Compute the newest release_date per family from the FULL catalog so a
  // superseding model that isn't in this list still counts.
  const familyNewest = new Map();
  for (const [id, cr] of Object.entries(catModels)) {
    const fam = _stalenessFamily(cr, id);
    const ep = _releaseEpoch(cr);
    if (!fam || ep == null) continue;
    const prev = familyNewest.get(fam);
    if (prev == null || ep > prev) familyNewest.set(fam, ep);
  }

  let dropped = new Set();
  for (const m of meta) {
    if (!m.cat || m.family == null || m.epoch == null) continue; // fallback: keep
    const newest = familyNewest.get(m.family);
    if (newest != null && newest > m.epoch) dropped.add(m.row);
  }
  // Never empty a family the user relies on: if supersession removed every
  // in-list member of a family, restore the newest-in-list member.
  const byFamilyInList = new Map();
  for (const m of meta) {
    if (m.family == null) continue;
    if (!byFamilyInList.has(m.family)) byFamilyInList.set(m.family, []);
    byFamilyInList.get(m.family).push(m);
  }
  for (const [, members] of byFamilyInList) {
    if (!members.every((m) => dropped.has(m.row))) continue;
    let best = null;
    for (const m of members) {
      if (!best || (m.epoch || 0) > (best.epoch || 0)) best = m;
    }
    if (best) dropped.delete(best.row);
  }

  // (2) Absolute cut: drop rows whose release_date is older than N months.
  const months = _staleMonths();
  if (months > 0) {
    const cutoff = Date.now() - months * 30.4375 * 24 * 60 * 60 * 1000;
    const cutDropped = new Set();
    for (const m of meta) {
      if (dropped.has(m.row)) continue;
      if (!m.cat || m.epoch == null) continue; // fallback: keep
      if (m.epoch < cutoff) cutDropped.add(m.row);
    }
    // If applying the absolute cut would empty the entire provider list, skip
    // the cut (supersession drops still stand).
    const survivorsAfterCut = kept.filter((r) => !dropped.has(r) && !cutDropped.has(r));
    if (survivorsAfterCut.length > 0) {
      for (const r of cutDropped) dropped.add(r);
    }
  }

  return kept.filter((r) => !dropped.has(r));
}

// ── Coding-unfit filter (models.dev tool_call/modalities + id fallback) ──────
// HOSTED providers only, applied AFTER staleness, BEFORE dedupe. Data-driven:
//   (1) catalog row exists and tool_call === false → drop (search-preview,
//       roleplay, lightweight chat SKUs — regardless of mode:'chat');
//   (2) catalog row exists and modalities.output is an array lacking 'text' →
//       drop (non-text-emitting SKUs);
//   (3) catalog row MISSING → id fallback CODING_UNFIT_ID_RE (search-preview /
//       audio|realtime-preview), applied even for mode:'chat';
//   (4) not in catalog + no id match → keep.
// Catalog cold/unavailable → id-fallback still applies (safe, id-only).
function _applyCodingUnfit(kept, provider, testCatalog) {
  const out = [];
  for (const row of kept) {
    const id = row?.id;
    if (!id) continue;
    const cr = getModelsDevRowSync(id, provider, testCatalog);
    if (cr) {
      // (1) explicit non-tool-calling SKU
      if (cr.tool_call === false) continue;
      // (2) output modalities present but no 'text'
      const outMods = cr?.modalities?.output;
      if (Array.isArray(outMods) && !outMods.includes('text')) continue;
      out.push(row);
      continue;
    }
    // (3) catalog row missing → id-level fallback
    if (CODING_UNFIT_ID_RE.test(String(id).toLowerCase())) continue;
    // (4) keep
    out.push(row);
  }
  return out;
}

/**
 * Sanitize a provider model list.
 * @param {Array<object>} models enriched rows ({ id, mode?, created?, ... })
 * @param {{provider?: string}} [opts]
 * @returns {Array<object>} filtered + deduped subset (same row objects)
 */
export function sanitizeModelList(models, opts = {}) {
  if (!Array.isArray(models)) return models;
  const provider = String(opts?.provider || '').trim().toLowerCase();
  const hosted = HOSTED_PROVIDERS.has(provider);

  // CUSTOM/local providers (ollama, lmstudio, unknown names): apply ONLY the
  // enriched-mode drop. No id heuristics, no legacy filter, no dedupe.
  if (!hosted) {
    return models.filter((row) => row?.id && !_isNonChatMode(row));
  }

  const kept = [];
  for (const row of models) {
    const id = row?.id;
    if (!id) continue;
    const lid = String(id).toLowerCase();
    const modeChat = typeof row?.mode === 'string' && row.mode.trim().toLowerCase() === 'chat';
    // (a0) hard non-LLM SKUs (image/tts/embeddings/moderation/realtime/audio):
    // dropped even if the row falsely claims mode:'chat'. These families are
    // never text-completion LLMs.
    if (_isNonLlmId(lid)) continue;
    // (a) enriched mode present and not chat-like
    if (_isNonChatMode(row)) continue;
    // (a) non-chat modality id — but an explicit mode:'chat' overrides id regex
    if (!modeChat && NON_CHAT_RE.test(lid)) continue;
    // (b) legacy/deprecated family
    if (_isLegacy(lid)) continue;
    kept.push(row);
  }

  // Data-driven auto-staleness (models.dev): applied AFTER the static drops
  // above and BEFORE canonical dedupe. Catalog cold/unavailable → no-op.
  // `opts._testCatalog` (tests only) injects a fake catalog map.
  const staleFiltered = _applyAutoStaleness(kept, provider, opts?._testCatalog);

  // Coding-unfit filter (models.dev tool_call/modalities + id fallback):
  // AFTER staleness, BEFORE dedupe.
  const codingFit = _applyCodingUnfit(staleFiltered, provider, opts?._testCatalog);

  // (c) canonical dedupe on unambiguous date suffixes: prefer undated alias.
  const byKey = new Map();
  for (const row of codingFit) {
    const key = _canonicalKey(row.id);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, row); continue; }
    byKey.set(key, _preferRow(prev, row));
  }
  let winners = new Set(byKey.values());

  // Conditional MMDD collapse: drop a `-0xxx` row only when its undated alias
  // survives in the winner set AND both share identical context/output limits.
  const aliasByKey = new Map();
  for (const row of winners) aliasByKey.set(_canonicalKey(row.id), row);
  for (const row of [...winners]) {
    const base = _mmddBase(row.id);
    if (!base) continue;
    const alias = aliasByKey.get(base);
    if (alias && alias !== row && _sameLimits(alias, row)) winners.delete(row);
  }

  // Preserve original ordering of the winners.
  return codingFit.filter((row) => winners.has(row));
}

function _preferRow(a, b) {
  const aDated = _isDated(a.id);
  const bDated = _isDated(b.id);
  // Prefer the undated canonical alias.
  if (aDated !== bDated) return aDated ? b : a;
  if (!aDated && !bDated) return a; // both undated (shouldn't happen) keep first
  // Both dated: keep the newest by `created`, else the lexically-latest id.
  const ac = Number(a.created) || 0;
  const bc = Number(b.created) || 0;
  if (ac !== bc) return ac > bc ? a : b;
  return String(b.id) > String(a.id) ? b : a;
}
