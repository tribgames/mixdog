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
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;

use crate::boundary::CompactPolicy;
use crate::env::RetractReason;
use crate::env::Retracted;
use crate::env::RunEvent;
use crate::env::Stage;
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

enum Recovery {
    Proceed(Box<ModelResponse>),
    /// Run another attempt of the same round.
    Replay,
    RetryRound,
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

/// The row that governs a failure first: an unreachable network has its own
/// long ladder; otherwise the request or the stream row.
fn first_class(error: &ProviderError, midstream: bool) -> RetryClass {
    if is_connect_fault(error) {
        RetryClass::Connection
    } else if midstream {
        RetryClass::Midstream
    } else {
        RetryClass::Request
    }
}

/// Session-level replay once the provider rows are spent: after a transport
/// failure, a connect failure, or while the server stays unavailable.
fn escalate(class: RetryClass, error: &ProviderError) -> Option<RetryClass> {
    if !matches!(class, RetryClass::Request | RetryClass::Midstream) {
        return None;
    }
    if is_connect_fault(error) {
        Some(RetryClass::Connection)
    } else if error.transport.is_some() {
        Some(RetryClass::Transport)
    } else if matches!(error.kind, ErrorKind::Overloaded | ErrorKind::Transient) {
        Some(RetryClass::Recovery)
    } else {
        None
    }
}

impl Run {
    fn build_request(&mut self) -> ModelRequest {
        let mut options = self.config.options.clone();
        options.provider_state = self.provider_state.clone();
        // The output-limit escalation is one-shot: this attempt alone carries it.
        options.max_output_tokens_override = self.max_output_override.take().or(options.max_output_tokens_override);
        let mut messages = if self.unprojected {
            self.messages.iter().map(AgentMessage::wire).collect()
        } else if self.image_strip_active {
            crate::project::project_for_wire(&crate::recovery::without_latest_images(&self.messages))
        } else {
            crate::project::project_for_wire(&self.messages)
        };
        // The tail reminder rides on this request only; the assistant turn it
        // produces keeps its text.
        self.last_reminder = self.env.tail.as_ref().and_then(|t| t.text(&self.model));
        if let Some(text) = &self.last_reminder {
            let mut reminder = mixdog_core_api::domain::provider::Message::new(
                mixdog_core_api::domain::provider::Role::User,
                mixdog_core_api::domain::provider::Content::Text(text.clone()),
            );
            reminder.source = Some(mixdog_core_api::domain::provider::MessageSource::TailReminder);
            messages.push(reminder);
        }
        ModelRequest {
            model: self.model.clone(),
            messages,
            tools: self
                .tools
                .definitions()
                .into_iter()
                .filter(|t| !self.dropped_tools.contains_key(&t.name))
                .collect(),
            options,
        }
    }

    /// Sends the transcript, recovering from failures. The returned response
    /// is whole; a retry never leaks a dead attempt's output.
    pub(crate) async fn send_provider_request(&mut self) -> Result<SendResult, AgentError> {
        loop {
            self.throw_if_aborted()?;
            // Calls a dead attempt started are dropped with it.
            self.drop_eager();
            let request = Arc::new(self.build_request());
            let failure = match self.attempt_once(request).await? {
                Ok(response) => {
                    // A completed send ends the outage the budgets covered.
                    self.retry = RetryStates::new(&self.model);
                    self.image_strip_active = false;
                    self.image_strip_used = false;
                    return Ok(SendResult::Proceed(Box::new(response)));
                }
                Err(failure) => failure,
            };
            // A failed attempt may have changed the session's state (a dropped
            // cache after a 401): it replaces the pending state exactly as a
            // reported one does, before any recovery builds the next request.
            let mut failure = failure;
            if let Some(state) = failure.error.provider_state.take() {
                self.provider_state = Some(*state);
                self.provider_state_changed = true;
            }
            match self.recover(*failure).await? {
                Recovery::Proceed(response) => return Ok(SendResult::Proceed(response)),
                Recovery::Replay => continue,
                Recovery::RetryRound => return Ok(SendResult::RetryRound),
            }
        }
    }

    /// Exactly one attempt: admission, the stream, its fold.
    async fn attempt_once(
        &mut self,
        request: Arc<ModelRequest>,
    ) -> Result<Result<ModelResponse, Box<Failure>>, AgentError> {
        let mut builder = ResponseBuilder::new(&self.model, ToolCallIds::new(&self.messages));
        let fail = |error: ProviderError, builder: ResponseBuilder, midstream, shown, reasoning| {
            Err(Box::new(Failure {
                error,
                partial: builder.finish(),
                midstream,
                shown_chars: shown,
                reasoning_shown: reasoning,
            }))
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
            Some(Err(error)) => return Ok(fail(error, builder, false, 0, false)),
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
                    return Ok(fail(error, builder, true, shown_chars, reasoning_shown));
                }
                Some(Ok(event)) => event,
            };
            match &event {
                StreamEvent::TextDelta(text) => {
                    shown_chars += mixdog_js::utf16_len(&text);
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
                _ => {}
            }
            let tool_done = matches!(event, StreamEvent::ToolCallDone(_));
            builder.push(event);
            if tool_done && let Some(call) = builder.so_far().tool_calls.last().cloned() {
                self.try_eager(&call);
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
        // unrun and the model told to split it.
        let input_cut = error.exposure.tool_input_cut;
        let recoverable = !partial.tool_calls.is_empty()
            && (!input_cut || partial.tool_calls.iter().all(|c| self.eager_dispatched(&c.id)));
        if is_stream_cut(&error) && recoverable {
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

        let mut class = first_class(&decide_on, midstream);
        let mut spent: Vec<RetryState> = Vec::new();
        let provider = Arc::clone(&self.provider);
        let committed = loop {
            let decision = self.env.decider.verdict(
                &decide_on,
                self.retry.get(class),
                provider.retry_policy(),
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
        if let Some(model) = fallback {
            self.model = model.clone();
            self.retry = RetryStates::new(&model);
            self.emit(RunEvent::Stage(Stage::ModelFallback { model }));
        }
        if let Some((delay, reason)) = wait {
            let max = provider
                .retry_policy()
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
                ));
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
                Some(Recovery::Replay)
            }
            // The latest assistant turn carries reasoning replay the API will
            // not take back: drop it from that turn, in place, once.
            ErrorKind::ReplayRejected
                if !self.replay_repair_used && self.repair_thinking_replay() =>
            {
                self.replay_repair_used = true;
                Some(Recovery::Replay)
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
                Some(Recovery::Replay)
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
    async fn try_route(&mut self, error: &ProviderError) -> Result<bool, AgentError> {
        let Some(route) = self.env.route.clone() else {
            return Ok(false);
        };
        let Some(switch) = or_cancelled(&self.cancel, route.advance(error))
            .await
            .ok_or(AgentError::Aborted)?
        else {
            return Ok(false);
        };
        self.provider = switch.provider;
        self.config.effort = switch.effort;
        self.config.text_only = switch.text_only;
        self.model = switch.model.clone();
        self.retry = RetryStates::new(&self.model);
        self.context_overflow_retry_used = false;
        self.baseline = None;
        self.emit(RunEvent::Stage(Stage::Notice {
            message: switch.notice,
        }));
        self.emit(RunEvent::Stage(Stage::ModelFallback {
            model: switch.model,
        }));
        Ok(true)
    }

    /// A failure no retry covers ends the ask unless the route changes.
    async fn surface(&mut self, error: ProviderError) -> Result<Recovery, AgentError> {
        if self.try_route(&error).await? {
            return Ok(Recovery::RetryRound);
        }
        Err(AgentError::Provider(Box::new(error)))
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
        let estimate = self
            .env
            .compactor
            .as_ref()
            .map(|c| c.estimate_tokens(&self.messages));
        let overflow = AgentError::ContextOverflow(Box::new(ContextOverflow {
            stage: "send",
            provider: self.provider.id().to_string(),
            model: self.model.clone(),
            context_window: policy.as_ref().map(|p| p.context_window),
            budget_tokens: policy.as_ref().map(|p| p.context_window),
            reserve_tokens: policy.as_ref().map(|p| p.reserve_tokens),
            message_tokens_est: estimate,
            cause: Some(error.message.clone()),
        }));
        if self.try_route(&error).await? {
            return Ok(Recovery::RetryRound);
        }
        Err(overflow)
    }
}
