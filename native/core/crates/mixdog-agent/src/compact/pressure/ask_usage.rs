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
use super::bump_epoch;
use super::bump_turn_id;
use super::invalidate_provider_context_baseline;
use super::iteration_metrics;
use super::compact_telemetry;
use super::post_compact_snapshot;
use super::pre_send_check;
use super::provider_pressure;
use super::provider_token_calibration;
use super::record_provider_context_baseline;
use super::terminal_usage;
use super::baseline_message_count;
use super::current_provider_reading;
use super::single_shot_consumed;
use super::unanchored_after_restart;
use crate::compact::tool_schema::RequestTools;
use crate::env::CompactPass;
use crate::env::PassStage;
use crate::env::SessionPressure;
use crate::message::AgentMessage;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::Usage;

/// What a thread's context pressure is recorded with: the signer of its transcript (its meter, image
/// identities and stored rows), the provider-native tools its requests carry first, and its mode.
pub struct Books<'a> {
    pub signer: &'a TranscriptSigner<'a>,
    pub native: &'a [Value],
    /// `isAgentModeSession(session)`.
    pub agent_mode: bool,
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

/// `onUsageDelta(delta)` for one model call: `delta` is the call's `usageDeltaEvent`, `outgoing` the
/// transcript its request carried (the provider's reading covers it, not the reply appended after) and
/// `send_tools` its tools. `books`: `None` records no pressure.
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
    // `traceActualCacheMiss` (`loop/send-phase.mjs:340-384`): an Anthropic session keeps the call's cache read plus
    // write as the next call's miss baseline, on the record so it survives a reload.
    if matches!(header.get("provider").and_then(Value::as_str), Some("anthropic" | "anthropic-oauth")) {
        // `Number(x) || 0`.
        let tokens = |key: &str| {
            let n = mixdog_js::to_number_of(delta.get(key));
            if n.is_nan() { 0.0 } else { n }
        };
        sent.put("lastProviderCachedPrefixTokens", mixdog_js::json_number(tokens("deltaCachedRead") + tokens("deltaCacheWrite")));
    }
    draft.apply(sent);
    draft.apply(iteration_metrics(header, delta, input_excludes_cache, now));
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
            token_calibration: provider_token_calibration(header.get("provider")),
            now,
        };
        if let Some(patch) = record_provider_context_baseline(&draft.working, outgoing, &usage, books.signer, &args) {
            draft.apply(patch);
        }
    }
    draft.finish()
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
    let request = |session: &Header, stage: &str, meta: &StageMeta<'_>| compact_telemetry(&status_input(session, &pass.request, &pass.tools, books), now, pass.reactive, stage, meta);
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
        "outputTokens": usage.output_tokens,
        "cachedTokens": usage.cache_read_tokens,
        "cacheWriteTokens": usage.cache_write_tokens,
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
    mixdog_js::math::round((estimated + reserve) * provider_token_calibration(provider))
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
pub fn settled_change(header: &Header, settled: &Settled<'_>, incremental: bool, books: Option<&Books<'_>>, input_excludes_cache: bool, now: f64) -> Option<HeaderPatch> {
    let (usage, last) = (usage_record(settled.usage), usage_record(settled.last_turn_usage));
    let mut draft = Draft::new(header);
    let ask = TerminalUsage { usage: Some(&usage), last_turn: &last, tool_calls_total: settled.tool_calls_total as f64, incremental, input_excludes_cache, now };
    draft.apply(terminal_usage(header, &ask));
    if let Some(books) = books {
        let args = BaselineArgs {
            boundary: "complete",
            send_tools: RequestTools { native: books.native, defined: settled.send_tools },
            input_excludes_cache,
            token_calibration: provider_token_calibration(header.get("provider")),
            now,
        };
        if let Some(patch) = record_provider_context_baseline(&draft.working, settled.transcript, &last, books.signer, &args) {
            draft.apply(patch);
        }
    }
    draft.finish()
}
