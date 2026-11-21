//! Writing the conversation summary: batching a long conversation through the
//! summary model, the route plan (which model writes it), and the fork of the
//! session's cached request.
//!
//! The model call itself, the route lookups and the saved request to fork are
//! the host's: [`SummarySender`], [`RouteResolver`] and [`ForkSource`].

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::Usage;

use super::conversation::chunk;
use super::estimate::MessageMeter;
use super::execution_tail::MessageRows;
use super::fresh::FreshContext;
use super::fresh::effective_budget;
use super::fresh::split_fresh_source;
use super::summary::COMPACTION_SYSTEM_PROMPT;
use super::summary::EnforcedSummary;
use super::summary::HandoffMeta;
use super::summary::enforce_compact_summary_schema;
use super::summary::extract_response_text;
use super::summary::fit_complete_compaction_prompt;
use super::summary::fit_generated_handoff_message;
use crate::env::CompactError;
use crate::env::CompactRoute;
use crate::message::AgentMessage;
use crate::one_shot::CallShape;
use crate::response::is_output_limit;
use crate::response::stop_text;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;

/// The output room the window budget keeps for a summary, and the cap an isolated summary request carries on the
/// providers Node's reached (every one but Anthropic's, see `summarize_on_route`).
pub const SUMMARY_OUTPUT_TOKENS: u64 = 4_096;
const COMPACTION_PROMPT_HEADROOM: f64 = 0.85;
/// `HANDOFF_TIMEOUT_MAX_MS` (`session/compact/constants.mjs`): the summary's deadline when the session states none.
pub const HANDOFF_TIMEOUT_MAX_MS: u64 = 300_000;
/// The reason `AbortSignal.timeout` aborts with: the failure of a summary past its deadline.
const SUMMARY_TIMED_OUT: &str = "The operation was aborted due to timeout";

#[derive(Debug)]
pub enum SummaryFailure {
    /// The summary request itself overflowed the model window.
    Overflow(String),
    /// Out of quota, unavailable to the account, or not found: the next
    /// route can still summarize. Set by the sender from the typed error.
    NextRoute(String),
    /// The call was cancelled: the abort propagates, no route is tried after it.
    Aborted,
    Failed(String),
}

/// Node `fallsToNextRoute`: a failure out of quota, unavailable to the account or naming a model
/// that is not found lets the next route still summarize, wherever it arose (the send, or the
/// route's provider init).
pub fn falls_to_next_route(code: Option<&str>, status: Option<u16>, quota: bool) -> bool {
    matches!(code, Some("provider_accounts_exhausted" | "model_not_found")) || matches!(status, Some(429 | 404)) || quota
}

/// A failure of a route step classified by [`falls_to_next_route`].
pub fn route_failure(message: String, code: Option<&str>, status: Option<u16>, quota: bool) -> SummaryFailure {
    if falls_to_next_route(code, status, quota) { SummaryFailure::NextRoute(message) } else { SummaryFailure::Failed(message) }
}

impl From<SummaryFailure> for CompactError {
    fn from(failure: SummaryFailure) -> Self {
        match failure {
            SummaryFailure::Overflow(text) => Self::Overflow(text),
            SummaryFailure::Aborted => Self::Aborted,
            SummaryFailure::NextRoute(text) | SummaryFailure::Failed(text) => Self::Failed(text),
        }
    }
}

/// One summary call: an independent request, never a continuation of the
/// source conversation's effort history, provider state or callbacks.
#[derive(Clone, Debug)]
pub struct SummaryCall {
    pub model: String,
    /// `None`: the model's own output limit.
    pub max_output_tokens: Option<u64>,
    pub fast: bool,
    /// Request kind, effort, 529 retry and cache choice of the step making the call.
    pub shape: CallShape,
}

pub struct SummaryResponse {
    pub text: String,
    /// The model answered with a tool call instead of text.
    pub tool_call: bool,
    /// Why the model stopped; `None` when the provider did not say.
    pub stop: Option<StopReason>,
    pub usage: Option<Usage>,
    /// The usage convention of the adapter that sent this request.
    pub input_excludes_cache: bool,
}

/// Sends one summary request (system prompt + user prompt, no tools) with the
/// standard provider recovery. Cancel-safe.
#[async_trait]
pub trait SummarySender: Send + Sync {
    async fn send(&self, system: &str, prompt: &str, call: &SummaryCall) -> Result<SummaryResponse, SummaryFailure>;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RouteStep {
    /// The conversation's own model.
    Session,
    /// The Maintainer's model.
    Maintainer,
    /// The subscription provider's lighter model.
    Lighter,
}

impl RouteStep {
    /// `summaryRoute` (`fresh-context.mjs`): the name the pass records for the step.
    pub fn name(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Maintainer => "maintenance",
            Self::Lighter => "lighter",
        }
    }
}

pub struct SummaryRoute {
    pub step: RouteStep,
    pub provider_name: String,
    pub model: String,
    /// The window the summary request must fit.
    pub context_window: u64,
    /// Provider token-count calibration (see `providerTokenCalibration`).
    pub calibration: f64,
    pub fast: bool,
    /// The route's own effort (the room Maintainer's); `None` where the step names none.
    pub effort: Option<String>,
    pub sender: Arc<dyn SummarySender>,
}

#[async_trait]
pub trait RouteResolver: Send + Sync {
    /// The route of a step; `None` when it is unavailable and the next one runs.
    async fn resolve(&self, step: RouteStep) -> Result<Option<SummaryRoute>, SummaryFailure>;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum SummaryMode {
    #[default]
    Smart,
    Maintainer,
    Session,
}

impl SummaryMode {
    /// The saved `compaction.summaryMode`; the previous release's boolean
    /// `useMaintainer:false` reads as `self`, true or absent as `smart`.
    pub fn normalize(summary_mode: Option<&str>, use_maintainer: Option<bool>) -> Self {
        match summary_mode {
            Some("smart") => Self::Smart,
            Some("maintainer") => Self::Maintainer,
            Some("self") => Self::Session,
            _ if use_maintainer == Some(false) => Self::Session,
            _ => Self::Smart,
        }
    }
}

/// The routes in the order they are tried; the conversation's own model is
/// always the last step.
pub fn plan_steps(mode: SummaryMode, warm: bool) -> Vec<RouteStep> {
    match mode {
        SummaryMode::Maintainer => vec![RouteStep::Maintainer, RouteStep::Session],
        SummaryMode::Smart if !warm => vec![RouteStep::Maintainer, RouteStep::Lighter, RouteStep::Session],
        _ => vec![RouteStep::Session],
    }
}

#[derive(Default, Clone, Debug)]
pub struct Generated {
    pub summary: String,
    /// A section was completed by the schema repair, as Node's `enforceCompactSummarySchema` does.
    pub repaired: bool,
    /// The stop of the call that wrote it (the last one of a batched run).
    pub stop: Option<StopReason>,
    pub usage: Option<Usage>,
    /// The usage convention of the adapter that sent the summary requests the usage sums.
    pub input_excludes_cache: bool,
    pub calls: u32,
    /// `shared-prefix` or `isolated`.
    pub mode: &'static str,
    pub shared_prefix_fallback: Option<&'static str>,
    /// `diagnostics.durationMs`: whole milliseconds from the start of the request that wrote the summary.
    pub duration_ms: f64,
    /// The provider and model of the route that wrote it (set by [`summarize_on_plan`]).
    pub provider_name: String,
    pub model: String,
}

/// Whole milliseconds since `started` (a `Date.now()` difference).
pub(crate) fn elapsed_ms(started: tokio::time::Instant) -> f64 {
    started.elapsed().as_millis() as f64
}

/// A length-limited answer can still supply a handoff; repair its missing sections just like a naturally ended one.
fn usable_summary_stop(stop: Option<&StopReason>) -> bool {
    matches!(stop, None | Some(StopReason::EndTurn | StopReason::StopSequence)) || is_output_limit(stop)
}

fn accept_summary(response: &SummaryResponse, source: &[AgentMessage]) -> Result<EnforcedSummary, SummaryFailure> {
    let stop = response.stop.as_ref().map_or_else(|| "unreported".to_owned(), stop_text);
    let output_tokens = response.usage.as_ref().map_or(0, |u| u.output_tokens);
    let reject = |why: &str| {
        SummaryFailure::Failed(format!(
            "compact summary rejected: {why} (stop={stop}, output_tokens={output_tokens}); the conversation and the previous summary are kept"
        ))
    };
    if response.tool_call {
        return Err(reject("the model answered with a tool call"));
    }
    if !usable_summary_stop(response.stop.as_ref()) {
        return Err(reject("the answer did not end naturally"));
    }
    let raw = extract_response_text(&response.text);
    if raw.is_empty() {
        // Node's own text for it (`generateFreshHandoffSummary`): recorded as the compaction's error.
        return Err(SummaryFailure::Failed("generateFreshHandoffSummary: summary provider returned empty output".into()));
    }
    Ok(enforce_compact_summary_schema(&raw, source, &[]))
}

fn add_usage(total: Option<Usage>, add: Option<&Usage>) -> Option<Usage> {
    let Some(add) = add else { return total };
    let first = total.is_none();
    let mut total = total.unwrap_or_default();
    total.input_tokens += add.input_tokens;
    total.output_tokens += add.output_tokens;
    total.cache_read_tokens += add.cache_read_tokens;
    total.cache_write_tokens += add.cache_write_tokens;
    total.cache_write_1h_tokens += add.cache_write_1h_tokens;
    if first {
        // The first figure is the aggregate so far, not a combination with nothing.
        total.reasoning_tokens = add.reasoning_tokens;
        total.reasoning_incomplete = add.reasoning_incomplete;
    } else {
        total.combine_reasoning(add);
    }
    Some(total)
}

fn sum_usage(a: Option<Usage>, b: Option<Usage>) -> Option<Usage> {
    match (a, b) {
        (Some(a), Some(b)) => add_usage(Some(a), Some(&b)),
        (a, b) => a.or(b),
    }
}

pub struct HandoffInput<'a> {
    pub sender: &'a dyn SummarySender,
    pub model: &'a str,
    pub provider_name: Option<&'a str>,
    pub budget_tokens: u64,
    pub reserve_tokens: u64,
    /// The summary model's own input budget, split into batches when the
    /// conversation is larger.
    pub input_budget_tokens: u64,
    /// `None`: the model's own output limit.
    pub max_output_tokens: Option<u64>,
    pub fast: bool,
}

type Fit<'a> = dyn Fn(&[AgentMessage], Option<&str>) -> Option<String> + 'a;

/// The largest complete next batch that fits beside the previous summary.
/// Each call advances the source cursor, so a failed input cannot loop.
fn fit_next_batch(fit: &Fit<'_>, head: &[AgentMessage], offset: usize, previous: Option<&str>) -> (Option<String>, usize) {
    let all = fit(&head[offset..], previous);
    if all.is_some() {
        return (all, head.len());
    }
    let (mut low, mut high, mut end) = (offset + 1, head.len(), offset);
    let mut prompt = None;
    while low <= high {
        let mid = (low + high) / 2;
        match fit(&head[offset..mid], previous) {
            Some(candidate) => {
                prompt = Some(candidate);
                end = mid;
                low = mid + 1;
            }
            None => {
                if mid == 0 {
                    break;
                }
                high = mid - 1;
            }
        }
    }
    (prompt, end)
}

/// Writes the handoff summary of `messages`, feeding the history through the
/// summary model in budget-fitting batches; each call carries the running
/// summary as its previous-summary context.
pub async fn generate_fresh_handoff_summary(ctx: &FreshContext<'_>, messages: &[AgentMessage], input: &HandoffInput<'_>) -> Result<Generated, SummaryFailure> {
    let started = tokio::time::Instant::now();
    let meter: &MessageMeter<'_> = ctx.tail.meter;
    let rows: &dyn MessageRows = ctx.tail.rows;
    let budget = effective_budget(input.budget_tokens, input.reserve_tokens).map_err(|e| SummaryFailure::Failed(e.message().to_owned()))?;
    let source = split_fresh_source(ctx, messages).await;
    let mut head = source.live.clone();
    let mut previous: Option<String> = source.previous_summary.as_ref().map(AgentMessage::text);
    if head.is_empty() && previous.is_none() {
        return Err(SummaryFailure::Failed("generateFreshHandoffSummary: no compactable session history".into()));
    }
    let base = if input.input_budget_tokens > 0 { input.input_budget_tokens } else { budget };
    let call_budget = ((base as f64 * COMPACTION_PROMPT_HEADROOM).floor() as u64).max(1);
    let fit = |items: &[AgentMessage], prev: Option<&str>| fit_complete_compaction_prompt(meter, items, prev, call_budget);
    if let Some(prev) = previous.as_deref()
        && fit(&[], Some(prev)).is_none()
    {
        let mut chunks = chunk(Role::Assistant, prev);
        chunks.extend(head);
        head = chunks;
        previous = None;
    }
    let call = SummaryCall { model: input.model.to_owned(), max_output_tokens: input.max_output_tokens, fast: input.fast, shape: CallShape::compaction() };
    let mut run = Generated { mode: "isolated", ..Generated::default() };
    let mut offset: usize = 0;
    loop {
        let (prompt, end) = fit_next_batch(&fit, &head, offset, previous.as_deref());
        let Some(prompt) = prompt.filter(|_| !(end == offset && offset < head.len())) else {
            return Err(SummaryFailure::Failed(format!("generateFreshHandoffSummary: complete source cannot fit call budget={call_budget}")));
        };
        let response = input.sender.send(COMPACTION_SYSTEM_PROMPT, &prompt, &call).await?;
        let accepted = accept_summary(&response, &head[offset..end])?;
        run.summary = accepted.summary;
        run.repaired |= accepted.repaired;
        run.stop = response.stop.clone();
        run.usage = add_usage(run.usage, response.usage.as_ref());
        run.input_excludes_cache = response.input_excludes_cache;
        run.calls += 1;
        previous = Some(run.summary.clone());
        offset = end;
        if offset >= head.len() {
            break;
        }
    }
    let message =
        fit_generated_handoff_message(meter, rows, &source.live, &run.summary, budget, &HandoffMeta { provider: input.provider_name, model: input.model })
            .ok_or_else(|| SummaryFailure::Failed(format!("generateFreshHandoffSummary: summary cannot fit budget={budget}")))?;
    drop(message);
    run.duration_ms = elapsed_ms(started);
    Ok(run)
}

/// The saved request of the session that a summary can fork: the same
/// provider, model, system prompt, tools and message prefix, with the summary
/// instruction appended as the final user turn.
pub struct ForkRequest {
    pub provider_name: String,
    pub model: String,
    /// Tokens of the forked messages plus the tool-schema reserve.
    pub prompt_tokens: u64,
    pub shared_prefix_messages: usize,
}

#[async_trait]
pub trait ForkSource: Send + Sync {
    /// Whether the session's last settled request is still inside the cache
    /// lifetime it used (with a safety margin); no forkable request = cold.
    fn warm(&self) -> bool;
    fn request(&self) -> Option<ForkRequest>;
    /// Sends the forked request on `route`. Cancel-safe.
    async fn send(&self, route: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure>;
}

pub enum Forked {
    Generated(Generated),
    /// Why the isolated request runs instead, and the usage the fork spent.
    Fallback {
        reason: &'static str,
        usage: Option<Usage>,
    },
}

/// Summarizes through a fork of the session's cached request. A fork that
/// cannot run, errors, answers with a tool call or yields no summary text falls back. A terminal refusal does not.
pub async fn summarize_on_shared_prefix(fork: &dyn ForkSource, route: &SummaryRoute, conversation_input: &[AgentMessage]) -> Result<Forked, SummaryFailure> {
    let Some(request) = fork.request() else {
        return Ok(Forked::Fallback { reason: "no_settled_request", usage: None });
    };
    if request.provider_name != route.provider_name || request.model != route.model {
        return Ok(Forked::Fallback { reason: "different_route", usage: None });
    }
    let started = tokio::time::Instant::now();
    let window = (route.context_window as f64 / route.calibration).floor() as u64;
    if request.prompt_tokens + SUMMARY_OUTPUT_TOKENS > window {
        return Ok(Forked::Fallback { reason: "window", usage: None });
    }
    let response = match fork.send(route).await {
        Ok(response) => response,
        Err(_) => return Ok(Forked::Fallback { reason: "error", usage: None }),
    };
    if response.tool_call {
        return Ok(Forked::Fallback { reason: "tool_call", usage: response.usage });
    }
    if usable_summary_stop(response.stop.as_ref()) && extract_response_text(&response.text).is_empty() {
        return Ok(Forked::Fallback { reason: "empty", usage: response.usage });
    }
    let accepted = accept_summary(&response, conversation_input)?;
    Ok(Forked::Generated(Generated {
        summary: accepted.summary,
        repaired: accepted.repaired,
        stop: response.stop,
        usage: response.usage,
        input_excludes_cache: response.input_excludes_cache,
        calls: 1,
        mode: "shared-prefix",
        shared_prefix_fallback: None,
        duration_ms: elapsed_ms(started),
        ..Generated::default()
    }))
}

pub struct SummarizeContext<'a> {
    pub fresh: &'a FreshContext<'a>,
    pub fork: &'a dyn ForkSource,
    pub resolver: &'a dyn RouteResolver,
    pub reserve_tokens: u64,
    /// The soft target and the hard window the rebuilt conversation must fit.
    pub compact_budget_tokens: u64,
    pub hard_budget_tokens: u64,
    /// The session's window, bounding the summary's output.
    pub context_window: u64,
    /// What the summary is written from (`conversation_compaction_input`).
    pub conversation_input: &'a [AgentMessage],
    /// `handoffTimeoutMs`: how long the fork, and then the isolated request, may take; `None` is
    /// [`HANDOFF_TIMEOUT_MAX_MS`].
    pub timeout_ms: Option<u64>,
}

/// `future` under one summary deadline (`AbortSignal.timeout`): past it the summary fails, it is not a cancellation.
async fn before_deadline<T>(limit: std::time::Duration, future: impl std::future::Future<Output = T>) -> Result<T, SummaryFailure> {
    mixdog_rt::time::timeout(limit, future).await.map_err(|_| SummaryFailure::Failed(SUMMARY_TIMED_OUT.to_owned()))
}

async fn summarize_on_route(cx: &SummarizeContext<'_>, route: &SummaryRoute, warm: bool) -> Result<Generated, SummaryFailure> {
    let limit = std::time::Duration::from_millis(cx.timeout_ms.filter(|ms| *ms > 0).unwrap_or(HANDOFF_TIMEOUT_MAX_MS));
    let (fallback, fork_usage) = if warm {
        match before_deadline(limit, summarize_on_shared_prefix(cx.fork, route, cx.conversation_input)).await?? {
            Forked::Generated(done) => return Ok(done),
            Forked::Fallback { reason, usage } => (reason, usage),
        }
    } else {
        ("cold_cache", None)
    };
    let window = if route.context_window > 0 { route.context_window } else { cx.context_window };
    let output_reserve = SUMMARY_OUTPUT_TOKENS.min(256.max((window as f64 * 0.15).floor() as u64));
    // What Node sent on the wire: its `maxOutputTokens` reached every provider that reads that key (OpenAI,
    // compat, Gemini, Devin) but never the Anthropic providers, which read only `maxOutputTokensOverride`; there the
    // summary had the model's own output limit, and a cap of the reserve's size would cut a summary that re-emits
    // the previous one.
    let anthropic = route.provider_name.eq_ignore_ascii_case("anthropic") || route.provider_name.eq_ignore_ascii_case("anthropic-oauth");
    let output_cap = (!anthropic).then_some(output_reserve);
    let input_budget = 1.max(((window.saturating_sub(output_reserve)) as f64 / route.calibration).floor() as u64);
    let generated = before_deadline(
        limit,
        generate_fresh_handoff_summary(
            cx.fresh,
            cx.conversation_input,
            &HandoffInput {
                sender: &*route.sender,
                model: &route.model,
                provider_name: Some(&route.provider_name),
                budget_tokens: cx.compact_budget_tokens.max(cx.hard_budget_tokens),
                reserve_tokens: cx.reserve_tokens,
                input_budget_tokens: input_budget,
                max_output_tokens: output_cap,
                fast: route.fast,
            },
        ),
    )
    .await??;
    Ok(Generated { usage: sum_usage(generated.usage, fork_usage), mode: "isolated", shared_prefix_fallback: Some(fallback), ..generated })
}

/// Tries the plan's routes in order. A route out of quota or unavailable
/// moves to the next; every other failure, and a failure of the
/// conversation's own model (the last step), ends the compaction.
pub async fn summarize_on_plan(cx: &SummarizeContext<'_>, steps: &[RouteStep]) -> Result<(RouteStep, Generated), CompactError> {
    let warm = cx.fork.warm();
    let mut tried: HashSet<(String, String)> = HashSet::new();
    let mut failure: Option<CompactError> = None;
    // `error.compactRoute`: a failure on a resolved route names that route.
    let on_route = |error: SummaryFailure, route: &SummaryRoute| match error {
        SummaryFailure::NextRoute(text) | SummaryFailure::Failed(text) => {
            CompactError::RouteFailed(text, CompactRoute { provider: route.provider_name.clone(), model: route.model.clone() })
        }
        other => other.into(),
    };
    for step in steps {
        let route = match cx.resolver.resolve(*step).await {
            Ok(route) => route,
            Err(error) if *step != RouteStep::Session && matches!(error, SummaryFailure::NextRoute(_)) => {
                failure = Some(error.into());
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let Some(route) = route else { continue };
        if !tried.insert((route.provider_name.clone(), route.model.clone())) {
            continue;
        }
        match summarize_on_route(cx, &route, warm).await {
            Ok(done) => return Ok((route.step, Generated { provider_name: route.provider_name, model: route.model, ..done })),
            Err(error) if route.step != RouteStep::Session && matches!(error, SummaryFailure::NextRoute(_)) => {
                failure = Some(on_route(error, &route));
            }
            Err(error) => return Err(on_route(error, &route)),
        }
    }
    Err(failure.unwrap_or_else(|| CompactError::Failed("compact summary route unavailable".into())))
}
