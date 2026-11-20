//! What a run's usage reports write into its thread's header, at the point and with the values Node
//! writes them. Each function reads the header as it stands and answers the change to write, over the
//! ports of this module (`usage_metrics`, `status::pre_send_check`, `record_provider_context_baseline`):
//!
//! - one model call (`session/manager/ask-turn-loop-options.mjs` `onUsageDelta`):
//!   `persistIterationMetrics`, then, for a provider send, the request-boundary
//!   `recordProviderContextBaseline` ([`usage_change`]);
//! - the check before a send that compacts nothing (`session/pre-send-compact.mjs`
//!   `compactTelemetry(ctx, 'pre_send_check')`, [`check_change`]);
//! - a compaction pass (`compactBeforeSend`: its telemetry stages, an adopted transcript's
//!   `bumpUsageMetricsEpoch`, `invalidateProviderContextBaseline` and the post-compact usage snapshot,
//!   [`pass_change`]);
//! - the turn's start (`bumpUsageMetricsTurnId`, [`turn_started`]);
//! - the ask's end (`session/manager/ask-turn-settle.mjs` `applyAskTerminalUsageTotals`, then the
//!   complete-boundary `recordProviderContextBaseline`, [`settled_change`]).

use serde_json::Value;
use serde_json::json;

use super::BaselineArgs;
use super::Header;
use super::HeaderPatch;
use super::Route;
use super::StageMeta;
use super::StatusInput;
use super::TerminalUsage;
use super::TranscriptSigner;
use super::baseline_message_count;
use super::bump_epoch;
use super::bump_turn_id;
use super::compact_telemetry;
use super::current_provider_reading;
use super::invalidate_provider_context_baseline;
use super::iteration_metrics;
use super::post_compact_snapshot;
use super::pre_send_check;
use super::provider_pressure;
use super::provider_token_calibration;
use super::record_provider_context_baseline;
use super::single_shot_consumed;
use super::terminal_usage;
use super::unanchored_after_restart;
use crate::compact::tool_schema::RequestTools;
use crate::env::CompactPass;
use crate::env::PassStage;
use crate::env::SessionPressure;
use crate::message::AgentMessage;
use mixdog_core_api::domain::cache_tail::Counters;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::Usage;

/// What a thread's context pressure is recorded with: the signer of its transcript (its meter, image
/// identities and stored rows), the provider-native tools its requests carry first, and its mode.
pub struct Books<'a> {
    pub signer: &'a TranscriptSigner<'a>,
    pub native: &'a [Value],
    /// `isAgentModeSession(session)`.
    pub agent_mode: bool,
    /// The environment the policy reads its tuning variables from.
    pub env: &'a dyn mixdog_ai::registry::keys::Environment,
}

/// A header change built up step by step, each step reading the header the earlier ones left.
struct Draft {
    working: Header,
    patch: HeaderPatch,
}

impl Draft {
    fn new(header: &Header) -> Self {
        Self { working: header.clone(), patch: HeaderPatch::default() }
    }

    fn apply(&mut self, step: HeaderPatch) {
        step.apply(&mut self.working);
        for key in &step.unset {
            self.patch.remove(key);
        }
        for (key, value) in step.set {
            self.patch.put(&key, value);
        }
    }

    /// `None` when no step changed anything.
    fn finish(self) -> Option<HeaderPatch> {
        (!self.patch.set.is_empty() || !self.patch.unset.is_empty()).then_some(self.patch)
    }
}

/// `bumpUsageMetricsTurnId(session)`, at the start of a turn (`whileTurnDispatched`).
pub fn turn_started(header: &Header) -> Option<HeaderPatch> {
    let mut draft = Draft::new(header);
    draft.apply(bump_turn_id(header));
    draft.finish()
}

/// Attach evidence to the private pressure projection, not to usage totals or the public delta.
pub fn with_prompt_cache_evidence<'a>(header: &Header, delta: &'a Value, usage: &Usage) -> std::borrow::Cow<'a, Value> {
    let counters = incomplete_prompt(header, usage);
    let prompt = prompt_evidence(usage);
    let output = output_evidence(usage);
    if counters.is_none() && prompt.is_none() && output == delta.get("contextOutputTokens").and_then(Value::as_u64) {
        return std::borrow::Cow::Borrowed(delta);
    }
    let mut delta = delta.clone();
    delta["contextPromptKnown"] = json!(prompt);
    delta["contextOutputTokens"] = json!(output);
    if let Some(counters) = counters {
        delta["unmeasuredAnthropicPrompt"] = json!({ "read": counters.read, "written": counters.created });
    }
    std::borrow::Cow::Owned(delta)
}

fn prompt_evidence(usage: &Usage) -> Option<bool> {
    let raw = usage.raw.as_ref()?;
    if raw["input_tokens_known"] == Value::Bool(false) || raw["cache_tokens_known"] == Value::Bool(false) {
        return Some(false);
    }
    ["input_tokens", "prompt_tokens", "promptTokenCount"].iter().any(|key| raw.get(*key).and_then(Value::as_u64).is_some()).then_some(true)
}

fn output_evidence(usage: &Usage) -> Option<u64> {
    (usage.output_tokens > 0
        || usage.raw.as_ref().is_some_and(|raw| {
            ["output_tokens", "completion_tokens", "candidatesTokenCount"].iter().any(|key| raw.get(*key).and_then(Value::as_u64).is_some())
        }))
    .then_some(usage.output_tokens)
}

fn incomplete_prompt(header: &Header, usage: &Usage) -> Option<Counters> {
    let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default();
    (crate::cache_observation::is_anthropic(provider) && !crate::cache_observation::has_prompt(usage)).then(|| Counters::of_usage(usage))
}

fn unmeasured_prompt(read: Value, written: Value, now: f64) -> HeaderPatch {
    let mut patch = HeaderPatch::default();
    for key in ["lastInputTokens", "lastUncachedInputTokens", "lastPromptTokens", "lastContextTokens"] {
        patch.put(key, Value::Null);
    }
    patch.put("lastCachedReadTokens", read);
    patch.put("lastCacheWriteTokens", written);
    patch.put("lastContextTokensUpdatedAt", mixdog_js::json_number(now));
    // The previous pressure reading remains historical and cannot anchor this request.
    patch.put("lastContextTokensStaleAfterCompact", json!(true));
    patch
}

/// `onUsageDelta(delta)` for one model call: `delta` is the call's `usageDeltaEvent`, `outgoing` the
/// transcript its request carried (the provider's reading covers it, not the reply appended after) and
/// `send_tools` its tools. `books`: `None` records no pressure.
#[allow(
    clippy::too_many_arguments,
    reason = "Preserve the established usage projection API shared by core-session and recorded replay callers; inputs retain their independent meanings"
)]
pub fn usage_change(
    header: &Header,
    delta: &Value,
    outgoing: &[AgentMessage],
    send_tools: &[ToolDefinition],
    books: Option<&Books<'_>>,
    input_excludes_cache: bool,
    sent_at: f64,
    now: f64,
) -> Option<HeaderPatch> {
    let mut draft = Draft::new(header);
    // `sessionRef.lastProviderSendAt = sent.sendStartedAt` (`loop/send-phase.mjs`), when the response arrived:
    // before the call's usage is reported.
    let mut sent = HeaderPatch::default();
    sent.put("lastProviderSendAt", mixdog_js::json_number(sent_at));
    // The send carry owns the cache observation and its timestamp; this timestamp is request timing only.
    draft.apply(sent);
    draft.apply(iteration_metrics(header, delta, input_excludes_cache, now));
    if let Some(missing) = delta.get("unmeasuredAnthropicPrompt") {
        draft.apply(unmeasured_prompt(missing["read"].clone(), missing["written"].clone(), now));
        return draft.finish();
    }
    if let Some(books) = books
        && delta.get("source") == Some(&json!("provider_send"))
    {
        // `d.contextInputTokens ?? d.deltaInput`: a missing or null context figure takes the billed one.
        let pick = |context: &str, fallback: &str| -> Value {
            delta.get(context).filter(|value| !value.is_null()).or_else(|| delta.get(fallback)).cloned().unwrap_or(Value::Null)
        };
        let usage = json!({
            "inputTokens": pick("contextInputTokens", "deltaInput"),
            "outputTokens": pick("contextOutputTokens", "deltaOutput"),
            "promptTokens": pick("contextPromptTokens", "deltaPrompt"),
            "cachedTokens": pick("contextCachedReadTokens", "deltaCachedRead"),
            "cacheWriteTokens": pick("contextCacheWriteTokens", "deltaCacheWrite"),
            "contextTokens": delta.get("contextMeasuredTokens").cloned().unwrap_or(Value::Null),
        });
        let args = BaselineArgs {
            boundary: "request",
            send_tools: RequestTools { native: books.native, defined: send_tools },
            input_excludes_cache,
            token_calibration: provider_token_calibration(books.env, header.get("provider")),
            now,
        };
        if let Some(patch) = record_provider_context_baseline(&draft.working, outgoing, &usage, books.signer, &args) {
            draft.apply(patch);
        }
    }
    draft.finish()
}

#[cfg(test)]
mod cache_evidence_tests {
    use super::*;

    #[test]
    fn a_partial_prompt_preserves_the_cache_baseline_but_does_not_reanchor_pressure() {
        let mut header = json!({
            "provider": "anthropic",
            "lastProviderCachedPrefixTokens": 8000,
            "lastCachedReadTokens": 7000,
            "lastContextTokens": 10000,
            "contextPressureBaselineTokens": 10000,
            "contextPressureBaselineUpdatedAt": 100,
        })
        .as_object()
        .unwrap()
        .clone();
        let reported =
            Usage { input_tokens: 50, output_tokens: 10, raw: Some(json!({ "input_tokens": 50, "cache_creation_input_tokens": 0 })), ..Usage::default() };
        let delta = json!({
            "source": "provider_send", "deltaInput": 50, "deltaOutput": 10,
            "deltaCachedRead": 0, "deltaCacheWrite": 0,
        });
        let pressure_delta = with_prompt_cache_evidence(&header, &delta, &reported);
        usage_change(&header, &pressure_delta, &[], &[], None, true, 200.0, 210.0).unwrap().apply(&mut header);
        assert_eq!(header["lastProviderSendAt"], json!(200));
        assert_eq!(header["lastProviderCachedPrefixTokens"], json!(8000));
        assert_eq!(header["contextPressureBaselineUpdatedAt"], json!(100));
        assert_eq!(header["lastContextTokens"], Value::Null);
        assert_eq!(header["lastCachedReadTokens"], Value::Null);
        assert_eq!(header["lastCacheWriteTokens"], json!(0));
        assert_eq!(header["totalOutputTokens"], json!(10));

        let settled = Settled { transcript: &[], usage: &reported, last_turn_usage: &reported, tool_calls_total: 0, send_tools: &[] };
        settled_change(&header, &settled, true, None, true, 220.0).unwrap().apply(&mut header);
        assert_eq!(header["lastProviderCachedPrefixTokens"], json!(8000));
        assert_eq!(header["lastContextTokens"], Value::Null);
        assert_eq!(header["lastCachedReadTokens"], Value::Null);
        assert_eq!(header["lastCacheWriteTokens"], json!(0));
        assert_eq!(header["totalOutputTokens"], json!(10));
    }

    #[test]
    fn a_reported_zero_read_and_write_still_give_a_measured_prompt() {
        let mut header = json!({ "provider": "anthropic" }).as_object().unwrap().clone();
        let reported = Usage {
            raw: Some(json!({
                "input_tokens": 50, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
            })),
            ..Usage::default()
        };
        let delta = json!({ "deltaInput": 50, "deltaCachedRead": 0, "deltaCacheWrite": 0 });
        let pressure_delta = with_prompt_cache_evidence(&header, &delta, &reported);
        usage_change(&header, &pressure_delta, &[], &[], None, true, 200.0, 210.0).unwrap().apply(&mut header);
        assert_eq!(header["lastContextTokens"], json!(50));
        assert_eq!(header["lastCachedReadTokens"], json!(0));
        assert_eq!(header["lastCacheWriteTokens"], json!(0));
    }
}

/// The check before a send that compacts nothing: `messages` and `tools` are the request about to go
/// out, `reactive` a pending context-overflow retry. `None` for a session whose policy does not compact.
pub fn check_change(header: &Header, messages: &[AgentMessage], tools: &[ToolDefinition], reactive: bool, books: &Books<'_>, now: f64) -> Option<HeaderPatch> {
    let mut draft = Draft::new(header);
    draft.apply(pre_send_check(&status_input(header, messages, tools, books), now, reactive)?);
    draft.finish()
}

/// What the decision before a send reads from the session for `messages` and `tools`: the pressure its provider reading
/// gives them, the figure [`check_change`] records for that send (`None` when the estimate prices them), and its
/// unanchored mark (`shouldCompactForSession`).
pub fn send_pressure(header: &Header, messages: &[AgentMessage], tools: &[ToolDefinition], books: &Books<'_>) -> SessionPressure {
    SessionPressure {
        tokens: provider_pressure(&status_input(header, messages, tools, books)).map(|tokens| tokens as u64),
        unanchored: unanchored_after_restart(header),
        single_shot_consumed: single_shot_consumed(header),
        reading: current_provider_reading(header),
        reading_count: baseline_message_count(header),
    }
}

/// The status input of a request: the session header, the transcript about to go out and its tools.
fn status_input<'a>(header: &'a Header, messages: &'a [AgentMessage], tools: &'a [ToolDefinition], books: &'a Books<'a>) -> StatusInput<'a> {
    let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default();
    let model = header.get("model").and_then(Value::as_str).unwrap_or_default();
    StatusInput {
        session: header,
        route: Route { provider, model, context_window: Value::Null },
        cwd: Value::Null,
        mode: Value::Null,
        messages,
        active: true,
        request_tools: RequestTools { native: books.native, defined: tools },
        session_tools: RequestTools::default(),
        tool_breakdown: &Value::Null,
        agent_mode: books.agent_mode,
        meter: books.signer.meter,
        signer: books.signer,
        env: books.env,
    }
}

/// One stage of a pre-send compaction pass (`session/pre-send-compact.mjs` `compactBeforeSend`), as
/// the header records it:
///
/// - the pass starts: `compactTelemetry(ctx, 'compacting', { trigger })`;
/// - it failed: `reportCompactFailure`'s `compactTelemetry(ctx, 'overflow_failed', ..)`;
/// - it found no token reduction: `compactTelemetry(ctx, 'pre_send_check', { skipReason })`;
/// - it finished: a changed transcript was adopted (`adoptCompactedTranscript`'s `bumpUsageMetricsEpoch`),
///   `reportCompactOutcome`'s `compactTelemetry(ctx, 'pre_send', ..)` (which stamps the compaction's time
///   and voids the provider reading of the old transcript when the transcript changed) and, then,
///   `recordContextUsageSnapshot(.., 'post_compact')`.
pub fn pass_change(header: &Header, pass: &CompactPass, books: &Books<'_>, now: f64) -> Option<HeaderPatch> {
    let mut draft = Draft::new(header);
    let request = |session: &Header, stage: &str, meta: &StageMeta<'_>| {
        compact_telemetry(&status_input(session, &pass.request, &pass.tools, books), now, pass.reactive, stage, meta)
    };
    match &pass.stage {
        PassStage::Started => {
            let meta = StageMeta { trigger: Some(pass.trigger.as_str()), ..StageMeta::default() };
            if let Some(patch) = request(header, "compacting", &meta) {
                draft.apply(patch);
            }
        }
        PassStage::Failed { message, duration_ms } => {
            let meta = StageMeta {
                trigger: Some(pass.trigger.as_str()),
                fresh_error: Some(Some(message.as_str())),
                compact_error: Some(Some(message.as_str())),
                duration_ms: Some(*duration_ms as f64),
                ..StageMeta::default()
            };
            if let Some(patch) = request(header, "overflow_failed", &meta) {
                draft.apply(patch);
            }
        }
        PassStage::Skipped => {
            if let Some(patch) = request(header, "pre_send_check", &StageMeta::default()) {
                draft.apply(patch);
            }
        }
        PassStage::Done { changed, handoff_source, after_tokens, duration_ms, after } => {
            if *changed {
                draft.apply(bump_epoch(header));
            }
            let meta = StageMeta {
                after_tokens: Some(*after_tokens as f64),
                changed: *changed,
                fresh_context: true,
                fresh_error: Some(None),
                compact_error: Some(None),
                handoff_source: Some(*handoff_source),
                duration_ms: Some(*duration_ms as f64),
                ..StageMeta::default()
            };
            if let Some(patch) = request(&draft.working, "pre_send", &meta) {
                draft.apply(patch);
            }
            if *changed {
                draft.apply(invalidate_provider_context_baseline());
                // The compacted transcript is a cold point: the next turn start rebuilds the system text from current sources.
                let mut fold = HeaderPatch::default();
                fold.put("promptFoldPending", Value::Bool(true));
                fold.put("compactionFoldPending", Value::Bool(true));
                draft.apply(fold);
                let snapshot = post_compact_snapshot(&status_input(&draft.working, after, &pass.tools, books), *after_tokens as f64, now);
                if let Some(patch) = snapshot {
                    draft.apply(patch);
                }
            }
        }
    }
    draft.finish()
}

/// `usage` in the shape of Node's normalized usage record.
fn usage_record(usage: &Usage) -> Value {
    let mut record = json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": output_evidence(usage),
        "cachedTokens": usage.cache_read_tokens,
        "cacheWriteTokens": usage.cache_write_tokens,
        "contextPromptKnown": prompt_evidence(usage),
        "reasoningTokens": usage.reasoning_tokens,
        "reasoningTokensComplete": usage.reasoning_complete(),
    });
    // `normalizeUsage` keeps the provider-measured occupancy beside the counts.
    if let Some(context) = super::measured_context_tokens(usage) {
        record["contextTokens"] = json!(context);
    }
    record
}

/// `estimateTranscriptContextUsage(messages, tools, { provider })`: the transcript estimate plus the
/// request reserve, calibrated for the provider; 0 for an empty transcript.
pub fn estimate_transcript_context_usage(messages: &[AgentMessage], tools: &RequestTools<'_>, provider: Option<&Value>, books: &Books<'_>) -> f64 {
    if messages.is_empty() {
        return 0.0;
    }
    let estimated = super::number_or_zero(super::summarize_messages(messages, books.signer.meter).get("estimatedTokens"));
    let reserve = crate::compact::tool_schema::estimate_request_reserve_tokens(tools) as f64;
    mixdog_js::math::round((estimated + reserve) * provider_token_calibration(books.env, provider))
}

/// What the ask's settlement reads of a finished run (`result` of `settleAskTurn`).
pub struct Settled<'a> {
    /// `session.messages` after the terminal assistant message was appended.
    pub transcript: &'a [AgentMessage],
    /// `result.usage`, the ask's aggregate.
    pub usage: &'a Usage,
    /// `result.lastTurnUsage`.
    pub last_turn_usage: &'a Usage,
    /// `result.toolCallsTotal`.
    pub tool_calls_total: u64,
    /// `result.lastSendTools`.
    pub send_tools: &'a [ToolDefinition],
}

/// `applyAskTerminalUsageTotals` and the complete-boundary `recordProviderContextBaseline` of the
/// ask's settlement. `incremental`: some call of the ask already counted its own usage.
pub fn settled_change(
    header: &Header,
    settled: &Settled<'_>,
    incremental: bool,
    books: Option<&Books<'_>>,
    input_excludes_cache: bool,
    now: f64,
) -> Option<HeaderPatch> {
    let (usage, last) = (usage_record(settled.usage), usage_record(settled.last_turn_usage));
    let mut draft = Draft::new(header);
    let ask =
        TerminalUsage { usage: Some(&usage), last_turn: &last, tool_calls_total: settled.tool_calls_total as f64, incremental, input_excludes_cache, now };
    draft.apply(terminal_usage(header, &ask));
    if let Some(counters) = incomplete_prompt(header, settled.last_turn_usage) {
        draft.apply(unmeasured_prompt(json!(counters.read), json!(counters.created), now));
        return draft.finish();
    }
    if let Some(books) = books {
        let args = BaselineArgs {
            boundary: "complete",
            send_tools: RequestTools { native: books.native, defined: settled.send_tools },
            input_excludes_cache,
            token_calibration: provider_token_calibration(books.env, header.get("provider")),
            now,
        };
        if let Some(patch) = record_provider_context_baseline(&draft.working, settled.transcript, &last, books.signer, &args) {
            draft.apply(patch);
        }
    }
    draft.finish()
}
