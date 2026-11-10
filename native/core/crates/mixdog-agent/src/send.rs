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
        // Only a dropped future gets here (an explicit exit settled the group); settling is
        // async, so it runs on the runtime the run was on.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let (provider, id) = (Arc::clone(&self.provider), std::mem::take(&mut self.id));
            runtime.spawn(async move { provider.settle_send(&id, SendEnd::Cancelled).await });
        }
    }
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
fn request_policy(provider: &dyn ProviderAdapter, retry_529: bool) -> std::borrow::Cow<'_, RetryPolicy> {
    let policy = provider.retry_policy();
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
        options.provider_state = self.provider_state.clone();
        let provider = Arc::clone(&self.provider);
        options.send_group = Some(self.send_group.get_or_insert_with(|| SendGroup::new(provider)).id.clone());
        // The output-limit escalation is one-shot: this attempt alone carries it.
        options.max_output_tokens_override = self.max_output_override.take().or(options.max_output_tokens_override);
        let messages = if self.unprojected {
            self.messages.iter().map(AgentMessage::wire).collect()
        } else if self.image_strip_active {
            crate::project::project_for_wire(&crate::recovery::without_latest_images(&self.messages))
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
        self.emit(RunEvent::SendStarted);
        loop {
            self.throw_if_aborted()?;
            // Calls a dead attempt started are dropped with it.
            self.drop_eager();
            let request = Arc::new(self.build_request());
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
                    self.image_strip_active = false;
                    self.image_strip_used = false;
                    if let Some(group) = self.send_group.take() {
                        group.complete();
                    }
                    return Ok(SendResult::Proceed(Box::new(response)));
                }
                Err(failure) => failure,
            };
            match self.recover(*failure).await? {
                Recovery::Proceed(response) => return Ok(SendResult::Proceed(response)),
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
        // The projection is rebuilt from the transcript for every request.
        let attempt = match &self.config.effort {
            Some(wiring) => {
                let projection = wiring.route.project(&self.messages);
                let adapter = Arc::clone(&wiring.adapter);
                or_cancelled(&self.cancel, async move { adapter.attempt_with(request, projection).await }).await
            }
            None => or_cancelled(&self.cancel, provider.attempt(request)).await,
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
        loop {
            let next = or_cancelled(&self.cancel, stream.next())
                .await
                .ok_or(AgentError::Aborted)?;
            let event = match next {
                None => break,
                Some(Err(error)) => {
                    self.show_notices(&error);
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
                _ => {}
            }
            let tool_done = matches!(event, StreamEvent::ToolCallDone(_));
            builder.push(event);
            if tool_done && let Some(call) = builder.so_far().tool_calls.last().cloned() {
                if !call.id.is_empty() {
                    self.streamed_ids.insert(call.id.clone());
                }
                self.try_eager(&call).await;
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
            error,
            partial,
            midstream,
            shown_chars,
            reasoning_shown,
        } = fail;
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
        if let Some(recovery) = self.request_changing_recovery(&error, &partial, replay_safe) {
            return Ok(recovery);
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
        let policy = request_policy(provider.as_ref(), self.config.retry_529);
        let committed = loop {
            let decision = self.env.decider.verdict(
                &decide_on,
                self.retry.get(class),
                &policy,
                JitterSamples {
                    step: self.env.jitter.draw(),
                    advice: self.env.jitter.draw(),
                },
            );
            match decision.verdict {
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
            return self.surface(error).await;
        };
        if retractable && self.retraction(shown_chars, reasoning_shown) != Retracted::Withdrawn {
            for state in spent {
                self.retry.store(state);
            }
            return self.surface(error).await;
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
        }
        if let Some(model) = fallback {
            self.model = model.clone();
            self.retry = RetryStates::new(&model);
            self.emit(RunEvent::Stage(Stage::ModelFallback { model }));
        }
        if let Some((delay, reason)) = wait {
            let max = policy
                .row(next.class())
                .map_or(0, |row| row.schedule.max_retries);
            self.emit(RunEvent::Stage(Stage::Reconnecting {
                attempt: next.count(None).retries,
                max,
                delay,
                reason,
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
            ErrorKind::ImageRejected
                if !self.image_strip_used
                    && replay_safe
                    && partial.tool_calls.is_empty()
                    && crate::recovery::latest_turn_has_images(&self.messages) =>
            {
                self.image_strip_used = true;
                self.image_strip_active = true;
                self.emit(RunEvent::Stage(Stage::Reconnecting {
                    attempt: 1,
                    max: 3,
                    delay: std::time::Duration::ZERO,
                    reason: mixdog_core_api::domain::retry::RetryReason::Other,
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
        self.context_overflow_retry_used = false;
        self.baseline = None;
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
