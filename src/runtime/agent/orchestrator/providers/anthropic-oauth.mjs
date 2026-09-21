/**
 * Anthropic OAuth provider — uses Mixdog-owned local OAuth credentials
 * for Claude Max subscription access.
 *
 * Raw HTTP + SSE streaming, reuses message/tool conversion patterns
 * from anthropic.mjs. agent-trace instrumented.
 */
import { traceAgentSse, traceAgentUsage } from '../agent-trace.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { resolveAnthropicMaxTokens } from './anthropic-max-tokens.mjs';
import { systemBlockItems, systemBlockTtl } from './anthropic-messages.mjs';
import { prepareAnthropicImages } from './lib/anthropic-image-input.mjs';
import {
  _loadModelCache,
  _setInMemoryCatalog,
  _catalogHas,
  _displayModel,
  _catalogOutputTokens,
  normalizeAndSaveCatalog,
  resolveAnthropicModelAfter404,
  ensureLatestAnthropicModel,
} from './anthropic-model-resolve.mjs';
import { sanitizeToolPairs } from '../session/context-utils.mjs';
import {
  TOKEN_REFRESH_SKEW_MS,
  isAnthropicOAuthRefreshDisabled,
  loadCredentials,
  hasAnthropicOAuthCredentials,
  describeAnthropicOAuthCredentials,
  forgetAnthropicOAuthCredentials,
  _scrubTokens,
  _credentialsMaxMtime,
  refreshOAuthCredentials,
  beginOAuthLogin,
  loginOAuth,
} from './anthropic-oauth-credentials.mjs';
import { learnRequiredCliVersion, resolveCliVersion } from './anthropic-oauth-client-version.mjs';
import { createPassthroughSignal } from '../stall-policy.mjs';
import { AnthropicFallbackTriggeredError } from './retry-classifier.mjs';
import { ANTHROPIC_MAX_MIDSTREAM_RETRIES, parseSSEStream, _classifyMidstreamError } from './anthropic-sse.mjs';
import { buildAnthropicBetaHeaders, supportsAnthropicFastMode } from './anthropic-betas.mjs';
import { applyAnthropicServerFallback } from './anthropic-server-fallback.mjs';
import { fastModeAvailable } from './anthropic-fast-mode.mjs';
import { ANTHROPIC_VERSION, anthropicQuotaError, createAnthropicOAuthRequest } from './anthropic-oauth-request.mjs';
import { createAnthropicOAuthRecovery } from './anthropic-oauth-recovery.mjs';
import { createMidState, createMidstreamRecovery } from './anthropic-oauth-midstream.mjs';
import { applyAnthropicEffortToBody, shouldIncludeEffortBeta } from './anthropic-effort.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import {
  applyAnthropicCacheMarkers,
  clampAnthropicThinkingBudget as clampThinkingBudgetTokens,
  deferredAnthropicTools as sharedDeferredAnthropicTools,
  requestAnthropicTools as sharedRequestAnthropicTools,
  resolveAnthropicCacheTtls as resolveCacheTtls,
  resolveAnthropicMessageCacheSlots,
  sanitizeAnthropicInputSchema,
  toAnthropicMessages,
  toAnthropicToolChoice,
} from './lib/anthropic-request-utils.mjs';

// SSE progress emits (per-request "Response …" and "Done:" lines). Off by default.
const SSE_VERBOSE = process.env.MIXDOG_SSE_VERBOSE === '1';

let _modelRefreshInFlight = null;
const _oauthRefreshes = new Map();
// The credentials file is canonical: ensureAuth reloads the in-memory copy
// when its mtime changes, and refresh re-reads disk before exchanging tokens.
// This picks up cross-process refresh_token rotation rather than replaying
// a stale single-use token.

// Anthropic OAuth contract for first-party OAuth clients: Opus/Sonnet
// requests are gated on this exact system-prompt prefix. Haiku is not
// gated and ignores this prefix.
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA_HEADERS =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,extended-cache-ttl-2025-04-11';
import {
  EFFORT_CONFIGURATION_BETA,
  projectEffortConfiguration,
  lowerAnthropicEffortHistory,
  markAnthropicEffortBody,
  usesAnthropicEffortBody,
} from './effort-configuration.mjs';

function requiresSystemPrefix(model) {
  // High-tier Claude OAuth models require the first-party system prefix for
  // OAuth pool routing. Haiku does not; keep every other Claude family (Opus,
  // Sonnet, Fable, and future non-Haiku families) on the prefixed path.
  const id = String(model || '').toLowerCase();
  return /^claude-/.test(id) && !/^claude-haiku(?:-|$)/.test(id);
}

function buildOAuthBetaHeaders(body, { fastMode = false, toolSearch = false, model, opts = {} } = {}) {
  return buildAnthropicBetaHeaders({
    base: usesAnthropicEffortBody(body) ? `${OAUTH_BETA_HEADERS},${EFFORT_CONFIGURATION_BETA}` : OAUTH_BETA_HEADERS,
    fastMode,
    toolSearch,
    effort: shouldIncludeEffortBeta(model, opts),
    serverFallback: body?.fallbacks === 'default',
  });
}

// OAuth rate-limit pool routing is gated by the server inspecting the first
// system block. When it reads exactly the OAuth system prefix string it routes
// into the first-party OAuth pool; any other
// content (even the prefix concatenated with extra text in the same block)
// falls into the standard pool and Opus/Sonnet return 429. Splitting into
// two blocks — [prefix, rest] — keeps both routing and user instructions.
function buildSystemBlocks(systemMsgs, model, systemTtl, tier3Ttl) {
  // systemMsgs is an array of { content, cacheTier } — each non-empty element
  // becomes its own Anthropic content block with its own cache_control
  // breakpoint. Blocks tagged cacheTier:'tier3' (BP3 sessionMarker) take the
  // tier3 TTL; every other block (BP1 baseRules / BP2 stableSystem) takes the
  // system TTL. Invariant: callers must pass an array.
  const items = systemBlockItems(systemMsgs);
  const gated = requiresSystemPrefix(model);

  const blocks = [];
  if (gated) {
    blocks.push({ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX });
  }
  for (let i = 0; i < items.length; i++) {
    let body = items[i].text;
    // Strip a duplicated OAuth system prefix from the first block if present.
    if (gated && i === 0 && body.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) {
      body = body.slice(CLAUDE_CODE_SYSTEM_PREFIX.length).trim();
      if (!body) continue;
    }
    // Anthropic concatenates system text blocks byte-for-byte with no
    // separator, so a trimmed block would glue its last line onto the next
    // block's heading (`...Claude.# Tool Calls`, `...and b# Session`). Every
    // block after the first opens with a paragraph break; the gating
    // prefix block itself stays byte-exact.
    blocks.push({ type: 'text', text: blocks.length ? `\n\n${body}` : body, _tier: items[i].tier });
  }
  // Apply per-tier cache_control. BP1/BP2 -> systemTtl, BP3 -> tier3Ttl. The
  // gating prefix block is never cached (Anthropic routes on its exact bytes).
  // tier3Ttl === null leaves the 3rd block uncached (e.g. maintenance roles).
  // Anthropic caps cache_control breakpoints at 4 per request; defensively
  // cap it here too so an unexpectedly large systemMsgs array can never
  // mark more than 4 blocks (extras keep their text, just lose the
  // cache_control breakpoint, not the block itself).
  const MAX_SYSTEM_BREAKPOINTS = 4;
  let bpCount = 0;
  for (const b of blocks) {
    const tier = b._tier;
    delete b._tier;
    if (b.text === CLAUDE_CODE_SYSTEM_PREFIX) continue;
    const ttl = systemBlockTtl(tier, { tier3Ttl, systemTtl });
    if (ttl && bpCount < MAX_SYSTEM_BREAKPOINTS) {
      b.cache_control = ttl;
      bpCount++;
    }
  }
  return blocks;
}

// resolveMaxTokens: catalog-driven max_tokens for a model id. Thin wrapper
// around the shared anthropic-max-tokens helper (also used by the API-key
// twin in anthropic.mjs) — this provider supplies its own in-memory-mirror-
// first catalog lookup strategy (see anthropic-model-resolve.mjs).
//   1. MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS env override, if set, wins outright.
//   2. Catalog outputTokens (trusted over hardcoded heuristics when present),
//      clamped to [MAX_TOKENS_FLOOR, safetyCap].
//   3. Static MAX_TOKENS table / family heuristic fallback when the catalog
//      has no entry for this model, also clamped to the safety cap.
function resolveMaxTokens(model) {
  return resolveAnthropicMaxTokens(model, { catalogLookup: _catalogOutputTokens });
}

// --- Message conversion ---

// Anthropic's tool spec forbids oneOf / allOf / anyOf at the TOP level of
// input_schema (nested usage inside properties is allowed). External MCP
// servers sometimes emit such schemas.
// Convert them to a flat object schema so the API never sees a 400.
// Map the orchestrator-level opts.toolChoice into Anthropic's tool_choice.
// Only 'none' is activated: it lets the hard-cap final turn keep the tool
// DEFINITIONS in-request (so the tools->system->messages prefix — and its
// prompt-cache prefix — stay byte-identical to prior turns) while forbidding
// tool USE, so the model can only emit text. Forced values
// ('required'->{type:'any'}, {name}->{type:'tool'}) are deliberately NOT
// mapped: Anthropic returns a 400 for any forced tool_choice while
// extended/adaptive thinking is enabled, and the only caller that sets
// opts.toolChoice='required' (the forced-first-tool turn) runs with
// effort/thinking active on reasoning models — activating it would convert a
// previously-harmless no-op into a hard 400 on exactly that turn. Attached
// only when the request actually carries tools (see buildRequestBody).
function deferredAnthropicTools(activeTools, messages, opts) {
  return sharedDeferredAnthropicTools(activeTools, messages, opts, 'anthropic-oauth');
}
function requestAnthropicTools(tools, messages, opts) {
  return sharedRequestAnthropicTools(tools, messages, opts, 'anthropic-oauth');
}

// Applies cache_control markers to the FINAL, already-sanitized Anthropic
// message array — by INVARIANT, never by pre-sanitize index. Because
// sanitizeAnthropicContentPairs has already run (and must NOT run again
// after this), the blocks we mark here are exactly the blocks the provider
// sees, so the cache breakpoint is stable across turns.
//   message-anchor: prefer a safe tool_result tail, then a previous real user
//                   text turn if another slot remains. Synthetic
//                   <system-reminder> messages and current pure-text prompts
//                   are excluded so first-turn prompts do not create a fresh
//                   BP4 write on every new session.
// messageTtl === null disables the tail. BP3 (tier3) now rides a system block,
// so it is no longer marked here.
// ANTHROPIC_MSG_SLOTS=0 is honoured upstream by passing messageTtl = null.
// --- Build request body ---

// BP3 (tier3) is injected by session/manager as its own `system` role block —
// the 3rd system block, tagged `cacheTier:'tier3'`. buildSystemBlocks applies
// the tier3 1h cache_control to that block; BP1/BP2 take the system TTL. No
// `<system-reminder>` user message / sentinel scan is involved anymore.

function buildRequestBody(messages, model, tools, sendOpts) {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const chatMsgs = messages.filter((m) => m.role !== 'system');
  const maxTokens = resolveMaxTokens(model);
  const opts = sendOpts || {};
  const effortProjection = projectEffortConfiguration(messages, 'anthropic-oauth', model, opts);
  const ttls = resolveCacheTtls(opts);
  // Each system message becomes its own Anthropic content block with its own
  // breakpoint: BP1 baseRules + BP2 stableSystem at ttls.system, BP3
  // sessionMarker (cacheTier:'tier3') at ttls.tier3.
  const systemBlocks = buildSystemBlocks(systemMsgs, model, ttls?.system, ttls?.tier3);

  // Message-tail cache budget (4-BP layout + ANTHROPIC_MSG_SLOTS) is shared
  // with anthropic.mjs — see resolveAnthropicMessageCacheSlots.
  const messageCacheSlots = resolveAnthropicMessageCacheSlots(systemBlocks, ttls);
  // Tools are resolved BEFORE the messages: the lowering needs the final
  // tool list to drop tool_reference blocks whose tool no longer ships in
  // this request (otherwise the API rejects the whole turn).
  const requestTools = requestAnthropicTools(tools, chatMsgs, opts);
  // Build → sanitize (once, inside toAnthropicMessages) → mark. Markers are
  // applied to the FINAL sanitized array by invariant, so block drops /
  // inserts / reorders performed by the sanitizer can never move or delete a
  // marked block. NEVER sanitize again after this (see send path).
  const anthropicMessages = applyAnthropicCacheMarkers(
    lowerAnthropicEffortHistory(chatMsgs, (segment) => toAnthropicMessages(segment, requestTools), effortProjection),
    messageCacheSlots
  );

  const body = {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
    stream: true,
  };
  applyAnthropicServerFallback(body, model, {
    enabled: opts.serverFallback !== false,
  });

  if (systemBlocks.length) body.system = systemBlocks;

  if (requestTools.length) {
    // No cache_control on tools — the systemBase BP already covers the
    // tools prefix via Anthropic's prompt cache prefix semantics (order:
    // tools → system → messages). Placing a separate BP here would waste
    // a slot that's better spent on messages tail.
    body.tools = requestTools;
  }
  // tool_choice only when tools are actually present (Anthropic rejects
  // tool_choice without tools). 'none' rides the hard-cap final turn to
  // forbid tool USE while keeping the tools prefix stable for cache reuse.
  if (body.tools) {
    const toolChoice = toAnthropicToolChoice(opts.toolChoice);
    if (toolChoice) body.tool_choice = toolChoice;
  }

  applyAnthropicEffortToBody(body, {
    model,
    opts: effortProjection ? { ...opts, effort: effortProjection.initialEffort } : opts,
    maxTokens,
    clampThinkingBudgetTokens,
    logTag: 'anthropic-oauth',
  });

  // Skipped while the fast capacity pool is in cooldown (or permanently
  // unavailable) so a drained pool is not re-probed every turn.
  if (opts.fast === true && supportsAnthropicFastMode(model) && fastModeAvailable()) {
    body.speed = 'fast';
  }

  return markAnthropicEffortBody(body, effortProjection);
}

export function _buildRequestBodyForCacheSmoke(messages, model, tools = [], sendOpts = {}) {
  return buildRequestBody(messages, model, tools, sendOpts);
}

// --- Provider ---

export class AnthropicOAuthProvider {
  // input_tokens EXCLUDES cache_read_input_tokens (separate field) — add the
  // cache back for the real context footprint. See registry.mjs.
  static inputExcludesCache = true;
  name = 'anthropic-oauth';
  credentials = null;
  config;
  fastModeBetaHeaderLatched = false;

  constructor(config) {
    this.config = config || {};
    this.credentials = loadCredentials();
    // Warm a kept-alive socket to the messages API so the first request
    // skips the cold TLS handshake. Best-effort; never throws.
    preconnect('https://api.anthropic.com');
  }

  async ensureAuth({ forceRefresh = false, reason = 'preemptive' } = {}) {
    if (!this.credentials) {
      this.credentials = loadCredentials();
    }
    if (!this.credentials) {
      throw new Error('Anthropic OAuth credentials not found. Open /providers in mixdog to sign in.');
    }

    // Pick up Mixdog-updated tokens the moment the credentials file is
    // rewritten — without this, a fresh /auth login in another process is
    // ignored until the in-memory token's expiry skew triggers a refresh.
    const diskMtime = _credentialsMaxMtime();
    if (diskMtime > 0 && diskMtime > (this.credentials.mtimeMs || 0)) {
      const fresh = loadCredentials();
      if (fresh?.accessToken) {
        this.credentials = fresh;
        if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
          process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk (mtime change)\n`);
      }
    }

    const expiring = this.credentials.expiresAt && this.credentials.expiresAt < Date.now() + TOKEN_REFRESH_SKEW_MS;
    if (forceRefresh || expiring) {
      if (isAnthropicOAuthRefreshDisabled()) {
        throw new Error(
          'Anthropic OAuth credentials require refresh, but refresh is disabled ' +
            'in this container. Host credential preflight must provide a fresh snapshot.'
        );
      }
      this.credentials = await this._refreshCredentials({ force: forceRefresh, reason });
    }

    return this.credentials;
  }

  async _refreshCredentials({ force = false, reason = 'preemptive' } = {}) {
    if (isAnthropicOAuthRefreshDisabled()) {
      throw new Error(
        'Anthropic OAuth refresh is disabled in this container; ' +
          'host credential preflight must provide a fresh snapshot.'
      );
    }
    const currentToken = this.credentials?.accessToken || null;
    const disk = loadCredentials();
    const validAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
    if (disk?.accessToken && disk.accessToken !== currentToken && (!disk.expiresAt || disk.expiresAt >= validAfter)) {
      this.credentials = disk;
      if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
        process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk\n`);
      return disk;
    }
    if (!this.credentials && disk) this.credentials = disk;

    const refreshKey = disk?.path || boundProviderAuthPath('anthropic-oauth') || 'default';
    if (_oauthRefreshes.has(refreshKey)) {
      const shared = await _oauthRefreshes.get(refreshKey);
      this.credentials = shared;
      if (!force || shared?.accessToken !== currentToken) return this.credentials;
    }

    const startingCreds = this.credentials || disk;
    const refresh = (async () => {
      const latest = loadCredentials() || startingCreds;
      const latestValidAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
      if (
        latest?.accessToken &&
        latest.accessToken !== currentToken &&
        (!latest.expiresAt || latest.expiresAt >= latestValidAfter)
      ) {
        if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
          process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk\n`);
        return latest;
      }

      if (!latest?.refreshToken) {
        if (!force && latest?.accessToken && (!latest.expiresAt || latest.expiresAt > Date.now())) {
          if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
            process.stderr.write(
              `[anthropic-oauth] WARNING: token expiring but no refresh token; using current token until expiry\n`
            );
          return latest;
        }
        throw new Error('Anthropic OAuth refresh token not available. Open /providers in mixdog to sign in again.');
      }

      try {
        if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
          process.stderr.write(`[anthropic-oauth] Token ${reason}, refreshing...\n`);
        const refreshed = await refreshOAuthCredentials(latest);
        if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
          process.stderr.write(
            `[anthropic-oauth] Token refreshed, expires in ${Math.round(((refreshed.expiresAt || Date.now()) - Date.now()) / 1000)}s\n`
          );
        return refreshed;
      } catch (err) {
        if (!force && latest?.accessToken && (!latest.expiresAt || latest.expiresAt > Date.now())) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
            process.stderr.write(`[anthropic-oauth] Refresh failed (${msg}); using still-valid current token\n`);
          return latest;
        }
        throw err;
      }
    })().finally(() => {
      _oauthRefreshes.delete(refreshKey);
    });
    _oauthRefreshes.set(refreshKey, refresh);

    this.credentials = await refresh;
    return this.credentials;
  }

  scrubTokens(text) {
    return _scrubTokens(text);
  }

  async send(messages, model, tools, sendOpts) {
    // Re-warm the kept-alive socket before the turn. preconnect() is a
    // best-effort no-op while a socket is still hot (TTL gate), but after an
    // idle gap longer than the keep-alive window it re-opens one in parallel
    // with auth/body build so the POST below skips the cold TLS handshake.
    preconnect('https://api.anthropic.com');
    // Defense-in-depth: enforce tool_use / tool_result pairing before
    // the Anthropic API call. The trim.mjs sanitize pass is normally
    // invoked by the budget trimmer in loop.mjs, but dispatches under
    // budget skip it — a tool that aborted mid-flight then leaves an
    // unmatched tool_use in messages, which the provider rejects with
    // a hard 400. Pairing here closes the gap regardless of caller.
    messages = sanitizeToolPairs(messages);
    const opts = sendOpts || {};
    const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
    const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
    const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
    const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
    const onTextReset = typeof opts.onTextReset === 'function' ? opts.onTextReset : null;
    const externalSignal = opts.signal || null;
    // Test seam: lets the retry harness drive stream outcomes without a
    // live OAuth session.
    const parseSSEFn = typeof opts._parseSSEFn === 'function' ? opts._parseSSEFn : parseSSEStream;

    // Shared credential holder: the non-streaming fallback refreshes it on
    // 401 and the streaming loop must see the same token afterwards.
    const auth = { creds: await this.ensureAuth() };
    // Default when the caller doesn't pin a model: newest high-tier chat
    // model from the live catalog (one warmup round-trip if cache is cold).
    const useModel = model || (await ensureLatestAnthropicModel(this));
    const body = buildRequestBody(messages, useModel, tools, sendOpts);
    body.messages = await prepareAnthropicImages(body.messages, { signal: externalSignal });
    if (body.speed === 'fast') {
      this.fastModeBetaHeaderLatched = true;
    }
    // advanced-tool-use-2025-11-20 beta is only needed when this request
    // actually carries deferred (defer_loading) tools — gate the header on
    // that instead of sending it unconditionally on every request.
    const hasDeferredTools = Array.isArray(body.tools) && body.tools.some((t) => t && t.defer_loading === true);
    // Known tool names for the leaked-tool-call guard in parseSSEStream:
    // recovered leaked calls are only synthesized when they name a tool
    // actually offered to this request (native + lowered). Derived from the
    // final request body so it matches exactly what the model was given.
    const knownToolNames = new Set(
      (Array.isArray(body.tools) ? body.tools : [])
        .map((t) => (t && typeof t.name === 'string' ? t.name : null))
        .filter(Boolean)
    );
    const sessionId = opts.sessionId || null;
    const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
    // Option A: no absolute wall-clock cap on streaming generation. A stream
    // that keeps emitting SSE deltas must NOT be killed by a fixed total-lifetime
    // timer — the old PROVIDER_GENERATE_TOTAL_TIMEOUT_MS (~285s, derived from the
    // stall WARN threshold) false-aborted live high-reasoning turns that were
    // still alive and producing tokens. The streaming phase is bounded instead by:
    //   (a) the per-attempt initial-response timeout in requestWithRetry
    //       (PROVIDER_HTTP_RESPONSE_TIMEOUT_MS) for a socket that never sends a
    //       first byte (truly wedged),
    //   (b) externalSignal (client disconnect / replaced-by-newer-request), and
    //   (c) the agent stall watchdog (STALL_ABORT_S, 600s, progress-based) plus
    //       the optional SSE idle watchdog for a stream that goes dead mid-flight.
    // totalSignal is therefore a pure pass-through of externalSignal with no timer.
    const totalTimeout = createPassthroughSignal(externalSignal);
    const totalSignal = totalTimeout.signal;
    const { requestWithRetry, cleanupCancelHandler } = createAnthropicOAuthRequest({
      provider: this,
      opts,
      body,
      useModel,
      sessionId,
      totalSignal,
      betaHeadersFor: (requestBody) =>
        buildOAuthBetaHeaders(requestBody, {
          fastMode: this.fastModeBetaHeaderLatched,
          toolSearch: hasDeferredTools,
          model: useModel,
          opts,
        }),
      onStageChange,
    });
    const recovery = createAnthropicOAuthRecovery({
      provider: this,
      opts,
      body,
      useModel,
      auth,
      totalSignal,
      requestWithRetry,
      cleanupCancelHandler,
      onStageChange,
      onTextReset,
    });
    // Bounded mid-stream retries for transient stream loss; jittered backoff
    // between attempts (anthropic-oauth-midstream.mjs).
    const midstream = createMidstreamRecovery({
      maxRetries: ANTHROPIC_MAX_MIDSTREAM_RETRIES,
      totalSignal,
      recovery,
    });

    try {
      for (let attemptIndex = 0; attemptIndex <= ANTHROPIC_MAX_MIDSTREAM_RETRIES; attemptIndex++) {
        let response, controller, cancelHandler;
        try {
          ({ response, controller, cancelHandler } = await requestWithRetry(auth.creds.accessToken));
        } catch (err) {
          if (err instanceof AnthropicFallbackTriggeredError) {
            process.stderr.write(`[anthropic-oauth] ${err.message}\n`);
            return this.send(messages, err.fallbackModel, tools, {
              ...opts,
              fallbackModel: undefined,
              _fallbackTriggered: true,
            });
          }
          throw err;
        }

        // Refresh on 401, and only Anthropic's exact official revoked-token
        // 403 signature. Ordinary permission/policy 403s are terminal.
        let rejectedAuthBody = null;
        if (response.status === 401 || response.status === 403) {
          rejectedAuthBody = await response.text().catch(() => '');
        }
        const revoked403 = response.status === 403 && String(rejectedAuthBody).includes('OAuth token has been revoked');
        if (response.status === 401 || revoked403) {
          process.stderr.write(`[anthropic-oauth] ${response.status} — forcing refresh and retrying once\n`);
          cleanupCancelHandler(cancelHandler);
          // Body was drained above; abort closes any remaining transport
          // resources before the credential-refresh replay.
          try {
            controller?.abort?.();
          } catch {}
          auth.creds = await this.ensureAuth({ forceRefresh: true, reason: String(response.status) });
          ({ response, controller, cancelHandler } = await requestWithRetry(auth.creds.accessToken));
          rejectedAuthBody = null;
        }

        if (!response.ok) {
          cleanupCancelHandler(cancelHandler);
          return await this._resendAfterRejection({
            response,
            rejectedAuthBody,
            messages,
            model,
            useModel,
            tools,
            opts,
            onStageChange,
          });
        }

        if (SSE_VERBOSE) process.stderr.write(`[anthropic-oauth] Response ${response.status}, parsing SSE...\n`);
        try {
          onStageChange?.('streaming');
        } catch {}

        const midState = createMidState(attemptIndex);
        try {
          const sseStartedAt = Date.now();
          const result = await parseSSEFn(
            response,
            controller.signal,
            (reason) => controller.abort(reason),
            onStreamDelta,
            onToolCall,
            midState,
            onTextDelta,
            knownToolNames
          );
          try {
            controller?.abort?.('Anthropic SSE complete');
          } catch {}
          this._settleStreamedTurn({
            result,
            midState,
            sseStartedAt,
            sessionId,
            iteration,
            useModel,
            requestKind: opts.requestKind || null,
          });
          try {
            Object.defineProperty(result, '__midstreamRetries', { value: attemptIndex, enumerable: false });
          } catch {
            /* ignore non-extensible result */
          }
          return result;
        } catch (err) {
          const decision = await midstream.onStreamError({ err, midState, controller, response, attemptIndex });
          if (decision.retry) continue;
          return decision.value;
        } finally {
          cleanupCancelHandler(cancelHandler);
        }
      }
      throw midstream.exhaustedError();
    } finally {
      totalTimeout.cleanup();
    }
  }

  // A non-OK initial response: quota errors surface as-is; a CLI-version
  // floor or an unknown/retired model replays the turn ONCE through send().
  async _resendAfterRejection({ response, rejectedAuthBody, messages, model, useModel, tools, opts, onStageChange }) {
    const text = rejectedAuthBody ?? (await response.text().catch(() => ''));
    const scrubbedText = this.scrubTokens(text);
    const safeText = scrubbedText.slice(0, 200);
    process.stderr.write(`[anthropic-oauth] API error ${response.status}: ${safeText}\n`);

    if (response.status === 429) {
      throw anthropicQuotaError(response.status, response.headers, safeText);
    }

    // Anthropic can gate a newly launched model on a newer Claude
    // Code client identity. Learn only the exact minimum-version
    // rejection, persist the raised floor, and replay this untouched
    // request once with the new user-agent. The retry flag prevents
    // a malformed or repeatedly rejected requirement from looping.
    const cliVersionRequirement =
      response.status === 400 ? learnRequiredCliVersion(scrubbedText.slice(0, 2_000)) : null;
    if (cliVersionRequirement?.retryable && !opts._cliVersionRetry) {
      process.stderr.write(
        `[anthropic-oauth] Claude CLI compatibility floor ${cliVersionRequirement.requiredVersion}; retrying once\n`
      );
      return this.send(messages, useModel, tools, {
        ...opts,
        _cliVersionRetry: true,
      });
    }

    // On an unknown/404 model error, refresh the catalog and retry
    // ONCE with the SAME model. A 404 usually says this credential
    // cannot reach the model (plan or account permission), not that
    // the id disappeared — and answering from a different model
    // hides that behind a quietly downgraded reply. Substitution is
    // kept for the single case this branch was written for: the
    // refreshed catalog no longer lists the id at all (a rotated
    // model id), and then the swap is announced on the turn's status
    // channel instead of living in stderr alone.
    // A refresh that FAILED returns null — "cannot tell", never
    // "retired" — so it retries the requested model untouched.
    const isUnknownModel = response.status === 404 || /unknown[_\s-]?model|model[_\s-]?not[_\s-]?found/i.test(safeText);
    if (isUnknownModel && !opts._modelRetry) {
      process.stderr.write(`[anthropic-oauth] unknown model — refreshing catalog + 1 retry\n`);
      const refreshed = await this._refreshModelCache();
      const retired = Array.isArray(refreshed) && !_catalogHas(useModel);
      const fallbackModel = retired ? resolveAnthropicModelAfter404(useModel) : null;
      if (fallbackModel) {
        process.stderr.write(`[anthropic-oauth] ${useModel} left the catalog — continuing on ${fallbackModel}\n`);
        try {
          onStageChange?.('reconnecting', {
            message: `${_displayModel(useModel)} is no longer offered — continuing on ${_displayModel(fallbackModel)}`,
          });
        } catch {
          /* display-only */
        }
      }
      return this.send(messages, fallbackModel || model, tools, { ...opts, _modelRetry: true });
    }
    const err = new Error(`Anthropic OAuth API ${response.status}: ${safeText}`);
    err.status = response.status;
    err.httpStatus = response.status;
    throw err;
  }

  // Traces + catalog upkeep for a streamed turn, then the empty-stream guard.
  _settleStreamedTurn({ result, midState, sseStartedAt, sessionId, iteration, useModel, requestKind }) {
    const ttftMs = midState.ttftAt ? midState.ttftAt - sseStartedAt : null;
    const liveModel = result.model || useModel;
    traceAgentSse({
      sessionId,
      sseParseMs: Date.now() - sseStartedAt,
      ttftMs,
      provider: 'anthropic-oauth',
      model: liveModel,
      transport: 'sse',
    });

    traceAgentUsage({
      sessionId,
      iteration,
      inputTokens: result.usage?.inputTokens || 0,
      outputTokens: result.usage?.outputTokens || 0,
      cachedTokens: result.usage?.cachedTokens || 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens || 0,
      promptTokens: result.usage?.promptTokens || 0,
      model: liveModel,
      modelDisplay: _displayModel(liveModel),
      rawUsage: result.usage?.raw || null,
      provider: 'anthropic-oauth',
      requestKind,
    });

    // Phase I: if the live response surfaced a model id we don't know
    // about yet, kick off a background catalog refresh. Fire-and-forget
    // — do not await, do not surface errors.
    if (result.model && !_catalogHas(result.model)) {
      void this._refreshModelCache();
    }

    if (SSE_VERBOSE)
      process.stderr.write(
        `[anthropic-oauth] Done: ${result.content.length} chars, ${result.toolCalls?.length || 0} tool calls\n`
      );
    // Empty-stream guard. Invariant: a valid Anthropic SSE response
    // ALWAYS opens with message_start (which carries usage.input_tokens).
    // A 200 whose body produced no message_start delivered nothing —
    // no usage, no content, no tool calls — i.e. a dropped/empty stream
    // (transient, often rate-limit-adjacent under concurrent load), NOT
    // a valid terminal turn. Returning it surfaces upstream as a silent
    // empty turn (0 tokens, no content) that masks the cause. Throw a
    // marked error: retry is provably safe here (no message_start ⇒
    // nothing was emitted ⇒ no duplicate-tool risk), and once retries
    // are exhausted the error is surfaced instead of swallowed.
    if (
      !midState.sawMessageStart &&
      !midState.userAbort &&
      !midState.watchdogAbort &&
      !result.content &&
      !result.toolCalls?.length &&
      !(result.usage && result.usage.inputTokens > 0)
    ) {
      const emptyErr = new Error(
        'Anthropic OAuth SSE stream produced no message_start (empty/dropped stream — likely transient or rate-limited)'
      );
      emptyErr.code = 'EEMPTYSTREAM';
      emptyErr.isEmptyStream = true;
      throw emptyErr;
    }
  }

  async listModels() {
    // Dynamic lookup via /v1/models — returns whatever Anthropic currently
    // exposes for this OAuth account. Cached on disk with 24h TTL; falls
    // back to the static MODELS list on any failure so the plugin still
    // works offline or when Anthropic's /v1/models is momentarily down.
    const cached = await _loadModelCache();
    if (cached) {
      _setInMemoryCatalog(cached);
      return cached;
    }
    try {
      const creds = await this.ensureAuth();
      const res = await fetch('https://api.anthropic.com/v1/models', {
        signal: AbortSignal.timeout(10_000),
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': OAUTH_BETA_HEADERS,
          'anthropic-dangerous-direct-browser-access': 'true',
          'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
          'x-app': 'cli',
        },
        dispatcher: getLlmDispatcher(),
      });
      if (!res.ok) throw new Error(`list_models ${res.status}`);
      const data = await res.json();
      const items = Array.isArray(data?.data) ? data.data : [];
      // Normalize + mark-latest + LiteLLM-enrich + persist (shared helper).
      const enriched = await normalizeAndSaveCatalog(items);
      return enriched;
    } catch (err) {
      if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
        process.stderr.write(`[anthropic-oauth] listModels fetch failed (${err.message})\n`);
      // Fallback with full API model IDs. Short family tokens leaked
      // through here would be accepted by setup and reintroduce the
      // legacy shape. Env var override keeps this tracking defaults.
      const opusId = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-opus-4-8';
      const sonnetId = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';
      const haikuId = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
      return [
        {
          id: opusId,
          display: 'Opus (auto)',
          family: 'opus',
          provider: 'anthropic-oauth',
          tier: 'family',
          latest: true,
          contextWindow: 1000000,
        },
        {
          id: sonnetId,
          display: 'Sonnet (auto)',
          family: 'sonnet',
          provider: 'anthropic-oauth',
          tier: 'family',
          latest: true,
          contextWindow: 1000000,
        },
        {
          id: haikuId,
          display: 'Haiku (auto)',
          family: 'haiku',
          provider: 'anthropic-oauth',
          tier: 'family',
          latest: true,
          contextWindow: 200000,
        },
      ];
    }
  }

  // Force a catalog refresh (ignores the 24h TTL). De-duped via
  // _modelRefreshInFlight so concurrent callers share one HTTP round-trip.
  // Returns the new catalog on success, null on failure.
  async _refreshModelCache() {
    if (_modelRefreshInFlight) return _modelRefreshInFlight;
    _modelRefreshInFlight = (async () => {
      try {
        const creds = await this.ensureAuth();
        const res = await fetch('https://api.anthropic.com/v1/models', {
          signal: AbortSignal.timeout(10_000),
          method: 'GET',
          headers: {
            Authorization: `Bearer ${creds.accessToken}`,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': OAUTH_BETA_HEADERS,
            'anthropic-dangerous-direct-browser-access': 'true',
            'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
            'x-app': 'cli',
          },
          dispatcher: getLlmDispatcher(),
        });
        if (!res.ok) throw new Error(`list_models ${res.status}`);
        const data = await res.json();
        const items = Array.isArray(data?.data) ? data.data : [];
        const enriched = await normalizeAndSaveCatalog(items);
        if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
          process.stderr.write(`[anthropic-oauth] catalog refreshed (${enriched.length} models)\n`);
        return enriched;
      } catch (err) {
        if (!process.env.MIXDOG_QUIET_PROVIDER_LOG)
          process.stderr.write(`[anthropic-oauth] catalog refresh failed (${err.message})\n`);
        return null;
      } finally {
        _modelRefreshInFlight = null;
      }
    })();
    return _modelRefreshInFlight;
  }

  async isAvailable() {
    return this.credentials !== null || loadCredentials() !== null;
  }
}

// Re-exports so external callers of anthropic-oauth.mjs keep their existing
// import path after the credential/login-flow extraction into
// anthropic-oauth-credentials.mjs.
export {
  hasAnthropicOAuthCredentials,
  describeAnthropicOAuthCredentials,
  forgetAnthropicOAuthCredentials,
  beginOAuthLogin,
  loginOAuth,
};

// Re-exports so anthropic.mjs and the test harnesses keep their existing
// import path after the SSE-parser extraction into anthropic-sse.mjs.
export { parseSSEStream, _classifyMidstreamError, ANTHROPIC_MAX_MIDSTREAM_RETRIES };

// Test-only escape hatch for scripts/tool-smoke.mjs to verify the
// catalog-driven max-tokens resolution without duplicating its logic.
export const _test = {
  resolveMaxTokens,
  deferredAnthropicTools,
  requestAnthropicTools,
  buildOAuthBetaHeaders,
  sanitizeInputSchema: (schema, toolName) => sanitizeAnthropicInputSchema(schema, toolName, 'anthropic-oauth'),
};
