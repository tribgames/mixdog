//! One explorer: the run loop driven with one fixed system prompt and the
//! read-only filesystem tools: no session record, rules, skills, profile
//! context, steering or persistence (Node `explore/explorer.mjs`).
//!
//! The `explore` tool owns the fan-out and the merge; this is the
//! [`ExploreRunner`] it calls once per query. The deadline it passes is armed on
//! the core ticker, the one timing mechanism, and cancels the loop's token; the
//! runner then answers with the text the loop had already written (marked late),
//! as Node does for an abort that opts into salvage.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::JsonValue;
use mixdog_tools::orch::explore::ExploreAnswer;
use mixdog_tools::orch::explore::ExploreFailure;
use mixdog_tools::orch::explore::ExploreRun;
use mixdog_tools::orch::explore::ExploreRunner;

use crate::env::RunEvent;
use crate::env::RunEnv;
use crate::env::RunObserver;
use crate::env::Retracted;
use crate::env::TextRetraction;
use crate::limits::TurnLimits;
use crate::message::AgentMessage;
use crate::message::content_text;
use crate::one_shot::isolated_env;
use crate::run::Run;
use crate::run::RunCarry;
use crate::run::RunConfig;
use crate::tools::ToolEnv;
use crate::tools::ToolSet;

/// Tool-calling responses before the explorer must answer from what it has.
pub const EXPLORER_MAX_TOOL_ROUNDS: u64 = 10;

/// The explorer's messages before its own: the system prompt and the query.
const SEEDED_MESSAGES: usize = 2;

pub fn system_prompt() -> String {
    [
        "You explore the working directory read-only to answer one question. You cannot edit, run commands or delegate.".to_owned(),
        String::new(),
        "Search:".to_owned(),
        format!("- You have {EXPLORER_MAX_TOOL_ROUNDS} tool rounds: batch independent searches in one turn (parallel calls or array arguments)."),
        "- Search the question's own nouns, and match the subsystem it names, not a similarly named one.".to_owned(),
        "- Locate first, then read only that window.".to_owned(),
        "- A location a tool returned is final; never reconfirm it.".to_owned(),
        "- Before answering, list the parts the question asks about; each needs its own tool-returned `path:line`.".to_owned(),
        "- Cite implementation, not tests, docs or changelogs, unless asked.".to_owned(),
        "- A part without a `path:line`: search again with different terms, or use `code_graph` on a found symbol (definition, callers, writers). Call it missing only after that search, and name what you searched.".to_owned(),
        "- Stop once every part has its location.".to_owned(),
        String::new(),
        "Answer shape, hard limit 1,500 characters, nothing else:".to_owned(),
        "- One short answer line.".to_owned(),
        "- One evidence line per hop of each part (entry, callee, writer, reader), at most 10 lines: `path:line` from tool output, the exact function or symbol name there, a few words.".to_owned(),
        "- No intro, summary, extra locations, notes about unread code or \"Open:\" lines.".to_owned(),
    ]
    .join("\n")
}

/// The Explore route: Node's `route` argument to `runExplorer`.
#[derive(Clone)]
pub struct ExplorerRoute {
    pub model: String,
    pub provider: Arc<dyn ProviderAdapter>,
    pub effort: Option<String>,
    pub fast: bool,
    pub model_parameters: Option<JsonValue>,
    /// The session whose spend the explorer's requests are attributed to.
    pub owner_session_id: Option<String>,
}

/// What the explorer borrows from the host.
#[async_trait]
pub trait ExplorerHost: Send + Sync {
    /// The route, or the user-facing reason Explore has no model or its
    /// provider is not ready.
    async fn route(&self) -> Result<ExplorerRoute, String>;
    /// The read-only filesystem tools, one list for every explorer: the
    /// schema allowlist is also the execution allowlist.
    fn tools(&self) -> ToolSet;
}

pub struct AgentExplorer {
    host: Arc<dyn ExplorerHost>,
    env: RunEnv,
    tool_env: ToolEnv,
}

impl AgentExplorer {
    /// `env` supplies the clock, jitter, retry wait and decider; `tool_env` the
    /// shared tool plumbing (its thread and cwd are replaced per query).
    pub fn new(host: Arc<dyn ExplorerHost>, env: &RunEnv, tool_env: ToolEnv) -> Self {
        Self { host, env: isolated_env(env), tool_env }
    }

    /// The explorer of a host with no run around it: the process's clock, jitter, retry wait and
    /// decider.
    pub fn standalone(
        host: Arc<dyn ExplorerHost>,
        clock: Arc<dyn crate::env::Clock>,
        jitter: Arc<dyn crate::env::JitterSource>,
        waiter: Arc<dyn crate::env::RetryWait>,
        decider: Arc<dyn mixdog_core_api::domain::retry::RetryDecider>,
        tool_env: ToolEnv,
    ) -> Self {
        Self { host, env: crate::one_shot::isolated(clock, jitter, waiter, decider), tool_env }
    }
}

/// The answer text of the request in flight, for salvage when the deadline cuts it.
#[derive(Default)]
struct Streamed(Mutex<String>);

impl Streamed {
    fn text(&self) -> String {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
}

impl RunObserver for Streamed {
    fn event(&self, event: RunEvent) {
        let mut text = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match event {
            RunEvent::TextDelta(chunk) => text.push_str(&chunk),
            // The text of a committed turn is in the transcript from here on.
            RunEvent::ToolCalls { .. } | RunEvent::AssistantText { committed: true, .. } => text.clear(),
            _ => {}
        }
    }

    fn can_retract(&self) -> bool {
        true
    }

    fn retract_text(&self, retraction: TextRetraction) -> Retracted {
        if !retraction.reasoning {
            let mut text = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let keep = mixdog_js::utf16_len(&text).saturating_sub(retraction.chars);
            *text = mixdog_js::slice_utf16(&text, keep).to_string();
        }
        Retracted::Withdrawn
    }
}

fn blocks_text(content: &JsonValue) -> String {
    match content {
        JsonValue::String(s) => s.clone(),
        JsonValue::Array(blocks) => blocks
            .iter()
            .filter(|b| matches!(b.get("type").and_then(JsonValue::as_str), Some("text" | "output_text")))
            .map(|b| b.get("text").and_then(JsonValue::as_str).unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Visible assistant text inside a provider replay item (Node
/// `replayItemText`): reasoning, thinking and tool items are skipped.
fn replay_item_text(item: &JsonValue) -> String {
    let Some(object) = item.as_object() else { return String::new() };
    let kind = object.get("type").and_then(JsonValue::as_str);
    match kind {
        Some("message") => object.get("content").map(blocks_text).unwrap_or_default(),
        Some("text" | "output_text") => object.get("text").and_then(JsonValue::as_str).unwrap_or("").to_owned(),
        None if object.get("thought") != Some(&JsonValue::Bool(true)) => {
            object.get("text").and_then(JsonValue::as_str).unwrap_or("").to_owned()
        }
        _ => String::new(),
    }
}

fn replay_text(message: &AgentMessage) -> String {
    message
        .message
        .provider_replay()
        .iter()
        .filter_map(|replay| replay.items.as_array())
        .flatten()
        .map(replay_item_text)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The assistant text the run wrote after its seed messages (Node
/// `partialHandoffTextFromSession`).
fn handoff_text(transcript: &[AgentMessage]) -> String {
    transcript
        .iter()
        .skip(SEEDED_MESSAGES)
        .filter(|m| m.role() == Role::Assistant)
        .filter_map(|m| {
            let content = content_text(&m.message.content);
            let content = mixdog_js::js_trim(&content);
            let text = if content.is_empty() { mixdog_js::js_trim(&replay_text(m)).to_owned() } else { content.to_owned() };
            (!text.is_empty() && text != ".").then_some(text)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn salvage(transcript: &[AgentMessage], streamed: &str) -> String {
    let handoff = handoff_text(transcript);
    [handoff.as_str(), mixdog_js::js_trim(streamed)]
        .into_iter()
        .filter(|t| !mixdog_js::js_trim(t).is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[async_trait]
impl ExploreRunner for AgentExplorer {
    async fn prepare(&self) -> Result<(), String> {
        self.host.route().await.map(|_| ())
    }

    async fn explore(&self, run: ExploreRun<'_>) -> Result<ExploreAnswer, ExploreFailure> {
        let route = self.host.route().await.map_err(ExploreFailure::Message)?;
        let mut system = AgentMessage::user(system_prompt());
        system.message.role = Role::System;
        let messages = vec![system, AgentMessage::user(run.query)];

        // No session id: nothing session-keyed is created for an explorer.
        let options = mixdog_core_api::domain::provider::RequestOptions {
            effort: route.effort.clone(),
            fast: route.fast,
            model_parameters: route.model_parameters.clone(),
            // `ownerSessionId: ctx.callerSessionId`: the thread that called `explore`.
            parent_session_id: route.owner_session_id.clone().or_else(|| Some(run.thread.as_str().to_owned())),
            prompt_cache_scope: Some(crate::cache_scope::SHARED.to_owned()),
            ..Default::default()
        };
        let mut tool_env = self.tool_env.clone();
        tool_env.thread_id = run.thread.clone();
        tool_env.cwd = run.cwd.clone();
        let mut config = RunConfig::new(tool_env.thread_id.clone(), tool_env.turn_id.clone(), route.model.clone());
        config.options = options;
        config.limits = Some(TurnLimits { max_tool_rounds: Some(EXPLORER_MAX_TOOL_ROUNDS), ..TurnLimits::default() });

        let streamed = Arc::new(Streamed::default());
        let mut env = self.env.clone();
        env.observer = streamed.clone();

        // The deadline cuts every explorer of the call, not just this one.
        let token = run.cancel.child_token();
        let fired = Arc::new(AtomicBool::new(false));
        let timer = mixdog_rt::ticker().register(run.deadline, {
            let (fired, token) = (Arc::clone(&fired), token.clone());
            move || {
                fired.store(true, Ordering::SeqCst);
                token.cancel();
            }
        });
        let outcome = Run::new(env, token, route.provider, self.host.tools(), tool_env, config, messages, RunCarry::default())
            .run()
            .await;
        timer.cancel();
        let late = fired.load(Ordering::SeqCst);

        match outcome {
            Ok(output) => {
                let text = mixdog_js::js_trim(&output.response.content).to_owned();
                if text.is_empty() && late {
                    return Err(ExploreFailure::TimedOut);
                }
                Ok(ExploreAnswer { text, late })
            }
            Err(failure) if late => {
                let partial = salvage(&failure.transcript, &streamed.text());
                if partial.is_empty() { Err(ExploreFailure::TimedOut) } else { Ok(ExploreAnswer { text: partial, late: true }) }
            }
            Err(failure) => Err(ExploreFailure::Message(failure.error.to_string())),
        }
    }
}
