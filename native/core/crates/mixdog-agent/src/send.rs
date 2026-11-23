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

use mixdog_core_api::domain::image_overlay::stable_message_id;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
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
use crate::env::Retracted;
use crate::env::RouteDecision;
use crate::env::RouteSwitch;
use crate::env::RunEvent;
use crate::env::Stage;
use crate::env::TextRetraction;
use crate::env::Tone;
use crate::env::or_cancelled;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::repair::ToolCallIds;
use crate::response::ModelResponse;
use crate::response::ResponseBuilder;
use crate::run::AgentError;
use crate::run::ContextOverflow;
use crate::run::RetryStates;
use crate::run::Run;

/// Runtime notice for the model after a stream was cut while a tool call's
/// arguments were still streaming: that call never ran, and the same large
/// arguments would likely be cut again.
const TOOL_INPUT_CUT_NOTICE: &str = "[mixdog-runtime] The previous response was cut off in transit while a tool call's arguments were still streaming, so that call never ran. This was a network interruption, not a tool failure; tools remain available. Do not resend the same large arguments in one call: split the content across several smaller tool calls (for example, write the first part, then append or patch the rest), keeping each call well under about 8K tokens of arguments.";

/// The guidance a content-filter replay carries. The `[mixdog-runtime]` prefix keeps it out of the visible transcript.
const CONTENT_FILTER_NOTICE: &str = "[mixdog-runtime] The previous response was stopped by the provider content filter before it completed. Continue the task, but rephrase or avoid the content that likely triggered the filter; do not repeat it verbatim.";

/// The provider's own re-issue of a send (`ProviderAdapter::recover_spent`: the non-streaming request of the
/// Anthropic, Chat Completions and Gemini sends), which a send gets once per run of the provider's ladder.
pub(crate) struct Reissue {
    /// The next attempt is the re-issue.
    pending: bool,
    /// The attempt that just ran was the re-issue.
    ran: bool,
    /// The failure the provider's ladder ended on, which surfaces unless the re-issue reports a terminal refusal.
    /// `None` for the re-issue of a cut stream, whose own failure always surfaces.
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

fn fail(error: ProviderError, builder: ResponseBuilder, midstream: bool, shown_chars: usize, reasoning_shown: bool) -> Result<ModelResponse, Box<Failure>> {
    let mut partial = builder.finish();
    if partial.replay.is_empty()
        && let Some(replay) = &error.partial_replay
    {
        partial.replay.push((**replay).clone());
    }
    if partial.thinking_blocks.is_none() && !error.partial_thinking_blocks.is_empty() {
        partial.thinking_blocks = Some(serde_json::Value::Array(error.partial_thinking_blocks.clone()));
    }
    Err(Box::new(Failure { error, partial, midstream, shown_chars, reasoning_shown }))
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
    /// Another attempt of the same logical send on the provider's own ladder, in the same round.
    Replay,
    /// Another attempt of the same logical send as the loop's own replay (the connection and recovery rows, withdrawn
    /// output, a cut tool call's arguments, the content-filter replay), in a new round.
    LoopReplay,
    /// The request itself changed (a dropped tool, repaired replay): the old send ended in its failure and the replay is
    /// a new logical send in a new round.
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

/// A provider whose run stays open across a tool batch, owned by the stream that handed the batch over (Cursor's agent
/// run): the turn keeps that stream until its next exchange, so the run outlives the tools and ends with the turn.
pub(crate) fn keeps_its_run(provider: &str) -> bool {
    provider.starts_with("cursor-")
}

/// An idle-window expiry of a stream that had started (`stallObserved`).
fn is_stall(error: &ProviderError) -> bool {
    error.timeout_phase == Some(mixdog_core_api::domain::provider::StreamTimeoutPhase::Idle) || error.code.as_deref() == Some("ESTREAMSTALL")
}

/// The facts that end a stream after it started: a transport that gave out, or a stall.
fn is_stream_cut(error: &ProviderError) -> bool {
    is_stall(error)
        || matches!(
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
                    | TransportFault::CorruptBody
            )
        )
}

/// `isServerUnavailable`: an overload, or a transient failure that is a timeout or a 408/5xx the server answered. A
/// stall is not one, and neither is a 409/425.
fn server_unavailable(error: &ProviderError) -> bool {
    match error.kind {
        ErrorKind::Overloaded => true,
        ErrorKind::Transient if is_stall(error) => false,
        ErrorKind::Transient => match error.status {
            Some(status) => status == 408 || ((500..600).contains(&status) && status != 525 && status != 526),
            None => true,
        },
        _ => false,
    }
}

fn is_connect_fault(error: &ProviderError) -> bool {
    matches!(error.transport, Some(TransportFault::Connect { .. } | TransportFault::Dns))
}

/// The row that governs a failure first: the request or the stream row, a connect
/// failure included (the provider's own `withRetry` covers it before the loop's
/// outage ladder does, `golden/connect_errors.json`).
fn first_class(midstream: bool) -> RetryClass {
    if midstream { RetryClass::Midstream } else { RetryClass::Request }
}

/// Session-level replay once the provider rows are spent: after a connect failure,
/// or while the server stays unavailable. A transport fault is otherwise final, before the first byte or after the
/// headers alike (`golden/connect_errors.json`: `reset`, `cutRole`, `cutText`), except a provider whose stream ladder
/// leaves a spent cut unmarked ([`RetryPolicy::stream_cut_loop_replay`]), which hands it to the loop's transport row.
fn escalate(class: RetryClass, error: &ProviderError, policy: &RetryPolicy) -> Option<RetryClass> {
    if !matches!(class, RetryClass::Request | RetryClass::Midstream) {
        return None;
    }
    if is_connect_fault(error) {
        Some(RetryClass::Connection)
    } else if error.transport.is_some() {
        let replayed =
            policy.stream_cut_loop_replay && class == RetryClass::Midstream && !error.recovery_exhausted && !error.recovery_terminal && is_stream_cut(error);
        replayed.then_some(RetryClass::Transport)
    } else if server_unavailable(error) {
        Some(RetryClass::Recovery)
    } else {
        None
    }
}

/// Whether this failure is the overload the policy ends the send on (`stopAfterRepeated529`: consecutive overloads
/// reached `overloadFallbackAfter` with no fallback model).
fn repeated_overload_stop(policy: &RetryPolicy, state: &RetryState, error: &ProviderError) -> bool {
    policy.overload.stop_after_repeated
        && policy.overload.fallback_model.is_none()
        && (error.kind == ErrorKind::Overloaded || error.status == Some(529))
        && policy.overload.fallback_after.is_some_and(|after| state.consecutive_overloads() + 1 >= after)
}

/// The provider's retry policy for one request: `retry_529: false` stops an overload retrying, ahead of the overload fallback.
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
        mixdog_core_api::domain::provider::Content::Text(text.to_owned().into()),
    );
    reminder.source = Some(mixdog_core_api::domain::provider::MessageSource::TailReminder);
    reminder
}

/// The messages of a sent request before its tail reminder (the last message when `wire_request` put one): the messages
/// [`without_tail_reminder`] keeps, without a copy.
pub fn kept_messages(request: &ModelRequest) -> &[mixdog_core_api::domain::provider::Message] {
    match request.messages.last() {
        Some(last) if last.source == Some(mixdog_core_api::domain::provider::MessageSource::TailReminder) => &request.messages[..request.messages.len() - 1],
        _ => &request.messages,
    }
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
        // A failed reduction's leave is the request it was decided for: this one, and no later one.
        options.tail_unreduced = self.config.options.tail_unreduced.take();
        let messages = if self.unprojected { self.messages.iter().map(AgentMessage::wire).collect() } else { crate::project::project_for_wire(&self.messages) };
        let messages = self.with_image_choices(messages);
        // The tail reminder rides on this request only; the assistant turn it
        // produces keeps its text.
        let (request, reminder) = assemble_request(&self.model, options, messages, self.env.tail.as_deref(), self.request_tools());
        self.last_reminder = reminder;
        request
    }

    /// `messages` as the session's image choices project them: an image the person chose to continue without is left out, a
    /// replaced one is the file chosen, and a new context starts where it was started. The transcript (`self.messages`) is not
    /// touched, so the choice survives restart, forks and every later turn, and can be undone. A history the choices cannot
    /// project into a request the wire can represent, or choices that cannot be read, leave the projection undone and the send
    /// is refused before anything goes out ([`Self::image_choices_refusal`]).
    fn with_image_choices(&mut self, messages: Vec<Message>) -> Vec<Message> {
        self.image_choices_refusal = None;
        let Some(load) = self.config.image_overlay.clone() else { return messages };
        // Every message is sent under the id its image choices are kept by ([`stable_message_id`]), so a refusal names an image
        // by the same id a later choice is saved under.
        let mut messages = messages;
        for (index, message) in messages.iter_mut().enumerate() {
            message.message_id.get_or_insert_with(|| stable_message_id(None, index));
        }
        let overlay = match load() {
            Ok(overlay) => overlay,
            Err(_) => {
                self.image_choices_refusal = Some(
                    "Nothing was sent. The image choices saved for this conversation could not be read. Start again from your last message, leaving out the earlier conversation, to make them again."
                        .to_owned(),
                );
                return messages;
            }
        };
        if overlay.is_empty() {
            return messages;
        }
        let mut ids: Vec<String> = messages.iter().map(|m| m.message_id.clone().expect("stamped above")).collect();
        let mut projected = messages.clone();
        match overlay.apply(&mut ids, &mut projected) {
            Ok(()) => projected,
            Err(_) => {
                self.image_choices_refusal = Some(
                    "Nothing was sent. Leaving out the images you chose would leave an instruction message with nothing in it. Put one of them back and try again."
                        .to_owned(),
                );
                messages
            }
        }
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

    /// `session=… turn=… send=… attempt=…`: whose line of the turn's trace this is.
    pub(crate) fn trace_identity(&self) -> String {
        format!("session={} turn={} send={} attempt={}", self.config.thread_id.as_str(), self.config.turn_id.as_str(), self.sends, self.exchanges)
    }

    /// One line of the turn's trace in the daemon log, so one turn's wait can be followed through its sends and attempts.
    pub(crate) fn trace(&self, phase: &str, detail: std::fmt::Arguments<'_>) {
        mixdog_rt::turn_trace!("[turn] {} phase={phase} {detail}", self.trace_identity());
    }

    /// A failed exchange already left its executor lease suspended. Do not reacquire it for the sleep.
    async fn retry_wait(&self, delay: std::time::Duration) -> Result<(), AgentError> {
        or_cancelled(&self.cancel, self.env.waiter.wait(delay)).await.ok_or(AgentError::Aborted)
    }

    /// A retry of this send was scheduled on the ladder `state` now stands at. Every ladder's retries count against one outage
    /// clock, started by the send's first scheduled retry and ended with the send; the status payload says when the retry runs
    /// (`retryAt`), since when the send has been failing, and whether the failure came after output the user saw (a replay
    /// that withdrew it) or before any; the turn's trace gets the same.
    fn scheduled(&mut self, payload: &mut serde_json::Value, state: &RetryState, delay: std::time::Duration, reason: &str, replay_safe: bool) {
        let now = self.env.clock.now_ms();
        let since = *self.outage_since_ms.get_or_insert(now);
        if let Some(object) = payload.as_object_mut() {
            object.insert("outageStartedAt".into(), serde_json::json!(since));
            object.insert("afterOutput".into(), serde_json::json!(!replay_safe));
        }
        let delay_ms = i64::try_from(delay.as_millis()).unwrap_or(i64::MAX);
        self.trace(
            "retry-scheduled",
            format_args!(
                "ladder={:?} retries={} delay_ms={delay_ms} retry_at={} reason={reason} after_output={} outage_ms={}",
                state.class(),
                state.count(None).retries,
                now.saturating_add(delay_ms),
                !replay_safe,
                now - since
            ),
        );
    }

    async fn send_attempts(&mut self) -> Result<SendResult, AgentError> {
        self.sends += 1;
        self.exchanges = 0;
        self.outage_since_ms = None;
        self.request_started_ms = self.env.clock.now_ms();
        self.send_started_ms = self.request_started_ms;
        self.send_identity = Default::default();
        self.reissue = None;
        self.emit(RunEvent::ProviderSendStarted);
        // A new logical request: nothing the previous one owned is current.
        self.emit(RunEvent::SubmissionStarted { id: mixdog_core_api::domain::provider::next_submission_id() });
        self.env.observer.local_wait(Some("preparing"));
        // The mark of this send is stored before the request leaves; a cancel ends the wait and the loop below reports it.
        let _ = or_cancelled(&self.cancel, self.env.sink.drafted()).await;
        loop {
            self.throw_if_aborted()?;
            // Calls a dead attempt started are dropped with it.
            self.env.observer.local_wait(Some("preparing"));
            self.drop_eager();
            let request = Arc::new(self.build_request());
            if let Some(message) = self.image_choices_refusal.take() {
                let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
                error.message = message;
                return Err(AgentError::Provider(Box::new(error)));
            }
            self.prepare_prefix_guard(&request)?;
            // A restarted process compares its first request with the last prefix fingerprint the record kept.
            mixdog_ai::providers::anthropic::prefix_trace::seed(self.config.thread_id.as_str(), self.carry.cache.prefix_baseline.as_ref());
            self.last_request = Some(request.clone());
            if self.side_ticket.is_none()
                && let Some(tap) = &self.env.side
            {
                self.side_ticket = Some(tap.begin_shared(&request));
            }
            if let Some(begin) = &self.config.request_begin {
                begin();
            }
            self.exchanges += 1;
            let failure = match mixdog_rt::node_log::provider_work(self.trace_identity(), "preparing", self.attempt_once(request)).await? {
                Ok(response) => {
                    // A completed send ends the outage the budgets covered.
                    self.retry = RetryStates::new(&self.model);
                    self.settle_prefix(&response);
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
            if let Some(refusal) = failure.error.tail_refusal {
                use mixdog_core_api::domain::cache_tail::TailRefusal;
                if let Some(ticket) = self.side_ticket.take() {
                    ticket.discard();
                }
                use mixdog_core_api::domain::cache_tail::Claimed;
                let Some(gate) = self.config.options.tail_gate.clone() else { return Err(AgentError::Provider(Box::new(failure.error))) };
                let wait = match refusal {
                    TailRefusal::Rebuild(cold) => match gate.claim(cold) {
                        Claimed::Owner(lease) => {
                            // A failed reduction hands back the leave of this request, which the next build carries.
                            self.config.options.tail_unreduced = self.cold_pass(lease).await?;
                            None
                        }
                        Claimed::Wait(ticket) => Some(ticket),
                        Claimed::Stale => None,
                    },
                    // Another caller owns the rewrite of this history: its outcome decides this attempt too.
                    TailRefusal::Wait(ticket) => Some(ticket),
                    TailRefusal::Stale => {
                        let Some(history) = self.config.history.clone() else { return Err(AgentError::Provider(Box::new(failure.error))) };
                        let reloaded = crate::env::or_cancelled(&self.cancel, history.reload()).await.ok_or(AgentError::Aborted)?;
                        match reloaded {
                            Ok((conversation, generation)) if Some(generation) != self.config.options.tail_generation => {
                                self.adopt_reloaded(conversation, generation);
                            }
                            _ => return Err(AgentError::Provider(Box::new(failure.error))),
                        }
                        None
                    }
                    // Only optional attempts are skipped; a turn's is never. An owner on another host that could not be
                    // reached judged nothing, and nothing was sent: the failure is the turn's.
                    TailRefusal::Skip(_) | TailRefusal::Unjudged => return Err(AgentError::Provider(Box::new(failure.error))),
                };
                if let Some(ticket) = wait
                    && crate::env::or_cancelled(&self.cancel, gate.0.wait_for(ticket)).await.is_none()
                {
                    return Err(AgentError::Aborted);
                }
                self.readmitting = true;
                continue;
            }
            match mixdog_rt::node_log::provider_work(self.trace_identity(), "recovering", self.recover(*failure)).await? {
                Recovery::Proceed(response) => {
                    // The send returned its (recovered) turn to the loop: the budgets and the overload count belong to
                    // this logical send and end with it, as with a completed one.
                    self.retry = RetryStates::new(&self.model);
                    self.settle_prefix(&response);
                    return Ok(SendResult::Proceed(response));
                }
                Recovery::Replay => continue,
                Recovery::LoopReplay => {
                    self.begin_replay_round();
                    continue;
                }
                Recovery::Rebuilt => {
                    if let Some(group) = self.send_group.take() {
                        group.settle(SendEnd::Surfaced).await;
                    }
                    self.begin_replay_round();
                    continue;
                }
                Recovery::RetryRound => return Ok(SendResult::RetryRound),
            }
        }
    }

    /// A replay run as a new round restarts the `loop` row's marks after the failed round's wait and notice, so the
    /// row of the send that settles times that round alone. `request_started_ms`, which the usage and cache figures read,
    /// is left as it is.
    fn begin_replay_round(&mut self) {
        let now = self.env.clock.now_ms();
        self.iteration_started_ms = now;
        self.send_started_ms = now;
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
        self.trace_actual_cache_miss(response, previous_guard.as_ref());
        self.cache_break_intent = None;
    }

    fn trace_actual_cache_miss(&mut self, response: &ModelResponse, previous_guard: Option<&crate::prefix_guard::Snapshot>) {
        use crate::cache_observation::{self, Request};
        use mixdog_core_api::domain::cache_tail::Counters;

        let provider = self.provider.id().as_str().to_owned();
        let cache = &mut self.carry.cache;
        if !cache_observation::is_anthropic(&provider) {
            cache.changed |= cache.observation.take().is_some();
            return;
        }
        let usage = &response.usage;
        let counters = Counters::of_usage(usage);
        let sent_on = self.send_identity.account();
        let account = response
            .account_routing
            .as_ref()
            .filter(|routing| routing.provider == provider)
            .map(|routing| routing.account_id.as_str())
            .or_else(|| sent_on.as_ref().map(|sent| sent.account.as_str()));
        let pinned_wire = self.last_request.as_ref().and_then(|request| request.options.wire_pin.as_ref()).map(|pin| pin.wire.as_str());
        let wire = match self.send_identity.wire() {
            Some(wire) => wire,
            None => pinned_wire.unwrap_or("messages"),
        };
        let thread = self.config.thread_id.as_str();
        let fingerprint = mixdog_ai::providers::anthropic::prefix_trace::latest_persistable(thread);
        let dispatch = self.cache_dispatches.latest();
        let request = Request {
            dispatched_at: dispatch.as_ref().map_or(self.cache_attempt_started_ms, |dispatch| dispatch.at),
            ttl_ms: dispatch.as_ref().map(|dispatch| dispatch.ttl_ms).or(cache.messages_ttl_ms),
            wire,
            serving_model: if response.model.is_empty() { &self.model } else { &response.model },
            account,
            admitted_route: dispatch.as_ref().map(|dispatch| dispatch.route.as_str()),
            changed_intentionally: self.cache_break_intent.is_some(),
            prefix: self.carry.prefix_guard.as_ref(),
            wire_prefix: fingerprint.as_ref(),
        };
        let had_observation = cache.observation.is_some();
        let miss = cache_observation::settle(&mut cache.observation, request, counters);
        cache.changed |= had_observation && cache.observation.is_none();
        if let Some(miss) = miss
            && let Some(log) = &self.env.failures
        {
            let mut record = serde_json::Map::new();
            record.insert("sessionId".into(), serde_json::json!(thread));
            record.insert("iteration".into(), serde_json::json!(self.iterations + 1));
            record.insert("classification".into(), serde_json::json!("unexpected"));
            record.insert("reason".into(), serde_json::json!("actual_cache_miss"));
            record.insert("source".into(), serde_json::json!("provider_usage"));
            record.insert("provider".into(), serde_json::json!(provider));
            record.insert("model".into(), serde_json::json!(self.model));
            record.insert("actualCacheMiss".into(), serde_json::json!(true));
            record.insert("cachedTokens".into(), serde_json::json!(miss.read));
            if cache_observation::has_prompt(usage)
                && let Some(written) = counters.created
            {
                record.insert("promptTokens".into(), serde_json::json!(usage.input_tokens.saturating_add(miss.read).saturating_add(written)));
            }
            record.insert("previousCachedPrefixTokens".into(), serde_json::json!(miss.previous_prefix));
            record.insert("idleMs".into(), serde_json::json!(miss.idle_ms));
            record.insert("missingPrefixGuardBaseline".into(), serde_json::json!(previous_guard.is_none()));
            // These wire details compare adjacent requests, not necessarily the last measured observation.
            if let Some(changes) = mixdog_ai::providers::anthropic::prefix_trace::changes(thread) {
                record.extend(changes);
            }
            log.cache_break(record);
        }
        if let (Some(read), Some(written)) = (counters.read, counters.created) {
            cache.cached_prefix_tokens = Some(read.saturating_add(written) as f64);
            cache.changed = true;
            if let Some(fingerprint) = fingerprint {
                cache.prefix_baseline = Some(fingerprint);
            }
        }
    }

    /// Exactly one attempt: admission, the stream, its fold.
    /// The provider request is I/O: an agent job's slot goes back to the pool for its length.
    async fn attempt_once(&mut self, request: Arc<ModelRequest>) -> Result<Result<ModelResponse, Box<Failure>>, AgentError> {
        let epoch = self.call_epoch();
        let builder = ResponseBuilder::new(&self.model, ToolCallIds::new(&self.messages).in_session(epoch));
        let request = match self.prepare_request(request).await? {
            Ok(request) => request,
            Err(error) => return Ok(fail(*error, builder, false, 0, false)),
        };
        let Some(slot) = self.config.slot.clone() else { return self.exchange(request, builder).await };
        let mut settled = None;
        let turn = self.config.signal.clone().unwrap_or_else(|| crate::cancel::Cancel::from_token(&self.cancel));
        let observer = self.env.observer.clone();
        let queued = std::sync::atomic::AtomicBool::new(false);
        let label = self.trace_identity();
        let waiting = || {
            queued.store(true, std::sync::atomic::Ordering::Relaxed);
            observer.local_wait(Some("resource_wait"));
            mixdog_rt::turn_trace!("[turn] {label} phase=executor-capacity-queued");
        };
        let yielded = slot
            .run_yielded_reporting(
                Box::pin(async {
                    let result = self.exchange(request, builder).await;
                    let ok = matches!(result, Ok(Ok(_)));
                    settled = Some(result);
                    ok
                }),
                Some(&turn),
                &waiting,
            )
            .await;
        if queued.into_inner() {
            observer.local_wait(None);
            self.trace(if yielded.is_ok() { "executor-capacity-granted" } else { "executor-capacity-cancelled" }, format_args!(""));
        }
        match yielded {
            Ok(()) => settled.expect("the request ran"),
            Err(reason) => Err(AgentError::Admission(reason)),
        }
    }

    /// The request as every attempt sends it: stored text attachments become their text (the saved messages keep the
    /// reference), and a text-only route degrades and checks it.
    async fn prepare_request(&mut self, request: Arc<ModelRequest>) -> Result<Result<Arc<ModelRequest>, Box<ProviderError>>, AgentError> {
        let request = match self.config.attachments.clone() {
            Some(resolver) => {
                let mut built = (*request).clone();
                let messages = std::mem::take(&mut built.messages);
                let resolved =
                    or_cancelled(&self.cancel, crate::attachments::resolve_text_attachments(messages, resolver.as_ref())).await.ok_or(AgentError::Aborted)?;
                let resolved = match resolved {
                    // A text-only route reads and lowers its stored files itself.
                    Ok(messages) if self.config.text_only.is_none() => {
                        // The engine this request goes to says what it takes as a document (a gateway's Messages
                        // engine differs from its Chat wire).
                        let support = self.provider.media_support(&request).await;
                        let resolved =
                            or_cancelled(&self.cancel, crate::attachments::resolve_media_attachments(messages, resolver.as_ref(), support.native_pdf))
                                .await
                                .ok_or(AgentError::Aborted)?;
                        // `preparePdfTextForProvider`, and the text of an Office file, for every provider.
                        match (resolved, self.config.file_text.clone()) {
                            (Ok(messages), Some(media)) => {
                                or_cancelled(&self.cancel, media.prepare_for_route(messages, support)).await.ok_or(AgentError::Aborted)?
                            }
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
                    Err(error) => return Ok(Err(error)),
                }
            }
            None => request,
        };
        let request = match self.config.text_only.clone() {
            Some(text_only) => {
                let built = (*request).clone();
                let prepared = or_cancelled(&self.cancel, crate::text_only::prepare_text_only_request(&text_only, built)).await.ok_or(AgentError::Aborted)?;
                match prepared {
                    Ok(done) => Arc::new(done),
                    Err(error) => return Ok(Err(error)),
                }
            }
            None => request,
        };
        Ok(Ok(request))
    }

    /// The provider request and the fold of its stream.
    async fn exchange(&mut self, request: Arc<ModelRequest>, mut builder: ResponseBuilder) -> Result<Result<ModelResponse, Box<Failure>>, AgentError> {
        let provider = Arc::clone(&self.provider);
        self.trace("request-prepared", format_args!("provider={} model={} messages={}", provider.id().as_str(), self.model, request.messages.len()));
        // The provider's own `requesting` stages (`onStageChange`): those it raises before a send's first attempt and
        // before every attempt, here; those it raises from inside the attempt, once the attempt is over.
        let stages = provider.send_stages_of(&request);
        let first_attempt = self.retry.get(RetryClass::Request).count(None).retries == 0 && self.retry.get(RetryClass::Midstream).count(None).retries == 0;
        if !std::mem::take(&mut self.readmitting) {
            if first_attempt {
                for _ in 0..stages.preparing {
                    self.emit(RunEvent::Stage(Stage::Requesting));
                }
            }
            if stages.each_attempt {
                self.emit(RunEvent::Stage(Stage::Requesting));
            }
        }
        if stages.model_thinking {
            self.emit(RunEvent::Stage(Stage::ModelThinking));
        }
        let reissued = self.reissue.as_mut().is_some_and(|reissue| {
            reissue.ran = std::mem::take(&mut reissue.pending);
            reissue.ran
        });
        let identity = request.options.send_identity.clone();
        self.cache_attempt_started_ms = self.env.clock.now_ms();
        self.cache_dispatches = Default::default();
        let request = if crate::cache_observation::is_anthropic(provider.id().as_str())
            && let Some(gate) = request.options.tail_gate.clone()
        {
            let mut request = Arc::unwrap_or_clone(request);
            request.options.tail_gate = Some(self.cache_dispatches.observe(gate));
            Arc::new(request)
        } else {
            request
        };
        // This exchange is a submission of its own, for a provider outside the driver as for one inside it: the run's record of
        // an earlier submission's attempt stops being current before any provider work begins.
        self.emit(RunEvent::SubmissionStarted { id: identity.begin_submission() });
        let deliver = |stage: &'static str, payload: Option<serde_json::Value>| self.deliver_raised(stage, payload);
        let send = async {
            let wiring = self.config.effort.as_ref();
            let projection = wiring.and_then(|wiring| wiring.route.project(&self.messages));
            let effort = if wiring.is_some() {
                projection.as_ref().map(|p| p.updates.last_key_value().map_or(p.initial_effort.as_str(), |(_, e)| e.as_str()))
            } else {
                request.options.effort_projection.as_ref().map(|p| p.updates.last_key_value().map_or(p.initial_effort.as_str(), |(_, e)| e.as_str()))
            };
            self.env.observer.request_started(provider.id().as_str(), &request, effort.or(request.options.effort.as_deref()));
            match wiring {
                // The provider's re-issue carries the same projection as a normal attempt.
                _ if reissued => {
                    let mut request = Arc::unwrap_or_clone(request);
                    if wiring.is_some() {
                        request.options.effort_projection = projection.map(Into::into);
                    }
                    provider.recover_spent(Arc::new(request)).await
                }
                Some(wiring) => wiring.adapter.attempt_with(request, projection).await,
                None => provider.attempt(request).await,
            }
        };
        let attempt = identity.deliver_stages(or_cancelled(&self.cancel, send), deliver).await;
        // The attempt continued the waiting run or left it: the turn holds it no longer.
        *self.open_run.get_mut().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        let mut stream = match attempt {
            None => return Err(AgentError::Aborted),
            Some(Err(error)) => {
                identity.observe(mixdog_core_api::domain::provider::Boundary::AttemptFailed);
                identity.deliver_pending(|stage, payload| self.deliver_raised(stage, payload));
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
            // The stages an open stream raises (a WebSocket resume's retry) are delivered with each poll that raised them,
            // as an attempt's are.
            let ready = std::future::poll_fn(|cx| {
                let polled = std::future::Future::poll(pending.as_mut(), cx);
                identity.deliver_pending(|stage, payload| self.deliver_raised(stage, payload));
                std::task::Poll::Ready(polled)
            })
            .await;
            let next = match ready {
                std::task::Poll::Ready(next) => next,
                std::task::Poll::Pending => {
                    // Every byte received is handled and the response is still open.
                    if !builder.completed() && !wire_left.load(std::sync::atomic::Ordering::Acquire) {
                        self.settle_gate.send_replace(true);
                    }
                    let next = identity
                        .deliver_stages(or_cancelled(&self.cancel, pending), |stage, payload| self.deliver_raised(stage, payload))
                        .await
                        .ok_or(AgentError::Aborted)?;
                    self.settle_gate.send_replace(false);
                    next
                }
            };
            let event = match next {
                None => break,
                Some(Err(error)) => {
                    identity.observe(mixdog_core_api::domain::provider::Boundary::AttemptFailed);
                    identity.deliver_pending(|stage, payload| self.deliver_raised(stage, payload));
                    self.show_notices(&error);
                    // The stream is issued anew by the retry: the provider's once-per-ladder `requesting` is raised again.
                    identity.reissue();
                    return Ok(fail(error, builder, true, shown_chars, reasoning_shown));
                }
                Some(Ok(event)) => event,
            };
            // The boundaries the stream's events are: a whole protocol payload, and the first output among them. An adapter that
            // publishes its own has already moved the attempt; the same boundary is then a no-op.
            if is_protocol_payload(&event) {
                identity.observe(mixdog_core_api::domain::provider::Boundary::FirstProtocolPayload);
            }
            if is_semantic_output(&event) {
                identity.observe(mixdog_core_api::domain::provider::Boundary::FirstSemanticOutput);
            }
            identity.deliver_pending(|stage, payload| self.deliver_raised(stage, payload));
            if let StreamEvent::ChunkProgress(kind) = &event {
                self.emit(RunEvent::Chunk(*kind));
            }
            if let StreamEvent::Progress(kind) = &event {
                self.emit(RunEvent::ToolStream(*kind));
            }
            if let StreamEvent::ItemStart { kind, .. } = &event {
                self.emit(RunEvent::ItemStart(*kind));
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
                // Shown like text, so it cannot be withdrawn either; the turn's content does not hold it.
                StreamEvent::ProgressDelta(text) => {
                    shown_chars += mixdog_js::utf16_len(text);
                    self.emit(RunEvent::ProgressDelta(text.clone()));
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
                    mixdog_core_api::domain::provider::AccountStage::Switching { message } => Stage::AccountSwitching { message: message.clone() },
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
                // Starting the call is this run's own work while the response stays unread: not the provider's silence.
                let _local = identity.local_work();
                self.try_eager(&call, &started_in).await;
            }
        }
        if !builder.completed() {
            // A stream may only end with its terminal event.
            let mut error = ProviderError::transport(TransportFault::TruncatedStream, stream.delivery());
            error.exposure.text_emitted = shown_chars > 0;
            return Ok(fail(error, builder, true, shown_chars, reasoning_shown));
        }
        self.last_streamed_chars = shown_chars;
        if keeps_its_run(provider.id().as_str()) {
            *self.open_run.get_mut().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(stream);
        }
        Ok(Ok(builder.finish()))
    }

    /// What the run shows of a stage the provider raised from inside its attempt or its stream. `requesting` is the request
    /// going out; `transport` the response's bytes arriving (health, never a stage); `notice` a transcript notice; and
    /// `reconnecting` a retry the provider ladders itself (a resumed WebSocket), which no verdict of the loop's decider
    /// shows because the loop never sees that failure.
    fn deliver_raised(&self, stage: &'static str, payload: Option<serde_json::Value>) {
        match (stage, payload) {
            ("preparing", _) => self.env.observer.local_wait(Some("preparing")),
            ("requesting", _) => self.emit(RunEvent::Stage(Stage::Requesting)),
            ("transport", _) => self.emit(RunEvent::Transport),
            ("boundary", Some(payload)) => {
                if let Some((submission, attempt, boundary)) = mixdog_core_api::domain::provider::decode_boundary(&payload) {
                    self.emit(RunEvent::Boundary { submission, attempt, boundary });
                }
            }
            ("notice", Some(payload)) => {
                if let Some(message) = payload.get("message").and_then(serde_json::Value::as_str) {
                    self.show_notice(message, payload.get("tone").and_then(serde_json::Value::as_str) == Some("warn"));
                }
            }
            ("reconnecting", Some(payload)) => {
                let number = |key: &str| payload.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0);
                self.emit(RunEvent::Stage(Stage::Reconnecting {
                    attempt: u32::try_from(number("attempt")).unwrap_or(u32::MAX),
                    max: u32::try_from(number("max")).unwrap_or(u32::MAX),
                    delay: std::time::Duration::from_millis(number("waitMs")),
                    reason: mixdog_core_api::domain::retry::RetryReason::Other,
                    payload: Some(payload),
                }));
            }
            _ => {}
        }
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
        let Failure { mut error, partial, midstream, shown_chars, reasoning_shown } = fail;
        if let Some(fault) = &error.transport {
            mixdog_rt::node_stderr!(
                "[attempt-error] session={} provider={} model={} phase={} code={} delivery={:?} fault={fault:?} connection={}",
                self.config.thread_id.as_str(),
                self.provider.id().as_str(),
                self.model,
                if midstream { "stream" } else { "request" },
                error.code.as_deref().filter(|code| !code.is_empty()).unwrap_or("-"),
                error.delivery,
                error.connection.map_or_else(|| "-".to_owned(), |c| format!("{}/{}", c.protocol, c.id)),
            );
        }
        // A terminal unary refusal is the answer, not another failed way to get the stream's answer. The send group
        // settles the unary error's usage; opening the unary attempt already moved the stream's bill to abandoned usage.
        let mut reissue_failed = false;
        if let Some(reissue) = self.reissue.as_mut()
            && std::mem::take(&mut reissue.ran)
        {
            if reissue.ladder_failure.is_some() && error.recovery_terminal {
                error.recovery_exhausted = true;
                return Err(AgentError::Provider(Box::new(error)));
            }
            if let Some(ladder) = reissue.ladder_failure.clone() {
                error = ladder;
            }
            error.recovery_exhausted = true;
            reissue_failed = true;
        }
        let input_cut = error.exposure.tool_input_cut;
        let recoverable = !partial.tool_calls.is_empty() && (!input_cut || partial.tool_calls.iter().all(|c| self.stream_dispatched(&c.id)));
        if is_stream_cut(&error) && recoverable {
            self.emit(RunEvent::PartialToolRecovery(PartialToolRecovery {
                iteration: self.iterations + 1,
                tool_calls: partial.tool_calls.len(),
                dropped_incomplete_input: input_cut,
                partial_content_len: mixdog_js::utf16_len(&partial.content),
            }));
            let recovery_notice = input_cut.then(|| AgentMessage::sourced(Source::StreamCutRecovery, TOOL_INPUT_CUT_NOTICE));
            return Ok(Recovery::Proceed(Box::new(ModelResponse { stop: Some(StopReason::ToolUse), recovery_notice, ..partial })));
        }
        // First-party Responses marks a failure after visible reasoning
        // terminal even when the UI could retract it. Keep the usage and
        // original error, without another sample on this or another route.
        if error.recovery_terminal && error.unsafe_to_retry && matches!(self.provider.id().as_str(), "openai" | "openai-oauth") {
            return Err(AgentError::Provider(Box::new(error)));
        }
        let replay_safe = !error.exposure.text_emitted && !error.exposure.tool_dispatched && shown_chars == 0 && !reasoning_shown;
        if error.kind == ErrorKind::ContextOverflow {
            return self.on_context_overflow(error, replay_safe).await;
        }
        if self.content_filter_replayable(&error) {
            return self.replay_after_content_filter(error, &partial, replay_safe, shown_chars, reasoning_shown).await;
        }
        if replay_safe && let Some(recovery) = self.request_changing_recovery(&error) {
            return Ok(recovery);
        }
        if midstream && self.reissue_cut_stream(&error, &partial, shown_chars, reasoning_shown) {
            return Ok(Recovery::Replay);
        }
        // A provider's exposure flag also covers reasoning text; what the owner saw as text is `shown_chars`.
        let reasoning_only = shown_chars == 0 && reasoning_shown;
        let text_shown = shown_chars > 0 || (error.exposure.text_emitted && !reasoning_only);
        let exposed = text_shown || reasoning_shown;
        if text_shown
            && is_stream_cut(&error)
            && partial.tool_calls.is_empty()
            && self.eager.is_empty()
            && !error.exposure.tool_input_cut
            && !error.exposure.tool_dispatched
            && !self.env.observer.can_retract()
        {
            return Ok(Recovery::Proceed(Box::new(ModelResponse { stop: None, truncated: true, stream_cut: true, tool_calls: Vec::new(), ..partial })));
        }
        let ws_owner_replay = error.ws_phase == Some(WsPhase::Stream) && !error.recovery_exhausted && (exposed || error.exposure.tool_input_cut);
        // Withdrawing shown text makes a replay safe; it is asked only once a
        // replay is decided. A dispatched tool call can never be replayed.
        let retractable = exposed && !error.exposure.tool_dispatched && self.eager.is_empty() && partial.tool_calls.is_empty();
        let mut decide_on = error.clone();
        // A call already running cannot be replayed.
        decide_on.exposure.tool_dispatched |= !self.eager.is_empty();
        if retractable {
            decide_on.exposure.text_emitted = false;
            // The adapter marks any shown output unsafe; the owner's withdrawal (asked once the replay is decided) is what
            // makes the owner's replay of a socket closed mid-response safe.
            if reasoning_only || ws_owner_replay {
                decide_on.unsafe_to_retry = false;
            }
        }
        let split_notice = decide_on.exposure.tool_input_cut;
        decide_on.exposure.tool_input_cut = false;

        let mut class = if ws_owner_replay || retractable || split_notice { RetryClass::Transport } else { first_class(midstream) };
        let initial_class = class;
        let mut spent: Vec<RetryState> = Vec::new();
        let provider = Arc::clone(&self.provider);
        let policy = request_policy(provider.as_ref(), &self.model, self.config.retry_529);
        // A failure the provider's own recovery ended on has no step left on the provider's rows: the loop's outage
        // and recovery ladders take it, or it surfaces (`providerRecoveryEnded`).
        let mut ended = false;
        if reissue_failed {
            match escalate(class, &decide_on, &policy) {
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
                &self.retry.get(class).at_elapsed(self.send_identity.elapsed()),
                &policy,
                JitterSamples { step: self.env.jitter.draw(), advice: self.env.jitter.draw() },
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
                Verdict::Retry { delay, reason, .. } => {
                    break Some((decision.next, Some((delay, reason)), None));
                }
                Verdict::Fallback { model } => break Some((decision.next, None, Some(model))),
                Verdict::Exhausted => {
                    let stopped = repeated_overload_stop(&policy, self.retry.get(class), &decide_on);
                    spent.push(decision.next);
                    // The repeated-overload stop is the provider's verdict that recovery is over (`isProviderRecoveryTerminal`).
                    if stopped {
                        break None;
                    }
                    match escalate(class, &decide_on, &policy) {
                        Some(next) => class = next,
                        None => break None,
                    }
                }
                Verdict::Surface => break None,
            }
        };
        let Some((next, wait, fallback)) = committed else {
            for state in spent {
                self.retry.store(state);
            }
            return if replay_safe { self.surface(error).await } else { Err(AgentError::Provider(Box::new(error))) };
        };
        // Where the owner has no reset channel, shown reasoning is not withdrawn at all and is replayed; a channel that
        // exists and refuses ends the send.
        let no_channel_reasoning = reasoning_only && !self.env.observer.can_retract();
        if retractable && !no_channel_reasoning && self.retraction(shown_chars, reasoning_shown) != Retracted::Withdrawn {
            for state in spent {
                self.retry.store(state);
            }
            return Err(AgentError::Provider(Box::new(error)));
        }
        for state in spent {
            self.retry.store(state);
        }
        self.retry.store(next.clone());
        // Escalation changes which retry schedule applies. It does not refill the provider schedules.
        let cut_replay = next.class() == RetryClass::Transport && initial_class != RetryClass::Transport;
        let loop_replay = matches!(next.class(), RetryClass::Connection | RetryClass::Recovery) || cut_replay;
        if let Some(model) = fallback {
            self.model = model.clone();
            self.retry = RetryStates::new(&model);
            self.emit(RunEvent::Stage(Stage::ModelFallback { model }));
        }
        if let Some((delay, reason)) = wait {
            let row_max = |class| policy.row(class).map_or(0, |row| row.schedule.max_retries);
            // A failure that goes on to the recovery ladder counts its provider row and the recovery laps as one
            // run (B-11: the user reads one rising n/N); any other wait counts its own row.
            let first = first_class(midstream);
            let (used, max) = match escalate(first, &decide_on, &policy) {
                Some(RetryClass::Recovery) if next.class() != RetryClass::Transport && policy.recovery.is_some() => (
                    self.retry.get(first).count(None).retries + self.retry.get(RetryClass::Recovery).count(None).retries,
                    row_max(first) + row_max(RetryClass::Recovery),
                ),
                _ => (next.count(None).retries, row_max(next.class())),
            };
            let mut payload =
                mixdog_ai::retry::stage::reconnecting(&decide_on, used + 1, max.saturating_add(1), delay, u64::try_from(self.env.clock.now_ms()).unwrap_or(0));
            self.scheduled(&mut payload, &next, delay, &format!("{reason:?}"), replay_safe);
            self.emit(RunEvent::Stage(Stage::Reconnecting { attempt: used, max, delay, reason, payload: Some(payload) }));
            self.retry_wait(delay).await?;
        }
        if split_notice {
            // A repeated cut keeps the single notice already at the tail.
            let tail_is_notice = self.messages.last().is_some_and(|m| m.source == Some(Source::StreamCutRecovery));
            if !tail_is_notice {
                self.push(AgentMessage::sourced(Source::StreamCutRecovery, TOOL_INPUT_CUT_NOTICE)).await?;
            }
        }
        Ok(if loop_replay || retractable || split_notice { Recovery::LoopReplay } else { Recovery::Replay })
    }

    /// Whether the provider re-issues this send now that its ladder ended on `error` (`canFallbackNonStreaming`): once
    /// per run of the ladder, with nothing shown and no tool call started. A ladder that goes by the connection
    /// re-issues only a stream that opened.
    fn reissues_spent(&self, error: &ProviderError, partial: &ModelResponse, midstream: bool, replay_safe: bool) -> bool {
        self.reissue.is_none()
            && !error.recovery_terminal
            && replay_safe
            && !error.exposure.tool_input_cut
            && self.eager.is_empty()
            && partial.tool_calls.is_empty()
            && (midstream || !self.provider.send_stages(&self.model).ladder_by_connection)
            && self.last_request.as_ref().is_some_and(|request| self.provider.recovers_spent(request, error))
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
        if !self.last_request.as_ref().is_some_and(|request| self.provider.recovers_cut(request, &seen)) {
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

    /// A `content_filter` refusal on a provider that opted in
    /// (`retryPolicy.contentFilterRetryable`).
    fn content_filter_replayable(&self, error: &ProviderError) -> bool {
        self.provider.retry_policy_for(&self.model).content_filter_retryable
            && error.code.as_deref().is_some_and(|code| code.trim().eq_ignore_ascii_case("content_filter"))
    }

    /// The content-filter replay: under the transport row's budget and wait, and
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
            &self.retry.get(RetryClass::Transport).at_elapsed(self.send_identity.elapsed()),
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
        let mut payload = mixdog_ai::retry::stage::reconnecting(&error, attempt, max, delay, u64::try_from(self.env.clock.now_ms()).unwrap_or(0));
        let state = self.retry.get(RetryClass::Transport).clone();
        self.scheduled(&mut payload, &state, delay, "content_filter", replay_safe);
        self.emit(RunEvent::Stage(Stage::Reconnecting {
            attempt,
            max,
            delay,
            reason: mixdog_core_api::domain::retry::RetryReason::Other,
            payload: Some(payload),
        }));
        self.retry_wait(delay).await?;
        // `appendRecoveryNotice`: a repeated refusal keeps the single notice already at the tail.
        let tail_is_notice = self.messages.last().is_some_and(|m| m.source == Some(Source::ContentFilterRecovery));
        if !tail_is_notice {
            self.push(AgentMessage::sourced(Source::ContentFilterRecovery, CONTENT_FILTER_NOTICE)).await?;
        }
        // `scheduleTransportReplay`: the loop's replay, a new round.
        Ok(Recovery::LoopReplay)
    }

    /// The typed rejections a changed request can clear, each tried once.
    fn request_changing_recovery(&mut self, error: &ProviderError) -> Option<Recovery> {
        match error.kind {
            // The provider named a tool whose schema it rejects: the run drops
            // it (with a notice) and the turn is rebuilt without it, once.
            // Nothing was generated, and the same body would fail again.
            ErrorKind::ToolSchemaRejected if !self.tool_schema_drop_used && self.drop_rejected_tool(error) => {
                self.tool_schema_drop_used = true;
                Some(Recovery::Rebuilt)
            }
            // The latest assistant turn carries reasoning replay the API will
            // not take back: drop it from that turn, in place, once.
            ErrorKind::ReplayRejected if !self.replay_repair_used && self.repair_thinking_replay() => {
                self.replay_repair_used = true;
                Some(Recovery::Rebuilt)
            }
            // An image the provider refuses is not retried without it: no request is re-sent with an image removed or
            // replaced by text. The failure surfaces as the provider's own, distinct from a request that was never sent.
            _ => None,
        }
    }
    fn retraction(&self, chars: usize, reasoning: bool) -> Retracted {
        self.env.observer.retract_text(TextRetraction { chars, reasoning, reason: RetractReason::TransportRetraction })
    }

    /// The session's fallback chain takes the next model for a failure no
    /// retry covers. `true` when the route changed.
    async fn try_route(&mut self, error: &ProviderError) -> Result<Route, AgentError> {
        let Some(route) = self.env.route.clone() else {
            return Ok(Route::Stay);
        };
        let running = self.last_usage.clone();
        let decision = or_cancelled(&self.cancel, route.advance(error.clone(), running.as_ref())).await.ok_or(AgentError::Aborted)?;
        let switch = match decision {
            RouteDecision::Switch(switch) => switch,
            // The error as given: after a chain that ran out it names every model tried.
            RouteDecision::Surface(surface) => return Ok(Route::Surface(Box::new(surface.error))),
            RouteDecision::Fail(message) => return Err(AgentError::RouteFailed(message)),
        };
        self.seat_route(switch);
        Ok(Route::Switched)
    }

    /// The order the session is configured with may now prefer another route than the one it stands on: asked before a
    /// request is built, so nothing is on the wire to interrupt and no failed send is needed to learn it.
    pub(crate) async fn reconsider_route(&mut self) -> Result<(), AgentError> {
        let Some(route) = self.env.route.clone() else {
            return Ok(());
        };
        let running = self.last_usage.clone();
        let switch = or_cancelled(&self.cancel, route.reconsider(running.as_ref())).await.ok_or(AgentError::Aborted)?.map_err(AgentError::RouteFailed)?;
        if let Some(switch) = switch {
            self.seat_route(switch);
        }
        Ok(())
    }

    /// The run takes the route its session was just written to: what a hop and a reconsidered route both do to the run.
    fn seat_route(&mut self, switch: RouteSwitch) {
        // The new provider takes no other provider's replay state.
        self.strip_replay_for_new_route();
        self.carry.cache.messages_ttl_ms = crate::run::CacheReadings::messages_ttl(&switch.request.header);
        self.provider = switch.provider;
        // The requests captured for the session's side questions and compaction forks from here on are on the destination.
        if let Some(tap) = &self.env.side {
            let named = switch.request.header.get("provider").and_then(|provider| provider.as_str()).map(|name| name.trim().to_owned());
            let name = named.filter(|name| !name.is_empty()).unwrap_or_else(|| self.provider.id().as_str().to_owned());
            tap.route_changed(&name, &self.provider);
        }
        // The departing provider owns nothing of the new route's work.
        self.emit(RunEvent::SubmissionStarted { id: mixdog_core_api::domain::provider::next_submission_id() });
        self.fixed_surface = None;
        let next = switch.request.options;
        let options = &mut self.config.options;
        options.effort = next.effort;
        options.effort_projection = None;
        options.fast = next.fast;
        options.model_parameters = next.model_parameters;
        // The adapter's own per-model output ceiling belongs to the destination model, never the departing one.
        options.model_max_output_tokens = next.model_max_output_tokens;
        // The prompt cache key and scope are the session's, whatever route it stands on: only the wire identity follows the
        // provider (a Codex session names its stored wire id).
        options.wire_pin = next.wire_pin;
        if next.thread.is_some() {
            options.thread = next.thread;
            options.session_id = next.session_id;
        }
        self.config.escalated_max_output_tokens = switch.request.escalated_max_output_tokens;
        let mut compact = switch.request.compact;
        if let (Some(next), Some(old)) = (compact.as_mut(), self.config.compact.as_ref()) {
            // The tool reserve is turn input, not one of the destination's window settings.
            next.request_reserve_tokens = old.request_reserve_tokens;
        }
        self.config.compact = compact;
        // Every consumer of the compaction sizing follows the destination: the loop's policy above, the compactor's budgets
        // and summary route, and the cache-tail gate's sizing key. A consumer the destination gives no settings keeps what
        // it had.
        if let Some(settings) = self.config.compact.as_ref() {
            let seated = crate::env::SeatedRoute { header: switch.request.header, settings: settings.clone() };
            if let Some(resized) = self.env.compactor.as_ref().and_then(|compactor| compactor.resized(&seated)) {
                self.env.compactor = Some(resized);
            }
            if let Some(gate_for) = switch.request.tail_gate {
                self.config.options.tail_gate = Some(gate_for(Some(settings)));
            }
        }
        self.context = Default::default();
        self.config.effort = switch.effort;
        self.config.text_only = switch.text_only;
        self.model = switch.model;
        self.retry = RetryStates::new(&self.model);
        self.context_overflow_retry_used = false;
        // The one-shot recoveries the left model spent belong to its requests; the next model's first request gets its
        // own, and the left provider's continuation state is not the next one's.
        self.replay_repair_used = false;
        self.tool_schema_drop_used = false;
        self.provider_state = None;
        self.provider_state_changed = true;
        self.baseline = None;
        self.carry.prefix_guard = None;
        self.carry.cache.changed |= self.carry.cache.observation.take().is_some();
        self.cache_break_keys.clear();
        self.emit(RunEvent::Stage(Stage::Notice { message: switch.notice, tone: Tone::Info }));
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
    async fn on_context_overflow(&mut self, error: ProviderError, replay_safe: bool) -> Result<Recovery, AgentError> {
        let settings = self.config.compact.as_ref();
        let policy = settings.and_then(CompactPolicy::resolve);
        if !self.context_overflow_retry_used && policy.is_some() && replay_safe {
            self.context_overflow_retry_used = true;
            self.reactive_overflow_retry_pending = true;
            return Ok(Recovery::RetryRound);
        }
        if let Some(compactor) = self.env.compactor.as_ref() {
            compactor.prepare(&self.messages).await;
        }
        let estimate = self.env.compactor.as_ref().map(|c| c.estimate_tokens(&self.messages));
        let context_window = settings.and_then(|s| s.context_window).filter(|window| *window > 0);
        let overflow = AgentError::ContextOverflow(Box::new(ContextOverflow {
            stage: "send",
            provider: self.provider.id().to_string(),
            model: self.model.clone(),
            context_window,
            budget_tokens: context_window,
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

/// A decoded protocol record of the response, output or not (a role-only delta, a usage-only chunk). Keepalives and the
/// facts an adapter queues about the request itself (a served-model announcement, session state) are not.
fn is_protocol_payload(event: &StreamEvent) -> bool {
    !matches!(
        event,
        StreamEvent::ProviderKeepalive
            | StreamEvent::Notice { .. }
            | StreamEvent::ServedModel(_)
            | StreamEvent::ProviderState(_)
            | StreamEvent::ProviderMetadata(_)
            | StreamEvent::ResponseId(_)
            | StreamEvent::AccountRouting(_)
            | StreamEvent::AccountStage(_)
            | StreamEvent::WireRerouted(_)
            | StreamEvent::ThinkingBlocks(_)
            | StreamEvent::ReturnedCalls(_)
    )
}

/// Text, reasoning or tool-protocol output; headers, comments, usage-only metadata and pings are not.
fn is_semantic_output(event: &StreamEvent) -> bool {
    use mixdog_core_api::domain::provider::ProgressKind;
    matches!(
        event,
        StreamEvent::TextDelta(_)
            | StreamEvent::ReasoningDelta(_)
            | StreamEvent::ProgressDelta(_)
            | StreamEvent::ToolCallStart { .. }
            | StreamEvent::ToolCallArgsDelta { .. }
            | StreamEvent::ToolCallDone(_)
            | StreamEvent::Progress(ProgressKind::Text | ProgressKind::Reasoning | ProgressKind::Tool)
            | StreamEvent::ChunkProgress(Some(ProgressKind::Text | ProgressKind::Reasoning | ProgressKind::Tool))
    )
}
