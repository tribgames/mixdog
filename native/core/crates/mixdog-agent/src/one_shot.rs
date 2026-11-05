//! One model call outside any ask, on the loop's own attempt, retry and
//! stream-fold path (`Run::send_provider_request`): the compaction summary.
//!
//! The call is a request of messages with no tools, sent to one route's
//! provider. The decider owns retries (through the host's wait), the stream is
//! folded by the loop's builder, and the call ends with the caller's token. No
//! timer: liveness comes from the provider stack, as for turns.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::Usage;
use tokio_util::sync::CancellationToken;

use crate::compact::summary_run::SummaryCall;
use crate::compact::summary_run::SummaryFailure;
use crate::compact::summary_run::SummaryResponse;
use crate::compact::summary_run::SummarySender;
use crate::env::AllowAll;
use crate::env::DrainRequest;
use crate::env::NoGuards;
use crate::env::NullObserver;
use crate::env::RunEnv;
use crate::env::SteerEntry;
use crate::env::SteerSource;
use crate::env::Ticket;
use crate::env::TranscriptSink;
use crate::message::AgentMessage;
use crate::repair::repair_before_send;
use crate::run::AgentError;
use crate::run::Run;
use crate::run::RunCarry;
use crate::run::RunConfig;
use crate::send::SendResult;
use crate::tools::ToolEnv;
use crate::tools::ToolSet;

struct NoSteer;

#[async_trait]
impl SteerSource for NoSteer {
    async fn drain(&self, _request: DrainRequest) -> Vec<SteerEntry> {
        Vec::new()
    }
}

/// A one-shot call commits nothing.
struct DiscardSink;

#[async_trait]
impl TranscriptSink for DiscardSink {
    fn commit(&self, _message: &AgentMessage) -> Ticket {
        Ticket(0)
    }
    fn replace(&self, _messages: &[AgentMessage]) {}
    fn message_id(&self) -> String {
        String::new()
    }
    async fn durable(&self, _ticket: Ticket) {}
}

/// A run outside any session: the host's clock, jitter, retry wait and decider,
/// with steering, compaction, routing fallback, hooks and sinks off.
pub(crate) fn isolated_env(host: &RunEnv) -> RunEnv {
    RunEnv {
        clock: Arc::clone(&host.clock),
        jitter: Arc::clone(&host.jitter),
        waiter: Arc::clone(&host.waiter),
        decider: Arc::clone(&host.decider),
        steer: Arc::new(NoSteer),
        observer: Arc::new(NullObserver),
        sink: Arc::new(DiscardSink),
        gate: Arc::new(AllowAll),
        guards: Arc::new(NoGuards),
        compactor: None,
        route: None,
        skills: None,
        hooks: None,
        reuse: None,
        reactions: None,
        tail: None,
        step_judge: None,
        artifacts: None,
        images: None,
    }
}

/// What one call asks for.
#[derive(Clone, Debug)]
pub struct OneShotCall {
    pub model: String,
    /// The output cap of this request, kept on every retry of it.
    pub max_output_tokens: u32,
    pub fast: bool,
}

/// The folded answer.
#[derive(Clone, Debug)]
pub struct OneShotOutput {
    pub text: String,
    /// The model answered with a tool call instead of text.
    pub tool_call: bool,
    pub stop: Option<StopReason>,
    pub usage: Usage,
}

/// A route's provider plus the host plumbing a call needs. Cheap to clone.
#[derive(Clone)]
pub struct OneShot {
    env: RunEnv,
    tool_env: ToolEnv,
    provider: Arc<dyn ProviderAdapter>,
    cancel: CancellationToken,
    options: RequestOptions,
}

impl OneShot {
    /// `host` supplies the clock, jitter, retry wait and decider; everything
    /// else of a run (steering, compaction, routing fallback, hooks, sinks) is
    /// off. `cancel` ends every call of this value. `tool_env` is only the
    /// run's identity: no tool is offered.
    pub fn new(host: &RunEnv, tool_env: ToolEnv, provider: Arc<dyn ProviderAdapter>, cancel: CancellationToken) -> Self {
        Self { env: isolated_env(host), tool_env, provider, cancel, options: RequestOptions::default() }
    }

    /// The session facts a request carries (session id, transport scope,
    /// parent, thread); effort, tool choice and the projection are reset per
    /// call.
    pub fn with_options(mut self, options: RequestOptions) -> Self {
        self.options = options;
        self
    }

    /// Sends `messages` (system and user rows, as given on the wire).
    pub async fn call(&self, call: &OneShotCall, mut messages: Vec<AgentMessage>) -> Result<OneShotOutput, AgentError> {
        // This path skips the request boundary, which repairs the loop's
        // transcript; the adapters do not pair tool calls themselves.
        repair_before_send(&mut messages);
        // An independent request, never a continuation of the source
        // conversation's effort history.
        let options = RequestOptions {
            effort: Some("low".to_owned()),
            effort_projection: None,
            tool_choice: None,
            hosted_tools: Vec::new(),
            shared_cache_prefix_count: None,
            provider_state: None,
            fast: call.fast,
            request_kind: Some("compaction".to_owned()),
            max_output_tokens_override: Some(call.max_output_tokens),
            ..self.options.clone()
        };
        let mut config = RunConfig::new(self.tool_env.thread_id.clone(), self.tool_env.turn_id.clone(), call.model.clone());
        config.options = options;
        let mut run = Run::new(
            self.env.clone(),
            self.cancel.clone(),
            Arc::clone(&self.provider),
            ToolSet::new(Vec::new()),
            self.tool_env.clone(),
            config,
            messages,
            RunCarry::default(),
        );
        run.unprojected = true;
        loop {
            // No route fallback or compaction is configured, so a round never
            // restarts; the arm only keeps the match total.
            match run.send_provider_request().await? {
                SendResult::Proceed(response) => {
                    return Ok(OneShotOutput {
                        tool_call: !response.tool_calls.is_empty(),
                        text: response.content,
                        stop: response.stop,
                        usage: response.usage,
                    });
                }
                SendResult::RetryRound => continue,
            }
        }
    }

    /// A system prompt and one user prompt, the shape of a summary request.
    pub async fn call_prompt(&self, call: &OneShotCall, system: &str, prompt: &str) -> Result<OneShotOutput, AgentError> {
        let mut system_row = AgentMessage::user(system);
        system_row.message.role = Role::System;
        self.call(call, vec![system_row, AgentMessage::user(prompt)]).await
    }
}

/// The facts after which the next route can still summarize (Node
/// `fallsToNextRoute`): out of quota or unavailable to the account, or the
/// model not found.
fn falls_to_next_route(error: &ProviderError) -> bool {
    error.code.as_deref() == Some("provider_accounts_exhausted")
        || error.code.as_deref() == Some("model_not_found")
        || error.status == Some(429)
        || error.status == Some(404)
        || error.kind.is_quota()
}

fn summary_failure(error: AgentError) -> SummaryFailure {
    match error {
        AgentError::Aborted => SummaryFailure::Aborted,
        AgentError::Provider(e) if falls_to_next_route(&e) => SummaryFailure::NextRoute(e.message),
        AgentError::Provider(e) => SummaryFailure::Failed(e.message),
        AgentError::ContextOverflow(o) => {
            let text = o.cause.clone().unwrap_or_else(|| AgentError::ContextOverflow(o).to_string());
            SummaryFailure::Overflow(text)
        }
        other => SummaryFailure::Failed(other.to_string()),
    }
}

#[async_trait]
impl SummarySender for OneShot {
    async fn send(&self, system: &str, prompt: &str, call: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
        let call = OneShotCall {
            model: call.model.clone(),
            max_output_tokens: u32::try_from(call.max_output_tokens).unwrap_or(u32::MAX),
            fast: call.fast,
        };
        let out = self.call_prompt(&call, system, prompt).await.map_err(summary_failure)?;
        let reported = out.usage != Usage::default();
        Ok(SummaryResponse { text: out.text, tool_call: out.tool_call, usage: reported.then_some(out.usage) })
    }
}
