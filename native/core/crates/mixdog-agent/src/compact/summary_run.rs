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
use super::summary::HandoffMeta;
use super::summary::enforce_compact_summary_schema;
use super::summary::fit_complete_compaction_prompt;
use super::summary::fit_generated_handoff_message;
use super::summary::extract_response_text;
use crate::env::CompactError;
use crate::one_shot::CallShape;
use crate::message::AgentMessage;
use mixdog_core_api::domain::provider::Role;

/// Output ceiling of one summary call.
pub const SUMMARY_OUTPUT_TOKENS: u64 = 4_096;
const COMPACTION_PROMPT_HEADROOM: f64 = 0.85;

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
    pub max_output_tokens: u64,
    pub fast: bool,
    /// Request kind, effort, 529 retry and cache choice of the step making the call.
    pub shape: CallShape,
}

pub struct SummaryResponse {
    pub text: String,
    /// The model answered with a tool call instead of text.
    pub tool_call: bool,
    pub usage: Option<Usage>,
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
    pub repaired: bool,
    pub usage: Option<Usage>,
    pub calls: u32,
    /// `shared-prefix` or `isolated`.
    pub mode: &'static str,
    pub shared_prefix_fallback: Option<&'static str>,
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
    pub max_output_tokens: u64,
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
pub async fn generate_fresh_handoff_summary(
    ctx: &FreshContext<'_>,
    messages: &[AgentMessage],
    input: &HandoffInput<'_>,
) -> Result<Generated, SummaryFailure> {
    let meter: &MessageMeter<'_> = ctx.tail.meter;
    let rows: &dyn MessageRows = ctx.tail.rows;
    let budget = effective_budget(input.budget_tokens, input.reserve_tokens)
        .map_err(|e| SummaryFailure::Failed(e.message().to_owned()))?;
    let source = split_fresh_source(ctx, messages);
    let mut head = source.live.clone();
    let mut previous: Option<String> = source.previous_summary.as_ref().map(AgentMessage::text);
    if head.is_empty() && previous.is_none() {
        return Err(SummaryFailure::Failed("generateFreshHandoffSummary: no compactable session history".into()));
    }
    let base = if input.input_budget_tokens > 0 { input.input_budget_tokens } else { budget };
    let call_budget = ((base as f64 * COMPACTION_PROMPT_HEADROOM).floor() as u64).max(1);
    let fit = |items: &[AgentMessage], prev: Option<&str>| fit_complete_compaction_prompt(meter, items, prev, call_budget);
    // An enormous earlier summary is fed through the same bounded pass; it is
    // never silently cut.
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
    let mut offset = 0;
    loop {
        let (prompt, end) = fit_next_batch(&fit, &head, offset, previous.as_deref());
        let Some(prompt) = prompt.filter(|_| !(end == offset && offset < head.len())) else {
            return Err(SummaryFailure::Failed(format!(
                "generateFreshHandoffSummary: complete source cannot fit call budget={call_budget}"
            )));
        };
        let response = input.sender.send(COMPACTION_SYSTEM_PROMPT, &prompt, &call).await?;
        let raw = extract_response_text(&response.text);
        if raw.is_empty() {
            return Err(SummaryFailure::Failed("generateFreshHandoffSummary: summary provider returned empty output".into()));
        }
        let enforced = enforce_compact_summary_schema(&raw, &head[offset..end], &[]);
        run.summary = enforced.summary;
        run.repaired |= enforced.repaired;
        run.usage = add_usage(run.usage, response.usage.as_ref());
        run.calls += 1;
        previous = Some(run.summary.clone());
        offset = end;
        if offset >= head.len() {
            break;
        }
    }
    let message = fit_generated_handoff_message(
        meter,
        rows,
        &source.live,
        &run.summary,
        budget,
        &HandoffMeta { provider: input.provider_name, model: input.model },
    )
    .ok_or_else(|| SummaryFailure::Failed(format!("generateFreshHandoffSummary: summary cannot fit budget={budget}")))?;
    drop(message);
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
    Fallback { reason: &'static str, usage: Option<Usage> },
}

/// Summarizes through a fork of the session's cached request. A fork that
/// cannot run, errors, answers with a tool call or returns no text falls back.
pub async fn summarize_on_shared_prefix(
    fork: &dyn ForkSource,
    route: &SummaryRoute,
    conversation_input: &[AgentMessage],
) -> Forked {
    let Some(request) = fork.request() else {
        return Forked::Fallback { reason: "no_settled_request", usage: None };
    };
    if request.provider_name != route.provider_name || request.model != route.model {
        return Forked::Fallback { reason: "different_route", usage: None };
    }
    let window = (route.context_window as f64 / route.calibration).floor() as u64;
    if request.prompt_tokens + SUMMARY_OUTPUT_TOKENS > window {
        return Forked::Fallback { reason: "window", usage: None };
    }
    let response = match fork.send(route).await {
        Ok(response) => response,
        Err(_) => return Forked::Fallback { reason: "error", usage: None },
    };
    if response.tool_call {
        return Forked::Fallback { reason: "tool_call", usage: response.usage };
    }
    let raw = extract_response_text(&response.text);
    if raw.is_empty() {
        return Forked::Fallback { reason: "empty", usage: response.usage };
    }
    let enforced = enforce_compact_summary_schema(&raw, conversation_input, &[]);
    Forked::Generated(Generated {
        summary: enforced.summary,
        repaired: enforced.repaired,
        usage: response.usage,
        calls: 1,
        mode: "shared-prefix",
        shared_prefix_fallback: None,
    })
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
}

/// The summary on one route: a fork while the cache is warm and the route is
/// the session's own, else (or when the fork cannot run) an isolated request
/// whose input budget belongs to its own model.
async fn summarize_on_route(
    cx: &SummarizeContext<'_>,
    route: &SummaryRoute,
    warm: bool,
) -> Result<Generated, SummaryFailure> {
    let (fallback, fork_usage) = if warm {
        match summarize_on_shared_prefix(cx.fork, route, cx.conversation_input).await {
            Forked::Generated(done) => return Ok(done),
            Forked::Fallback { reason, usage } => (reason, usage),
        }
    } else {
        ("cold_cache", None)
    };
    let window = if route.context_window > 0 { route.context_window } else { cx.context_window };
    let output_tokens = SUMMARY_OUTPUT_TOKENS.min(256.max((window as f64 * 0.15).floor() as u64));
    let input_budget = 1.max(((window.saturating_sub(output_tokens)) as f64 / route.calibration).floor() as u64);
    let generated = generate_fresh_handoff_summary(
        cx.fresh,
        cx.conversation_input,
        &HandoffInput {
            sender: &*route.sender,
            model: &route.model,
            provider_name: Some(&route.provider_name),
            budget_tokens: cx.compact_budget_tokens.max(cx.hard_budget_tokens),
            reserve_tokens: cx.reserve_tokens,
            input_budget_tokens: input_budget,
            max_output_tokens: output_tokens,
            fast: route.fast,
        },
    )
    .await?;
    Ok(Generated {
        usage: sum_usage(generated.usage, fork_usage),
        mode: "isolated",
        shared_prefix_fallback: Some(fallback),
        ..generated
    })
}

/// Tries the plan's routes in order. A route out of quota or unavailable
/// moves to the next; every other failure, and a failure of the
/// conversation's own model (the last step), ends the compaction.
pub async fn summarize_on_plan(cx: &SummarizeContext<'_>, steps: &[RouteStep]) -> Result<(RouteStep, Generated), CompactError> {
    let warm = cx.fork.warm();
    let mut tried: HashSet<(String, String)> = HashSet::new();
    let mut failure: Option<SummaryFailure> = None;
    for step in steps {
        let route = match cx.resolver.resolve(*step).await {
            Ok(route) => route,
            Err(error) if *step != RouteStep::Session && matches!(error, SummaryFailure::NextRoute(_)) => {
                failure = Some(error);
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let Some(route) = route else { continue };
        if !tried.insert((route.provider_name.clone(), route.model.clone())) {
            continue;
        }
        match summarize_on_route(cx, &route, warm).await {
            Ok(done) => return Ok((route.step, done)),
            Err(error) if route.step != RouteStep::Session && matches!(error, SummaryFailure::NextRoute(_)) => {
                failure = Some(error);
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(failure.map_or_else(|| CompactError::Failed("compact summary route unavailable".into()), Into::into))
}
