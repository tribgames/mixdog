//! One provider round: build the request, run exactly one attempt, fold its
//! stream, and decide what a failure means.
//!
//! Retrying has a single owner, the [`RetryDecider`](mixdog_core_api::domain::retry::RetryDecider):
//! the loop classifies a failure into a [`RetryClass`] from typed facts, asks
//! for a verdict, stores the returned state as is, and waits through the host's
//! timer. The loop adds only the recoveries that change the request or the
//! transcript (a reactive compaction, a split-call notice, a stream cut kept
//! as shown, partial tool calls kept) and never counts a retry itself.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendEnd;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WsPhase;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;

use crate::boundary::CompactPolicy;
use crate::env::PartialToolRecovery;
use crate::env::RetractReason;
use crate::env::RouteDecision;
use crate::env::Retracted;
use crate::env::RunEvent;
use crate::env::Stage;
use crate::env::Tone;
use crate::env::TextRetraction;
use crate::env::or_cancelled;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::response::ModelResponse;
use crate::response::ResponseBuilder;
use crate::repair::ToolCallIds;
use crate::run::AgentError;
use crate::run::ContextOverflow;
use crate::run::RetryStates;
use crate::run::Run;

/// Runtime notice for the model after a stream was cut while a tool call's
/// arguments were still streaming: that call never ran, and the same large
/// arguments would likely be cut again.
const TOOL_INPUT_CUT_NOTICE: &str = "[mixdog-runtime] The previous response was cut off in transit while a tool call's arguments were still streaming, so that call never ran. This was a network interruption, not a tool failure; tools remain available. Do not resend the same large arguments in one call: split the content across several smaller tool calls (for example, write the first part, then append or patch the rest), keeping each call well under about 8K tokens of arguments.";

/// `CONTENT_FILTER_NOTICE` (`send-with-recovery.mjs:360`): the guidance a content-filter replay carries. The
/// `[mixdog-runtime]` prefix keeps it out of the visible transcript.
const CONTENT_FILTER_NOTICE: &str = "[mixdog-runtime] The previous response was stopped by the provider content filter before it completed. Continue the task, but rephrase or avoid the content that likely triggered the filter; do not repeat it verbatim.";

/// The provider's own re-issue of a send (`ProviderAdapter::recover_spent`: the non-streaming request of the
/// Anthropic, Chat Completions and Gemini sends), which a send gets once per run of the provider's ladder.
pub(crate) struct Reissue {
    /// The next attempt is the re-issue.
    pending: bool,
    /// The attempt that just ran was the re-issue.
    ran: bool,
    /// The failure the provider's ladder ended on, which surfaces when the re-issue fails too
    /// (`if (!recovered) throw streamErr`); `None` for the re-issue of a cut stream, whose own failure surfaces.
    ladder_failure: Option<ProviderError>,
}

pub(crate) enum SendResult {
    Proceed(Box<ModelResponse>),
    /// The transcript or route changed: start the round over.
    RetryRound,
}

/// A failed attempt with what it had produced.
struct Failure {
    error: ProviderError,
    partial: ModelResponse,
    midstream: bool,
    shown_chars: usize,
    reasoning_shown: bool,
}

/// What the session's fallback chain did with a failure.
enum Route {
    /// No chain, or it kept the error as it was.
    Stay,
    /// The request goes to the next model.
    Switched,
    /// The error to surface instead (a chain that ran out names every model tried).
    Surface(Box<ProviderError>),
}

enum Recovery {
    Proceed(Box<ModelResponse>),
    /// Run another attempt of the same logical send (the decider's `Retry` or `Fallback`).
    Replay,
    /// The request itself changed (a dropped tool, repaired replay, stripped images): the old
    /// send ended in its failure and the replay is a new logical send.
    Rebuilt,
    RetryRound,
}

/// One logical send as the provider's accounting sees it (`RequestOptions.send_group`): the id
/// rides on every attempt the decider replays, and the group must end exactly once. The guard
/// makes that structural: unless it was completed or settled, dropping it settles the group as
/// cancelled, so no exit path leaves a ledger row held open.
pub(crate) struct SendGroup {
    id: String,
    provider: Arc<dyn ProviderAdapter>,
    open: bool,
}

impl SendGroup {
    fn new(provider: Arc<dyn ProviderAdapter>) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self { id: format!("send-{n}"), provider, open: true }
    }

    /// The send succeeded: the provider already wrote its row.
    fn complete(mut self) {
        self.open = false;
    }

    async fn settle(mut self, end: SendEnd) {
        self.open = false;
        self.provider.settle_send(&self.id, end).await;
    }
}

impl Drop for SendGroup {
    fn drop(&mut self) {
        if !self.open {
            return;
        }
        // Only a dropped future gets here (an explicit exit settled the group). What other sends wait
        // for is let go at once, with no runtime; the async settling runs on the runtime the run was on.
        self.provider.release_send(&self.id);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let (provider, id) = (Arc::clone(&self.provider), std::mem::take(&mut self.id));
            runtime.spawn(async move { provider.settle_send(&id, SendEnd::Cancelled).await });
        }
    }
}

/// `MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT`: the retries one WebSocket send spends, handshake and stream failures alike
/// (the adapter's own switch to HTTP/SSE ends such a send earlier on a switchable route).
const WS_RETRY_LIMIT: u32 = 5;

/// `_mustSurfaceCurrentAttempt` (`openai-ws-send-attempts/policy.mjs`): a decision of the current attempt (auth, an
/// upgrade or rate-limit answer, a 1009, a cancellation, a replay that is no longer safe) is never replaced by the
/// outage's earlier failure.
fn must_surface_current(error: &ProviderError, replay_safe: bool) -> bool {
    matches!(error.status, Some(401 | 403 | 426 | 429))
        || matches!(error.transport, Some(TransportFault::WsClose { code: Some(1009) }))
        || error.unsafe_to_retry
        || !replay_safe
}

/// The facts that end a stream after it started.
fn is_stream_cut(error: &ProviderError) -> bool {
    matches!(
        error.transport,
        Some(
            TransportFault::TruncatedStream
                | TransportFault::Closed
                | TransportFault::Reset
                | TransportFault::Tls
                | TransportFault::H2GoAway { .. }
                | TransportFault::H2RstStream { .. }
                | TransportFault::WsClose { .. }
                | TransportFault::KeepaliveExpired { .. }
                | TransportFault::Io { .. }
        )
    )
}

fn is_connect_fault(error: &ProviderError) -> bool {
    matches!(
        error.transport,
        Some(TransportFault::Connect { .. } | TransportFault::Dns)
    )
}

/// The row that governs a failure first: the request or the stream row, a connect
/// failure included (the provider's own `withRetry` covers it before the loop's
/// outage ladder does, `golden/connect_errors.json`).
fn first_class(midstream: bool) -> RetryClass {
    if midstream {
        RetryClass::Midstream
    } else {
        RetryClass::Request
    }
}

/// Session-level replay once the provider rows are spent: after a connect failure,
/// or while the server stays unavailable. A transport fault is not replayed by
/// the loop, before the first byte or after the headers alike: `sendWithRecovery`
/// reads the provider's spent ladder (`providerRecoveryExhausted`) as final for
/// everything but a connect failure and an unavailable server
/// (`providerRecoveryEnded`, `send-with-recovery.mjs:190`), and a reset or a cut
/// stream is neither (`golden/connect_errors.json`: `reset`, `cutRole`, `cutText`).
fn escalate(class: RetryClass, error: &ProviderError) -> Option<RetryClass> {
    if !matches!(class, RetryClass::Request | RetryClass::Midstream) {
        return None;
    }
    if is_connect_fault(error) {
        Some(RetryClass::Connection)
    } else if error.transport.is_some() {
        None
    } else if matches!(error.kind, ErrorKind::Overloaded | ErrorKind::Transient) {
        Some(RetryClass::Recovery)
    } else {
        None
    }
}

/// The provider's retry policy for one request: `retry_529: false` (Node `opts.retry529 === false`,
/// `retry-executor.mjs`) stops an overload retrying, ahead of the overload fallback.
fn request_policy<'a>(provider: &'a dyn ProviderAdapter, model: &str, retry_529: bool) -> std::borrow::Cow<'a, RetryPolicy> {
    let policy = provider.retry_policy_for(model);
    if retry_529 {
        return std::borrow::Cow::Borrowed(policy);
    }
    let mut policy = policy.clone();
    policy.status.retry_529 = false;
    std::borrow::Cow::Owned(policy)
}

/// The one assembly of a send's request: [`wire_request`] with the reminder `tail`'s rules give for `model` (also
/// returned, the turn keeps its text). The loop's sends and the request snapshot both build their request here.
pub fn assemble_request(
    model: &str,
    options: mixdog_core_api::domain::provider::RequestOptions,
    messages: Vec<mixdog_core_api::domain::provider::Message>,
    tail: Option<&dyn crate::env::TailReminder>,
    tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
) -> (ModelRequest, Option<String>) {
    let reminder = tail.and_then(|t| t.text(model));
    (wire_request(model, options, messages, reminder.as_deref(), tools), reminder)
}

/// The request the loop sends: the projected transcript, the tail reminder when the turn has one
/// (it rides on this request only), the tool definitions and the options. A side question rebuilds
/// the request of the session's next turn through the same function.
pub fn wire_request(
    model: &str,
    options: mixdog_core_api::domain::provider::RequestOptions,
    mut messages: Vec<mixdog_core_api::domain::provider::Message>,
    tail_reminder: Option<&str>,
    tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
) -> ModelRequest {
    if let Some(text) = tail_reminder {
        messages.push(tail_reminder_message(text));
    }
    ModelRequest { model: model.to_owned(), messages, tools, options }
}

fn tail_reminder_message(text: &str) -> mixdog_core_api::domain::provider::Message {
    let mut reminder = mixdog_core_api::domain::provider::Message::new(
        mixdog_core_api::domain::provider::Role::User,
        mixdog_core_api::domain::provider::Content::Text(text.to_owned()),
    );
    reminder.source = Some(mixdog_core_api::domain::provider::MessageSource::TailReminder);
    reminder
}

/// The request as the side-question store keeps it (`captureSideQuestionRequest` takes the
/// messages before `sendWithRecovery` adds the reminder to its own copy): without the tail
/// reminder `wire_request` put last. A fork or a cache warm adds the reminder of its own moment.
pub fn without_tail_reminder(request: &ModelRequest) -> ModelRequest {
    let mut kept = request.clone();
    if kept.messages.last().is_some_and(|m| m.source == Some(mixdog_core_api::domain::provider::MessageSource::TailReminder)) {
        kept.messages.pop();
    }
    kept
}

/// `withTailReminder` over a kept request: its messages plus the reminder `text` (when the rules
/// give one) as the last, ephemeral message; the same message `wire_request` builds.
pub fn with_tail_reminder(request: &ModelRequest, text: Option<&str>) -> ModelRequest {
    let mut sent = request.clone();
    if let Some(text) = text {
        sent.messages.push(tail_reminder_message(text));
    }
    sent
}

impl Run {
    fn build_request(&mut self) -> ModelRequest {
        let mut options = self.config.options.clone();
        // One identity per send, shared by its attempts: the run's options would hand every send of the run the same one.
        options.send_identity = self.send_identity.clone();
        options.provider_state = self.provider_state.clone();
        let provider = Arc::clone(&self.provider);
        options.send_group = Some(self.send_group.get_or_insert_with(|| SendGroup::new(provider)).id.clone());
        // The output-limit escalation is one-shot: this attempt alone carries it.
        options.max_output_tokens_override = self.max_output_override.take().or(options.max_output_tokens_override);
        let messages = if self.unprojected {
            self.messages.iter().map(AgentMessage::wire).collect()
        } else if let Some(strip) = &self.image_strip {
            crate::project::project_for_wire(&crate::recovery::with_images_stripped(&self.messages, strip))
        } else {
            crate::project::project_for_wire(&self.messages)
        };
        // The tail reminder rides on this request only; the assistant turn it
        // produces keeps its text.
        let (request, reminder) = assemble_request(&self.model, options, messages, self.env.tail.as_deref(), self.request_tools());
        self.last_reminder = reminder;
        request
    }

    /// Sends the transcript, recovering from failures. The returned response
    /// is whole; a retry never leaks a dead attempt's output.
    pub(crate) async fn send_provider_request(&mut self) -> Result<SendResult, AgentError> {
        let result = self.send_attempts().await;
        // sideQuestion.settle(response) on a proceed, discard() on anything else.
        if let Some(ticket) = self.side_ticket.take() {
            match &result {
                Ok(SendResult::Proceed(response)) => ticket.settle(response),
                _ => ticket.discard(),
            }
        }
        // Whatever left the group open ended without a success: a surfaced failure (a recovered
        // partial, a route switch, an error), or the user's abort. Settled before any other send.
        let end = match &result {
            Err(AgentError::Aborted | AgentError::Admission(_)) => SendEnd::Cancelled,
            _ => SendEnd::Surfaced,
        };
        if let Some(group) = self.send_group.take() {
            group.settle(end).await;
        }
        result
    }

    async fn send_attempts(&mut self) -> Result<SendResult, AgentError> {
        self.request_started_ms = self.env.clock.now_ms();
        self.send_identity = Default::default();
        self.reissue = None;
        self.emit(RunEvent::ProviderSendStarted);
        // The mark of this send is stored before the request leaves; a cancel ends the wait and the loop below reports it.
        let _ = or_cancelled(&self.cancel, self.env.sink.drafted()).await;
        loop {
            self.throw_if_aborted()?;
            // Calls a dead attempt started are dropped with it.
            self.drop_eager();
            let request = Arc::new(self.build_request());
            self.prepare_prefix_guard(&request)?;
            // A restarted process compares its first request with the last prefix fingerprint the record kept.
            mixdog_ai::providers::anthropic::prefix_trace::seed(self.config.thread_id.as_str(), self.carry.cache.prefix_baseline.as_ref());
            self.last_request = Some(request.clone());
            if self.side_ticket.is_none() && let Some(tap) = &self.env.side {
                self.side_ticket = Some(tap.begin(&request));
            }
            if let Some(begin) = &self.config.request_begin {
                begin();
            }
            let failure = match self.attempt_once(request).await? {
                Ok(response) => {
                    // A completed send ends the outage the budgets covered.
                    self.retry = RetryStates::new(&self.model);
                    self.first_ws_failure = None;
                    self.ws_retries = 0;
                    self.settle_prefix(&response);
                    // `settleImageStrip`: a confirmed rejection of one image is
                    // healed out of the transcript, so later turns never send it again; any other
                    // strip was held for the replay alone and the cache break is traced.
                    if let Some(strip) = self.image_strip.take() {
                        if strip.persist {
                            self.messages = crate::recovery::with_images_stripped(&self.messages, &strip);
                            self.env.sink.replace(&self.messages, &crate::env::Rewrite::default());
                        } else if let Some(sent) = self.last_request.clone() {
                            self.trace_image_strip_rebaseline(&sent);
                        }
                    }
                    self.image_strip_used = false;
                    // The re-issue of a spent ladder answered: the provider's line (`recoverCompatNonStreaming`).
                    if let Some(Reissue { ran: true, ladder_failure: Some(failure), .. }) = self.reissue.take()
                        && let Some(line) = self.provider.recovery_line(&self.model, &failure)
                    {
                        mixdog_rt::node_stderr!("{line}");
                    }
                    if let Some(group) = self.send_group.take() {
                        group.complete();
                    }
                    return Ok(SendResult::Proceed(Box::new(response)));
                }
                Err(failure) => failure,
            };
            match self.recover(*failure).await? {
                Recovery::Proceed(response) => {
                    self.settle_prefix(&response);
                    return Ok(SendResult::Proceed(response));
                }
                Recovery::Replay => continue,
                Recovery::Rebuilt => {
                    if let Some(group) = self.send_group.take() {
                        group.settle(SendEnd::Surfaced).await;
                    }
                    continue;
                }
                Recovery::RetryRound => return Ok(SendResult::RetryRound),
            }
        }
    }

    /// `projectProviderRequest`'s prefix guard: the request's fingerprint against the one the session last settled on; a
    /// break is traced once per turn (`cacheBreakTracer`), and an unexpected one refuses the send as Node's guard throws
    /// (`ProviderPrefixMutationError`, traced first). The tail reminder rides the request alone and is not part of it.
    fn prepare_prefix_guard(&mut self, request: &ModelRequest) -> Result<(), AgentError> {
        let messages = match request.messages.split_last() {
            Some((last, rest)) if last.source == Some(mixdog_core_api::domain::provider::MessageSource::TailReminder) => rest,
            _ => &request.messages[..],
        };
        let provider = self.provider.id().as_str().to_owned();
        let next = crate::prefix_guard::snapshot(messages, &request.tools, &request.options.hosted_tools, &provider, &self.model);
        let intent = self.cache_break_intent.clone();
        let options = crate::prefix_guard::GuardOptions {
            provider: &provider,
            model: &self.model,
            intent: intent.as_deref(),
            mutation_source: (intent.as_deref() == Some("transcript_rebuild")).then_some("transcript_rebuild"),
        };
        let mut refused = None;
        if let Some(details) = crate::prefix_guard::compare(self.carry.prefix_guard.as_ref(), &next, &options) {
            if details.get("classification").and_then(serde_json::Value::as_str) == Some("unexpected") {
                refused = Some(match details.get("reason").and_then(serde_json::Value::as_str) {
                    Some("history_shrink") => "provider message history shrank outside compaction",
                    _ => "provider message prefix changed outside compaction",
                });
            }
            if self.cache_break_keys.insert(crate::prefix_guard::trace_key(&details))
                && let Some(log) = &self.env.failures
            {
                let mut record = serde_json::Map::new();
                record.insert("sessionId".into(), serde_json::json!(self.config.thread_id.as_str()));
                record.insert("iteration".into(), serde_json::json!(self.iterations + 1));
                record.insert("intentionalTransition".into(), intent.map_or(serde_json::Value::Null, serde_json::Value::String));
                record.extend(details);
                log.cache_break(record);
            }
        }
        if let Some(message) = refused {
            return Err(AgentError::PrefixMutation(message.to_owned()));
        }
        self.guard_candidate = Some(next);
        Ok(())
    }

    /// `settleSendResult` for a completed send: the request becomes the session's prefix baseline, the usage-based cache
    /// miss check runs (`traceActualCacheMiss`), and the one-shot intent is spent.
    fn settle_prefix(&mut self, response: &ModelResponse) {
        let previous_guard = std::mem::replace(&mut self.carry.prefix_guard, self.guard_candidate.take());
        let previous_send_at = self.carry.cache.last_send_at;
        let sent_at = self.request_started_ms as f64;
        self.carry.cache.last_send_at = Some(sent_at);
        self.trace_actual_cache_miss(response, previous_guard.as_ref(), previous_send_at, sent_at);
        self.cache_break_intent = None;
    }

    /// `traceActualCacheMiss` (send-phase.mjs): on an Anthropic session, a response that read far less of the prompt cache
    /// than the previous request held, within the cache's lifetime and with no intended break or changed request prefix, is
    /// an unexpected break; the session record keeps this request's cache read plus write and its prefix fingerprint.
    fn trace_actual_cache_miss(&mut self, response: &ModelResponse, previous_guard: Option<&crate::prefix_guard::Snapshot>, previous_send_at: Option<f64>, sent_at: f64) {
        const MISS_RATIO: f64 = 0.5;
        const MISS_MIN_DROP_TOKENS: f64 = 4096.0;
        let provider = self.provider.id().as_str().to_owned();
        if provider != "anthropic" && provider != "anthropic-oauth" {
            return;
        }
        let usage = &response.usage;
        let cached = usage.cache_read_tokens as f64;
        let cache_prefix = cached + usage.cache_write_tokens as f64;
        let baseline = self.carry.cache.cached_prefix_tokens.unwrap_or(f64::NAN);
        let idle = sent_at - previous_send_at.unwrap_or(f64::NAN);
        let request_prefix_changed = previous_guard.is_some_and(|previous| Some(&previous.request_prefix_hash) != self.carry.prefix_guard.as_ref().map(|next| &next.request_prefix_hash));
        let thread = self.config.thread_id.as_str().to_owned();
        if baseline > 0.0
            && let Some(ttl) = self.carry.cache.messages_ttl_ms
            && idle.is_finite()
            && idle >= 0.0
            && idle < ttl as f64
            && cached < baseline * MISS_RATIO
            && baseline - cached >= MISS_MIN_DROP_TOKENS
            && self.cache_break_intent.is_none()
            && !request_prefix_changed
            && let Some(log) = &self.env.failures
        {
            let prompt = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
            let mut record = serde_json::Map::new();
            record.insert("sessionId".into(), serde_json::json!(thread));
            record.insert("iteration".into(), serde_json::json!(self.iterations + 1));
            record.insert("classification".into(), serde_json::json!("unexpected"));
            record.insert("reason".into(), serde_json::json!("actual_cache_miss"));
            record.insert("source".into(), serde_json::json!("provider_usage"));
            record.insert("provider".into(), serde_json::json!(provider));
            record.insert("model".into(), serde_json::json!(self.model));
            record.insert("actualCacheMiss".into(), serde_json::json!(true));
            record.insert("cachedTokens".into(), mixdog_js::json_number(cached));
            record.insert("promptTokens".into(), if prompt == 0 { serde_json::Value::Null } else { serde_json::json!(prompt) });
            record.insert("previousCachedPrefixTokens".into(), mixdog_js::json_number(baseline));
            record.insert("idleMs".into(), mixdog_js::json_number(idle));
            record.insert("missingPrefixGuardBaseline".into(), serde_json::json!(previous_guard.is_none()));
            // Which wire block moved ('none': same bytes, so the cache itself dropped it).
            if let Some(changes) = mixdog_ai::providers::anthropic::prefix_trace::changes(&thread) {
                record.extend(changes);
            }
            log.cache_break(record);
        }
        self.carry.cache.cached_prefix_tokens = Some(cache_prefix);
        self.carry.cache.changed = true;
        // The fingerprint of this request survives a restart on the record, so the next process's first miss can still name
        // what moved.
        if let Some(fingerprint) = mixdog_ai::providers::anthropic::prefix_trace::latest_persistable(&thread) {
            self.carry.cache.prefix_baseline = Some(fingerprint);
        }
    }

    /// `settleImageStrip` (send-phase.mjs): the strip held for the replay alone, so the request the provider cached
    /// differs from the transcript the next send continues; the change is traced as intentional.
    fn trace_image_strip_rebaseline(&mut self, sent: &ModelRequest) {
        self.carry.prefix_guard = None;
        let Some(log) = &self.env.failures else { return };
        let record = serde_json::json!({
            "sessionId": self.config.thread_id.as_str(),
            "iteration": self.iterations + 1,
            "classification": "intentional",
            "reason": "image_strip_nonpersistent_rebaseline",
            "source": "image_strip_retry",
            "provider": self.provider.id().as_str(),
            "model": self.model,
            "previousCount": sent.messages.len(),
            "nextCount": self.messages.len(),
        });
        if let serde_json::Value::Object(record) = record {
            log.cache_break(record);
        }
    }

    /// Exactly one attempt: admission, the stream, its fold.
    async fn attempt_once(
        &mut self,
        request: Arc<ModelRequest>,
    ) -> Result<Result<ModelResponse, Box<Failure>>, AgentError> {
        let builder = ResponseBuilder::new(&self.model, ToolCallIds::new(&self.messages));
        let fail = |error: ProviderError, builder: ResponseBuilder, midstream, shown, reasoning| {
            let mut partial = builder.finish();
            // What the provider kept of a cut stream beyond the events (`partialProviderReplay`).
            if partial.replay.is_empty()
                && let Some(replay) = &error.partial_replay
            {
                partial.replay.push((**replay).clone());
            }
            Err(Box::new(Failure {
                error,
                partial,
                midstream,
                shown_chars: shown,
                reasoning_shown: reasoning,
            }))
        };
        // Stored text attachments become their text in every request; the saved
        // messages keep the reference.
        let request = match self.config.attachments.clone() {
            Some(resolver) => {
                let mut built = (*request).clone();
                let messages = std::mem::take(&mut built.messages);
                let resolved = or_cancelled(&self.cancel, crate::attachments::resolve_text_attachments(messages, resolver.as_ref()))
                    .await
                    .ok_or(AgentError::Aborted)?;
                let resolved = match resolved {
                    // A text-only route reads and lowers its stored files itself.
                    Ok(messages) if self.config.text_only.is_none() => {
                        // The engine this request goes to says what it takes as a document (a gateway's Messages
                        // engine differs from its Chat wire).
                        let support = self.provider.media_support(&request).await;
                        let takes_vision = self.provider.takes_vision(&request).await;
                        let resolved = or_cancelled(
                            &self.cancel,
                            crate::attachments::resolve_media_attachments(messages, resolver.as_ref(), support.native_pdf, takes_vision),
                        )
                        .await
                        .ok_or(AgentError::Aborted)?;
                        // `preparePdfTextForProvider`, and the text of an Office file, for every provider.
                        match (resolved, self.config.file_text.clone()) {
                            (Ok(messages), Some(media)) => or_cancelled(&self.cancel, media.prepare_for_route(messages, support))
                                .await
                                .ok_or(AgentError::Aborted)?,
                            (resolved, _) => resolved,
                        }
                    }
                    other => other,
                };
                match resolved {
                    Ok(messages) => {
                        built.messages = messages;
                        Arc::new(built)
                    }
                    Err(error) => return Ok(fail(*error, builder, false, 0, false)),
                }
            }
            None => request,
        };
        // A text-only route degrades and checks the request on every attempt.
        let request = match self.config.text_only.clone() {
            Some(text_only) => {
                let built = (*request).clone();
                let prepared = or_cancelled(&self.cancel, crate::text_only::prepare_text_only_request(&text_only, built))
                    .await
                    .ok_or(AgentError::Aborted)?;
                match prepared {
                    Ok(done) => Arc::new(done),
                    Err(error) => return Ok(fail(*error, builder, false, 0, false)),
                }
            }
            None => request,
        };
        // The provider request is I/O: an agent job's slot goes back to the pool for its length.
        let Some(slot) = self.config.slot.clone() else { return self.exchange(request, builder).await };
        let mut settled = None;
        let turn = self.config.signal.clone().unwrap_or_else(|| crate::cancel::Cancel::from_token(&self.cancel));
        let yielded = slot
            .run_yielded(
                Box::pin(async {
                    let result = self.exchange(request, builder).await;
                    let ok = matches!(result, Ok(Ok(_)));
                    settled = Some(result);
                    ok
                }),
                Some(&turn),
            )
            .await;
        match yielded {
            Ok(()) => settled.expect("the request ran"),
            Err(reason) => Err(AgentError::Admission(reason)),
        }
    }

    /// The provider request and the fold of its stream.
    async fn exchange(
        &mut self,
        request: Arc<ModelRequest>,
        mut builder: ResponseBuilder,
    ) -> Result<Result<ModelResponse, Box<Failure>>, AgentError> {
        let fail = |error: ProviderError, builder: ResponseBuilder, midstream, shown, reasoning| {
            let mut partial = builder.finish();
            // What the provider kept of a cut stream beyond the events (`partialProviderReplay`).
            if partial.replay.is_empty()
                && let Some(replay) = &error.partial_replay
            {
                partial.replay.push((**replay).clone());
            }
            Err(Box::new(Failure {
                error,
                partial,
                midstream,
                shown_chars: shown,
                reasoning_shown: reasoning,
            }))
        };
        let provider = Arc::clone(&self.provider);
        // The provider's own `requesting` stages (`onStageChange`): those it raises before a send's first attempt and
        // before every attempt, here; those it raises from inside the attempt, once the attempt is over.
        let stages = provider.send_stages_of(&request);
        let first_attempt = self.retry.get(RetryClass::Request).count(None).retries == 0
            && self.retry.get(RetryClass::Midstream).count(None).retries == 0;
        if first_attempt {
            for _ in 0..stages.preparing {
                self.emit(RunEvent::Stage(Stage::Requesting));
            }
        }
        if stages.each_attempt {
            self.emit(RunEvent::Stage(Stage::Requesting));
        }
        let reissued = self.reissue.as_mut().is_some_and(|reissue| {
            reissue.ran = std::mem::take(&mut reissue.pending);
            reissue.ran
        });
        let identity = request.options.send_identity.clone();
        // The projection is rebuilt from the transcript for every request.
        // The provider's own `requesting` is delivered as its request goes out: the attempt may already be reading the
        // response's first output when it returns, and the liveness clock starts at the request.
        let deliver = |stage: &'static str, _payload: Option<serde_json::Value>| {
            if stage == "requesting" {
                self.emit(RunEvent::Stage(Stage::Requesting));
            }
        };
        let attempt = match &self.config.effort {
            // The provider's re-issue of this send, with the projection an attempt carries (`ProjectingAdapter`).
            _ if reissued => {
                let mut request = Arc::unwrap_or_clone(request);
                if let Some(wiring) = &self.config.effort {
                    request.options.effort_projection = wiring.route.project(&self.messages).map(Into::into);
                }
                identity.deliver_stages(or_cancelled(&self.cancel, provider.recover_spent(Arc::new(request))), deliver).await
            }
            Some(wiring) => {
                let projection = wiring.route.project(&self.messages);
                let adapter = Arc::clone(&wiring.adapter);
                identity.deliver_stages(or_cancelled(&self.cancel, async move { adapter.attempt_with(request, projection).await }), deliver).await
            }
            None => identity.deliver_stages(or_cancelled(&self.cancel, provider.attempt(request)), deliver).await,
        };
        let mut stream = match attempt {
            None => return Err(AgentError::Aborted),
            Some(Err(error)) => {
                self.show_notices(&error);
                return Ok(fail(error, builder, false, 0, false));
            }
            Some(Ok(stream)) => stream,
        };
        self.emit(RunEvent::Stage(Stage::Streaming));
        let mut shown_chars = 0usize;
        let mut reasoning_shown = false;
        self.settle_gate.send_replace(false);
        // Invariant (`crate::batch::settle_gate`): the gate is open only while a pending `next` waits for the wire. It is
        // opened here, between polls of `next`, and closed by the stream itself inside the poll in which the wire's
        // terminal event arrives, before that `next` goes on to the ledger's write: both run on this task, so a waiter
        // never finds it open from the instant the response ended, whether the `next` that ends it began on the wire or not.
        let wire_left = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let (gate, left) = (self.settle_gate.clone(), Arc::clone(&wire_left));
            stream.on_wire_left(Arc::new(move || {
                left.store(true, std::sync::atomic::Ordering::Release);
                gate.send_replace(false);
            }));
        }
        loop {
            let mut pending = std::pin::pin!(stream.next());
            let ready = std::future::poll_fn(|cx| std::task::Poll::Ready(std::future::Future::poll(pending.as_mut(), cx))).await;
            let next = match ready {
                std::task::Poll::Ready(next) => next,
                std::task::Poll::Pending => {
                    // Every byte received is handled and the response is still open.
                    if !builder.completed() && !wire_left.load(std::sync::atomic::Ordering::Acquire) {
                        self.settle_gate.send_replace(true);
                    }
                    let next = or_cancelled(&self.cancel, pending).await.ok_or(AgentError::Aborted)?;
                    self.settle_gate.send_replace(false);
                    next
                }
            };
            let event = match next {
                None => break,
                Some(Err(error)) => {
                    self.show_notices(&error);
                    // The stream is issued anew by the retry: the provider's once-per-ladder `requesting` is raised again.
                    identity.reissue();
                    return Ok(fail(error, builder, true, shown_chars, reasoning_shown));
                }
                Some(Ok(event)) => event,
            };
            if let StreamEvent::ChunkProgress(kind) = &event {
                self.emit(RunEvent::Chunk(*kind));
            }
            if let StreamEvent::Progress(kind) = &event {
                self.emit(RunEvent::ToolStream(*kind));
            }
            match &event {
                StreamEvent::TextDelta(text) => {
                    shown_chars += mixdog_js::utf16_len(text);
                    self.emit(RunEvent::TextDelta(text.clone()));
                }
                StreamEvent::ReasoningDelta(text) => {
                    reasoning_shown = true;
                    self.emit(RunEvent::ReasoningDelta(text.clone()));
                }
                // Informational only: never progress, never death.
                StreamEvent::ProviderKeepalive => {
                    self.emit(RunEvent::Stage(Stage::WaitingOnProvider));
                }
                // The provider changed the session's state; later requests of
                // the turn (a replay included) carry it, and the host persists it.
                StreamEvent::ProviderState(state) => {
                    self.provider_state = Some(state.clone());
                    self.provider_state_changed = true;
                }
                // `onStageChange('notice', { tone, message })`: shown in the transcript, nothing else.
                StreamEvent::Notice { message, warn } => self.show_notice(message, *warn),
                // The account pool's `onStageChange`, in the order the pool raised it.
                StreamEvent::AccountStage(stage) => self.emit(RunEvent::Stage(match stage {
                    mixdog_core_api::domain::provider::AccountStage::Switching { message } => {
                        Stage::AccountSwitching { message: message.clone() }
                    }
                    mixdog_core_api::domain::provider::AccountStage::Changed { provider, account_id, at } => {
                        Stage::AccountChanged { provider: provider.clone(), account_id: account_id.clone(), at: *at }
                    }
                })),
                // `sendOnRoute`'s reroute: a session whose pin named this provider and model takes the new route; the
                // turn's later sends read it, and the host saves it with the carry.
                StreamEvent::WireRerouted(route) => {
                    let new = mixdog_core_api::domain::provider::WirePin::from_route(route);
                    if let (Some(pin), Some(new)) = (&self.config.options.wire_pin, new)
                        && pin.provider == new.provider
                        && pin.model == new.model
                    {
                        self.config.options.wire_pin = Some(new);
                        self.carry.wire_route = Some(route.clone());
                    }
                }
                _ => {}
            }
            let tool_done = matches!(event, StreamEvent::ToolCallDone(_));
            builder.push(event);
            if tool_done && let Some(call) = builder.so_far().tool_calls.last().cloned() {
                if !call.id.is_empty() {
                    self.streamed_ids.insert(call.id.clone());
                }
                self.emit(RunEvent::ToolCallObserved(call.clone()));
                let started_in = self.live_cwd();
                self.try_eager(&call, &started_in).await;
            }
        }
        if !builder.completed() {
            // A stream may only end with its terminal event.
            let mut error = ProviderError::transport(
                TransportFault::TruncatedStream,
                stream.delivery(),
            );
            error.exposure.text_emitted = shown_chars > 0;
            return Ok(fail(error, builder, true, shown_chars, reasoning_shown));
        }
        self.last_streamed_chars = shown_chars;
        Ok(Ok(builder.finish()))
    }

    fn show_notice(&self, message: &str, warn: bool) {
        let tone = if warn { Tone::Warn } else { Tone::Info };
        self.emit(RunEvent::Stage(Stage::Notice { message: message.to_owned(), tone }));
    }

    /// The notices a failed request raised before it failed (`ProviderError::notices`).
    fn show_notices(&self, error: &ProviderError) {
        for (message, warn) in &error.notices {
            self.show_notice(message, *warn);
        }
    }

    async fn recover(&mut self, fail: Failure) -> Result<Recovery, AgentError> {
        let Failure {
            mut error,
            partial,
            midstream,
            shown_chars,
            reasoning_shown,
        } = fail;
        // The provider's re-issue failed: after a spent ladder its own failure is dropped and the ladder's surfaces;
        // either way the provider's recovery of this send is over (`markProviderRecoveryExhausted`).
        let mut reissue_failed = false;
        if let Some(reissue) = self.reissue.as_mut()
            && std::mem::take(&mut reissue.ran)
        {
            if let Some(ladder) = reissue.ladder_failure.clone() {
                error = ladder;
            }
            error.recovery_exhausted = true;
            reissue_failed = true;
        }
        // Parsed tool calls survive a cut stream: continuing is not replaying.
        // The calls resolve and run exactly once, and the next request carries
        // them forward. A half-streamed call is never one of them.
        // When a tool input was still streaming at the cut, the turn continues
        // only if every complete call was already dispatched: nothing committed
        // may reference an undispatched call. The in-flight call is dropped
        // unrun and the model told to split it. A call the stream handed over is dispatched whether or not it was admitted
        // for an eager run (`recoverableToolCalls`, `send-with-recovery.mjs:720`).
        let input_cut = error.exposure.tool_input_cut;
        let recoverable = !partial.tool_calls.is_empty()
            && (!input_cut || partial.tool_calls.iter().all(|c| self.stream_dispatched(&c.id)));
        if is_stream_cut(&error) && recoverable {
            // `recoverPartialToolCalls`' trace (`send-with-recovery.mjs:769`), at the round's iteration (`nextIteration`).
            self.emit(RunEvent::PartialToolRecovery(PartialToolRecovery {
                iteration: self.iterations + 1,
                tool_calls: partial.tool_calls.len(),
                dropped_incomplete_input: input_cut,
                partial_content_len: mixdog_js::utf16_len(&partial.content),
            }));
            let recovery_notice = input_cut
                .then(|| AgentMessage::sourced(Source::StreamCutRecovery, TOOL_INPUT_CUT_NOTICE));
            return Ok(Recovery::Proceed(Box::new(ModelResponse {
                stop: Some(StopReason::ToolUse),
                recovery_notice,
                ..partial
            })));
        }
        let replay_safe = !error.exposure.text_emitted
            && !error.exposure.tool_dispatched
            && shown_chars == 0
            && !reasoning_shown;
        if error.kind == ErrorKind::ContextOverflow {
            return self.on_context_overflow(error, replay_safe).await;
        }
        if self.content_filter_replayable(&error) {
            return self.replay_after_content_filter(error, &partial, replay_safe, shown_chars, reasoning_shown).await;
        }
        if let Some(recovery) = self.request_changing_recovery(&error, &partial, replay_safe) {
            return Ok(recovery);
        }
        if midstream && self.reissue_cut_stream(&error, &partial, shown_chars, reasoning_shown) {
            return Ok(Recovery::Replay);
        }
        let text_shown = error.exposure.text_emitted || shown_chars > 0;
        let exposed = text_shown || reasoning_shown;
        // Withdrawing shown text makes a replay safe; it is asked only once a
        // replay is decided. A dispatched tool call can never be replayed.
        let retractable = exposed && !error.exposure.tool_dispatched;
        let mut decide_on = error.clone();
        // A call already running cannot be replayed.
        decide_on.exposure.tool_dispatched |= !self.eager.is_empty();
        if retractable {
            decide_on.exposure.text_emitted = false;
        }
        let split_notice = decide_on.exposure.tool_input_cut;
        decide_on.exposure.tool_input_cut = false;

        let mut class = first_class(midstream);
        let mut spent: Vec<RetryState> = Vec::new();
        let provider = Arc::clone(&self.provider);
        let policy = request_policy(provider.as_ref(), &self.model, self.config.retry_529);
        // A failure the provider's own recovery ended on has no step left on the provider's rows: the loop's outage
        // and recovery ladders take it, or it surfaces (`providerRecoveryEnded`).
        let mut ended = false;
        if reissue_failed {
            match escalate(class, &decide_on) {
                Some(next) => class = next,
                None => ended = true,
            }
        }
        let committed = loop {
            if ended {
                break None;
            }
            let decision = self.env.decider.verdict(
                &decide_on,
                self.retry.get(class),
                &policy,
                JitterSamples {
                    step: self.env.jitter.draw(),
                    advice: self.env.jitter.draw(),
                },
            );
            // The provider's ladder ended on this failure: its re-issue of the send runs once before the loop's own
            // ladders (`recoverCompatNonStreaming`, `_recoverGeminiNonStreaming`).
            if matches!(decision.verdict, Verdict::Exhausted | Verdict::Surface)
                && class == first_class(midstream)
                && self.reissues_spent(&error, &partial, midstream, replay_safe)
            {
                for state in spent {
                    self.retry.store(state);
                }
                self.retry.store(decision.next);
                if provider.send_stages(&self.model).before_recovery {
                    self.emit(RunEvent::Stage(Stage::Requesting));
                }
                self.reissue = Some(Reissue { pending: true, ran: false, ladder_failure: Some(error) });
                return Ok(Recovery::Replay);
            }
            match decision.verdict {
                // A WebSocket send's budget is its own: a spent one surfaces, whatever the loop's ladder would allow.
                Verdict::Retry { .. } if error.ws_phase.is_some() && self.ws_retries >= WS_RETRY_LIMIT => break None,
                Verdict::Retry { delay, reason, .. } => {
                    break Some((decision.next, Some((delay, reason)), None));
                }
                Verdict::Fallback { model } => break Some((decision.next, None, Some(model))),
                Verdict::Exhausted => {
                    spent.push(decision.next);
                    match escalate(class, &decide_on) {
                        Some(next) => class = next,
                        None => break None,
                    }
                }
                Verdict::Surface => break None,
            }
        };
        let Some((next, wait, fallback)) = committed else {
            // Surfacing: text the owner offers no way to withdraw is kept as
            // shown and the cut response resumed through the output-limit
            // ladder, instead of being lost with a failed turn.
            if text_shown
                && is_stream_cut(&error)
                && partial.tool_calls.is_empty()
                && !error.exposure.tool_input_cut
                && !error.exposure.tool_dispatched
                && !self.env.observer.can_retract()
            {
                return Ok(Recovery::Proceed(Box::new(ModelResponse {
                    stop: None,
                    truncated: true,
                    stream_cut: true,
                    tool_calls: Vec::new(),
                    ..partial
                })));
            }
            for state in spent {
                self.retry.store(state);
            }
            // A WebSocket send that ends after a retry surfaces the failure that retry left behind (`firstAttemptError`:
            // `resolveHandshakeFailure` / `resolveStreamFailure`), whether the budget is spent or the attempt is no retry's.
            let surfaced = match self.first_ws_failure.take() {
                Some(first) if error.ws_phase.is_some() && !must_surface_current(&error, replay_safe) => first,
                _ => error,
            };
            return self.surface(surfaced).await;
        };
        if retractable && self.retraction(shown_chars, reasoning_shown) != Retracted::Withdrawn {
            for state in spent {
                self.retry.store(state);
            }
            return self.surface(error).await;
        }
        // The retry about to start leaves its failure behind (`scheduleRetry`): a handshake failure only when none is
        // kept yet (`remember: !state.firstAttemptError`), a stream failure always (`remember: true`).
        match error.ws_phase {
            Some(WsPhase::Stream) => self.first_ws_failure = Some(error.clone()),
            Some(WsPhase::Handshake) if self.first_ws_failure.is_none() => self.first_ws_failure = Some(error.clone()),
            _ => {}
        }
        if error.ws_phase.is_some() {
            self.ws_retries += 1;
        }
        for state in spent {
            self.retry.store(state);
        }
        self.retry.store(next.clone());
        // The loop's connection and recovery replays call `sendWithRecovery` again, and each call
        // runs the provider's whole `withRetry` (`send-with-recovery.mjs:229`; recorded: every lap
        // of `refused`, `dns` and `cut` repeats the provider ladder). The request and stream
        // rows are the provider's own ladder, so only these replays refill them.
        if matches!(next.class(), RetryClass::Connection | RetryClass::Recovery) {
            self.retry.restart_provider_rows(next.model());
            // The provider's whole send runs again, its re-issue included.
            self.reissue = None;
        }
        if let Some(model) = fallback {
            self.model = model.clone();
            self.retry = RetryStates::new(&model);
            self.first_ws_failure = None;
            self.ws_retries = 0;
            self.emit(RunEvent::Stage(Stage::ModelFallback { model }));
        }
        if let Some((delay, reason)) = wait {
            let max = policy
                .row(next.class())
                .map_or(0, |row| row.schedule.max_retries);
            // Node's attempt is the one about to run, of the row's attempts.
            let payload = mixdog_ai::retry::stage::reconnecting(
                &decide_on,
                next.count(None).retries + 1,
                max.saturating_add(1),
                delay,
                u64::try_from(self.env.clock.now_ms()).unwrap_or(0),
            );
            self.emit(RunEvent::Stage(Stage::Reconnecting {
                attempt: next.count(None).retries,
                max,
                delay,
                reason,
                payload: Some(payload),
            }));
            or_cancelled(&self.cancel, self.env.waiter.wait(delay))
                .await
                .ok_or(AgentError::Aborted)?;
        }
        if split_notice {
            // A repeated cut keeps the single notice already at the tail.
            let tail_is_notice = self
                .messages
                .last()
                .is_some_and(|m| m.source == Some(Source::StreamCutRecovery));
            if !tail_is_notice {
                self.push(AgentMessage::sourced(
                    Source::StreamCutRecovery,
                    TOOL_INPUT_CUT_NOTICE,
                ))
                .await?;
            }
        }
        Ok(Recovery::Replay)
    }

    /// Whether the provider re-issues this send now that its ladder ended on `error` (`canFallbackNonStreaming`): once
    /// per run of the ladder, with nothing shown and no tool call started. A ladder that goes by the connection
    /// re-issues only a stream that opened.
    fn reissues_spent(&self, error: &ProviderError, partial: &ModelResponse, midstream: bool, replay_safe: bool) -> bool {
        self.reissue.is_none()
            && replay_safe
            && !error.exposure.tool_input_cut
            && self.eager.is_empty()
            && partial.tool_calls.is_empty()
            && (midstream || !self.provider.send_stages(&self.model).ladder_by_connection)
            && self.provider.recovers_spent(&self.model, error)
    }

    /// The provider's answer to a stream that died mid-response (`decideStreamError`,
    /// anthropic-midstream-recovery.mjs): the request is repeated without streaming, after the owner withdrew whatever
    /// text or thinking the dead stream had shown (`recoverNonStreaming`: no acknowledgement, no re-issue). Never past
    /// a tool call. `true` when the next attempt is the re-issue.
    fn reissue_cut_stream(&mut self, error: &ProviderError, partial: &ModelResponse, shown_chars: usize, reasoning_shown: bool) -> bool {
        let tool_work = error.exposure.tool_dispatched || error.exposure.tool_input_cut || !self.eager.is_empty() || !partial.tool_calls.is_empty();
        if self.reissue.is_some() || tool_work {
            return false;
        }
        let exposed = error.exposure.text_emitted || shown_chars > 0 || reasoning_shown;
        let mut seen = error.clone();
        seen.exposure.text_emitted = exposed;
        if !self.provider.recovers_cut(&self.model, &seen) {
            return false;
        }
        if exposed {
            let withdrawn = self.env.observer.can_retract()
                && self.env.observer.retract_text(TextRetraction { chars: shown_chars, reasoning: reasoning_shown, reason: RetractReason::StreamingFallback })
                    == Retracted::Withdrawn;
            if !withdrawn {
                return false;
            }
        }
        self.reissue = Some(Reissue { pending: true, ran: false, ladder_failure: None });
        true
    }

    /// `isReplayableContentFilter` (`send-with-recovery.mjs:352`): a `content_filter` refusal on a provider that opted in
    /// (`retryPolicy.contentFilterRetryable`).
    fn content_filter_replayable(&self, error: &ProviderError) -> bool {
        self.provider.retry_policy_for(&self.model).content_filter_retryable
            && error.code.as_deref().is_some_and(|code| code.trim().eq_ignore_ascii_case("content_filter"))
    }

    /// The content-filter replay (`send-with-recovery.mjs:464-475`): under the transport row's budget and wait, and
    /// only when nothing reached the user or what did was withdrawn, the send is replayed with a guidance notice for
    /// the model (`contentFilterNotice`); otherwise the refusal surfaces.
    async fn replay_after_content_filter(
        &mut self,
        error: ProviderError,
        partial: &ModelResponse,
        replay_safe: bool,
        shown_chars: usize,
        reasoning_shown: bool,
    ) -> Result<Recovery, AgentError> {
        let provider = Arc::clone(&self.provider);
        let policy = request_policy(provider.as_ref(), &self.model, self.config.retry_529);
        // The refusal itself is deterministic to the decider; the transport row is asked for its next step as for any
        // failure it covers (`transportRetryWaitMs`: the server's advice, else the ladder's jittered step).
        let mut covered = ProviderError::new(ErrorKind::Transient, error.delivery);
        covered.retry_after = error.retry_after;
        let decision = self.env.decider.verdict(
            &covered,
            self.retry.get(RetryClass::Transport),
            &policy,
            JitterSamples { step: self.env.jitter.draw(), advice: self.env.jitter.draw() },
        );
        let Verdict::Retry { delay, .. } = decision.verdict else {
            return self.surface(error).await;
        };
        if !replay_safe {
            // `retractExposedTextForReplay`: never past a tool call, and only with the owner's acknowledgement.
            let tool_work = error.exposure.tool_dispatched || !self.eager.is_empty() || !partial.tool_calls.is_empty();
            let exposed = shown_chars > 0 || reasoning_shown;
            if tool_work || !exposed || self.retraction(shown_chars, reasoning_shown) != Retracted::Withdrawn {
                return self.surface(error).await;
            }
        }
        let next = decision.next;
        let attempt = next.count(None).retries;
        self.retry.store(next);
        let max = policy.row(RetryClass::Transport).map_or(0, |row| row.schedule.max_retries);
        // `emitLoopReconnectProgress`: the replay about to run, of the transport budget.
        let payload = mixdog_ai::retry::stage::reconnecting(&error, attempt, max, delay, u64::try_from(self.env.clock.now_ms()).unwrap_or(0));
        self.emit(RunEvent::Stage(Stage::Reconnecting {
            attempt,
            max,
            delay,
            reason: mixdog_core_api::domain::retry::RetryReason::Other,
            payload: Some(payload),
        }));
        or_cancelled(&self.cancel, self.env.waiter.wait(delay)).await.ok_or(AgentError::Aborted)?;
        // `appendRecoveryNotice`: a repeated refusal keeps the single notice already at the tail.
        let tail_is_notice = self.messages.last().is_some_and(|m| m.source == Some(Source::ContentFilterRecovery));
        if !tail_is_notice {
            self.push(AgentMessage::sourced(Source::ContentFilterRecovery, CONTENT_FILTER_NOTICE)).await?;
        }
        Ok(Recovery::Replay)
    }

    /// The typed rejections a changed request can clear, each tried once.
    fn request_changing_recovery(
        &mut self,
        error: &ProviderError,
        partial: &ModelResponse,
        replay_safe: bool,
    ) -> Option<Recovery> {
        match error.kind {
            // The provider named a tool whose schema it rejects: the run drops
            // it (with a notice) and the turn is rebuilt without it, once.
            // Nothing was generated, and the same body would fail again.
            ErrorKind::ToolSchemaRejected
                if !self.tool_schema_drop_used && self.drop_rejected_tool(error) =>
            {
                self.tool_schema_drop_used = true;
                Some(Recovery::Rebuilt)
            }
            // The latest assistant turn carries reasoning replay the API will
            // not take back: drop it from that turn, in place, once.
            ErrorKind::ReplayRejected
                if !self.replay_repair_used && self.repair_thinking_replay() =>
            {
                self.replay_repair_used = true;
                Some(Recovery::Rebuilt)
            }
            // An image the provider refuses: replay once without the latest
            // turn's images, only when no tool ran and nothing was shown.
            _ if !self.image_strip_used
                && replay_safe
                && partial.tool_calls.is_empty()
                && crate::recovery::is_image_processing_error(error) =>
            {
                self.image_strip = Some(crate::recovery::latest_turn_strip(&self.messages, error)?);
                self.image_strip_used = true;
                self.emit(RunEvent::Stage(Stage::Reconnecting {
                    attempt: 1,
                    max: 3,
                    delay: std::time::Duration::ZERO,
                    reason: mixdog_core_api::domain::retry::RetryReason::Other,
                    payload: None,
                }));
                Some(Recovery::Rebuilt)
            }
            _ => None,
        }
    }
    fn retraction(&self, chars: usize, reasoning: bool) -> Retracted {
        self.env.observer.retract_text(TextRetraction {
            chars,
            reasoning,
            reason: RetractReason::TransportRetraction,
        })
    }

    /// The session's fallback chain takes the next model for a failure no
    /// retry covers. `true` when the route changed.
    async fn try_route(&mut self, error: &ProviderError) -> Result<Route, AgentError> {
        let Some(route) = self.env.route.clone() else {
            return Ok(Route::Stay);
        };
        let running = self.last_usage.clone();
        let decision = or_cancelled(&self.cancel, route.advance(error.clone(), running.as_ref()))
            .await
            .ok_or(AgentError::Aborted)?;
        let switch = match decision {
            RouteDecision::Switch(switch) => switch,
            // The error as given: after a chain that ran out it names every model tried.
            RouteDecision::Surface(surface) => return Ok(Route::Surface(Box::new(surface.error))),
            RouteDecision::Fail(message) => return Err(AgentError::RouteFailed(message)),
        };
        // The new provider takes no other provider's replay state.
        self.strip_replay_for_new_route();
        self.provider = switch.provider;
        // A new route takes a fresh snapshot of the tools (`route-fallback.mjs`).
        self.fixed_surface = None;
        self.config.effort = switch.effort;
        self.config.text_only = switch.text_only;
        self.model = switch.model.clone();
        self.retry = RetryStates::new(&self.model);
        self.first_ws_failure = None;
        self.ws_retries = 0;
        self.context_overflow_retry_used = false;
        self.baseline = None;
        // The new route's requests are measured from scratch (`route-fallback.mjs`).
        self.carry.prefix_guard = None;
        self.cache_break_keys.clear();
        self.emit(RunEvent::Stage(Stage::Notice {
            message: switch.notice,
            tone: Tone::Info,
        }));
        self.emit(RunEvent::Stage(Stage::ModelFallback {
            model: switch.model,
        }));
        Ok(Route::Switched)
    }

    /// A failure no retry covers ends the ask unless the route changes.
    async fn surface(&mut self, error: ProviderError) -> Result<Recovery, AgentError> {
        match self.try_route(&error).await? {
            Route::Switched => Ok(Recovery::RetryRound),
            Route::Surface(error) => Err(AgentError::Provider(error)),
            Route::Stay => Err(AgentError::Provider(Box::new(error))),
        }
    }

    /// A context-window refusal is deterministic. Compacting and re-sending
    /// once is allowed when nothing reached the user; a second overflow, or
    /// one after output was shown, surfaces.
    async fn on_context_overflow(
        &mut self,
        error: ProviderError,
        replay_safe: bool,
    ) -> Result<Recovery, AgentError> {
        let policy = self
            .config
            .compact
            .as_ref()
            .and_then(CompactPolicy::resolve);
        if !self.context_overflow_retry_used && policy.is_some() && replay_safe {
            self.context_overflow_retry_used = true;
            self.reactive_overflow_retry_pending = true;
            return Ok(Recovery::RetryRound);
        }
        if let Some(compactor) = self.env.compactor.as_ref() {
            compactor.prepare(&self.messages).await;
        }
        let estimate = self
            .env
            .compactor
            .as_ref()
            .map(|c| c.estimate_tokens(&self.messages));
        let overflow = AgentError::ContextOverflow(Box::new(ContextOverflow {
            stage: "send",
            provider: self.provider.id().to_string(),
            model: self.model.clone(),
            context_window: policy.as_ref().and_then(|p| p.context_window),
            // Node passes `sessionRef.contextWindow` (null when the session states none), not the boundary.
            budget_tokens: policy.as_ref().and_then(|p| p.context_window),
            reserve_tokens: policy.as_ref().map(|p| p.reserve_tokens),
            message_tokens_est: estimate,
            cause: Some(error.message.clone()),
        }));
        match self.try_route(&error).await? {
            Route::Switched => Ok(Recovery::RetryRound),
            // A chain that ran out names every model tried: that error replaces the overflow.
            Route::Surface(annotated) if annotated.message != error.message => Err(AgentError::Provider(annotated)),
            Route::Surface(_) | Route::Stay => Err(overflow),
        }
    }
}
