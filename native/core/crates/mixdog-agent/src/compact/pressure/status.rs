//! The `/context` gauge (`runtime-core/context-status*.mjs`, with the pieces of
//! `loop/compact-policy.mjs`, `context-compaction-policy.mjs` and `shared/context-measurement.mjs`
//! it reads): the session's token counters, its compaction policy and the resolved usage, as the
//! JSON record `thread/contextStatus` answers.
//!
//! It is a pure function of the session header (its fields under Node's names, as the pressure
//! state above keeps them), the transcript and the tools of the request. The facts that live in
//! modules this crate does not own arrive as inputs ([`StatusInput`]): the tool-schema breakdown by
//! catalog bucket, whether the transcript holds real history, and whether the session runs in agent
//! mode. The meter and the transcript signatures are the ones the compaction run uses.

use mixdog_core_api::domain::provider::Role;
use mixdog_js::JsRegex;
use mixdog_js::math::round;
use mixdog_js::token_estimate::estimate_tokens;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Header;
use super::TranscriptSigner;
use super::num;
use super::number;
use super::number_or_zero;
use super::or;
use super::or_null;
use super::positive_int;
use super::string_or_empty;
use super::truthy;
use crate::compact::estimate::MessageMeter;
use crate::compact::tool_schema::RequestTools;
use crate::compact::tool_schema::estimate_request_reserve_tokens;
use crate::compact::tool_schema::tool_schema_signature;
use crate::message::AgentMessage;

const SYSTEM_REMINDER_OPEN: &str = "<system-reminder>";
const COMPACT_SAFETY_PERCENT: f64 = 1.0;
const CONTEXT_SHARE_RATIO: f64 = 0.25;
const COMPACT_TARGET_MIN_TOKENS: f64 = 4000.0;
const DEFAULT_COMPACTION_BUFFER_RATIO: f64 = 0.0;
const MAX_COMPACTION_BUFFER_RATIO: f64 = 0.25;
const MAX_BUFFER_INPUT_RATIO: f64 = 0.999_999;
const LEGACY_DEFAULT_COMPACTION_BUFFER_RATIO: f64 = 0.1;
const CONTEXT_USAGE_SNAPSHOT_VERSION: f64 = 1.0;

/// The route the session runs on, as the runtime resolved it (`getRoute()`).
pub struct Route<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    /// `route.contextWindow`, `null` when the route states none.
    pub context_window: Value,
}

/// Everything one status computation reads.
pub struct StatusInput<'a> {
    /// The session header, present or not carrying an `id` (a status of no session is the empty one).
    pub session: &'a Header,
    pub route: Route<'a>,
    /// `getCurrentCwd()` and `getMode()`; a missing one is `Value::Null` and is left out of the record.
    pub cwd: Value,
    pub mode: Value,
    /// The working transcript: the in-flight turn's while one runs, else the committed one.
    pub messages: &'a [AgentMessage],
    /// `hasRouteHistoryMessage(messages)`.
    pub active: bool,
    /// The tools the next request carries, and the session's own tool list (the empty status prices
    /// that one).
    pub request_tools: RequestTools<'a>,
    pub session_tools: RequestTools<'a>,
    /// `estimateToolSchemaBreakdown(requestTools)`.
    pub tool_breakdown: &'a Value,
    /// `isAgentModeSession(session)`.
    pub agent_mode: bool,
    pub meter: &'a MessageMeter<'a>,
    pub signer: &'a TranscriptSigner<'a>,
}

// --- Environment and config reads -------------------------------------------

fn env_text(name: &str) -> Option<Value> {
    std::env::var(name).ok().map(Value::String)
}

/// `envFlag(name, fallback)`.
fn env_flag(name: &str, fallback: bool) -> bool {
    let Ok(raw) = std::env::var(name) else { return fallback };
    let value = raw.trim().to_lowercase();
    match value.as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "off" | "no" => false,
        _ => fallback,
    }
}

/// `envPositiveInt(name)`.
fn env_positive_int(name: &str) -> Option<f64> {
    positive_int(env_text(name).as_ref())
}

fn get<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    map.get(key)
}

/// `a ?? b`: the first that is not `undefined` or `null`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        Some(Value::Null) | None => b,
        _ => a,
    }
}

/// `raw == null || raw === ''`.
fn unset(raw: Option<&Value>) -> bool {
    matches!(raw, None | Some(Value::Null)) || raw.and_then(Value::as_str) == Some("")
}

/// `positiveInt(a) || positiveInt(b) || ...`'s first hit.
fn first_positive(values: &[Option<&Value>]) -> Option<f64> {
    values.iter().find_map(|value| positive_int(*value))
}

fn finite(value: f64) -> bool {
    value.is_finite()
}

fn is_agent_owner(session: &Header) -> bool {
    string_or_empty(get(session, "owner")).trim().to_lowercase() == "agent"
}

// --- Compaction buffer policy (context-compaction-policy.mjs) -----------------

fn normalize_buffer_ratio(value: Option<f64>, fallback: f64) -> f64 {
    let Some(n) = value else { return fallback };
    if !finite(n) || n < 0.0 {
        return fallback;
    }
    if n == 0.0 {
        return 0.0;
    }
    if n > 1.0 { n / 100.0 } else { n }
}

/// `resolveBufferRatioCandidate(percentInputs, ratioInputs)`.
fn buffer_ratio_candidate(percents: &[Option<Value>], ratios: &[Option<Value>]) -> Option<f64> {
    for raw in percents {
        if unset(raw.as_ref()) {
            continue;
        }
        let n = number(raw.as_ref());
        if finite(n) && n >= 0.0 {
            return Some(MAX_BUFFER_INPUT_RATIO.min(n / 100.0));
        }
    }
    for raw in ratios {
        if unset(raw.as_ref()) {
            continue;
        }
        let n = number(raw.as_ref());
        if finite(n) && n >= 0.0 {
            return Some(MAX_BUFFER_INPUT_RATIO.min(if n > 1.0 { n / 100.0 } else { n }));
        }
    }
    None
}

fn cfg_value(cfg: &Header, key: &str) -> Option<Value> {
    get(cfg, key).cloned()
}

/// `resolveCompactBufferRatio(cfg)`.
fn compact_buffer_ratio(cfg: &Header) -> f64 {
    let resolved = buffer_ratio_candidate(
        &[cfg_value(cfg, "bufferPercent"), cfg_value(cfg, "bufferPct"), env_text("MIXDOG_AGENT_COMPACT_BUFFER_PERCENT")],
        &[cfg_value(cfg, "bufferRatio"), cfg_value(cfg, "bufferFraction"), env_text("MIXDOG_AGENT_COMPACT_BUFFER_RATIO")],
    );
    normalize_buffer_ratio(resolved, DEFAULT_COMPACTION_BUFFER_RATIO)
}

enum MainBuffer {
    Tokens(f64),
    Ratio(f64),
}

/// `resolveMainBufferSetting(cfg)`.
fn main_buffer_setting(cfg: &Header) -> Option<MainBuffer> {
    if let Some(tokens) = first_positive(&[get(cfg, "mainBufferTokens"), get(cfg, "mainBuffer")]) {
        return Some(MainBuffer::Tokens(tokens));
    }
    if let Some(ratio) = buffer_ratio_candidate(
        &[cfg_value(cfg, "mainBufferPercent"), cfg_value(cfg, "mainBufferPct")],
        &[cfg_value(cfg, "mainBufferRatio"), cfg_value(cfg, "mainBufferFraction")],
    ) {
        return Some(MainBuffer::Ratio(ratio));
    }
    if let Some(tokens) = positive_int(env_text("MIXDOG_MAIN_COMPACT_BUFFER_TOKENS").as_ref()) {
        return Some(MainBuffer::Tokens(tokens));
    }
    buffer_ratio_candidate(
        &[env_text("MIXDOG_MAIN_COMPACT_BUFFER_PERCENT")],
        &[env_text("MIXDOG_MAIN_COMPACT_BUFFER_RATIO")],
    )
    .map(MainBuffer::Ratio)
}

/// `compactionBufferTokensForBoundary(boundary, { explicitTokens, ratio, maxRatio })`.
fn buffer_tokens_for_boundary(boundary_tokens: f64, explicit_tokens: f64, ratio: f64, max_ratio: f64) -> f64 {
    let boundary = number_or_zero(Some(&num(boundary_tokens))).floor().max(0.0);
    let explicit = explicit_tokens.floor().max(0.0);
    if boundary == 0.0 {
        return explicit;
    }
    let max_ratio = normalize_buffer_ratio(Some(max_ratio), MAX_COMPACTION_BUFFER_RATIO);
    let cap = (boundary * max_ratio).floor().max(0.0);
    if explicit > 0.0 {
        return explicit.min(cap).max(0.0);
    }
    let ratio = normalize_buffer_ratio(Some(ratio), DEFAULT_COMPACTION_BUFFER_RATIO);
    (boundary * ratio).floor().min(cap).max(0.0)
}

/// `bufferTelemetryBaseline(cfg, boundary)`.
fn buffer_telemetry_baseline(cfg: &Header, boundary: Option<f64>) -> bool {
    if boundary.is_none() || env_positive_int("MIXDOG_AGENT_COMPACT_BUFFER_TOKENS").is_some() {
        return false;
    }
    for name in ["MIXDOG_AGENT_COMPACT_BUFFER_PERCENT", "MIXDOG_AGENT_COMPACT_BUFFER_RATIO"] {
        let n = number(env_text(name).as_ref());
        if finite(n) && n > 0.0 {
            return false;
        }
    }
    for key in ["bufferPercent", "bufferPct", "bufferFraction"] {
        let n = number(get(cfg, key));
        if finite(n) && n > 0.0 {
            return false;
        }
    }
    true
}

fn is_persisted_zero_buffer_telemetry(cfg: &Header, boundary: Option<f64>) -> bool {
    if !buffer_telemetry_baseline(cfg, boundary) {
        return false;
    }
    let ratio = number(get(cfg, "bufferRatio"));
    if finite(ratio) && ratio > 0.0 {
        return false;
    }
    let explicit = number(nullish(get(cfg, "bufferTokens"), get(cfg, "buffer")));
    finite(explicit) && explicit == 0.0
}

fn is_legacy_default_buffer_telemetry(cfg: &Header, boundary: Option<f64>) -> bool {
    if !buffer_telemetry_baseline(cfg, boundary) {
        return false;
    }
    let Some(boundary) = boundary else { return false };
    let Some(explicit) = positive_int(nullish(get(cfg, "bufferTokens"), get(cfg, "buffer"))) else { return false };
    let ratio = number(get(cfg, "bufferRatio"));
    if !finite(ratio) || (ratio - LEGACY_DEFAULT_COMPACTION_BUFFER_RATIO).abs() > 1e-9 {
        return false;
    }
    let expected = (boundary * LEGACY_DEFAULT_COMPACTION_BUFFER_RATIO).floor();
    let cfg_boundary = positive_int(get(cfg, "boundaryTokens"));
    let cfg_trigger = positive_int(get(cfg, "triggerTokens"));
    explicit == expected
        || (cfg_boundary == Some(boundary) && cfg_trigger.is_some_and(|t| t > 0.0) && explicit == (boundary - cfg_trigger.unwrap_or(0.0)).max(0.0))
}

/// `resolveCompactBufferTokens(boundary, cfg)`.
fn compact_buffer_tokens(boundary: f64, cfg: &Header) -> f64 {
    let legacy = is_legacy_default_buffer_telemetry(cfg, Some(boundary)) || is_persisted_zero_buffer_telemetry(cfg, Some(boundary));
    let mut effective = cfg.clone();
    if legacy {
        for key in ["bufferTokens", "buffer", "bufferRatio"] {
            effective.insert(key.to_owned(), Value::Null);
        }
    }
    let configured = first_positive(&[nullish(get(&effective, "bufferTokens"), get(&effective, "buffer"))])
        .or_else(|| env_positive_int("MIXDOG_AGENT_COMPACT_BUFFER_TOKENS"))
        .unwrap_or(0.0);
    buffer_tokens_for_boundary(boundary, configured, compact_buffer_ratio(&effective), MAX_COMPACTION_BUFFER_RATIO)
}

/// `resolveMainCompactBufferTokens(boundary, cfg)`.
fn main_compact_buffer_tokens(boundary: f64, cfg: &Header) -> f64 {
    let (tokens, ratio) = match main_buffer_setting(cfg) {
        Some(MainBuffer::Tokens(tokens)) => (tokens, 0.0),
        Some(MainBuffer::Ratio(ratio)) => (0.0, ratio),
        None => (0.0, 0.0),
    };
    buffer_tokens_for_boundary(boundary, tokens, ratio, MAX_COMPACTION_BUFFER_RATIO)
}

/// What `resolveSessionCompactPolicy` answers.
struct SessionCompactPolicy {
    auto_compact_token_limit: Option<f64>,
    trigger_tokens: Option<f64>,
    buffer_tokens: f64,
    buffer_ratio: f64,
}

/// `resolveSessionCompactPolicy(session, boundaryTokens)`.
fn session_compact_policy(session: &Header, boundary_tokens: Option<f64>) -> SessionCompactPolicy {
    let compaction = get(session, "compaction").filter(|v| truthy(Some(v))).and_then(Value::as_object);
    let cfg = compaction.unwrap_or(session);
    let Some(boundary) = boundary_tokens.filter(|b| *b >= 1.0) else {
        let buffer_ratio = if is_agent_owner(session) {
            compact_buffer_ratio(cfg)
        } else {
            match main_buffer_setting(cfg) {
                Some(MainBuffer::Ratio(ratio)) => ratio,
                _ => 0.0,
            }
        };
        return SessionCompactPolicy { auto_compact_token_limit: None, trigger_tokens: None, buffer_tokens: 0.0, buffer_ratio };
    };
    let raw_limit = positive_int(nullish(get(session, "autoCompactTokenLimit"), get(cfg, "autoCompactTokenLimit")));
    let explicit_limit = raw_limit.filter(|limit| *limit < boundary);
    let trigger = match explicit_limit {
        Some(limit) => limit,
        None if is_agent_owner(session) => (boundary - compact_buffer_tokens(boundary, cfg)).max(1.0),
        None => (boundary - main_compact_buffer_tokens(boundary, cfg)).max(1.0),
    };
    let buffer_tokens = (boundary - trigger).max(0.0);
    SessionCompactPolicy {
        auto_compact_token_limit: explicit_limit,
        trigger_tokens: Some(trigger),
        buffer_tokens,
        buffer_ratio: buffer_tokens / boundary,
    }
}

// --- The worker policy (loop/compact-policy.mjs) -------------------------------

/// The compaction policy as the gauge reads it. A field the policy object does not carry is `None`
/// (`undefined`).
#[derive(Default)]
struct Policy {
    boundary_tokens: Option<f64>,
    trigger_tokens: Option<f64>,
    buffer_tokens: Option<f64>,
    buffer_ratio: Option<f64>,
    context_window: Option<f64>,
    request_reserve_tokens: Option<f64>,
    configured_reserve_tokens: Option<f64>,
    reserve_tokens: Option<f64>,
    token_calibration: f64,
    tool_schema_signature: Option<String>,
    provider: Option<Value>,
    /// `compactTargetTokens`: the gauge's post-compaction target.
    compact_target_tokens: Option<f64>,
    single_shot: bool,
}

/// `providerTokenCalibration(provider)`.
pub fn provider_token_calibration(provider: Option<&Value>) -> f64 {
    let p = string_or_empty(provider).to_lowercase();
    let env = |name: &str| {
        let n = number(env_text(name).as_ref());
        (finite(n) && n > 0.0).then(|| n.clamp(0.25, 3.0))
    };
    if p.starts_with("anthropic") {
        env("MIXDOG_TOKEN_CALIBRATION_ANTHROPIC").unwrap_or(1.4)
    } else if p.starts_with("gemini") || p.starts_with("google") {
        env("MIXDOG_TOKEN_CALIBRATION_GEMINI").unwrap_or(1.15)
    } else {
        env("MIXDOG_TOKEN_CALIBRATION_DEFAULT").unwrap_or(1.0)
    }
}

fn compact_target_ratio(cfg: &Header) -> f64 {
    let env = ["MIXDOG_AGENT_COMPACT_TARGET_PERCENT", "MIXDOG_COMPACT_TARGET_PERCENT"].map(env_text);
    let raw = [get(cfg, "targetPercent"), get(cfg, "targetPct"), get(cfg, "targetRatio"), get(cfg, "targetFraction")]
        .into_iter()
        .chain(env.iter().map(Option::as_ref))
        .find(|value| !matches!(value, None | Some(Value::Null)));
    let n = match raw {
        Some(value) => number(value),
        None => CONTEXT_SHARE_RATIO,
    };
    if !finite(n) || n <= 0.0 {
        return CONTEXT_SHARE_RATIO;
    }
    if n > 1.0 { n / 100.0 } else { n }
}

/// `resolveCompactTargetTokens(boundary, cfg)`.
fn compact_target_tokens(boundary: f64, cfg: &Header) -> Option<f64> {
    if boundary < 1.0 {
        return None;
    }
    let explicit = positive_int(nullish(get(cfg, "targetTokens"), get(cfg, "target")))
        .or_else(|| env_positive_int("MIXDOG_AGENT_COMPACT_TARGET_TOKENS"))
        .or_else(|| env_positive_int("MIXDOG_COMPACT_TARGET_TOKENS"));
    if let Some(explicit) = explicit {
        return Some(explicit.min(boundary).max(1.0));
    }
    let min_target = boundary.min(
        positive_int(nullish(get(cfg, "targetMinTokens"), get(cfg, "minTargetTokens")))
            .or_else(|| env_positive_int("MIXDOG_AGENT_COMPACT_TARGET_MIN_TOKENS"))
            .or_else(|| env_positive_int("MIXDOG_COMPACT_TARGET_MIN_TOKENS"))
            .unwrap_or(COMPACT_TARGET_MIN_TOKENS),
    );
    let by_ratio = (boundary * compact_target_ratio(cfg)).floor().max(1.0);
    Some(boundary.min(min_target.max(by_ratio)).max(1.0))
}

/// `resolveWorkerCompactPolicy(session, tools)`: `None` is `null`; `auto: false` is `{ auto: false }`.
enum Worker {
    Off,
    Policy(Box<Policy>),
}

fn worker_policy(session: &Header, tools: &RequestTools<'_>, agent_mode: bool) -> Option<Worker> {
    let empty = Map::new();
    let cfg = get(session, "compaction").filter(|v| truthy(Some(v))).and_then(Value::as_object).unwrap_or(&empty);
    let auto = (get(cfg, "auto") != Some(&Value::Bool(false)) || agent_mode) && env_flag("MIXDOG_AGENT_COMPACT_AUTO", true);
    if !auto {
        return Some(Worker::Off);
    }
    let context_window = positive_int(nullish(get(session, "contextWindow"), get(cfg, "contextWindow")));
    let explicit_boundary = positive_int(nullish(get(session, "compactBoundaryTokens"), get(cfg, "boundaryTokens")));
    let auto_limit = positive_int(nullish(get(session, "autoCompactTokenLimit"), get(cfg, "autoCompactTokenLimit")));
    let boundary_tokens = match (explicit_boundary, context_window) {
        (Some(explicit), Some(window)) => Some(explicit.min(window)),
        (Some(explicit), None) => Some(explicit),
        (None, Some(window)) => Some(window),
        (None, None) => auto_limit,
    }?;
    let compact_boundary = (boundary_tokens * COMPACT_SAFETY_PERCENT).floor().max(1.0);
    let policy = session_compact_policy(session, Some(compact_boundary));
    let configured = first_positive(&[get(cfg, "reservedTokens")])
        .or_else(|| env_positive_int("MIXDOG_AGENT_COMPACT_RESERVED_TOKENS"))
        .unwrap_or(0.0);
    let request_reserve = estimate_request_reserve_tokens(tools) as f64;
    let reserve = request_reserve + configured;
    let target = compact_target_tokens(compact_boundary, cfg).unwrap_or(compact_boundary);
    let legacy_target = (target + reserve).min(compact_boundary).max(1.0);
    let policy_trigger = policy.trigger_tokens.unwrap_or(f64::NAN);
    let single_shot = reserve >= policy_trigger;
    let base_trigger = if !single_shot && !is_agent_owner(session) && policy.auto_compact_token_limit.is_none() {
        let margin = (compact_boundary * 0.01).floor().min(1024.0).max(1.0);
        policy_trigger.max(compact_boundary.min(legacy_target + margin))
    } else {
        policy_trigger
    };
    let trigger = (base_trigger - configured).max(1.0);
    let buffer = (compact_boundary - trigger).max(0.0);
    Some(Worker::Policy(Box::new(Policy {
        boundary_tokens: Some(compact_boundary),
        trigger_tokens: Some(trigger),
        buffer_tokens: Some(buffer),
        buffer_ratio: Some(buffer / compact_boundary),
        context_window,
        request_reserve_tokens: Some(request_reserve),
        configured_reserve_tokens: Some(configured),
        reserve_tokens: Some(reserve),
        token_calibration: provider_token_calibration(get(session, "provider")),
        tool_schema_signature: Some(tool_schema_signature(tools)),
        provider: Some(or_null(get(session, "provider"))),
        compact_target_tokens: Some(target),
        single_shot,
    })))
}

// --- Usage resolution ---------------------------------------------------------

fn policy_calibration(policy: &Policy) -> f64 {
    if policy.token_calibration > 0.0 { policy.token_calibration } else { 1.0 }
}

/// `policyRequestReserveTokens(policy)`.
fn policy_request_reserve(policy: &Policy) -> f64 {
    let configured = policy.configured_reserve_tokens.filter(|v| finite(*v)).unwrap_or(0.0).max(0.0);
    let total = policy.reserve_tokens.filter(|v| finite(*v)).unwrap_or(0.0).max(0.0);
    let request = policy.request_reserve_tokens.unwrap_or(total - configured);
    total.min(if finite(request) { request.max(0.0) } else { 0.0 })
}

/// `currentContextEstimateTokens(messageTokensEst, policy)`.
fn current_estimate_tokens(message_tokens: f64, policy: &Policy) -> f64 {
    round((message_tokens + policy_request_reserve(policy)) * policy_calibration(policy)).max(0.0)
}

fn tail_of(messages: &[AgentMessage], signer: &TranscriptSigner<'_>) -> (String, String) {
    let (role, id) = signer.snapshot_tail(messages);
    (role.to_owned(), id)
}

fn count_value(value: Option<&Value>) -> f64 {
    number(value)
}

/// `resolveContextUsageSnapshot(session, policy, { messages })`: the post-compaction reading while it
/// still describes this transcript, route and tool surface.
fn usage_snapshot<'a>(session: &'a Header, policy: &Policy, messages: &[AgentMessage], signer: &TranscriptSigner<'_>) -> Option<&'a Map<String, Value>> {
    let snapshot = get(session, "contextUsageSnapshot")?.as_object()?;
    if number(get(snapshot, "version")) != CONTEXT_USAGE_SNAPSHOT_VERSION {
        return None;
    }
    let session_provider = get(session, "provider");
    let policy_provider = policy.provider.as_ref();
    if string_or_empty(get(snapshot, "provider")) != string_or_empty(or(session_provider, policy_provider))
        || string_or_empty(get(snapshot, "model")) != string_or_empty(get(session, "model"))
    {
        return None;
    }
    if count_value(get(snapshot, "messageCount")) != messages.len() as f64
        || string_or_empty(get(snapshot, "usageMetricsTurnId")) != string_or_empty(get(session, "usageMetricsTurnId"))
        || number_or_zero(get(snapshot, "usageMetricsEpoch")) != number_or_zero(get(session, "usageMetricsEpoch"))
    {
        return None;
    }
    let (tail_role, tail_id) = tail_of(messages, signer);
    if string_or_empty(get(snapshot, "tailRole")) != tail_role || string_or_empty(get(snapshot, "tailId")) != tail_id {
        return None;
    }
    let window = number_or_zero(or(get(session, "contextWindow"), None));
    let policy_window = policy.context_window.filter(|w| *w != 0.0).unwrap_or(window);
    let trigger_of = |policy: &Policy| policy.trigger_tokens.filter(|t| *t != 0.0).or(policy.boundary_tokens).unwrap_or(0.0);
    if string_or_empty(get(snapshot, "toolSchemaSignature")) != policy.tool_schema_signature.clone().unwrap_or_default()
        || number_or_zero(get(snapshot, "contextWindow")) != policy_window
        || number_or_zero(get(snapshot, "boundaryTokens")) != policy.boundary_tokens.unwrap_or(0.0)
        || number_or_zero(get(snapshot, "triggerTokens")) != trigger_of(policy)
    {
        return None;
    }
    // A stored-history normalization can replace inline media with placeholders without changing the
    // transcript; the turn, count and tail anchors above already hold then.
    let _ = signer.exact(messages);
    let used = number(get(snapshot, "usedTokens"));
    (finite(used) && used >= 0.0).then_some(snapshot)
}

/// A provider reading that still describes a prefix of the transcript.
pub(super) struct Coverage {
    pub(super) tokens: f64,
    pub(super) count: usize,
    baseline_at: f64,
}

/// `baselinePrefixMatchesTranscript(session, messages, count)`.
fn baseline_prefix_matches(session: &Header, messages: &[AgentMessage], count: usize, signer: &TranscriptSigner<'_>) -> bool {
    let stored = string_or_empty(get(session, "contextPressureBaselinePrefixSignature"));
    if stored.is_empty() {
        return false;
    }
    if stored == signer.exact(&messages[..count]) {
        return true;
    }
    let shape = string_or_empty(get(session, "contextPressureBaselineShapeSignature"));
    if !shape.is_empty() {
        return shape == signer.shape(&messages[..count]);
    }
    count == messages.len()
}

/// `providerBaselineCoverage(session, messages)`.
pub(super) fn provider_coverage(session: &Header, messages: &[AgentMessage], signer: &TranscriptSigner<'_>) -> Option<Coverage> {
    if get(session, "lastContextTokensStaleAfterCompact") == Some(&Value::Bool(true)) {
        return None;
    }
    let mut tokens = positive_int(get(session, "contextPressureBaselineTokens"))?;
    let output_tokens = number_or_zero(get(session, "contextPressureBaselineOutputTokens")).max(0.0);
    let count = number(get(session, "contextPressureBaselineMessageCount"));
    let baseline_at = number_or_zero(get(session, "contextPressureBaselineUpdatedAt"));
    let compaction = get(session, "compaction").and_then(Value::as_object);
    let compact_at = compaction
        .map(|c| number_or_zero(or(get(c, "lastChangedAt"), get(c, "lastCompactAt"))))
        .unwrap_or(0.0);
    if count.fract() != 0.0 || !finite(count) || count < 0.0 || count > messages.len() as f64 {
        return None;
    }
    let mut count = count as usize;
    let expected = |key: &str| or_null(get(session, key));
    if (compact_at > 0.0 && baseline_at > 0.0 && baseline_at < compact_at)
        || get(session, "contextPressureBaselineProvider") != Some(&expected("provider"))
        || get(session, "contextPressureBaselineModel") != Some(&expected("model"))
        || !baseline_prefix_matches(session, messages, count, signer)
    {
        return None;
    }
    if get(session, "contextPressureBaselineBoundary") == Some(&Value::String("request".into())) {
        match messages[count..].iter().position(|m| m.role() == Role::Assistant) {
            Some(offset) => count += offset + 1,
            None => tokens = (tokens - output_tokens).max(0.0),
        }
    }
    Some(Coverage { tokens, count, baseline_at })
}

/// `providerBaselinePressureTokens(messages, session, policy, { includeConfiguredReserve: false })`.
fn baseline_pressure_tokens(session: &Header, messages: &[AgentMessage], policy: &Policy, input: &StatusInput<'_>) -> Option<f64> {
    let aligned = provider_coverage(session, messages, input.signer)?;
    let (mut tokens, count, baseline_at) = (aligned.tokens, aligned.count, aligned.baseline_at);
    let calibration = policy_calibration(policy);
    let stored_signature = get(session, "contextPressureBaselineToolSignature");
    let same_tools = match (stored_signature, policy.tool_schema_signature.as_deref()) {
        (None, None) => true,
        (Some(Value::String(stored)), Some(current)) => stored == current,
        _ => false,
    };
    if !same_tools {
        let current = round(policy.request_reserve_tokens.filter(|v| finite(*v)).unwrap_or(0.0) * calibration).max(0.0);
        let stored = number(get(session, "contextPressureBaselineRequestReserveTokens"));
        tokens = if finite(stored) && stored >= 0.0 { (tokens - round(stored) + current).max(0.0) } else { tokens + current };
    }
    let last_send_at = number_or_zero(get(session, "lastProviderSendAt"));
    if messages.len() > count && baseline_at > 0.0 && last_send_at > baseline_at {
        return None;
    }
    let growth = if count < messages.len() { round(input.meter.messages(&messages[count..]) as f64 * calibration) } else { 0.0 };
    Some((tokens + growth).max(0.0))
}

/// `resolveContextTokensWithSource(messageTokensEst, policy, { messages, sessionRef })`.
fn resolve_tokens(session: &Header, message_tokens: f64, policy: &Policy, messages: &[AgentMessage], input: &StatusInput<'_>) -> (f64, &'static str) {
    if let Some(tokens) = baseline_pressure_tokens(session, messages, policy, input) {
        return (tokens, "provider");
    }
    if get(session, "contextPressureUnanchoredAfterRestart") == Some(&Value::Bool(true))
        && let Some(last) = first_positive(&[get(session, "contextPressureBaselineTokens"), get(session, "lastContextTokens")])
    {
        return (last, "provider_resume");
    }
    (current_estimate_tokens(message_tokens, policy), "estimated")
}

// --- Transcript summary (context-utils.mjs summarizeContextMessages) -------------

struct Row {
    count: f64,
    tokens: f64,
}

#[derive(Default)]
struct Semantic {
    system: (f64, f64),
    chat: (f64, f64),
    assistant: (f64, f64),
    reasoning: (f64, f64),
    tool_results: (f64, f64),
    reminders: (f64, f64, f64),
    workflow: f64,
    memory: f64,
    workspace: f64,
    environment: f64,
    other: f64,
}

static REMINDER_OPEN: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"^\s*<system-reminder>\s*", "i"));
static REMINDER_CLOSE: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"\s*</system-reminder>\s*$", "i"));
static HEADING_LINE: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"^#\s+", ""));
static HEADING: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"^#\s+([^\n]+)", ""));
static NEWLINE: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"\r?\n", ""));

fn js_trim(text: &str) -> &str {
    text.trim_matches(mixdog_js::is_js_space)
}

/// `section.match(/^#\s+([^\n]+)/)?.[1]`.
pub(super) fn section_heading(section: &str) -> Option<String> {
    HEADING.captures(section).and_then(|c| c.get(1)).map(str::to_owned)
}

/// `stripSystemReminder(text)`.
pub(super) fn strip_system_reminder(text: &str) -> String {
    let opened = REMINDER_OPEN.replace_all_with(text, |_| String::new());
    let closed = REMINDER_CLOSE.replace_all_with(&opened, |_| String::new());
    js_trim(&closed).to_owned()
}

/// `splitMarkdownSections(text)`.
pub(super) fn split_sections(text: &str) -> Vec<String> {
    let mut sections = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut lines = Vec::new();
    let mut from = 0;
    for found in NEWLINE.find_iter(text) {
        lines.push(&text[from..found.start]);
        from = found.end;
    }
    lines.push(&text[from..]);
    for line in lines {
        if HEADING_LINE.is_match(line) && !current.is_empty() {
            let body = js_trim(&current.join("\n")).to_owned();
            if !body.is_empty() {
                sections.push(body);
            }
            current = vec![line];
        } else {
            current.push(line);
        }
    }
    let tail = js_trim(&current.join("\n")).to_owned();
    if !tail.is_empty() {
        sections.push(tail);
    }
    sections
}

/// `reminderSectionBucket(section)`.
pub(super) fn section_bucket(section: &str) -> &'static str {
    let heading = HEADING.captures(section).and_then(|c| c.get(1)).map(|h| js_trim(h).to_lowercase()).unwrap_or_default();
    if heading.contains("core memory") {
        "memory"
    } else if heading.contains("active workflow") || heading.contains("available agents") || heading.contains("workflow") {
        "workflow"
    } else if heading.contains("workspace") {
        "workspace"
    } else if heading.contains("environment") {
        "environment"
    } else {
        "other"
    }
}

/// `summarizeContextMessages(messages)`.
pub fn summarize_messages(messages: &[AgentMessage], meter: &MessageMeter<'_>) -> Value {
    let mut roles = [("system", 0.0, 0.0), ("user", 0.0, 0.0), ("assistant", 0.0, 0.0), ("tool", 0.0, 0.0), ("other", 0.0, 0.0)].map(|(name, count, tokens)| (name, Row { count, tokens }));
    let mut semantic = Semantic::default();
    let (mut estimated, mut call_count, mut call_tokens, mut result_count, mut result_tokens) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for message in messages {
        let tokens = meter.message(message) as f64;
        let role = match message.role() {
            Role::System => 0,
            Role::User => 1,
            Role::Assistant => 2,
            Role::Tool => 3,
            Role::Developer => 4,
        };
        estimated += tokens;
        roles[role].1.count += 1.0;
        roles[role].1.tokens += tokens;
        let text = meter.estimate_text(message);
        match role {
            0 => {
                let workflow: f64 = split_sections(&text).iter().filter(|s| section_bucket(s) == "workflow").map(|s| estimate_tokens(s) as f64).sum();
                semantic.system.0 += 1.0;
                semantic.system.1 += tokens - workflow;
                semantic.workflow += workflow;
            }
            1 if js_trim(&text).starts_with(SYSTEM_REMINDER_OPEN) => {
                let mut buckets = [("workflow", 0.0), ("memory", 0.0), ("workspace", 0.0), ("environment", 0.0), ("other", 0.0)];
                let mut section_tokens = 0.0;
                for section in split_sections(&strip_system_reminder(&text)) {
                    let count = estimate_tokens(&section) as f64;
                    let name = section_bucket(&section);
                    if let Some(bucket) = buckets.iter_mut().find(|(n, _)| *n == name) {
                        bucket.1 += count;
                    }
                    section_tokens += count;
                }
                semantic.reminders.0 += 1.0;
                semantic.reminders.1 += tokens;
                semantic.reminders.2 += (tokens - section_tokens).max(0.0);
                semantic.workflow += buckets[0].1;
                semantic.memory += buckets[1].1;
                semantic.workspace += buckets[2].1;
                semantic.environment += buckets[3].1;
                semantic.other += buckets[4].1;
            }
            1 => {
                semantic.chat.0 += 1.0;
                semantic.chat.1 += tokens;
            }
            2 => {
                let reasoning = meter.reasoning_tokens(message) as f64;
                semantic.assistant.0 += 1.0;
                semantic.assistant.1 += tokens - reasoning;
                semantic.reasoning.0 += if reasoning > 0.0 { 1.0 } else { 0.0 };
                semantic.reasoning.1 += reasoning;
            }
            3 => {
                semantic.tool_results.0 += 1.0;
                semantic.tool_results.1 += tokens;
                result_count += 1.0;
                result_tokens += tokens;
            }
            _ => {}
        }
        if role == 2 && !message.message.tool_calls.is_empty() {
            let calls: Vec<Value> = message.message.tool_calls.iter().map(|c| json!({"id": c.id, "name": c.name, "arguments": c.arguments})).collect();
            call_count += calls.len() as f64;
            call_tokens += estimate_tokens(&mixdog_js::json_stringify(&Value::Array(calls))) as f64;
        }
    }
    let row = |count: f64, tokens: f64| json!({ "count": num(count), "tokens": num(tokens) });
    let mut role_rows = Map::new();
    for (name, r) in &roles {
        role_rows.insert((*name).to_owned(), row(r.count, r.tokens));
    }
    let semantic_rows = json!({
        "system": row(semantic.system.0, semantic.system.1),
        "chat": row(semantic.chat.0, semantic.chat.1),
        "assistant": row(semantic.assistant.0, semantic.assistant.1),
        "reasoning": row(semantic.reasoning.0, semantic.reasoning.1),
        "toolResults": row(semantic.tool_results.0, semantic.tool_results.1),
        "reminders": { "count": num(semantic.reminders.0), "tokens": num(semantic.reminders.1), "otherTokens": num(semantic.reminders.2) },
        "workflow": { "tokens": num(semantic.workflow) },
        "memory": { "tokens": num(semantic.memory) },
        "workspace": { "tokens": num(semantic.workspace) },
        "environment": { "tokens": num(semantic.environment) },
        "other": { "tokens": num(semantic.other) },
    });
    json!({
        "count": messages.len(),
        "estimatedTokens": num(estimated),
        "roles": role_rows,
        "semantic": semantic_rows,
        "toolCallCount": num(call_count),
        "toolCallTokens": num(call_tokens),
        "toolResultCount": num(result_count),
        "toolResultTokens": num(result_tokens),
    })
}

// --- Status records (context-status-shape.mjs) ------------------------------------

/// `sessionContextMeasurement(session, hasConversationActivity)`.
fn measurement(session: &Header, active: bool) -> Value {
    let pending = json!({ "tokens": null, "source": "pending", "updatedAt": null });
    if !active || get(session, "contextPressureBaselineSource") == Some(&Value::String("checkpoint_post_compact".into())) {
        return pending;
    }
    let updated_at = number_or_zero(get(session, "lastContextTokensUpdatedAt"));
    let compaction = get(session, "compaction").and_then(Value::as_object);
    let compact_at = compaction
        .map(|c| number_or_zero(get(c, "lastChangedAt")).max(number_or_zero(get(c, "lastCompactAt"))))
        .unwrap_or(0.0);
    let differs = |baseline: &str, key: &str| truthy(get(session, baseline)) && get(session, baseline) != get(session, key);
    let route_mismatch = differs("contextPressureBaselineProvider", "provider") || differs("contextPressureBaselineModel", "model");
    if route_mismatch || (compact_at > 0.0 && updated_at <= compact_at) {
        return pending;
    }
    if get(session, "lastContextTokens") == Some(&Value::Null) && updated_at > 0.0 {
        return json!({ "tokens": null, "source": "unavailable", "updatedAt": num(updated_at) });
    }
    if get(session, "lastContextTokensStaleAfterCompact") == Some(&Value::Bool(true)) {
        return pending;
    }
    let tokens = number(get(session, "lastContextTokens"));
    if finite(tokens) && tokens > 0.0 {
        json!({ "tokens": num(tokens), "source": "last_api_request", "updatedAt": if updated_at != 0.0 { num(updated_at) } else { Value::Null } })
    } else {
        pending
    }
}

/// `statusIdentity(session, route, env)`.
fn identity(input: &StatusInput<'_>) -> Map<String, Value> {
    let session = input.session;
    let mut out = Map::new();
    out.insert("sessionId".into(), or_null(get(session, "id")));
    out.insert("provider".into(), or(get(session, "provider"), Some(&json!(input.route.provider))).cloned().unwrap_or(Value::Null));
    out.insert("model".into(), or(get(session, "model"), Some(&json!(input.route.model))).cloned().unwrap_or(Value::Null));
    if !input.cwd.is_null() {
        out.insert("cwd".into(), input.cwd.clone());
    }
    if !input.mode.is_null() {
        out.insert("toolMode".into(), input.mode.clone());
    }
    out
}

/// `sessionUsageCounters(session, lastContextTokens)`.
fn usage_counters(session: Option<&Header>, last_context_tokens: f64) -> Value {
    let counter = |key: &str| num(session.map_or(0.0, |s| number_or_zero(or(get(s, key), None))));
    let truthy_or_null = |key: &str| session.and_then(|s| get(s, key)).filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
    json!({
        "reasoningUsage": truthy_or_null("reasoningUsage"),
        "lastInputTokens": counter("lastInputTokens"),
        "lastUncachedInputTokens": counter("lastUncachedInputTokens"),
        "lastOutputTokens": counter("lastOutputTokens"),
        "lastCachedReadTokens": counter("lastCachedReadTokens"),
        "lastCacheWriteTokens": counter("lastCacheWriteTokens"),
        "lastContextTokens": num(last_context_tokens),
        "totalInputTokens": counter("totalInputTokens"),
        "totalUncachedInputTokens": counter("totalUncachedInputTokens"),
        "totalOutputTokens": counter("totalOutputTokens"),
        "totalCachedReadTokens": counter("totalCachedReadTokens"),
        "totalCacheWriteTokens": counter("totalCacheWriteTokens"),
        "usageReadout": truthy_or_null("usageReadout"),
    })
}

fn or_none(value: f64) -> Value {
    if value == 0.0 || value.is_nan() { Value::Null } else { num(value) }
}

fn finite_or_null(value: Option<f64>) -> Value {
    value.filter(|v| finite(*v)).map_or(Value::Null, num)
}

/// `emptyContextStatus(session, route, env)`.
fn empty_status(input: &StatusInput<'_>) -> Value {
    let session = input.session;
    let policy = worker_policy(session, &input.session_tools, input.agent_mode);
    let route_window = number_or_zero(or(
        get(session, "compactBoundaryTokens"),
        or(get(session, "contextWindow"), Some(&input.route.context_window)),
    ))
    .max(0.0);
    let window = if route_window != 0.0 { num(route_window) } else { Value::Null };
    let boundary = {
        let configured = or(get(session, "compactBoundaryTokens"), None);
        let from_policy = match &policy {
            Some(Worker::Policy(p)) => p.boundary_tokens,
            _ => None,
        };
        let value = if truthy(configured) { number(configured) } else { from_policy.unwrap_or(0.0) };
        or_none(value)
    };
    let (trigger, buffer_tokens, buffer_ratio) = match &policy {
        Some(Worker::Policy(p)) => (or_none(p.trigger_tokens.unwrap_or(0.0)), p.buffer_tokens.map(|b| b.max(0.0)), p.buffer_ratio),
        _ => (Value::Null, None, None),
    };
    let mut out = identity(input);
    out.insert("contextWindow".into(), window.clone());
    out.insert("effectiveContextWindow".into(), window.clone());
    out.insert("rawContextWindow".into(), window);
    out.insert("effectiveContextWindowPercent".into(), Value::Null);
    out.insert("usedTokens".into(), json!(0));
    out.insert("usedSource".into(), json!("empty"));
    out.insert("measurement".into(), measurement(session, false));
    out.insert("currentEstimatedTokens".into(), json!(0));
    out.insert("lastApiRequestTokens".into(), json!(0));
    out.insert("lastApiRequestStale".into(), json!(false));
    out.insert("freeTokens".into(), num(route_window));
    out.insert(
        "compaction".into(),
        json!({
            "boundaryTokens": boundary,
            "triggerTokens": trigger,
            "bufferTokens": finite_or_null(buffer_tokens),
            "bufferRatio": finite_or_null(buffer_ratio),
            "currentEstimatedTokens": 0,
            "lastApiRequestTokens": 0,
            "lastApiRequestStale": false,
        }),
    );
    out.insert("messages".into(), summarize_messages(&[], input.meter));
    out.insert("request".into(), json!({ "toolSchemaTokens": 0, "toolSchemaBreakdown": {}, "requestOverheadTokens": 0, "reserveTokens": 0 }));
    out.insert("usage".into(), usage_counters(None, 0.0));
    Value::Object(out)
}

/// The fallback policy when no worker policy has a boundary: the session's own buffer policy with the
/// provider's calibration.
fn contextual_policy(session: &Header, input: &StatusInput<'_>, compact_boundary: f64) -> Policy {
    if let Some(Worker::Policy(p)) = worker_policy(session, &input.request_tools, input.agent_mode)
        && p.boundary_tokens.is_some_and(|b| b != 0.0)
    {
        return *p;
    }
    let boundary = (compact_boundary != 0.0).then_some(compact_boundary);
    let base = session_compact_policy(session, boundary);
    Policy {
        trigger_tokens: base.trigger_tokens,
        buffer_tokens: Some(base.buffer_tokens),
        buffer_ratio: Some(base.buffer_ratio),
        token_calibration: provider_token_calibration(or(get(session, "provider"), Some(&json!(input.route.provider)))),
        ..Policy::default()
    }
}

/// `lastUsageIsStale(session, lastContextTokens)`.
fn last_usage_stale(session: &Header, last_context_tokens: f64) -> bool {
    if last_context_tokens == 0.0 {
        return false;
    }
    let compaction = get(session, "compaction").and_then(Value::as_object);
    let compact_at = compaction.map_or(0.0, |c| number_or_zero(or(get(c, "lastChangedAt"), get(c, "lastCompactAt"))));
    let usage_at = number_or_zero(get(session, "lastContextTokensUpdatedAt"));
    get(session, "lastContextTokensStaleAfterCompact") == Some(&Value::Bool(true))
        || (compact_at > 0.0 && usage_at > 0.0 && usage_at <= compact_at)
        || (compact_at > 0.0 && usage_at <= 0.0)
}

/// `thread/contextStatus`: the live status of the session (`createContextStatus().contextStatus()`).
pub fn context_status(input: &StatusInput<'_>) -> Value {
    let session = input.session;
    if !truthy(get(session, "id")) || !input.active {
        return empty_status(input);
    }
    let messages = input.messages;
    let summary = summarize_messages(messages, input.meter);
    let estimated = number_or_zero(summary.get("estimatedTokens"));
    let reserve = estimate_request_reserve_tokens(&input.request_tools) as f64;
    let schema_tokens = estimate_request_tokens(&input.request_tools);
    let raw_window = number_or_zero(or(get(session, "rawContextWindow"), get(session, "contextWindow")));
    let effective_window = number_or_zero(or(get(session, "contextWindow"), Some(&num(raw_window))));
    let last_context_tokens = number_or_zero(get(session, "lastContextTokens"));
    let stale = last_usage_stale(session, last_context_tokens);
    let compaction = get(session, "compaction").and_then(Value::as_object);
    let compact_boundary = number_or_zero(or(get(session, "compactBoundaryTokens"), compaction.and_then(|c| get(c, "boundaryTokens"))));
    let display_window = if compact_boundary != 0.0 { compact_boundary } else { effective_window };
    let policy = contextual_policy(session, input, compact_boundary);
    let snapshot = (last_context_tokens == 0.0 || stale).then(|| usage_snapshot(session, &policy, messages, input.signer)).flatten();
    let (used, source) = match snapshot {
        Some(snapshot) => (number(get(snapshot, "usedTokens")), "post_compact"),
        None => resolve_tokens(session, estimated, &policy, messages, input),
    };
    let free = if display_window != 0.0 { (display_window - used).max(0.0) } else { 0.0 };
    let mut out = identity(input);
    let window_or = |first: f64, second: f64| {
        let value = if first != 0.0 { first } else { second };
        or_none(value)
    };
    out.insert("contextWindow".into(), window_or(display_window, effective_window));
    out.insert("effectiveContextWindow".into(), or_none(effective_window));
    out.insert("rawContextWindow".into(), or_none(raw_window));
    out.insert("effectiveContextWindowPercent".into(), or_null(get(session, "effectiveContextWindowPercent")));
    out.insert("usedTokens".into(), num(used));
    out.insert("usedSource".into(), json!(source));
    out.insert("measurement".into(), measurement(session, true));
    out.insert("currentEstimatedTokens".into(), num(used));
    out.insert("lastApiRequestTokens".into(), num(last_context_tokens));
    out.insert("lastApiRequestStale".into(), json!(stale));
    out.insert("freeTokens".into(), num(free));
    let mut compaction_status = compaction.cloned().unwrap_or_default();
    let buffer_tokens = policy.buffer_tokens.filter(|b| finite(*b)).unwrap_or(0.0).max(0.0);
    let configured = policy.configured_reserve_tokens.filter(|c| finite(*c)).unwrap_or(0.0).max(0.0);
    for (key, value) in [
        ("boundaryTokens", or_none(compact_boundary)),
        ("triggerTokens", or_none(policy.trigger_tokens.unwrap_or(0.0))),
        ("bufferTokens", num(buffer_tokens)),
        ("bufferRatio", finite_or_null(policy.buffer_ratio)),
        ("currentEstimatedTokens", num(used)),
        ("pressureTokens", num(used)),
        ("reserveTokens", num(configured)),
        ("lastApiRequestTokens", num(last_context_tokens)),
        ("lastApiRequestStale", json!(stale)),
    ] {
        compaction_status.insert(key.to_owned(), value);
    }
    out.insert("compaction".into(), Value::Object(compaction_status));
    out.insert("messages".into(), summary);
    out.insert(
        "request".into(),
        json!({
            "toolSchemaTokens": num(schema_tokens),
            "toolSchemaBreakdown": input.tool_breakdown,
            "requestOverheadTokens": num((reserve - schema_tokens).max(0.0)),
            "reserveTokens": num(reserve),
        }),
    );
    out.insert("usage".into(), usage_counters(Some(session), last_context_tokens));
    Value::Object(out)
}

/// `estimateToolSchemaTokens(tools)`: the schema share of the request reserve (the two are one number).
fn estimate_request_tokens(tools: &RequestTools<'_>) -> f64 {
    estimate_request_reserve_tokens(tools) as f64
}

// --- The manual compaction's plan (session/manager/compaction-runner.mjs) -------------

/// The refusal of a forced compaction on a session with no window.
pub const COMPACT_NO_WINDOW: &str = "compact: no context window is available for this session";

/// `compactTargetBudget({ ...policy, force })`: the budget the summary is asked to fit.
fn compact_target_budget(policy: &Policy, force: bool) -> Option<f64> {
    let boundary = policy.boundary_tokens.filter(|b| *b >= 1.0)?;
    let reserve = policy.reserve_tokens.filter(|r| finite(*r)).unwrap_or(0.0).max(0.0);
    let gauge_target = policy.compact_target_tokens.filter(|t| *t >= 1.0).unwrap_or(boundary);
    let calibration = policy_calibration(policy);
    let request_reserve = policy_request_reserve(policy);
    let raw = |value: f64| (value / calibration).floor().max(1.0);
    let raw_boundary = raw(boundary);
    let raw_target = (raw_boundary.min(raw(gauge_target)) - request_reserve).max(1.0);
    let raw_trigger = policy.trigger_tokens.filter(|t| *t >= 1.0).map_or(0.0, |t| raw_boundary.min(raw(t)));
    // The reserve is already raw, so it is compared and subtracted as it is.
    let single_shot = policy.single_shot || (raw_trigger > 0.0 && reserve >= raw_trigger);
    let legacy = raw_boundary.min(raw_target + reserve).max(1.0);
    if single_shot || raw_trigger < 1.0 {
        return Some(legacy);
    }
    let bounded = legacy.min(raw_trigger - 1.0).max(1.0);
    // A forced (manual) compaction keeps a viable legacy budget when the no-repeat clamp would
    // consume all the working space beyond the reserve.
    Some(if force && bounded <= reserve { legacy } else { bounded })
}

/// The post-compaction numbers of a pass (`{ messages, tokens, messageTokens }`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct After {
    pub messages: usize,
    pub tokens: f64,
    pub message_tokens: f64,
}

/// `sessionCompactionPlan`'s numbers: what a compaction reports from before it summarizes anything.
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionPlan {
    pub force: bool,
    pub messages: usize,
    pub boundary: f64,
    pub before_message_tokens: f64,
    pub trigger_tokens: f64,
    pub buffer_tokens: f64,
    pub buffer_ratio: f64,
    pub budget: f64,
    pub pressure_tokens: f64,
    pub before_tokens: f64,
    pub reserve_tokens: f64,
}

/// `sessionCompactionPlan(session, opts)` over the session header and its transcript snapshot: `Ok(None)`
/// is Node's `null` (an automatic pass on a session that turned it off, a short transcript, or no
/// window); the refusal is a forced compaction that has no window. `input.request_tools` are the
/// tools of `resolveSessionCompactionPolicy`'s request, `input.session_tools` the session's own.
pub fn compaction_plan(input: &StatusInput<'_>, auto_mode: bool, force: bool) -> Result<Option<CompactionPlan>, &'static str> {
    let session = input.session;
    let force = force || !auto_mode;
    let compaction = get(session, "compaction").filter(|v| truthy(Some(v))).and_then(Value::as_object);
    if auto_mode && compaction.is_some_and(|c| get(c, "auto") == Some(&Value::Bool(false))) {
        return Ok(None);
    }
    let messages = input.messages;
    if messages.len() < 3 && !force {
        return Ok(None);
    }
    let Some(boundary) = first_positive(&[get(session, "compactBoundaryTokens"), get(session, "autoCompactTokenLimit"), get(session, "contextWindow")]) else {
        return if force { Err(COMPACT_NO_WINDOW) } else { Ok(None) };
    };
    // `resolveSessionCompactionPolicy`: the session's policy with automatic compaction on.
    let aligned = match worker_policy(session, &input.request_tools, true) {
        Some(Worker::Policy(policy)) => Some(*policy),
        // `{ auto: false }`: an object with none of the policy's fields.
        Some(Worker::Off) => Some(Policy::default()),
        None => None,
    };
    let before_message_tokens = input.meter.messages(messages) as f64;
    let trigger_tokens = aligned.as_ref().and_then(|p| p.trigger_tokens).filter(|t| *t != 0.0).unwrap_or(boundary);
    let buffer_tokens = aligned.as_ref().and_then(|p| p.buffer_tokens).unwrap_or_else(|| (boundary - trigger_tokens).max(0.0));
    let buffer_ratio = aligned.as_ref().and_then(|p| p.buffer_ratio).unwrap_or(buffer_tokens / boundary);
    let budget = aligned.as_ref().and_then(|p| compact_target_budget(p, force)).filter(|b| *b != 0.0).unwrap_or(boundary);
    let pressure_tokens = if messages.is_empty() {
        0.0
    } else {
        let estimated = number_or_zero(summarize_messages(messages, input.meter).get("estimatedTokens"));
        round((estimated + estimate_request_reserve_tokens(&input.session_tools) as f64) * provider_token_calibration(get(session, "provider"))).max(0.0)
    };
    let gauge = aligned.as_ref().map_or(0.0, |policy| resolve_tokens(session, before_message_tokens, policy, messages, input).0);
    // `compactDisplayBeforeTokens`: the context the provider last measured, while that reading is live.
    let before_tokens = match positive_int(get(session, "lastContextTokens")) {
        Some(last) if get(session, "lastContextTokensStaleAfterCompact") != Some(&Value::Bool(true)) => last,
        _ if gauge != 0.0 => gauge,
        _ => pressure_tokens,
    };
    let reserve_tokens = match aligned.as_ref().and_then(|p| p.reserve_tokens) {
        Some(reserve) => reserve,
        None => {
            let request = estimate_request_reserve_tokens(&input.session_tools) as f64;
            let configured = compaction
                .and_then(|c| positive_int(get(c, "reservedTokens")))
                .or_else(|| env_positive_int("MIXDOG_AGENT_COMPACT_RESERVED_TOKENS"))
                .unwrap_or(0.0);
            request + configured
        }
    };
    Ok(Some(CompactionPlan { force, messages: messages.len(), boundary, before_message_tokens, trigger_tokens, buffer_tokens, buffer_ratio, budget, pressure_tokens, before_tokens, reserve_tokens }))
}

impl CompactionPlan {
    /// `unchangedAfter(plan)`.
    pub fn unchanged_after(&self) -> After {
        After { messages: self.messages, tokens: self.before_tokens, message_tokens: self.before_message_tokens }
    }

    /// `compactionResult(plan, outcome, after, tail)`.
    pub fn result(&self, outcome: Map<String, Value>, after: &After, tail: Map<String, Value>) -> Value {
        let mut out = outcome;
        for (key, value) in [
            ("beforeMessages", json!(self.messages)),
            ("afterMessages", json!(after.messages)),
            ("beforeTokens", num(self.before_tokens)),
            ("afterTokens", num(after.tokens)),
            ("beforeMessageTokens", num(self.before_message_tokens)),
            ("afterMessageTokens", num(after.message_tokens)),
            ("pressureTokens", num(self.pressure_tokens)),
            ("triggerTokens", num(self.trigger_tokens)),
            ("bufferTokens", num(self.buffer_tokens)),
            ("bufferRatio", num(self.buffer_ratio)),
            ("boundaryTokens", num(self.boundary)),
            ("budgetTokens", num(self.boundary)),
            ("targetBudgetTokens", num(self.budget)),
            ("reserveTokens", num(self.reserve_tokens)),
        ] {
            out.insert(key.to_owned(), value);
        }
        out.extend(tail);
        Value::Object(out)
    }

    /// `runSessionCompaction`'s answer for a pass that is not forced and whose pressure is under
    /// the trigger; `None` when the pass goes on.
    pub fn below_threshold(&self) -> Option<Value> {
        (!self.force && self.pressure_tokens < self.trigger_tokens).then(|| self.unchanged([("changed", json!(false)), ("reason", json!("below threshold"))]))
    }

    /// The answer of a pass a required reduction cannot be had from.
    pub fn no_token_reduction(&self) -> Value {
        self.unchanged([("changed", json!(false)), ("skipped", json!(true)), ("reason", json!("no_token_reduction"))])
    }

    fn unchanged<const N: usize>(&self, outcome: [(&str, Value); N]) -> Value {
        let outcome = outcome.into_iter().map(|(key, value)| (key.to_owned(), value)).collect();
        self.result(outcome, &self.unchanged_after(), Map::from_iter([("freshContext".to_owned(), Value::Bool(false))]))
    }
}

/// The budget a forced (manual) compaction asks its summary to fit, for a session header.
pub fn forced_target_budget(input: &StatusInput<'_>) -> Option<f64> {
    match worker_policy(input.session, &input.request_tools, true) {
        Some(Worker::Policy(policy)) => compact_target_budget(&policy, true),
        _ => None,
    }
}

mod commit;
mod send_check;

pub use send_check::StageMeta;
pub use send_check::compact_telemetry;
pub use send_check::post_compact_snapshot;
pub use send_check::pre_send_check;
pub use commit::Archived;
pub use commit::CONFIG_KEYS as COMPACTION_CONFIG_KEYS;
pub use commit::CommitInput;
pub use commit::Committed;
pub use commit::Failed;
pub use commit::SummaryFacts;
pub use commit::TRANSCRIPT_MOVED_ERROR;
pub use commit::commit_compaction;
pub use commit::failed_compaction;
pub use commit::usage_totals;
