//! What a run's usage reports write into its thread's header, at the point and with the values Node
//! writes them. Each function reads the header as it stands and answers the change to write, over the
//! ports of this module (`usage_metrics`, `status::pre_send_check`, `record_provider_context_baseline`):
//!
//! - one model call (`session/manager/ask-turn-loop-options.mjs` `onUsageDelta`):
//!   `persistIterationMetrics`, then, for a provider send, the request-boundary
//!   `recordProviderContextBaseline` ([`usage_change`]);
//! - the check before a send that compacts nothing (`session/pre-send-compact.mjs`
//!   `compactTelemetry(ctx, 'pre_send_check')`, [`check_change`]);
//! - an adopted compaction (`adoptCompactedTranscript`'s `bumpUsageMetricsEpoch`, and
//!   `rememberCompactTelemetry`'s time stamps and `invalidateProviderContextBaseline`,
//!   [`compacted_change`]);
//! - the turn's start (`bumpUsageMetricsTurnId`, [`turn_started`]);
//! - the ask's end (`session/manager/ask-turn-settle.mjs` `applyAskTerminalUsageTotals`, then the
//!   complete-boundary `recordProviderContextBaseline`, [`settled_change`]).

use serde_json::Value;
use serde_json::json;

use super::BaselineArgs;
use super::Header;
use super::HeaderPatch;
use super::Route;
use super::StatusInput;
use super::TerminalUsage;
use super::TranscriptSigner;
use super::bump_epoch;
use super::bump_turn_id;
use super::invalidate_provider_context_baseline;
use super::iteration_metrics;
use super::pre_send_check;
use super::provider_token_calibration;
use super::record_provider_context_baseline;
use super::terminal_usage;
use crate::compact::tool_schema::RequestTools;
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
    now: f64,
) -> Option<HeaderPatch> {
    let mut draft = Draft::new(header);
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
    let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default();
    let model = header.get("model").and_then(Value::as_str).unwrap_or_default();
    let input = StatusInput {
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
    };
    let mut draft = Draft::new(header);
    draft.apply(pre_send_check(&input, now, reactive)?);
    draft.finish()
}

/// A compaction that changed the transcript was adopted: the loop's iteration counter restarts
/// (`bumpUsageMetricsEpoch`), and the provider reading of the old transcript is void
/// (`rememberCompactTelemetry` with `compactChanged`, which also stamps the compaction's time).
pub fn compacted_change(header: &Header, now: f64) -> Option<HeaderPatch> {
    let mut draft = Draft::new(header);
    draft.apply(bump_epoch(header));
    let mut compaction = header.get("compaction").and_then(Value::as_object).cloned().unwrap_or_default();
    compaction.insert("lastChangedAt".into(), mixdog_js::json_number(now));
    compaction.insert("lastCompactAt".into(), mixdog_js::json_number(now));
    let mut stamped = HeaderPatch::default();
    stamped.set.insert("compaction".into(), Value::Object(compaction));
    draft.apply(stamped);
    draft.apply(invalidate_provider_context_baseline());
    draft.finish()
}

/// `usage` in the shape of Node's normalized usage record.
fn usage_record(usage: &Usage) -> Value {
    json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "cachedTokens": usage.cache_read_tokens,
        "cacheWriteTokens": usage.cache_write_tokens,
        "reasoningTokens": usage.reasoning_tokens,
        "reasoningTokensComplete": usage.reasoning_complete(),
    })
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
