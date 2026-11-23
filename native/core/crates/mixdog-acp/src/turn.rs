//! One turn of an agent. A prompt's turn sends the prompt and shows what the agent streams back
//! until the agent closes the prompt. The turn of a reply the agent began on its own shows what
//! has arrived of it and ends: it waits on nothing, so a prompt queued behind it is never held.
//!
//! Every wait of a turn ends with the turn's cancel, the agent's exit or its pipe closing, and
//! every item a turn starts and every call it shows is settled however the turn ends.

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;

use mixdog_agent::handed::HandedCalls;
use mixdog_agent::handed::Judged;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_review::turn_review::line_diff::LineDiffer;
use mixdog_core_run::run_host::progress::RunProgress;
use mixdog_core_run::run_host::progress::StreamKind;
use mixdog_core_session::session::run::RunError;
use mixdog_core_session::session::run::new_item_id;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ItemId;
use mixdog_protocol::ItemMeta;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::connection::Incoming;
use crate::connection::RpcError;
use crate::mcp::ToolAsk;
use crate::rows;
use crate::rows::AgentTool;
use crate::session::AgentSession;
use crate::session::Background;
use crate::session::ContextUse;
use crate::surface::CallMark;
use crate::surface::TurnSurface;
use crate::surface::TurnUsage;

/// What a turn sends the agent.
pub enum Ask {
    /// `session/prompt` with these content blocks.
    Prompt(Vec<Value>),
    /// Nothing: the agent began a reply on its own, and the turn shows what has arrived of it.
    Reply,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TurnEnd {
    Completed {
        /// The text of the reply's last part.
        text: String,
        stop_reason: Option<String>,
        tool_calls: u64,
    },
    Interrupted,
    Failed {
        message: String,
        code: Option<i64>,
    },
    /// The agent answered that the signed-in account may not use it; `message` is what it said.
    Refused {
        message: String,
    },
}

/// What a turn is told besides its prompt.
pub struct TurnContext {
    pub turn: TurnId,
    /// The model the route names, for the usage report.
    pub model: String,
    /// The effort the route names: the tier the agent runs a model it lists at several (`tiers`).
    pub effort: Option<String>,
    pub now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub cancel: CancellationToken,
    /// The session's progress cell, which the worker views and a watchdog read; `None` where nothing reads one.
    pub progress: Option<watch::Sender<RunProgress>>,
    /// The session's tools as this turn runs a call of one; `None` for a turn that runs none.
    pub calls: Option<Arc<HandedCalls>>,
    /// Told each tool result the turn gains, with its card diff: the hook of the job that owns a sub-agent's turn.
    pub on_tool_result: Option<ToolResultHook>,
    /// The header change that records the agent's session with the conversation. It is saved once the prompt is
    /// written to the agent and never before: a session is recorded only as holding what the prompt carried to it.
    pub record: Option<HeaderChange>,
}

/// What a turn's owner hears of each tool result: its card diff, where it has one.
pub type ToolResultHook = Arc<dyn Fn(Option<String>) + Send + Sync>;

impl TurnContext {
    fn mark(&self, change: impl FnOnce(&mut RunProgress, i64)) {
        if let Some(progress) = &self.progress {
            let now = (self.now_ms)();
            progress.send_modify(|progress| change(progress, now));
        }
    }
}

struct Call {
    /// The call's id in the turn's rows.
    id: String,
    tool: AgentTool,
    /// Its tool row is committed.
    closed: bool,
}

struct Reply<'a> {
    session: &'a Arc<AgentSession>,
    surface: Arc<dyn TurnSurface>,
    context: &'a TurnContext,
    cwd: String,
    /// How many times calls have left the session's model context, as the session counted at the turn's start.
    epoch: u64,
    text: Option<(ItemId, String)>,
    /// White space the agent sent before any text of an item: it opens none.
    blank: String,
    reasoning: Option<(ItemId, String)>,
    /// The turn's calls by the agent's id of each.
    calls: HashMap<String, Call>,
    /// The agent's call ids in the order it made them.
    order: Vec<String>,
    /// Results shown here of calls an earlier turn made.
    late: u64,
    last_text: String,
    /// The step the spinner was last told of.
    marked: Option<CallMark>,
    plans: u64,
    /// Calls of Mixdog tools the agent made through the session's server.
    handed: u64,
    /// The agent's ids of its own reports of those calls: Mixdog shows each as its tool's call, once.
    reports: HashSet<String>,
    /// The names of the tools the session's server lists, as last read in this turn.
    listed: Option<Vec<String>>,
    /// Everything the agent said in the turn.
    said: String,
    differ: LineDiffer,
    /// The agent reported its context in this turn.
    reported: bool,
    /// The window the session was last told the agent holds its context in.
    window: Option<u64>,
    /// The last text chunk, held back while it has the form of the agent's notice of a failure of its own: the prompt's
    /// end tells whether it is one, and anything the agent sends after it shows it as the reply's.
    held: Option<String>,
}

/// The option the agent is answered with for how the user's approval ended, by the options' kinds. The agent's
/// lasting option writes a rule into the agent's own settings, so it is the answer only to the user's own lasting
/// approval; every other approval is for this one call, and what the user wants remembered for the session Mixdog
/// remembers itself. `lasting_asked`: the agent offered no option for one call, and the user was asked for the
/// lasting one in so many words.
pub fn chosen_option(resolution: &ApprovalResolution, options: &[(String, String)], lasting_asked: bool) -> Option<String> {
    let of = |kind: &str| options.iter().find(|(_, k)| k == kind).map(|(id, _)| id.clone());
    match resolution {
        ApprovalResolution::Decided { decision, .. } if decision.approved => {
            let lasting = lasting_asked || decision.remember == Some(ApprovalRemember::Always);
            if lasting { of("allow_always").or_else(|| of("allow_once")) } else { of("allow_once") }
        }
        ApprovalResolution::Decided { .. } => of("reject_once").or_else(|| of("reject_always")),
        // A session with nobody to ask refuses, as it refuses Mixdog's own calls, and never for longer than the call.
        ApprovalResolution::Unavailable { .. } => of("reject_once"),
        _ => None,
    }
}

/// The options of a permission request: each one's id and kind.
fn options_of(params: &Value) -> Vec<(String, String)> {
    params
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| Some((option.get("optionId")?.as_str()?.to_owned(), option.get("kind").and_then(Value::as_str).unwrap_or_default().to_owned())))
        .collect()
}

fn outcome(option: Option<String>) -> Value {
    match option {
        Some(option) => json!({ "outcome": { "outcome": "selected", "optionId": option } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

impl Reply<'_> {
    fn agent(&self) -> &str {
        &self.session.preset.id
    }

    fn meta(&self) -> ItemMeta {
        ItemMeta { turn_id: Some(self.context.turn.clone()), ..ItemMeta::default() }
    }

    /// Tells the spinner the step the turn is at, once per change: it reads as a turn of the loop does. A surface that
    /// is gone has no spinner to tell.
    async fn mark(&mut self, mark: CallMark) {
        if self.marked != Some(mark) {
            self.marked = Some(mark);
            let _ = self.surface.call_mark(mark).await;
        }
    }

    /// The step after a call ended: another call still runs, or the calls are over and the agent goes on.
    async fn mark_after_call(&mut self) {
        let running = self.calls.values().any(|call| !call.closed);
        self.mark(if running { CallMark::ToolCall } else { CallMark::ToolPhaseCompleted }).await;
    }

    /// Waits for `work` of the session's own pipeline on a call. The spinner shows the call running, and waiting on
    /// the user for as long as the pipeline holds an approval open (the session's progress counts that wait).
    async fn piped<T>(&mut self, work: impl std::future::Future<Output = T>) -> T {
        self.mark(CallMark::ToolCall).await;
        let mut progress = self.context.progress.as_ref().map(watch::Sender::subscribe);
        tokio::pin!(work);
        loop {
            tokio::select! {
                biased;
                outcome = &mut work => break outcome,
                Some(Ok(())) = async { Some(progress.as_mut()?.changed().await) } => {
                    let now = (self.context.now_ms)();
                    let waiting = progress.as_ref().is_some_and(|progress| progress.borrow().snapshot(now).is_some_and(|snapshot| snapshot.awaiting_user));
                    self.mark(if waiting { CallMark::ToolApproval } else { CallMark::ToolCall }).await;
                }
            }
        }
    }

    /// Runs `call` of a Mixdog tool.
    async fn run_handed(&mut self, calls: &HandedCalls, call: ToolCall) -> mixdog_agent::handed::Handed {
        let outcome = self.piped(calls.call(call)).await;
        self.mark_after_call().await;
        outcome
    }

    /// The agent reported its context: the window it names is the session's.
    async fn context_reported(&mut self) -> Result<(), RunError> {
        let Some(context) = self.session.context_use() else { return Ok(()) };
        self.reported = true;
        if self.window != Some(context.size) {
            self.window = Some(context.size);
            self.surface.window(context.size).await?;
        }
        Ok(())
    }

    /// Tells the turn's owner of a tool result the turn gained.
    fn result_told(&self, diff: Option<String>) {
        if let Some(hook) = &self.context.on_tool_result {
            hook(diff);
        }
    }

    async fn end_reasoning(&mut self) -> Result<(), RunError> {
        match self.reasoning.take() {
            Some((item, text)) => self.surface.reasoning_completed(item, text).await,
            None => Ok(()),
        }
    }

    /// Commits the text shown so far as an assistant row of its own.
    async fn end_text(&mut self, surface: &dyn TurnSurface) -> Result<(), RunError> {
        self.blank.clear();
        let Some((item, text)) = self.text.take() else { return Ok(()) };
        self.last_text.clone_from(&text);
        surface.commit(rows::assistant(item, &text, Vec::new())).await
    }

    /// Shows the chunk held back as a possible notice: the agent went on after it, so it is the reply's.
    async fn show_held(&mut self) -> Result<(), RunError> {
        match self.held.take() {
            Some(held) => self.text(&held).await,
            None => Ok(()),
        }
    }

    /// An item is opened by the first chunk that shows something, so none is left open with nothing to commit.
    async fn text(&mut self, chunk: &str) -> Result<(), RunError> {
        self.context.mark(|progress, now| progress.stream_delta(StreamKind::Text, now));
        self.mark(CallMark::Streaming).await;
        self.said.push_str(chunk);
        let shown = match &mut self.text {
            Some((_, text)) => {
                text.push_str(chunk);
                chunk.to_owned()
            }
            None if chunk.trim().is_empty() => {
                self.blank.push_str(chunk);
                return Ok(());
            }
            None => {
                self.end_reasoning().await?;
                let item = new_item_id();
                self.surface
                    .item_started(ThreadItem::AgentMessage {
                        id: item.clone(),
                        text: MaybeBlob::Inline(String::new()),
                        imported_tool_runs: Vec::new(),
                        meta: self.meta(),
                    })
                    .await?;
                let text = std::mem::take(&mut self.blank) + chunk;
                self.text = Some((item, text.clone()));
                text
            }
        };
        let (item, _) = self.text.as_ref().expect("the text item is open");
        self.surface.delta(item.clone(), shown).await
    }

    async fn thought(&mut self, chunk: &str) -> Result<(), RunError> {
        self.context.mark(|progress, now| progress.stream_delta(StreamKind::Reasoning, now));
        self.mark(CallMark::Streaming).await;
        let surface = self.surface.clone();
        self.end_text(surface.as_ref()).await?;
        if self.reasoning.is_none() {
            let item = new_item_id();
            self.surface.item_started(ThreadItem::Reasoning { id: item.clone(), summary: Vec::new(), content: Vec::new(), meta: self.meta() }).await?;
            self.reasoning = Some((item, String::new()));
        }
        let (item, text) = self.reasoning.as_mut().expect("the reasoning item was just opened");
        text.push_str(chunk);
        self.surface.reasoning_delta(item.clone(), chunk.to_owned()).await
    }

    /// The result of a call an earlier turn made, which that turn closed as still running: an item of its own that
    /// names the earlier call, so no call id is in two turns.
    async fn late_result(&mut self, agent_id: &str, earlier: Background) -> Result<(), RunError> {
        self.end_reasoning().await?;
        let surface = self.surface.clone();
        self.end_text(surface.as_ref()).await?;
        let id = self.session.call_id(agent_id, self.context.turn.as_str(), self.epoch);
        let tool = &earlier.tool;
        self.late += 1;
        self.surface.commit(rows::assistant(new_item_id(), "", vec![(id.clone(), tool.name(self.agent()), tool.late_arguments(&earlier.id))])).await?;
        self.commit_result(rows::tool_result(new_item_id(), &id, tool.result_text(), tool.status == "failed", tool.diff(&self.differ))).await
    }

    /// The call's state after `update`; a call first heard of gets its card: the assistant row that makes it,
    /// under the item of the text shown before it. `None` for an update of no call of this turn.
    async fn call(&mut self, update: &Value) -> Result<Option<String>, RunError> {
        let Some(agent_id) = update.get("toolCallId").and_then(Value::as_str).map(str::to_owned) else { return Ok(None) };
        self.context.mark(|progress, now| progress.stream_delta(StreamKind::Tool, now));
        if self.reports.contains(&agent_id) {
            return Ok(None);
        }
        if !self.calls.contains_key(&agent_id) && self.is_mixdog_call(update).await {
            self.reports.insert(agent_id);
            return Ok(None);
        }
        self.call_card(update).await
    }

    /// [`Self::call`] for a call that is shown as the agent's own, whatever it is a call of.
    async fn call_card(&mut self, update: &Value) -> Result<Option<String>, RunError> {
        let Some(agent_id) = update.get("toolCallId").and_then(Value::as_str).map(str::to_owned) else { return Ok(None) };
        if let Some(call) = self.calls.get_mut(&agent_id) {
            call.tool.merge(update);
        } else if let Some(ended) = self.session.background_update(&agent_id, update) {
            if ended && let Some(earlier) = self.session.background_shown(&agent_id) {
                self.late_result(&agent_id, earlier).await?;
            }
            return Ok(None);
        } else {
            let mut tool = AgentTool { id: agent_id.clone(), ..AgentTool::default() };
            tool.merge(update);
            self.end_reasoning().await?;
            self.blank.clear();
            let (item, text) = match self.text.take() {
                Some((item, text)) => {
                    self.surface.text_settled(item.clone()).await?;
                    (item, text)
                }
                None => (new_item_id(), String::new()),
            };
            let id = self.session.call_id(&agent_id, self.context.turn.as_str(), self.epoch);
            let name = tool.name(self.agent());
            self.context.mark(|progress, now| progress.tool_call(Some(&name), now));
            // The call is the turn's once its row is stored, and from then on the turn's end gives it a result: a row
            // the session did not take leaves no call to close, so no result is written for a call that is not there.
            self.surface.commit(rows::assistant(item, &text, vec![(id.clone(), name, tool.arguments())])).await?;
            self.mark(CallMark::ToolCall).await;
            self.order.push(agent_id.clone());
            self.calls.insert(agent_id.clone(), Call { id, tool, closed: false });
        }
        let ended = self.calls.get(&agent_id).is_some_and(|call| !call.closed && call.tool.ended());
        if ended {
            let surface = self.surface.clone();
            self.close_call(surface.as_ref(), &agent_id, None).await?;
            self.mark_after_call().await;
        }
        Ok(Some(agent_id))
    }

    /// `call` (a `tool_call`, a `tool_call_update` or a permission request's `toolCall`) is the agent's call of a tool
    /// of this session's Mixdog server: the session shows that call itself, and its pipeline asks the user what it must.
    /// Told by the agent's structured fields alone, each compared whole: `rawInput.ServerName` with the server's name
    /// and `rawInput.ToolName` with a tool the server lists, or the call's `name` with the name the agent gives such a
    /// tool. What the call's title or any other text says decides nothing.
    async fn is_mixdog_call(&mut self, call: &Value) -> bool {
        let Some(handed) = self.session.handed.clone() else { return false };
        let named = call.pointer("/rawInput/ServerName").and_then(Value::as_str).map(|server| {
            (server == crate::mcp::SERVER_NAME).then(|| call.pointer("/rawInput/ToolName").and_then(Value::as_str).unwrap_or_default().to_owned())
        });
        let name = call.get("name").and_then(Value::as_str);
        let format = self.session.preset.quirks.mcp_tool_name.as_deref();
        let is_listed = |listed: &[String]| match &named {
            // The agent names the server: that name alone decides.
            Some(tool) => tool.as_ref().is_some_and(|tool| listed.contains(tool)),
            None => match (name, format) {
                (Some(name), Some(format)) => listed.iter().any(|tool| format.replace("{server}", crate::mcp::SERVER_NAME).replace("{tool}", tool) == name),
                _ => false,
            },
        };
        // The server's listing is read only for a call that names the server: the agent's own tools cost no read.
        let names_server = match (&named, name, format) {
            (Some(tool), ..) => tool.is_some(),
            (None, Some(name), Some(format)) => {
                let server = format.replace("{server}", crate::mcp::SERVER_NAME);
                name.starts_with(server.split("{tool}").next().unwrap_or_default())
            }
            _ => false,
        };
        if !names_server {
            return false;
        }
        if self.listed.as_deref().is_some_and(is_listed) {
            return true;
        }
        // The session's surface may have moved since it was last read: a name it does not hold is looked for once more.
        let Ok(tools) = handed.tools.definitions(&handed.thread).await else { return false };
        let listed: Vec<String> = tools.into_iter().map(|tool| tool.name).collect();
        let found = is_listed(&listed);
        self.listed = Some(listed);
        found
    }

    /// Opens the card of a call of the Mixdog tool `name`: the assistant row that makes it, under the item of the
    /// text shown before it. Returns the call's id in the rows.
    async fn open_handed(&mut self, name: &str, arguments: &Value) -> Result<String, RunError> {
        self.end_reasoning().await?;
        self.blank.clear();
        let (item, text) = match self.text.take() {
            Some((item, text)) => {
                self.surface.text_settled(item.clone()).await?;
                (item, text)
            }
            None => (new_item_id(), String::new()),
        };
        self.handed += 1;
        let id = self.session.call_id(&format!("mixdog-{}", self.handed), self.context.turn.as_str(), self.epoch);
        self.context.mark(|progress, now| progress.tool_call(Some(name), now));
        self.surface.commit(rows::assistant(item, &text, vec![(id.clone(), name.to_owned(), arguments.clone())])).await?;
        Ok(id)
    }

    /// A call of a Mixdog tool the agent made through the session's server: it is shown as that tool's call, run
    /// through Mixdog's pipeline, and answered with its result. Its row is committed however the call ends.
    async fn handed(&mut self, ask: ToolAsk) -> Result<(), RunError> {
        let Some(handed) = self.session.handed.clone() else {
            ask.refuse("This session hands out no tools.");
            return Ok(());
        };
        // The agent is handed the session's surface as it is now, and nothing beyond it.
        let listed = handed.tools.definitions(&handed.thread).await;
        match listed {
            Ok(tools) if tools.iter().any(|tool| tool.name == ask.name) => {}
            Ok(_) => {
                let unknown = format!("{} is not a tool of this session.", ask.name);
                ask.refuse(&unknown);
                return Ok(());
            }
            Err(message) => {
                ask.refuse(&message);
                return Ok(());
            }
        }
        let id = match self.open_handed(&ask.name, &ask.arguments).await {
            Ok(id) => id,
            Err(error) => {
                ask.refuse("The session stopped taking this turn's work; the call was not run.");
                return Err(error);
            }
        };
        let outcome = match &self.context.calls {
            Some(calls) => {
                let calls = calls.clone();
                self.run_handed(&calls, ToolCall { id: id.clone(), name: ask.name.clone(), arguments: ask.arguments.clone(), native_type: None }).await
            }
            None => crate::mcp::unrun(&id, "This turn runs no Mixdog tools."),
        };
        self.context.mark(|progress, now| progress.tool_call(None, now));
        let committed = self.commit_result(rows::tool_message(new_item_id(), &outcome.message)).await;
        let _ = ask.answer.send(crate::mcp::rendered(&outcome));
        committed
    }

    /// Stores the result row of a call whose assistant row is stored. A stop of the turn that lands while the row is on
    /// its way refuses it on the turn's own surface; the surface that outlives the turn's token takes it then, so a
    /// stored call is never left without its result.
    async fn commit_result(&self, row: mixdog_core_session::session::ItemCommit) -> Result<(), RunError> {
        self.result_told(row.body.get("uiDiff").and_then(Value::as_str).map(str::to_owned));
        if self.context.cancel.is_cancelled() {
            return self.surface.closing().commit(row).await;
        }
        match self.surface.commit(row.clone()).await {
            Err(_) if self.context.cancel.is_cancelled() => self.surface.closing().commit(row).await,
            committed => committed,
        }
    }

    /// Commits the call's tool row: its own result, or `instead` for a call the turn ends before the agent did.
    async fn close_call(&mut self, surface: &dyn TurnSurface, agent_id: &str, instead: Option<(&str, bool)>) -> Result<(), RunError> {
        let Some(call) = self.calls.get_mut(agent_id) else { return Ok(()) };
        call.closed = true;
        let (text, failed) = match instead {
            Some((text, failed)) => (text.to_owned(), failed),
            None => (call.tool.result_text(), call.tool.status == "failed"),
        };
        let diff = call.tool.diff(&self.differ);
        let row = rows::tool_result(new_item_id(), &call.id, text, failed, diff.clone());
        self.result_told(diff);
        surface.commit(row).await
    }

    async fn plan(&mut self, update: &Value) -> Result<(), RunError> {
        self.end_reasoning().await?;
        let surface = self.surface.clone();
        self.end_text(surface.as_ref()).await?;
        self.plans += 1;
        let id = self.session.call_id(&format!("plan-{}", self.plans), self.context.turn.as_str(), self.epoch);
        let (arguments, text) = rows::plan(update);
        let name = crate::mcp::STEP_LIST_TOOL;
        self.surface.commit(rows::assistant(new_item_id(), "", vec![(id.clone(), name.to_owned(), arguments.clone())])).await?;
        // The session has one step list, the one its `todo` tool keeps: where the agent is handed that tool, its own
        // plan is written into the same list by the same call, so whichever of the two the agent used last is what
        // the list shows. A session that hands no tools shows the plan as the call's card only.
        let written = match self.context.calls.clone() {
            Some(calls) if !arguments["items"].as_array().is_none_or(Vec::is_empty) => {
                Some(self.run_handed(&calls, ToolCall { id: id.clone(), name: name.to_owned(), arguments, native_type: None }).await)
            }
            _ => None,
        };
        let row = match written {
            Some(written) => rows::tool_message(new_item_id(), &written.message),
            None => rows::tool_result(new_item_id(), &id, text, false, None),
        };
        self.commit_result(row).await
    }

    async fn update(&mut self, update: &Value) -> Result<(), RunError> {
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
        let chunk = || update.pointer("/content/text").and_then(Value::as_str).filter(|text| !text.is_empty());
        if matches!(kind, "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" | "plan") {
            self.show_held().await?;
        }
        match kind {
            "agent_message_chunk" => match chunk() {
                Some(text) if self.session.preset.quirks.failure_notice(text).is_some() => {
                    self.held = Some(text.to_owned());
                    Ok(())
                }
                Some(text) => self.text(text).await,
                None => Ok(()),
            },
            "agent_thought_chunk" => match chunk() {
                Some(text) => self.thought(text).await,
                None => Ok(()),
            },
            "tool_call" | "tool_call_update" => self.call(update).await.map(drop),
            "plan" => self.plan(update).await,
            "usage_update" => self.context_reported().await,
            _ => Ok(()),
        }
    }

    /// `session/request_permission`: the session's permissions' answer as the agent's option, or the user's, asked on
    /// the session's approval card. A tool the user approved for the rest of the session is answered without a card.
    async fn permission(&mut self, params: &Value) -> Result<Value, RunError> {
        let request = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let options = options_of(params);
        let once = options.iter().find(|(_, kind)| kind == "allow_once").map(|(id, _)| id.clone());
        // A call of a Mixdog tool is asked about by that tool's own pipeline, which asks the user what it must: the
        // agent's question about the same call is answered yes, for this one call. An agent that offers no answer for
        // one call is not answered for longer on the user's behalf: its question goes to the user as any other.
        if once.is_some() && self.is_mixdog_call(&request).await {
            if let Some(id) = request.get("toolCallId").and_then(Value::as_str) {
                self.reports.insert(id.to_owned());
            }
            return Ok(outcome(once));
        }
        if let Some(id) = request.get("toolCallId").and_then(Value::as_str) {
            // The question is the user's to answer: the call gets its card.
            self.reports.remove(id);
        }
        let Some(agent_id) = self.call_card(&request).await? else { return Ok(outcome(None)) };
        let call = &self.calls[&agent_id];
        let name = call.tool.name(self.agent());
        let key = call.tool.grant_key(self.agent());
        // Work of a kind Mixdog has a tool for (a read, an edit, a command) is judged first, as a call of that tool is
        // in this session: its surface, its PreToolUse hooks and its human gate, on every file the call touches. What
        // they allow or refuse is answered so, for this one call; what they would ask the user about is asked on the
        // call's card, and so is what they would run only changed, as the agent's call cannot be.
        let mut remembered = true;
        if let (Some(allow), Some(calls), Some((tool, arguments))) = (once.clone(), self.context.calls.clone(), call.tool.as_session_call()) {
            let (id, shown) = (call.id.clone(), if call.tool.title.is_empty() { name.clone() } else { call.tool.title.clone() });
            match self.piped(calls.judge(&id, tool, &arguments)).await {
                Judged::Allowed => {
                    self.mark(CallMark::ToolCall).await;
                    return Ok(outcome(Some(allow)));
                }
                Judged::Refused(refusal) => {
                    self.mark(CallMark::ToolCall).await;
                    let _ =
                        self.surface.notice(format!("{}'s call \"{shown}\" was not allowed in this session: {refusal}", self.session.preset.label), true).await;
                    return Ok(outcome(options.iter().find(|(_, kind)| kind == "reject_once").map(|(id, _)| id.clone())));
                }
                Judged::Asks => {}
                Judged::Changed => remembered = false,
            }
        }
        // What the user approved for the rest of the session answers, for this one call, what would otherwise be asked
        // on a card: the approval is remembered under the policy's key of the action, and covers what that key covers.
        let granted = |key: &mixdog_tools::policy::GrantKey| self.session.grants.lock().unwrap_or_else(std::sync::PoisonError::into_inner).contains(key);
        if remembered && once.is_some() && key.as_ref().is_some_and(granted) {
            return Ok(outcome(once));
        }
        let call = &self.calls[&agent_id];
        let always = options.iter().any(|(_, kind)| kind == "allow_always");
        // The agent offers no approval for one call: the user is asked for the lasting one, and told that it is.
        let lasting_only = once.is_none() && always;
        // The card's wording is the client's: the agent and whether its call has a title are data here.
        let title = Some(call.tool.title.clone()).filter(|title| !title.is_empty());
        let shown = title.clone().unwrap_or_else(|| name.clone());
        let preset = &self.session.preset;
        let ask = ApprovalAsk {
            kind: ApprovalKind::Tool,
            call_id: Some(ToolCallId::from(call.id.clone())),
            tool: Some(name.clone()),
            action_kind: None,
            reason: title.clone(),
            payload: json!({
                "name": name,
                "args": call.tool.arguments(),
                "cwd": self.cwd,
                "kind": "approval",
                "reason": title,
                "agent": { "id": preset.id, "label": preset.label },
                "untitled": title.is_none(),
                "lastingOnly": lasting_only,
            }),
            // "Session" is Mixdog's to remember, offered for what the policy remembers; "Always" is the agent's own
            // lasting rule, offered where the agent offers it.
            remember: [(key.is_some() && !lasting_only).then_some(ApprovalRemember::Session), always.then_some(ApprovalRemember::Always)]
                .into_iter()
                .flatten()
                .collect(),
            expires_after: None,
        };
        // The wait reads as the loop's approval wait does: the spinner's mark, and a counted wait of the progress.
        self.mark(CallMark::ToolApproval).await;
        self.context.mark(|progress, now| progress.approval_wait(true, now));
        let resolution = self.surface.approve(ask).await;
        self.context.mark(|progress, now| progress.approval_wait(false, now));
        // Answered, the call runs or is refused: the agent's next report of it tells which.
        self.mark(CallMark::ToolCall).await;
        if let (ApprovalResolution::Decided { decision, .. }, Some(key)) = (&resolution, key)
            && decision.approved
            && matches!(decision.remember, Some(ApprovalRemember::Session | ApprovalRemember::Agent | ApprovalRemember::Always))
        {
            self.session.grants.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(key);
        }
        if matches!(resolution, ApprovalResolution::Unavailable { .. }) {
            let notice = format!("{}'s call \"{shown}\" was not allowed: this session has nobody to approve it.", self.session.preset.label);
            let _ = self.surface.notice(notice, true).await;
        }
        Ok(outcome(chosen_option(&resolution, &options, lasting_only)))
    }

    /// Closes what the reply left open on `surface`; `open_calls` is the result a call still running gets. The
    /// calls it closed that way are returned by the agent's id of each.
    async fn close(&mut self, surface: &dyn TurnSurface, open_calls: (&str, bool)) -> Vec<(String, Background)> {
        // A surface that is gone has nobody to show the rest to; the rows that land are the ones the session took.
        if let Some((item, text)) = self.reasoning.take() {
            let _ = surface.reasoning_completed(item, text).await;
        }
        let open: Vec<String> = self.order.iter().filter(|id| self.calls.get(*id).is_some_and(|call| !call.closed)).cloned().collect();
        for id in &open {
            let _ = self.close_call(surface, id, Some(open_calls)).await;
        }
        let _ = self.end_text(surface).await;
        open.into_iter().filter_map(|agent_id| self.calls.remove(&agent_id).map(|call| (agent_id, Background { id: call.id, tool: call.tool }))).collect()
    }
}

enum Ended {
    /// The agent closed the prompt, or what had arrived of a reply it began on its own is shown (`None`).
    Agent(Option<Result<Value, RpcError>>),
    Stopped,
    /// The agent's process ended.
    Gone,
    /// The session stopped taking the turn's reports: it is closing, or the run was cancelled.
    Surface,
}

/// What the turn reports of its tokens: the prompt answer's usage, and the agent's own report of its context
/// (`reported`). `None` for a turn that has neither.
fn usage_of(answer: &Value, reported: Option<ContextUse>, context: &TurnContext, started_at_ms: i64, tool_calls: u64) -> Option<TurnUsage> {
    let usage = answer.get("usage").filter(|usage| usage.is_object());
    if usage.is_none() && reported.is_none() {
        return None;
    }
    let count = |key: &str| usage.and_then(|usage| usage.get(key)).and_then(Value::as_u64);
    Some(TurnUsage {
        input_tokens: count("inputTokens").unwrap_or(0),
        output_tokens: count("outputTokens").unwrap_or(0),
        cached_read_tokens: count("cachedReadTokens").unwrap_or(0),
        thought_tokens: count("thoughtTokens"),
        total_tokens: count("totalTokens"),
        context: reported,
        model: context.model.clone(),
        tool_calls,
        started_at_ms,
        elapsed_ms: ((context.now_ms)() - started_at_ms).max(0) as u64,
    })
}

/// The protocol's answer to a request about a resource the agent does not hold (`RESOURCE_NOT_FOUND`): the code a
/// turn whose agent lost its session fails with.
pub(crate) const SESSION_NOT_FOUND: i64 = -32002;

/// The turn failed with what the agent said, `message`, and the error code it answered with, if any. A failure that
/// says the sign-in no longer holds is the protocol's `AUTH_REQUIRED`, and one that says the agent's session is gone
/// is [`SESSION_NOT_FOUND`], whatever code the agent gave it.
fn failure(quirks: &crate::preset::Quirks, message: String, code: Option<i64>) -> TurnEnd {
    let says = |markers: &[String]| markers.iter().any(|marker| message.contains(marker.as_str()));
    let code = if says(&quirks.signed_out_failures) {
        Some(crate::agents::AUTH_REQUIRED)
    } else if says(&quirks.lost_session_failures) {
        Some(SESSION_NOT_FOUND)
    } else {
        code
    };
    TurnEnd::Failed { message, code }
}

/// Runs one turn on `session` and reports it to `surface`.
pub async fn run(session: &Arc<AgentSession>, surface: Arc<dyn TurnSurface>, ask: Ask, mut context: TurnContext) -> TurnEnd {
    let record = context.record.take();
    let started_at_ms = (context.now_ms)();
    let (waiting, mut stream) = session.attach(matches!(ask, Ask::Prompt(_)));
    let mut queued: VecDeque<Incoming> = waiting.into();
    context.mark(|progress, now| progress.ask_start(now));
    let mut reply = Reply {
        session,
        surface: surface.clone(),
        context: &context,
        cwd: session.cwd.as_path().to_string_lossy().into_owned(),
        epoch: surface.call_epoch(),
        text: None,
        blank: String::new(),
        reasoning: None,
        calls: HashMap::new(),
        order: Vec::new(),
        late: 0,
        last_text: String::new(),
        marked: None,
        plans: 0,
        handed: 0,
        reports: HashSet::new(),
        listed: None,
        said: String::new(),
        differ: LineDiffer::new(),
        reported: false,
        window: None,
        held: None,
    };
    let prompt = match ask {
        Ask::Prompt(blocks) => {
            let sent = tokio::select! {
                biased;
                () = context.cancel.cancelled() => None,
                sent = session.connection.send("session/prompt", json!({ "sessionId": session.session_id, "prompt": blocks })) => Some(sent),
            };
            match sent {
                Some(Ok(id)) => {
                    // The agent holds the prompt: its session is the conversation's from here. A record that cannot be
                    // saved leaves the conversation naming no session, and the next turn hands it over again.
                    if let Some(change) = record {
                        let on = if context.cancel.is_cancelled() { surface.closing() } else { surface.clone() };
                        if let Err(error) = on.save_header(change).await {
                            tracing::warn!("[acp] the agent's session could not be saved with the conversation: {error:?}");
                        }
                    }
                    Some(id)
                }
                Some(Err(fault)) => {
                    session.detach(stream, Vec::new()).await;
                    context.mark(|progress, now| progress.settle("error", now, false));
                    return TurnEnd::Failed { message: fault.to_string(), code: None };
                }
                // The agent stopped reading while the prompt was written: how much of it it holds is unknown.
                None => {
                    session.connection.kill();
                    session.detach(stream, Vec::new()).await;
                    context.mark(|progress, now| progress.settle("done", now, false));
                    return TurnEnd::Interrupted;
                }
            }
        }
        Ask::Reply => None,
    };
    // What the agent sent on its own before a prompt's turn began is shown first, as rows of its own: it is no part of
    // the answer to the prompt.
    let mut backlog = prompt.is_some() && !queued.is_empty();
    let ended = loop {
        if backlog && queued.is_empty() {
            backlog = false;
            if reply.end_reasoning().await.is_err() || reply.end_text(surface.as_ref()).await.is_err() {
                break Ended::Surface;
            }
        }
        let incoming = match queued.pop_front() {
            Some(incoming) => incoming,
            None if context.cancel.is_cancelled() => break Ended::Stopped,
            // A reply the agent began on its own is shown as far as it has arrived.
            None if prompt.is_none() => match stream.try_recv() {
                Ok(incoming) => incoming,
                Err(_) => break Ended::Agent(None),
            },
            None => tokio::select! {
                biased;
                () = context.cancel.cancelled() => break Ended::Stopped,
                next = stream.recv() => match next {
                    Some(incoming) => incoming,
                    None => break Ended::Gone,
                },
            },
        };
        let step = match incoming {
            Incoming::Notification { method, params } if method == "session/update" => reply.update(params.get("update").unwrap_or(&Value::Null)).await,
            Incoming::Request { id, params, .. } => match reply.permission(&params).await {
                Ok(answer) => {
                    session.connection.respond(id, Ok(answer)).await;
                    Ok(())
                }
                Err(error) => {
                    session.connection.respond(id, Ok(outcome(None))).await;
                    Err(error)
                }
            },
            Incoming::Response { id, result } if Some(id) == prompt => break Ended::Agent(Some(result)),
            Incoming::Tool(ask) => reply.handed(ask).await,
            _ => Ok(()),
        };
        if step.is_err() {
            break Ended::Surface;
        }
    };
    let tool_calls = reply.order.len() as u64 + reply.late + reply.handed;
    // What the agent holds in its context is the session's reading however the turn ends: a turn that was stopped or
    // failed after the agent reported leaves the report, with no tokens of an answer beside it.
    let reported = session.context_use().filter(|_| reply.reported);
    let cancelled_by_agent = matches!(&ended, Ended::Agent(Some(Ok(answer))) if answer.get("stopReason").and_then(Value::as_str) == Some("cancelled"));
    let end = match ended {
        Ended::Agent(Some(Err(error))) => {
            let _ = reply.show_held().await;
            reply.close(surface.as_ref(), ("The agent's turn failed before this call ended.", true)).await;
            session.detach(stream, Vec::new()).await;
            if let Some(usage) = usage_of(&Value::Null, reported, &context, started_at_ms, tool_calls) {
                let _ = surface.usage(usage).await;
            }
            failure(&session.preset.quirks, error.message, Some(error.code))
        }
        Ended::Agent(answer) if !cancelled_by_agent => {
            let answer = answer.and_then(Result::ok);
            // The agent's notice of a failure of its own closes a prompt it answers with no usage: a chunk of that form
            // anywhere else is the reply's.
            let quirks = &session.preset.quirks;
            let notice = match (reply.held.take(), &answer) {
                (Some(held), Some(answer)) if answer.get("usage").is_none() => quirks.failure_notice(&held),
                (Some(held), _) => {
                    let _ = reply.text(&held).await;
                    None
                }
                (None, _) => None,
            };
            // A call still open when the agent closes its turn is work it keeps running in its own process.
            let background = reply.close(surface.as_ref(), ("Still running in the agent's background.", false)).await;
            session.detach(stream, background).await;
            let answer = answer.unwrap_or(Value::Null);
            if let Some(usage) = usage_of(&answer, session.context_use(), &context, started_at_ms, tool_calls) {
                let _ = surface.usage(usage).await;
            }
            // A reply, or a notice, that is the agent's word that the account may not use it is no answer to the
            // prompt: the turn is refused, in the agent's own words. A notice of another failure fails the turn.
            let refuses = |said: &str| {
                let said = said.to_lowercase();
                quirks.account_refusals.iter().any(|refusal| said.contains(&refusal.to_lowercase()))
            };
            match notice {
                Some(notice) if refuses(&notice) => TurnEnd::Refused { message: notice },
                Some(notice) => failure(quirks, notice, None),
                None if tool_calls == 0 && refuses(&reply.said) => TurnEnd::Refused { message: reply.said.trim().to_owned() },
                None => TurnEnd::Completed {
                    text: std::mem::take(&mut reply.last_text),
                    stop_reason: answer.get("stopReason").and_then(Value::as_str).map(str::to_owned),
                    tool_calls,
                },
            }
        }
        Ended::Gone => {
            let _ = reply.show_held().await;
            reply.close(surface.as_ref(), ("The agent's process ended before this call did.", true)).await;
            session.detach(stream, Vec::new()).await;
            TurnEnd::Failed { message: session.connection.closed().to_string(), code: None }
        }
        // The user stopped the turn, the agent says it was stopped, or the session is gone from under the turn: the
        // agent is told to stop unless it already closed the prompt, and what the turn showed is closed on a surface
        // whose waits outlive the turn's token.
        Ended::Agent(_) | Ended::Stopped | Ended::Surface => {
            if !cancelled_by_agent {
                session.cancel(prompt);
            }
            let closing = surface.closing();
            reply.close(closing.as_ref(), ("Cancelled", true)).await;
            session.detach(stream, Vec::new()).await;
            if let Some(usage) = usage_of(&Value::Null, reported, &context, started_at_ms, tool_calls) {
                let _ = closing.usage(usage).await;
            }
            TurnEnd::Interrupted
        }
    };
    let stage = if matches!(end, TurnEnd::Failed { .. } | TurnEnd::Refused { .. }) { "error" } else { "done" };
    context.mark(|progress, now| progress.settle(stage, now, false));
    end
}
