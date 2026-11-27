//! A turn an agent outside Mixdog's loop runs. It begins as every turn does ([`super::drive`]: the model context read,
//! the settings reconcile, the session's prompt, the prompt hooks, the title and the reminders the input carries) and is
//! handed over where the loop would be entered: the agent gets the input as it is sent, the session's port, and the
//! session's tools as calls of the loop's own execution path.

use std::collections::HashSet;
use std::path::Path;

use mixdog_agent::env::DrainRequest;
use mixdog_agent::env::DrainStage;
use mixdog_agent::env::ModelVision;
use mixdog_agent::env::Priority;
use mixdog_agent::env::StopVerdict;
use mixdog_agent::env::Tone;
use mixdog_agent::handed::HandedCalls;
use mixdog_agent::handed::HandedParts;
use mixdog_agent::limits::TurnLimits;
use mixdog_agent::message::Source;
use mixdog_core_run::run_host::progress::RunProgress;
use mixdog_core_session::session::goal_reminder::GoalReminder;
use mixdog_core_session::session::prompt_notice::CarriedNotice;
use mixdog_core_session::session::run::Compaction;
use mixdog_core_session::session::run::SteerInput;
use mixdog_core_session::session::transcript_writer::TurnTranscript;
use mixdog_core_session::session::turn_snapshot::TurnSnapshot;
use mixdog_mcp::skill_select::SkillNames;
use mixdog_store::schema::record::Header;

use super::super::mcp_seams::ExplicitSkillSelector;
use super::super::reactions::LoopReactions;
use super::super::reactions::ReactionScope;
use super::super::reactions::ReactionTargets;
use super::*;

/// Maximum Stop-hook continuations within a single turn, matching `mixdog-agent/src/no_tool.rs`.
const STOP_CONTINUATION_LIMIT: u32 = 8;
/// Matches `HEARTBEAT_MAX_TOOL_CALLS` and `HEARTBEAT_WRAP_UP_MS` in `run_host/settings.rs`.
const HEARTBEAT_MAX_TOOL_CALLS: u64 = 8;
const HEARTBEAT_WRAP_UP_MS: i64 = 60_000;

/// Available skill names extracted from the session header's `<available_skills>` prompt block and optional
/// `availableSkills` list, allowing `ExplicitSkillSelector` to resolve `$name` / `Skill: "name"` without extra seams.
struct HeaderSkillNames {
    names: HashSet<String>,
}

impl HeaderSkillNames {
    fn from_header(header: &Header) -> Self {
        Self { names: super::super::assemble::header_skill_names(header) }
    }
}

#[async_trait]
impl SkillNames for HeaderSkillNames {
    async fn names(&self, _cwd: &Path) -> Result<HashSet<String>, String> {
        Ok(self.names.clone())
    }
}

/// Vision capability bound to the outside turn's active provider and model rather than `HandedCalls`' synthetic
/// `"outside"` adapter id.
struct BoundVision {
    inner: Arc<dyn ModelVision>,
    provider: String,
    model: String,
}

impl ModelVision for BoundVision {
    fn sees_images(&self, _provider: &str, _model: &str) -> bool {
        self.inner.sees_images(&self.provider, &self.model)
    }
}

/// Vision capability for an outside-agent turn, bound to the turn's active provider and model rather than
/// `HandedCalls`' synthetic `"outside"` adapter id.
struct OutsideVision {
    provider: String,
    model: String,
    header_override: Option<bool>,
}

impl OutsideVision {
    fn from_header(header: &Header) -> Self {
        let provider = header.get("provider").and_then(Value::as_str).unwrap_or_default().to_owned();
        let model = header.get("model").and_then(Value::as_str).unwrap_or_default().to_owned();
        let header_override = header.get("supportsVision").and_then(Value::as_bool);
        Self { provider, model, header_override }
    }
}

impl ModelVision for OutsideVision {
    fn sees_images(&self, _provider: &str, _model: &str) -> bool {
        if !super::super::model_proxy_pc::takes_images(&self.provider) {
            return false;
        }
        if let Some(vision) = self.header_override {
            return vision;
        }
        !self.model.to_ascii_lowercase().starts_with("gpt-oss")
    }
}

fn limits_from_header(header: &Header, now_ms: i64) -> Option<TurnLimits> {
    let obj = header.get("turnLimits").and_then(Value::as_object);
    let max_tool_calls = obj.and_then(|o| o.get("maxToolCalls")).or_else(|| header.get("maxToolCalls")).and_then(Value::as_u64).filter(|n| *n > 0);
    let max_tool_rounds = obj.and_then(|o| o.get("maxToolRounds")).or_else(|| header.get("maxToolRounds")).and_then(Value::as_u64).filter(|n| *n > 0);
    let wrap_up_at_ms = obj.and_then(|o| o.get("wrapUpAtMs")).or_else(|| header.get("wrapUpAtMs")).and_then(Value::as_i64);
    if max_tool_calls.is_some() || max_tool_rounds.is_some() || wrap_up_at_ms.is_some() {
        return Some(TurnLimits { max_tool_calls, wrap_up_at_ms, max_tool_rounds });
    }
    let is_heartbeat = header.get("heartbeat") == Some(&Value::Bool(true))
        || header.get("isHeartbeat") == Some(&Value::Bool(true))
        || header.get("routineKind").and_then(Value::as_str) == Some("heartbeat");
    is_heartbeat.then_some(TurnLimits {
        max_tool_calls: Some(HEARTBEAT_MAX_TOOL_CALLS),
        wrap_up_at_ms: Some(now_ms + HEARTBEAT_WRAP_UP_MS),
        max_tool_rounds: None,
    })
}

fn append_text_to_input(input: &Value, extra: &str) -> Value {
    if extra.trim().is_empty() {
        return input.clone();
    }
    let mut out = input.clone();
    match out.get_mut("content") {
        Some(Value::String(text)) => {
            if text.is_empty() {
                text.push_str(extra);
            } else {
                text.push_str("\n\n");
                text.push_str(extra);
            }
        }
        Some(Value::Array(parts)) => {
            parts.push(json!({ "type": "text", "text": extra }));
        }
        _ => {
            out["content"] = Value::String(extra.to_owned());
        }
    }
    out
}

fn input_from_steers(steers: &[SteerInput], extras: &[String]) -> Value {
    let mut parts: Vec<Value> = Vec::new();
    let mut all_text = true;
    for steer in steers {
        match &steer.content {
            Value::String(text) => {
                if !text.is_empty() {
                    parts.push(json!({ "type": "text", "text": text }));
                }
            }
            Value::Array(items) => {
                all_text = false;
                parts.extend(items.iter().cloned());
            }
            _ => {}
        }
    }
    for extra in extras {
        if !extra.trim().is_empty() {
            parts.push(json!({ "type": "text", "text": extra }));
        }
    }
    if all_text {
        let joined = parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n\n");
        json!({ "role": "user", "content": joined })
    } else {
        json!({ "role": "user", "content": parts })
    }
}

async fn commit_hidden_message(port: &RunPort, rows: &StoredRows, message: &AgentMessage) -> Result<(ItemId, Value), RunError> {
    let iid = new_item_id();
    let body = row_of(message);
    let role = body.get("role").and_then(Value::as_str).unwrap_or("user").to_owned();
    rows.record(message, body.clone());
    port.commit_item(ItemCommit { iid: iid.clone(), role: Some(role), model: true, visible: false, body: body.clone(), prompt: None }).await?;
    Ok((iid, body))
}

/// The agents that run turns outside Mixdog's loop.
#[async_trait]
pub trait OutsideAgents: Send + Sync + 'static {
    /// The route `header` names is one of these agents'.
    fn serves(&self, header: &Header) -> bool;
    /// The agent of the route `header` names cannot run now (turned off, not installed, signed out, failed to start):
    /// what it says why. `None` for an agent that can run, and for one whose turn waits for it.
    fn refusal(&self, _header: &Header) -> Option<String> {
        None
    }
    /// The refusal of [`Self::refusal`] is the agent's sign-in not holding: the turn's failure is then a provider's
    /// authentication failure.
    fn signed_out(&self, _header: &Header) -> bool {
        false
    }
    /// The input row `input` is something to tell the agent. One that is not (the turn of a reply the agent began on
    /// its own) is sent to nobody, so it carries no reminders.
    fn prompts(&self, input: &Value) -> bool;
    /// Runs the turn to its outcome.
    async fn run(&self, turn: OutsideTurn) -> RunOutcome;
    /// A turn of `thread` that began on an agent's route ended before it was handed to the agent, for the reason `why`.
    async fn unrun(&self, thread: &ThreadId, why: &str);
    /// A turn of the loop begins on `header`: what an agent holds of the thread is not continued past it. The change
    /// that takes the agent's own session out of the header, if the header names one; the turn starts once the session
    /// holds it.
    fn loop_turn(&self, thread: &ThreadId, header: &Header) -> Option<mixdog_store::schema::record::HeaderChange>;
}

/// Hears the calls an outside agent's turn runs as the loop's observer hears its own: a wait on the user's approval is
/// a counted wait of the session's progress. The agent's turn, which marks the spinner for every step it takes, reads
/// the wait there and marks it in order with its other steps.
struct HandedObserver {
    progress: watch::Sender<RunProgress>,
    clock: Arc<dyn Clock>,
}

impl RunObserver for HandedObserver {
    fn event(&self, event: RunEvent) {
        let RunEvent::Stage(Stage::ApprovalWait { waiting }) = event else { return };
        let now = self.clock.now_ms();
        self.progress.send_modify(|progress| progress.approval_wait(waiting, now));
    }

    // No text of Mixdog's is shown in a turn an agent outside the loop runs.
    fn can_retract(&self) -> bool {
        false
    }

    fn retract_text(&self, _: TextRetraction) -> Retracted {
        Retracted::Refused
    }
}

/// The tool side of a turn's assembly, for a turn no provider of Mixdog's answers.
pub struct OutsideAssembled {
    /// The header the tools were assembled on: the turn's, or the one a tool-exposure migration left.
    pub header: Header,
    pub tools: ToolSet,
    pub tool_env: ToolEnv,
    pub gate: GateBuilder,
    /// The turn's workspace, where the review baseline is taken.
    pub worktree: String,
    pub clock: Arc<dyn Clock>,
    pub guards: Arc<dyn TurnGuards>,
    pub hooks: Option<Arc<dyn ToolHooks>>,
    pub reuse: Option<Arc<dyn ResultReuse>>,
    pub blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
    pub hidden_agent: bool,
    pub live_cwd: Option<mixdog_agent::tools::LiveCwd>,
    /// Where a call's large result is stored, as a call of the loop's is.
    pub artifacts: Option<Arc<dyn mixdog_agent::offload::ArtifactStore>>,
    pub images: Option<Arc<dyn mixdog_agent::offload::ImageCompactor>>,
    pub failures: Option<Arc<dyn mixdog_agent::env::ToolFailureLog>>,
    /// The session's repeat guards, as its record holds them.
    pub repeat: mixdog_agent::tools::RepeatGuards,
    /// The token budget a summary of the conversation for the agent is sized by.
    pub handoff_budget_tokens: u64,
    /// The session's compaction policy, over the window its header holds (the agent's own, once it reported one);
    /// `None` with automatic compaction off or no window known.
    pub compact: Option<mixdog_agent::boundary::CompactPolicy>,
    /// The session's raw compaction settings, used to resolve policy dynamically for live windows and continuation rounds.
    pub compact_settings: Option<mixdog_agent::boundary::CompactSettings>,
    /// The session's reading of its context: what the agent last reported it holds. `None` with no reading, or one
    /// a compaction left behind.
    pub context_tokens: Option<u64>,
    pub limits: Option<TurnLimits>,
    pub skills: Option<SkillsBuilder>,
    pub reaction_targets: Option<Arc<ReactionTargets>>,
    pub vision: Option<Arc<dyn ModelVision>>,
    pub tail: Option<Arc<dyn mixdog_agent::env::TailReminder>>,
    pub route: Option<Arc<mixdog_core_run::run_host::route_fallback::RouteHop>>,
    pub switch_bus: Option<Arc<RouteSwitchBus>>,
}

/// One turn, begun, as its agent takes it.
pub struct OutsideTurn {
    pub thread: ThreadId,
    pub turn: TurnId,
    /// The header the turn runs on: reconciled, its prompt current.
    pub header: Header,
    /// The input row as it is sent: the turn's context ahead of the prompt, its reminders behind it.
    pub input: Value,
    pub port: RunPort,
    pub cancel: tokio_util::sync::CancellationToken,
    pub progress: watch::Sender<RunProgress>,
    pub transcript: Option<TurnTranscript>,
    /// The session's tools, each call run as the loop runs one.
    pub calls: Arc<HandedCalls>,
    /// The conversation the session holds from before this turn.
    pub history: History,
    /// The hook of the job that owns a sub-agent's turn (`AgentTurn.hooks.on_tool_result`): told each tool result
    /// the turn gains, as the loop's sink tells it.
    pub on_tool_result: Option<Arc<ToldResult>>,
    /// What the agent tells of its turn for the turn's end.
    pub report: Arc<OutsideReport>,
}

/// What an agent tells of its turn for the turn's end, besides its outcome, as the loop's run tells its own.
#[derive(Debug, Default)]
pub struct OutsideReport {
    /// The usage the agent reported for the turn, and whether its input leaves its cache reads out: what the ask of a
    /// finished turn is settled with.
    pub usage: Mutex<Option<(mixdog_core_api::domain::provider::Usage, bool)>>,
    /// Set once the outside agent emits any visible output (text, reasoning, tool call, image card, or visible row).
    pub output_produced: Arc<std::sync::atomic::AtomicBool>,
}

impl OutsideReport {
    pub fn mark_output(&self) {
        self.output_produced.store(true, Ordering::SeqCst);
    }

    pub fn output_produced(&self) -> bool {
        self.output_produced.load(Ordering::SeqCst)
    }
}

/// A job's hook for the tool results its turn gains.
pub type ToldResult = dyn Fn(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage) + Send + Sync;

/// The conversation a session holds from before a turn, for an agent that starts without it.
pub struct History {
    port: RunPort,
    /// Live reader of the session's model context (all rows since last compaction except `turn_input.0`).
    context: mixdog_core_session::session::run::ModelContext,
    rows: Vec<(ItemId, Value)>,
    input: (ItemId, Value),
    /// The turn's original input row whose id `ModelContext::read` excludes; kept separate from `input` on continuation rounds.
    turn_input: (ItemId, Value),
    /// Hidden rows committed right after `input` before handoff (e.g. sourced preloaded skill bodies) that must be
    /// preserved in a fresh-session compaction replacement for replay and future skill-update detection.
    after_input: Vec<(ItemId, Value)>,
    /// The model context as a run of the loop left it when a route hop handed the turn to the agent, the turn's input in
    /// its place: what the loop did of the turn, which the agent is told with the rest. Empty for a turn the agent runs
    /// from its start, or one the loop added nothing to.
    taken_over: Vec<(ItemId, Value)>,
    /// How many rows the session's model context holds ahead of the turn's input: the rows before the turn, or the
    /// summary a compaction of this turn stored in their place.
    held: Arc<std::sync::atomic::AtomicUsize>,
    /// When the session's context was last compacted, by its header.
    compacted_at: Option<f64>,
    budget_tokens: u64,
    compact_settings: Option<mixdog_agent::boundary::CompactSettings>,
    is_continuation: bool,
    clock: Arc<dyn Clock>,
    /// The session's reading of the agent's context and the trigger it reached, when it reached it.
    due: Option<(u64, u64)>,
}

/// The reading and the trigger of a context that reached the session's compaction trigger: the pressure a provider's
/// session reads before a request is the prompt its provider last measured, and an agent's is what the agent last
/// reported it holds.
fn due(policy: Option<&mixdog_agent::boundary::CompactPolicy>, context_tokens: Option<u64>) -> Option<(u64, u64)> {
    let (policy, used) = policy.zip(context_tokens)?;
    let trigger = policy.trigger_tokens.max(1);
    (used >= trigger).then_some((used, trigger))
}

fn header_positive_u64(header: &Header, key: &str) -> Option<u64> {
    let n = header.get(key).and_then(Value::as_f64)?.floor();
    (n.is_finite() && n >= 1.0).then_some(n as u64)
}

fn header_compacted_at(header: &Header) -> Option<f64> {
    header.get("compaction")?.get("lastCompactAt")?.as_f64()
}

fn header_context_tokens(header: &Header) -> Option<u64> {
    if header.get("lastContextTokensStaleAfterCompact") == Some(&Value::Bool(true)) {
        return None;
    }
    header_positive_u64(header, "lastContextTokens")
}

fn resolve_policy_for_window(
    settings: Option<&mixdog_agent::boundary::CompactSettings>,
    effective_window: Option<u64>,
) -> Option<mixdog_agent::boundary::CompactPolicy> {
    let mut settings = settings?.clone();
    if let Some(window) = effective_window.filter(|window| *window > 0) {
        settings.context_window = Some(window);
        if let Some(boundary) = settings.explicit_boundary.as_mut() {
            *boundary = (*boundary).min(window);
        }
    }
    mixdog_agent::boundary::CompactPolicy::resolve(&settings).filter(|policy| policy.boundary_tokens > 0)
}

fn header_window_policy(settings: Option<&mixdog_agent::boundary::CompactSettings>, header: &Header) -> Option<mixdog_agent::boundary::CompactPolicy> {
    let mut settings = settings?.clone();
    if let Some(window) = header_positive_u64(header, "contextWindow") {
        settings.context_window = Some(window);
    }
    if let Some(boundary) = header_positive_u64(header, "compactBoundaryTokens") {
        settings.explicit_boundary = Some(boundary);
    }
    if let Some(limit) = header_positive_u64(header, "autoCompactTokenLimit") {
        settings.auto_limit = Some(limit);
    }
    mixdog_agent::boundary::CompactPolicy::resolve(&settings).filter(|policy| policy.boundary_tokens > 0)
}

impl History {
    /// A row produced by a model or tool in an earlier turn, excluding synthetic context acks.
    fn is_reply(row: &Value) -> bool {
        match row.get("role").and_then(Value::as_str) {
            Some("assistant") => row.pointer("/meta/source").and_then(Value::as_str) != Some("context-ack"),
            Some("tool") => true,
            _ => false,
        }
    }

    /// A user row of a turn that failed with no reply recorded after it.
    fn is_unanswered_failed_user(rows: &[&Value], index: usize) -> bool {
        let row = rows[index];
        row.get("role").and_then(Value::as_str) == Some("user")
            && row.pointer("/meta/transcript/completion/status").and_then(Value::as_str) == Some("failed")
            && !rows[index + 1..].iter().any(|later| Self::is_reply(later))
    }

    /// The session holds a conversation from before the turn, or a run of the loop left part of the turn done.
    pub fn holds_conversation(&self) -> bool {
        if !self.taken_over.is_empty() {
            return true;
        }
        use mixdog_core_ports::ports::route::is_summary_anchor;
        use mixdog_core_session::session::route_session::has_user_conversation;
        let user = self.rows.iter().any(|(_, row)| has_user_conversation(std::slice::from_ref(row)));
        let reply = self.rows.iter().any(|(_, row)| Self::is_reply(row) || is_summary_anchor(row));
        user && reply
    }

    /// The rows the agent is told: the conversation before the turn, or all a run of the loop left of it.
    fn told_rows(&self) -> &[(ItemId, Value)] {
        if self.taken_over.is_empty() { &self.rows } else { &self.taken_over }
    }

    /// The summary an earlier compaction left standing for the conversation, handed over as it stands; none once a run
    /// of the loop did part of the turn, which a summary is made of.
    fn standing(&self) -> Option<Result<String, String>> {
        if !self.taken_over.is_empty() {
            return None;
        }
        Self::standing_summary(&self.rows.iter().map(|(_, row)| row).collect::<Vec<_>>(), self.compacted_at)
    }

    /// The summary an earlier compaction left in `rows`, where they hold nothing the user said since: the text an agent
    /// is handed as it stands. `None` for rows that hold a conversation, or no summary. A request the compaction of
    /// `compacted_at` kept beside its summary was said before it, and is part of what it left.
    fn standing_summary(rows: &[&Value], compacted_at: Option<f64>) -> Option<Result<String, String>> {
        use mixdog_core_ports::ports::route::is_summary_anchor;
        use mixdog_core_session::session::route_session::has_user_conversation;
        let summarized = rows.iter().any(|row| is_summary_anchor(row));
        let kept =
            |row: &Value| row.pointer("/meta/transcript/at").and_then(Value::as_f64).zip(compacted_at).is_some_and(|(said, compacted)| said <= compacted);
        let conversation = rows
            .iter()
            .enumerate()
            .any(|(i, row)| !Self::is_unanswered_failed_user(rows, i) && !kept(row) && has_user_conversation(std::slice::from_ref(*row)));
        (summarized && !conversation).then(|| {
            Self::told(
                rows.iter()
                    .enumerate()
                    .filter(|&(i, row)| row.get("role").and_then(Value::as_str) != Some("system") && !Self::is_unanswered_failed_user(rows, i))
                    .map(|(_, row)| *row),
            )
        })
    }

    /// Text of `message` for an ACP handover/compaction summary: carries no old image bytes, replacing each image
    /// part with a short text mark naming what it was. Only tool-produced images suggest capturing or reading again;
    /// user-attached images cannot be re-captured by the agent.
    fn told_text(message: &mixdog_agent::message::AgentMessage, tool_name: Option<&str>) -> String {
        use mixdog_core_api::domain::provider::Content;
        use mixdog_core_api::domain::provider::ContentPart;
        use mixdog_core_api::domain::provider::ImageSource;
        let mark = |what: String| {
            if message.role() == Role::Tool {
                format!("[image omitted from summary: {what}; capture or read again if needed]")
            } else {
                format!("[image omitted from summary: {what}]")
            }
        };
        match &message.message.content {
            Content::Text(text) => text.to_string(),
            Content::Parts(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text(text, _) if !text.is_empty() => Some(text.clone()),
                    ContentPart::Image(source) => {
                        let what = match (tool_name, source) {
                            (Some(tool), ImageSource::Base64 { mime_type, .. }) if !mime_type.is_empty() => format!("{tool} ({mime_type})"),
                            (Some(tool), _) => tool.to_owned(),
                            (None, ImageSource::Base64 { mime_type, .. }) if !mime_type.is_empty() => mime_type.clone(),
                            (None, _) => "image".to_owned(),
                        };
                        Some(mark(what))
                    }
                    ContentPart::File { mime_type, filename, text: None, .. } if mime_type.trim().to_ascii_lowercase().starts_with("image/") => {
                        let what = filename.as_deref().map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned).unwrap_or_else(|| match tool_name {
                            Some(tool) => format!("{tool} ({mime_type})"),
                            None => mime_type.clone(),
                        });
                        Some(mark(what))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }

    /// `rows` as the text an agent reads: each row that says something or calls a tool, under who said it.
    fn told<'a>(rows: impl IntoIterator<Item = &'a Value>) -> Result<String, String> {
        let mut decoded = Vec::new();
        for row in rows {
            let message = message_of(row).map_err(|error| format!("the summary holds a row this build cannot read: {error}"))?;
            decoded.push(message);
        }
        let mut call_names: HashMap<&str, &str> = HashMap::new();
        for message in &decoded {
            if message.role() == Role::Assistant {
                for call in message.tool_calls() {
                    call_names.insert(call.id.as_str(), call.name.as_str());
                }
            }
        }
        let mut text = Vec::new();
        for message in &decoded {
            let name = (message.role() == Role::Tool).then(|| message.tool_call_id().and_then(|id| call_names.get(id).copied())).flatten();
            let said = Self::told_text(message, name);
            let trimmed = mixdog_js::js_trim(&said);
            match message.role() {
                Role::Assistant => {
                    let mut parts = Vec::new();
                    if !trimmed.is_empty() {
                        parts.push(said);
                    }
                    for call in message.tool_calls() {
                        let args = match &call.arguments {
                            Value::String(s) => s.clone(),
                            Value::Null => "{}".to_owned(),
                            other => mixdog_js::json_stringify(other),
                        };
                        parts.push(format!("[tool call] {}({args})", call.name));
                    }
                    if !parts.is_empty() {
                        text.push(format!("## Assistant\n{}", parts.join("\n")));
                    }
                }
                Role::Tool => {
                    if !trimmed.is_empty() || name.is_some() {
                        let heading = match name {
                            Some(name) => format!("## Tool result ({name})"),
                            None => "## Tool result".to_owned(),
                        };
                        let body = if trimmed.is_empty() { "(empty result)".to_owned() } else { said };
                        text.push(format!("{heading}\n{body}"));
                    }
                }
                _ => {
                    if !trimmed.is_empty() {
                        text.push(format!("## User\n{said}"));
                    }
                }
            }
        }
        Ok(text.join("\n\n"))
    }

    /// Summarizes the conversation with the session's own compactor, makes the result the session's stored context, and
    /// returns it as text for the agent: what a run of the loop did of the turn before a route hop handed it over is in
    /// it. A context that holds only the summary of an earlier compaction is handed over as it stands; `None` for a
    /// session with neither. A summary that cannot be made, or stored, is the error.
    pub async fn hand_over(&self) -> Result<Option<String>, String> {
        if let Some(summary) = self.standing() {
            return summary.map(Some);
        }
        if !self.holds_conversation() {
            return Ok(None);
        }
        self.summarize().await.map(Some)
    }

    /// Whether [`Self::hand_over`] has a summary to make: a conversation with no earlier summary standing for it.
    pub fn hand_over_summarizes(&self) -> bool {
        self.standing().is_none() && self.holds_conversation()
    }

    /// The agent's context reached the session's compaction trigger: the reading and the trigger.
    pub fn compaction_due(&self) -> Option<(u64, u64)> {
        self.due
    }

    /// The session's automatic compaction trigger (in tokens) when running under `effective_window`, or `None` when
    /// automatic compaction is off.
    pub fn auto_compaction_trigger(&self, effective_window: u64) -> Option<u64> {
        resolve_policy_for_window(self.compact_settings.as_ref(), Some(effective_window)).map(|policy| policy.trigger_tokens.max(1))
    }

    /// The session's automatic compaction, for a context the agent holds: the header stops naming the agent's session,
    /// which holds what the summary replaces, and the stored conversation is summarized as [`Self::hand_over`]
    /// summarizes it, whatever it holds since an earlier summary (the agent's own turns are in it). The session is left
    /// first: a stop between the two writes leaves a conversation whose next turn hands it over, never a summary under a
    /// header that still names the session it replaced. `None` for a session whose stored context is empty; an error
    /// may come after the session was left.
    pub async fn compact(&self) -> Result<Option<String>, String> {
        if self.is_continuation {
            let live = self.splice_turn_input(&self.rows);
            return self.compact_live_rows(&live, self.budget_tokens).await;
        }
        if self.told_rows().iter().all(|(_, row)| row.get("role").and_then(Value::as_str) == Some("system")) {
            return Ok(None);
        }
        self.unset_agent_session().await?;
        let summary = self.summarize().await?;
        Ok(Some(self.with_compaction_reminder(summary).await))
    }

    /// `summary` with what a compaction before a provider's send gives the request it keeps: the session's Goal and its
    /// open step list, which the summary took the tool results of. The agent that goes on reads them with the summary.
    async fn with_compaction_reminder(&self, summary: String) -> String {
        match self.port.compaction_goal_reminder(false).await.ok().flatten() {
            Some(reminder) => {
                let _ = self.port.acknowledge_goal_reminder(reminder.revision).await;
                format!("{summary}\n\n{}", reminder.content)
            }
            None => summary,
        }
    }

    /// Compacts the live in-progress conversation mid-turn (including this turn's input and every assistant/tool row
    /// committed during the turn), leaves the agent's session behind, stores Mixdog's summary as the session's context,
    /// and returns it as text for the fresh agent session.
    pub async fn compact_mid_turn(&self, effective_window: Option<u64>) -> Result<Option<String>, String> {
        let live_rows = self.context.read().await.map_err(|error| format!("the live conversation could not be read for mid-turn compaction: {error:?}"))?;
        let full = self.splice_turn_input(&live_rows);
        let budget = resolve_policy_for_window(self.compact_settings.as_ref(), effective_window)
            .map(|policy| policy.target_budget())
            .unwrap_or(self.budget_tokens)
            .max(super::super::inheritance_fit::MIN_COMPACT_BUDGET_TOKENS);
        self.compact_live_rows(&full, budget).await
    }

    fn splice_turn_input(&self, live_rows: &[(ItemId, Value)]) -> Vec<(ItemId, Value)> {
        let at = self.held.load(Ordering::SeqCst).min(live_rows.len());
        let mut full = Vec::with_capacity(live_rows.len() + 1);
        full.extend_from_slice(&live_rows[..at]);
        full.push(self.turn_input.clone());
        full.extend_from_slice(&live_rows[at..]);
        full
    }

    async fn unset_agent_session(&self) -> Result<(), String> {
        let unset = vec![mixdog_core_session::session::turn_ops::AGENT_SESSION.to_owned()];
        let left = mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset, patch: Default::default() };
        self.port.save_header(left).await.map_err(|error| format!("the agent's session could not be left behind: {error:?}"))
    }

    async fn compact_live_rows(&self, full: &[(ItemId, Value)], budget_tokens: u64) -> Result<Option<String>, String> {
        if full.iter().all(|(_, row)| row.get("role").and_then(Value::as_str) == Some("system")) {
            return Ok(None);
        }
        self.unset_agent_session().await?;
        let summary = self.summarize_rows(full, &self.turn_input, budget_tokens, true).await?;
        Ok(Some(self.with_compaction_reminder(summary).await))
    }

    /// Summarizes the stored conversation with the session's own compactor, stores the result as the session's
    /// context and returns it as text.
    async fn summarize(&self) -> Result<String, String> {
        self.summarize_rows(self.told_rows(), &self.input, self.budget_tokens, false).await
    }

    async fn summarize_rows(
        &self,
        told: &[(ItemId, Value)],
        anchor_input: &(ItemId, Value),
        budget_tokens: u64,
        include_input_in_text: bool,
    ) -> Result<String, String> {
        let rows: Vec<Value> = told.iter().map(|(_, row)| row.clone()).collect();
        let compacted = self.port.compact_for_heir(&rows, budget_tokens).await.map_err(|error| error.to_string())?;
        let message_id = |row: &Value| message_of(row).ok().and_then(|message| message.message_id);
        let non_system: Vec<Value> = compacted
            .ok_or_else(|| "this session has no compaction to summarize it with".to_owned())?
            .into_iter()
            .filter(|row| row.get("role").and_then(Value::as_str) != Some("system"))
            .collect();
        let input_id = message_id(&anchor_input.1);
        let input_pos = non_system.iter().position(|row| match &input_id {
            Some(id) => message_id(row).as_deref() == Some(id.as_str()),
            None => (include_input_in_text || !self.taken_over.is_empty()) && row == &anchor_input.1,
        });
        // Rows from before the turn stay ahead of `anchor_input`; retained tool/reply rows from this turn stay after it.
        let (before, after): (Vec<Value>, Vec<Value>) = match input_pos {
            Some(pos) => (non_system[..pos].to_vec(), non_system[pos + 1..].to_vec()),
            None => {
                let after_input = told
                    .iter()
                    .position(|(item, row)| item == &anchor_input.0 || input_id.as_deref().is_some_and(|id| message_id(row).as_deref() == Some(id)))
                    .map(|pos| &told[pos + 1..])
                    .unwrap_or(&[]);
                let after_ids: std::collections::HashSet<String> = after_input.iter().filter_map(|(_, row)| message_id(row)).collect();
                let after_calls: std::collections::HashSet<String> = after_input
                    .iter()
                    .filter_map(|(_, row)| message_of(row).ok())
                    .flat_map(|m| m.tool_calls().iter().map(|c| c.id.clone()).chain(m.tool_call_id().map(str::to_owned)).collect::<Vec<_>>())
                    .collect();
                let split = non_system.iter().position(|row| {
                    message_id(row).is_some_and(|id| after_ids.contains(&id))
                        || message_of(row).ok().is_some_and(|m| {
                            m.tool_calls().iter().any(|c| after_calls.contains(&c.id)) || m.tool_call_id().is_some_and(|id| after_calls.contains(id))
                        })
                });
                match split {
                    Some(pos) => (non_system[..pos].to_vec(), non_system[pos..].to_vec()),
                    None => (non_system.clone(), Vec::new()),
                }
            }
        };
        let text = if include_input_in_text { Self::told(non_system.iter())? } else { Self::told(before.iter().chain(after.iter()))? };
        let mut replacement = Vec::with_capacity(before.len() + 1 + after.len() + self.after_input.len());
        let item_of: HashMap<String, ItemId> = told.iter().filter_map(|(item, row)| Some((message_id(row)?, item.clone()))).collect();
        let mut present_ids: std::collections::HashSet<ItemId> = std::collections::HashSet::new();
        let push_rows = |out: &mut Vec<(ItemId, Value)>, present: &mut std::collections::HashSet<ItemId>, slice: &[Value]| {
            for row in slice {
                let id = message_id(row);
                let item_id = id.as_ref().and_then(|id| item_of.get(id)).cloned().unwrap_or_else(new_item_id);
                present.insert(item_id.clone());
                out.push((item_id, row.clone()));
            }
        };
        push_rows(&mut replacement, &mut present_ids, &before);
        // The calls the summary took out leave the session's context: the ids of the calls that enter it from here on
        // are told apart from theirs.
        self.port.calls_left(self.port.call_epoch() + 1);
        present_ids.insert(anchor_input.0.clone());
        replacement.push(anchor_input.clone());
        push_rows(&mut replacement, &mut present_ids, &after);
        for (iid, body) in &self.after_input {
            if present_ids.insert(iid.clone()) {
                replacement.push((iid.clone(), body.clone()));
            }
        }
        let kept_count = if include_input_in_text || !self.taken_over.is_empty() { replacement.len() } else { before.len() + after.len() };
        let compaction = Compaction { replacement, at: self.clock.now_ms(), dropped_count: rows.len().saturating_sub(kept_count) as u64, dropped: None };
        self.port.compacted(compaction).await.map_err(|error| format!("the summary could not be stored: {error:?}"))?;
        self.held.store(before.len(), Ordering::SeqCst);
        // The reading was of the context the summary replaced: the session has none until the agent reports again.
        let now = mixdog_js::json_number(self.clock.now_ms() as f64);
        let set = [("lastContextTokens", json!(0)), ("lastContextTokensUpdatedAt", now), ("lastContextTokensStaleAfterCompact", json!(false))]
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect();
        let read = mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() };
        // The summary is stored: a failed reset is no failed compaction, or the turn would go on in the session it replaced.
        if let Err(error) = self.port.save_header(read).await {
            tracing::warn!("[session] the context reading could not be reset after a compaction: {error:?}");
        }
        Ok(text)
    }
}

/// What [`drive_outside`] takes over from the turn's start.
pub(super) struct Outside {
    pub(super) parts: Arc<dyn RunParts>,
    pub(super) agents: Arc<dyn OutsideAgents>,
    pub(super) thread: ThreadId,
    pub(super) turn: TurnId,
    pub(super) header: Header,
    pub(super) port: RunPort,
    pub(super) context: mixdog_core_session::session::run::ModelContext,
    pub(super) surface: watch::Receiver<Arc<SessionSurface>>,
    pub(super) progress: watch::Sender<RunProgress>,
    pub(super) tool_progress: Arc<dyn mixdog_core_api::domain::tool::ProgressSink>,
    pub(super) hints: ToolHints,
    pub(super) cancel: tokio_util::sync::CancellationToken,
    /// The same cancellation with the reason it was stopped for.
    pub(super) signal: mixdog_agent::cancel::Cancel,
    pub(super) review: TurnSnapshot,
    pub(super) input_body: Value,
    pub(super) input_item: ItemId,
    pub(super) stored_ids: Vec<ItemId>,
    pub(super) prior: Vec<Value>,
    pub(super) injected: bool,
    pub(super) goal_reminder: Option<GoalReminder>,
    pub(super) notice: CarriedNotice,
    pub(super) transcript: Option<TurnTranscript>,
    pub(super) turn_context: String,
    pub(super) unattended: bool,
    pub(super) generation: u64,
    pub(super) request: String,
    pub(super) asked: Arc<std::sync::atomic::AtomicBool>,
    pub(super) handover: Arc<AgentReach>,
    pub(super) rebound: bool,
    pub(super) rebind_owed: bool,
    /// What an agent-owned turn was given by the job that owns it (`AgentTurn`): the lane's admission lease, the
    /// completion hook its tools reach and the hook told each tool result.
    pub(super) slot: Option<Arc<dyn mixdog_agent::env::Yielder>>,
    pub(super) notify: Option<mixdog_core_api::domain::tool::ToolNotify>,
    pub(super) on_tool_result: Option<Arc<ToolResultCallback>>,
    /// The turn comes from a run of the loop that a route hop ended: its input is carried already, and this is the model
    /// context the run left, the input in its place ([`History`]). `None` for a turn the agent runs from its start.
    pub(super) taken_over: Option<Vec<(ItemId, Value)>>,
    /// The loop half of the turn already produced work before handing over, so a user stop does not rewind the prompt.
    pub(super) loop_produced: bool,
    /// The turn's already-started guards from the loop half of the turn, preserved across mid-turn hand-over.
    pub(super) guards: Option<Arc<dyn TurnGuards>>,
    /// The trusted text a routine's skill is selected from (`AgentTurn.skill_selection`).
    pub(super) skill_selection: Option<String>,
    /// Hidden rows already committed right after `input_body` in an earlier phase of this turn.
    pub(super) committed_after_input: Vec<(ItemId, Value)>,
    /// Reminders and prompt carry already ran for this turn on an earlier route phase.
    pub(super) already_carried: bool,
}

pub(super) struct OutsideHandover {
    pub(super) old_header: Header,
    pub(super) input_body: Value,
    pub(super) stored_ids: Vec<ItemId>,
    pub(super) prior: Vec<Value>,
    pub(super) committed_after_input: Vec<(ItemId, Value)>,
    pub(super) goal_reminder: Option<GoalReminder>,
    pub(super) notice: CarriedNotice,
    pub(super) guards: Arc<dyn TurnGuards>,
}

pub(super) enum OutsideOutcome {
    Done(RunOutcome),
    SwitchLoop { preflight: Box<PreflightLoop>, notice: Option<String>, state: Box<OutsideHandover> },
    SwitchOutside { header: Header, notice: Option<String>, switch_bus: Option<Arc<RouteSwitchBus>>, state: Box<OutsideHandover> },
}

fn acp_failover_error(error: &TurnError, agents: &dyn OutsideAgents, header: &Header) -> Option<mixdog_core_api::domain::provider::ProviderError> {
    use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError};
    let code = error.data.get("code").and_then(Value::as_i64);
    if code == Some(-32002) {
        return None;
    }
    let reason = error.data.get("reason").and_then(Value::as_str);
    let mut kind = if reason == Some("acpAgentAccount") || code == Some(-32000) {
        Some(ErrorKind::Auth)
    } else if let Some(detail) = &error.provider_error {
        match detail.kind.as_str() {
            "auth" => Some(ErrorKind::Auth),
            "quota_exhausted" => Some(ErrorKind::QuotaExhausted),
            "billing" => Some(ErrorKind::Billing),
            "entitlement" => Some(ErrorKind::Entitlement),
            "permission" => Some(ErrorKind::Permission),
            "rate_limited" => Some(ErrorKind::RateLimited),
            "overloaded" => Some(ErrorKind::Overloaded),
            "service_tier_unavailable" => Some(ErrorKind::ServiceTierUnavailable),
            "transient" => Some(ErrorKind::Transient),
            _ => None,
        }
    } else {
        None
    };
    let mut status = error.provider_error.as_ref().and_then(|detail| detail.status);
    if kind.is_none() && (error.data.get("prePromptRefusal") == Some(&Value::Bool(true)) || agents.refusal(header).is_some()) {
        if agents.signed_out(header) {
            kind = Some(ErrorKind::Auth);
        } else {
            kind = Some(ErrorKind::Transient);
            status = status.or(Some(503));
        }
    }
    let kind = kind?;
    if kind == ErrorKind::Transient {
        status = status.or(Some(503));
    }
    let mut out = ProviderError::new(kind, DeliveryState::NotSent);
    out.message.clone_from(&error.message);
    out.status = status;
    out.code = code.map(|c| c.to_string());
    Some(out)
}

fn route_moved(before: &mixdog_store::schema::record::Header, after: &mixdog_store::schema::record::Header) -> bool {
    ["owner", "provider", "model", "effort", "fast", "routeFallbackIndex"].into_iter().any(|key| before.get(key) != after.get(key))
}

pub(super) async fn drive_outside(outside: Outside) -> OutsideOutcome {
    let Outside {
        parts,
        agents,
        thread,
        turn,
        header,
        port,
        context,
        surface,
        progress,
        tool_progress,
        hints,
        cancel,
        signal,
        review,
        input_body,
        input_item,
        stored_ids,
        prior,
        injected,
        goal_reminder,
        notice,
        transcript,
        turn_context,
        unattended,
        generation,
        request,
        asked,
        handover,
        rebound,
        rebind_owed,
        slot,
        notify,
        on_tool_result,
        taken_over,
        loop_produced,
        guards,
        skill_selection,
        committed_after_input,
        already_carried,
    } = outside;
    let surface_now = surface.borrow().clone();
    let assembled = parts
        .assemble_outside(AssembleInput {
            thread: &thread,
            turn: &turn,
            header: &header,
            surface: surface_now,
            port: &port,
            surface_rx: surface.clone(),
            slot: None,
            skill_selection: skill_selection.clone(),
            prior: &prior,
            generation,
            request: &request,
            injected,
            cancel: &cancel,
            unattended,
            notify,
            progress: tool_progress,
            agent_refusal: None,
            guards,
        })
        .await;
    let OutsideAssembled {
        header,
        tools,
        mut tool_env,
        gate,
        worktree,
        clock,
        guards,
        hooks,
        reuse,
        blobs,
        hidden_agent,
        live_cwd,
        artifacts,
        images,
        failures,
        repeat,
        handoff_budget_tokens,
        compact,
        compact_settings,
        context_tokens,
        limits,
        skills,
        reaction_targets,
        vision,
        tail,
        route,
        switch_bus,
    } = match assembled {
        Ok(assembled) => assembled,
        Err(error) => return OutsideOutcome::Done(RunOutcome::Failed(error)),
    };
    // The turn's tools publish each edit's card diff to the turn's review, and the agent edits with tools of its own:
    // the baseline is taken over the turn's workspace before either runs.
    tool_env.review = Some(review.api());
    review.start(&worktree);
    let prompts_turn = agents.prompts(&input_body);
    let (input_body, retried) = if !already_carried && taken_over.is_none() && prompts_turn {
        let carried = carry_turn(Carry {
            parts: &parts,
            thread: &thread,
            header: &header,
            port: &port,
            stored_ids: &stored_ids,
            prior: &prior,
            input_item: &input_item,
            input_body,
            injected,
            turn_context: &turn_context,
            goal_reminder: goal_reminder.as_ref(),
            notice: &notice,
            hidden_agent,
            config: None,
            clock: &clock,
            blobs: &blobs,
            guards: &guards,
            rebound,
            rebind_owed,
        })
        .await;
        match carried {
            Ok((input_body, retried)) => (input_body, retried),
            Err(outcome) => return OutsideOutcome::Done(outcome),
        }
    } else {
        (input_body, false)
    };
    let redactor = context.clone();
    let turn_id = turn.clone();
    let observer: Arc<dyn RunObserver> = Arc::new(HandedObserver { progress: progress.clone(), clock: clock.clone() });
    let asks = mixdog_agent::handed::JudgedAsks::over(Arc::new(port.clone()));
    let gate: Arc<dyn ToolGate> = Arc::new(ReviewGate::new(
        review,
        gate(GateContext { observer: observer.clone(), cancel: cancel.clone(), guards: guards.clone(), approvals: asks.clone() }),
    ));
    let failures = failures.map(|inner| Arc::new(SensitiveFailures { inner, context }) as Arc<dyn mixdog_agent::env::ToolFailureLog>);
    let stored_rows = Arc::new(StoredRows::new());
    let prior_messages: Vec<AgentMessage> = prior.iter().filter_map(|row| message_of(row).ok()).collect();
    for msg in &prior_messages {
        stored_rows.record_stored(msg);
    }
    if let Ok(input_msg) = message_of(&input_body) {
        stored_rows.record(&input_msg, input_body.clone());
    }
    let reaction_targets = reaction_targets.unwrap_or_else(|| Arc::new(ReactionTargets::new()));
    let _reaction_scope = ReactionScope::new(reaction_targets.clone(), thread.as_str());
    let reactions: Arc<dyn Reactions> =
        Arc::new(LoopReactions::new(thread.as_str(), reaction_targets, stored_rows.clone(), mixdog_protocol::text_class::is_internal_transcript_display_text));
    let skill_selector: Option<Arc<dyn SkillSelector>> =
        skills.map(|build| build(SkillContext { gate: gate.clone(), env: tool_env.clone(), cancel: cancel.clone() })).or_else(|| {
            tools.get("Skill").map(|skill_tool| {
                let names = Arc::new(HeaderSkillNames::from_header(&header));
                let trusted_selection = skill_selection
                    .clone()
                    .or_else(|| header.get("skillSelection").or_else(|| input_body.pointer("/meta/skillSelection")).and_then(Value::as_str).map(str::to_owned));
                Arc::new(
                    ExplicitSkillSelector::new(names, skill_tool.clone(), gate.clone(), tool_env.clone(), cancel.clone())
                        .with_selection(trusted_selection)
                        .with_deliveries(None),
                ) as Arc<dyn SkillSelector>
            })
        });
    let mut initial_outgoing_input = input_body.clone();
    let mut committed_after_input = committed_after_input;
    if already_carried {
        for (_, body) in &committed_after_input {
            if let Ok(msg) = message_of(body) {
                stored_rows.record(&msg, body.clone());
                let text = msg.text();
                if !text.trim().is_empty() {
                    initial_outgoing_input = append_text_to_input(&initial_outgoing_input, &text);
                }
            }
        }
    } else if taken_over.is_none()
        && prompts_turn
        && !cancel.is_cancelled()
        && let Some(selector) = &skill_selector
    {
        let mut extras: Vec<String> = Vec::new();
        let update_notices = selector.update_notices(&prior_messages).await;
        for notice_msg in &update_notices {
            let text = notice_msg.text();
            if !text.trim().is_empty() {
                extras.push(text);
            }
        }
        let mut selected_rows: Vec<AgentMessage> = Vec::new();
        let applied = if !injected
            && !retried
            && let Ok(input_msg) = message_of(&input_body)
        {
            selector.select(&input_msg.message.content, true, &mut selected_rows).await
        } else {
            Vec::new()
        };
        if !applied.is_empty()
            && let Err(error) = port.applied_skills(applied).await
        {
            return OutsideOutcome::Done(match error {
                RunError::Cancelled => RunOutcome::Interrupted,
                RunError::Closed | RunError::NotApplied => failed("the applied skills could not be stored", Value::Null),
            });
        }
        for notice_msg in &update_notices {
            match commit_hidden_message(&port, &stored_rows, notice_msg).await {
                Ok(committed) => committed_after_input.push(committed),
                Err(RunError::Cancelled) => return OutsideOutcome::Done(RunOutcome::Interrupted),
                Err(RunError::Closed | RunError::NotApplied) => {
                    return OutsideOutcome::Done(failed("the skill update notice could not be stored", Value::Null));
                }
            }
        }
        for skill_msg in &selected_rows {
            let text = skill_msg.text();
            if !text.trim().is_empty() {
                extras.push(text);
            }
            match commit_hidden_message(&port, &stored_rows, skill_msg).await {
                Ok(committed) => committed_after_input.push(committed),
                Err(RunError::Cancelled) => return OutsideOutcome::Done(RunOutcome::Interrupted),
                Err(RunError::Closed | RunError::NotApplied) => {
                    return OutsideOutcome::Done(failed("the skill context could not be stored", Value::Null));
                }
            }
        }
        for extra in extras {
            initial_outgoing_input = append_text_to_input(&initial_outgoing_input, &extra);
        }
    }
    let limits = limits.or_else(|| limits_from_header(&header, clock.now_ms()));
    let vision: Arc<dyn ModelVision> = match vision {
        Some(inner) => Arc::new(BoundVision {
            inner,
            provider: header.get("provider").and_then(Value::as_str).unwrap_or_default().to_owned(),
            model: header.get("model").and_then(Value::as_str).unwrap_or_default().to_owned(),
        }),
        None => Arc::new(OutsideVision::from_header(&header)),
    };
    let calls = Arc::new(HandedCalls::new(HandedParts {
        tools,
        tool_env,
        gate,
        hooks: hooks.clone(),
        guards: guards.clone(),
        reuse,
        clock: clock.clone(),
        observer,
        mcp: Some(Arc::new(ThreadMcp { parts: parts.clone(), thread: thread.clone(), surface })),
        live_cwd,
        artifacts,
        images,
        failures: failures.clone(),
        repeat,
        cancel: cancel.clone(),
        slot,
        asks: Some(asks),
        limits,
        hidden_agent,
        vision: Some(vision),
        reactions: Some(reactions),
    }));
    let held = Arc::new(std::sync::atomic::AtomicUsize::new(stored_ids.len()));
    let (stopped_item, ended_input) = (input_item.clone(), input_body.clone());
    let model = header.get("model").and_then(Value::as_str).unwrap_or_default().to_owned();
    let tail_reminder = tail.unwrap_or_else(|| super::super::tail::session_tail_reminder(super::super::tail::tail_context(&header, || None)));
    let system = system_messages(&header);
    let asked_at = clock.now_ms();
    // An unattended turn's watchdog judges the agent's work as it judges the loop's, on the progress the agent's turn marks
    // from the ask it begins (the cell's earlier ask is the session's last turn's).
    let watchdog = if unattended {
        let watched = progress.subscribe();
        let watched_turn =
            Watched { parts: &parts, thread: &thread, header: &header, hidden_agent, budget: None, signal: &signal, clock: &clock, failures, asked_at };
        arm_watchdog(watched_turn, move |now| watched.borrow().snapshot(now).filter(|snapshot| snapshot.ask_started_at >= asked_at)).await
    } else {
        None
    };
    let stalled_thread = thread.clone();
    // From here the turn's stop is the agent's turn's to close, as the loop closes its own.
    asked.store(true, Ordering::SeqCst);
    handover.reached.store(true, Ordering::SeqCst);
    // What the turn leaves is saved whenever its token fires, before or after the agent's turn ends.
    let end_port = port.closing();
    let report = Arc::new(OutsideReport::default());
    let preloaded_ids: std::collections::HashSet<ItemId> = committed_after_input.iter().map(|(iid, _)| iid.clone()).collect();
    let turn_input = (input_item.clone(), input_body.clone());
    let mut initial_history = Some(History {
        port: port.clone(),
        context: redactor.clone(),
        rows: stored_ids.into_iter().zip(prior).collect(),
        input: (input_item, input_body),
        turn_input: turn_input.clone(),
        after_input: committed_after_input.clone(),
        taken_over: taken_over.unwrap_or_default(),
        held: held.clone(),
        compacted_at: header_compacted_at(&header),
        budget_tokens: handoff_budget_tokens,
        compact_settings: compact_settings.clone(),
        is_continuation: false,
        clock: clock.clone(),
        due: due(compact.as_ref(), context_tokens),
    });
    let mut round_header = header.clone();
    let mut current_input = initial_outgoing_input;
    let mut stop_continuations: u32 = 0;
    let mut total_tool_calls: u64 = 0;
    let mut total_iterations: u32 = 0;
    let mut completed_rounds: u32 = 0;
    let outcome = 'outer: loop {
        if completed_rounds > 0 {
            match refresh_continuation_header(parts.as_ref(), &thread, &round_header, &cancel).await {
                Ok(refreshed) => round_header = refreshed,
                Err(outcome) => break 'outer outcome,
            }
        }
        let history = match initial_history.take() {
            Some(history) => history,
            None => {
                let round_policy = header_window_policy(compact_settings.as_ref(), &round_header);
                let round_context_tokens = header_context_tokens(&round_header);
                let round_budget = round_policy
                    .as_ref()
                    .map_or(handoff_budget_tokens, |policy| policy.target_budget())
                    .max(super::super::inheritance_fit::MIN_COMPACT_BUDGET_TOKENS);
                History {
                    port: port.clone(),
                    context: redactor.clone(),
                    rows: conversation_after(&redactor).await.unwrap_or_default(),
                    input: (new_item_id(), current_input.clone()),
                    turn_input: turn_input.clone(),
                    after_input: committed_after_input.clone(),
                    taken_over: Vec::new(),
                    held: held.clone(),
                    compacted_at: header_compacted_at(&round_header),
                    budget_tokens: round_budget,
                    compact_settings: compact_settings.clone(),
                    is_continuation: true,
                    clock: clock.clone(),
                    due: due(round_policy.as_ref(), round_context_tokens),
                }
            }
        };
        let prompt_input = match tail_reminder.text(&model).filter(|_| prompts_turn) {
            Some(tail) => append_text_to_input(&current_input, &tail),
            None => current_input.clone(),
        };
        let pre_progress = progress.borrow().snapshot(clock.now_ms());
        let begun = OutsideTurn {
            thread: thread.clone(),
            turn: turn.clone(),
            header: round_header.clone(),
            input: prompt_input,
            port: port.clone(),
            cancel: cancel.clone(),
            progress: progress.clone(),
            transcript: transcript.clone(),
            calls: calls.clone(),
            history,
            on_tool_result: on_tool_result.clone(),
            report: report.clone(),
        };
        if cancel.is_cancelled() || signal.is_aborted() {
            break RunOutcome::Interrupted;
        }
        let round_outcome = agents.run(begun).await;
        if !prompts_turn {
            break round_outcome;
        }
        match round_outcome {
            RunOutcome::Completed(mut result) => {
                completed_rounds += 1;
                total_tool_calls += result.tool_calls_total;
                total_iterations += result.iterations.max(1);
                if cancel.is_cancelled() || result.termination.is_some() {
                    result.tool_calls_total = total_tool_calls;
                    result.iterations = total_iterations;
                    break RunOutcome::Completed(result);
                }
                // 1. Drain queued Terminal/Next steering input before completion checks and Stop hooks.
                let drain_req = DrainRequest { stage: DrainStage::Terminal, max_priority: Priority::Next };
                let peeked = tokio::select! {
                    biased;
                    () = cancel.cancelled() => Err(RunError::Cancelled),
                    res = port.peek_steers(drain_req) => res,
                };
                if let Ok(ready) = peeked
                    && !ready.is_empty()
                {
                    let qids: Vec<_> = ready.iter().flat_map(|s| s.queued_ids.iter().cloned()).collect();
                    let claimed = port.consume_steers(drain_req, qids, clock.now_ms()).await;
                    if let Ok(claimed) = claimed
                        && !claimed.is_empty()
                    {
                        let mut extras: Vec<String> = Vec::new();
                        for steer in &claimed {
                            if steer.mode == mixdog_agent::env::SteerMode::Prompt {
                                if let Some(transcript) = &transcript {
                                    transcript.user(&steer.content);
                                }
                                if let Some(selector) = &skill_selector
                                    && let Ok(msg) = message_of(&json!({ "role": "user", "content": steer.content }))
                                {
                                    let mut skill_rows = Vec::new();
                                    let _ = selector.select(&msg.message.content, false, &mut skill_rows).await;
                                    for skill_msg in &skill_rows {
                                        let text = skill_msg.text();
                                        if !text.trim().is_empty() {
                                            extras.push(text);
                                        }
                                        match commit_hidden_message(&port, &stored_rows, skill_msg).await {
                                            Ok(_) => {}
                                            Err(RunError::Cancelled) => break 'outer RunOutcome::Interrupted,
                                            Err(RunError::Closed | RunError::NotApplied) => {
                                                break 'outer failed("the skill context could not be stored", Value::Null);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        current_input = input_from_steers(&claimed, &extras);
                        continue;
                    }
                }
                if cancel.is_cancelled() {
                    result.tool_calls_total = total_tool_calls;
                    result.iterations = total_iterations;
                    break RunOutcome::Completed(result);
                }
                // 2. Turn-completion Todo and Goal reminder audit.
                if !hidden_agent {
                    let completion = tokio::select! {
                        biased;
                        () = cancel.cancelled() => None,
                        reminder = guards.completion_reminder(calls.turn_limit_noticed()) => reminder,
                    };
                    if let Some(reminder) = completion {
                        let msg = AgentMessage::user(reminder.clone());
                        match commit_hidden_message(&port, &stored_rows, &msg).await {
                            Ok(_) => {}
                            Err(RunError::Cancelled) => break 'outer RunOutcome::Interrupted,
                            Err(RunError::Closed | RunError::NotApplied) => {
                                break 'outer failed("the completion reminder could not be stored", Value::Null);
                            }
                        }
                        current_input = json!({ "role": "user", "content": reminder });
                        continue;
                    }
                }
                if cancel.is_cancelled() {
                    result.tool_calls_total = total_tool_calls;
                    result.iterations = total_iterations;
                    break RunOutcome::Completed(result);
                }
                // 3. Stop / SubagentStop hook enforcement.
                if let Some(hooks) = &hooks {
                    let active = stop_continuations > 0;
                    let verdict = tokio::select! {
                        biased;
                        () = cancel.cancelled() => None,
                        verdict = hooks.on_stop(active) => Some(verdict),
                    };
                    let Some(verdict) = verdict else {
                        break RunOutcome::Interrupted;
                    };
                    let continued = matches!(verdict, StopVerdict::Continue(_)) && stop_continuations < STOP_CONTINUATION_LIMIT;
                    hooks.stop_settled(continued);
                    match verdict {
                        StopVerdict::Proceed => {}
                        StopVerdict::Ignored(warning) => {
                            let _ = port.notice(warning, Tone::Warn).await;
                        }
                        StopVerdict::Continue(_) if stop_continuations >= STOP_CONTINUATION_LIMIT => {
                            let _ = port
                                .notice(
                                    format!("A Stop hook blocked the stop again after {STOP_CONTINUATION_LIMIT} continuations in this turn; the turn ends."),
                                    Tone::Warn,
                                )
                                .await;
                        }
                        StopVerdict::Continue(reason) => {
                            stop_continuations += 1;
                            let text = format!("<system-reminder>\nStop hook: {reason}\n</system-reminder>");
                            let msg = AgentMessage::sourced(Source::Hook, text.clone());
                            match commit_hidden_message(&port, &stored_rows, &msg).await {
                                Ok(_) => {}
                                Err(RunError::Cancelled) => break 'outer RunOutcome::Interrupted,
                                Err(RunError::Closed | RunError::NotApplied) => {
                                    break 'outer failed("the stop hook continuation could not be stored", Value::Null);
                                }
                            }
                            current_input = json!({ "role": "user", "content": text });
                            continue;
                        }
                    }
                }
                result.tool_calls_total = total_tool_calls;
                result.iterations = total_iterations;
                break RunOutcome::Completed(result);
            }
            RunOutcome::Failed(mut error) => {
                if completed_rounds == 0
                    && !loop_produced
                    && !cancel.is_cancelled()
                    && !signal.is_aborted()
                    && let Some(route_hop) = route.as_ref()
                    && let Some(provider_error) = acp_failover_error(&error, agents.as_ref(), &round_header)
                {
                    let after_progress = progress.borrow().snapshot(clock.now_ms());
                    let streamed_output = match (&pre_progress, &after_progress) {
                        (Some(before), Some(after)) => {
                            after.last_visible_text_at != before.last_visible_text_at
                                || after.tool_started_at != before.tool_started_at
                                || (after.has_first_semantic && (!before.has_first_semantic || after.last_stream_delta_at != before.last_stream_delta_at))
                        }
                        (None, Some(after)) => after.last_visible_text_at > 0 || after.tool_started_at > 0 || after.has_first_semantic,
                        _ => false,
                    };
                    let visible_output = report.output_produced() || streamed_output;
                    let after_rows = if !visible_output { conversation_after(&redactor).await } else { None };
                    if !visible_output
                        && let Some(mut after_rows) = after_rows
                        && {
                            let at = held.load(Ordering::SeqCst).min(after_rows.len());
                            !after_rows[at..].iter().any(|(iid, _)| !preloaded_ids.contains(iid))
                        }
                    {
                        let leave_header = parts.live_header(&thread).unwrap_or_else(|| round_header.clone());
                        if cancel.is_cancelled() || signal.is_aborted() {
                            super::drive::flush_buffered_switches(switch_bus.as_ref(), &port).await;
                            break RunOutcome::Interrupted;
                        }
                        let decision = tokio::select! {
                            biased;
                            () = cancel.cancelled() => {
                                if parts.live_header(&thread).is_some_and(|live| route_moved(&leave_header, &live)) {
                                    let _ = super::drive::leave_agent(agents.as_ref(), &thread, &leave_header, &end_port, &handover).await;
                                }
                                super::drive::flush_buffered_switches(switch_bus.as_ref(), &port).await;
                                break RunOutcome::Interrupted;
                            }
                            decision = route_hop.decide(provider_error, None) => decision,
                        };
                        if cancel.is_cancelled() || signal.is_aborted() {
                            let switched = matches!(decision, mixdog_agent::env::RouteDecision::Switch(_) | mixdog_agent::env::RouteDecision::Outside(_));
                            if switched || parts.live_header(&thread).is_some_and(|live| route_moved(&leave_header, &live)) {
                                let _ = super::drive::leave_agent(agents.as_ref(), &thread, &leave_header, &end_port, &handover).await;
                            }
                            super::drive::flush_buffered_switches(switch_bus.as_ref(), &port).await;
                            break RunOutcome::Interrupted;
                        }
                        match decision {
                            mixdog_agent::env::RouteDecision::Switch(switch) => {
                                drop(watchdog);
                                hints.finish().await;
                                progress.send_modify(|p| p.evict_terminal());
                                asked.store(false, Ordering::SeqCst);
                                let at = held.load(Ordering::SeqCst).min(after_rows.len());
                                let committed_after_input = after_rows.split_off(at);
                                let (stored_ids, prior) = after_rows.into_iter().unzip();
                                return OutsideOutcome::SwitchLoop {
                                    preflight: Box::new(PreflightLoop {
                                        header: switch.request.header,
                                        provider: switch.provider,
                                        route: route_hop.clone(),
                                        switch_bus: switch_bus.clone().unwrap_or_default(),
                                        landed: true,
                                        leave_old_agent: true,
                                    }),
                                    notice: (!switch.notice.is_empty()).then_some(switch.notice),
                                    state: Box::new(OutsideHandover {
                                        old_header: leave_header,
                                        input_body: ended_input,
                                        stored_ids,
                                        prior,
                                        committed_after_input,
                                        goal_reminder,
                                        notice,
                                        guards,
                                    }),
                                };
                            }
                            mixdog_agent::env::RouteDecision::Outside(moved) => {
                                drop(watchdog);
                                hints.finish().await;
                                progress.send_modify(|p| p.evict_terminal());
                                let at = held.load(Ordering::SeqCst).min(after_rows.len());
                                let committed_after_input = after_rows.split_off(at);
                                let (stored_ids, prior) = after_rows.into_iter().unzip();
                                return OutsideOutcome::SwitchOutside {
                                    header: moved.header,
                                    notice: (!moved.notice.is_empty()).then_some(moved.notice),
                                    switch_bus: switch_bus.clone(),
                                    state: Box::new(OutsideHandover {
                                        old_header: leave_header,
                                        input_body: ended_input,
                                        stored_ids,
                                        prior,
                                        committed_after_input,
                                        goal_reminder,
                                        notice,
                                        guards,
                                    }),
                                };
                            }
                            mixdog_agent::env::RouteDecision::Surface(surface) => {
                                if !surface.error.message.is_empty() {
                                    error.message.clone_from(&surface.error.message);
                                }
                            }
                            mixdog_agent::env::RouteDecision::Fail(message) => {
                                error = TurnError { message, data: Value::Null, provider_error: None };
                            }
                        }
                    }
                }
                if let Some(hooks) = &hooks
                    && !cancel.is_cancelled()
                    && !signal.is_aborted()
                {
                    let verdict = hooks.on_stop(stop_continuations > 0).await;
                    hooks.stop_settled(false);
                    match verdict {
                        StopVerdict::Proceed => {}
                        StopVerdict::Ignored(warning) => {
                            let _ = port.notice(warning, Tone::Warn).await;
                        }
                        StopVerdict::Continue(reason) => {
                            let _ = port.notice(format!("A Stop hook blocked the stop of a turn that cannot go on; it is ignored: {reason}"), Tone::Warn).await;
                        }
                    }
                }
                break RunOutcome::Failed(error);
            }
            RunOutcome::Interrupted => break RunOutcome::Interrupted,
        }
    };
    drop(watchdog);
    OutsideOutcome::Done(
        finish_outside_turn(
            OutsideCompletion {
                parts,
                stalled_thread,
                turn_id,
                model,
                system,
                asked_at,
                held,
                stopped_item,
                ended_input,
                redactor,
                calls,
                guards,
                hints,
                signal,
                cancel,
                end_port,
                report,
                preloaded_ids,
                loop_produced: loop_produced || completed_rounds > 0,
            },
            outcome,
        )
        .await,
    )
}

/// Refreshes the persisted session header before a continuation round so the newly persisted ACP session id is
/// preserved; any reconcile error fails the continuation rather than falling back to a stale header.
#[allow(clippy::result_large_err)]
pub(super) async fn refresh_continuation_header(
    parts: &dyn RunParts,
    thread: &ThreadId,
    current: &mixdog_store::schema::record::Header,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<mixdog_store::schema::record::Header, RunOutcome> {
    let mut probe = current.clone();
    probe.shift_remove("pendingRoute");
    let refreshed = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(RunOutcome::Interrupted),
        res = parts.reconcile_turn(thread, probe, true) => res,
    };
    refreshed.map_err(RunOutcome::Failed)
}

struct OutsideCompletion {
    parts: Arc<dyn RunParts>,
    stalled_thread: ThreadId,
    turn_id: TurnId,
    model: String,
    system: Vec<AgentMessage>,
    asked_at: i64,
    held: Arc<std::sync::atomic::AtomicUsize>,
    stopped_item: ItemId,
    ended_input: Value,
    redactor: mixdog_core_session::session::run::ModelContext,
    calls: Arc<HandedCalls>,
    guards: Arc<dyn TurnGuards>,
    hints: ToolHints,
    signal: mixdog_agent::cancel::Cancel,
    cancel: tokio_util::sync::CancellationToken,
    end_port: RunPort,
    report: Arc<OutsideReport>,
    preloaded_ids: std::collections::HashSet<ItemId>,
    loop_produced: bool,
}

async fn finish_outside_turn(completion: OutsideCompletion, outcome: RunOutcome) -> RunOutcome {
    let OutsideCompletion {
        parts,
        stalled_thread,
        turn_id,
        model,
        system,
        asked_at,
        held,
        stopped_item,
        ended_input,
        redactor,
        calls,
        guards,
        hints,
        signal,
        cancel,
        end_port,
        report,
        preloaded_ids,
        loop_produced,
    } = completion;
    // The watchdog's stop is a stalled failure, as the loop's is: its sentence is the error, and the shells the turn
    // registered while it unwound are swept.
    let outcome = if !matches!(outcome, RunOutcome::Completed(_)) && signal.is_aborted() && is_watchdog_abort(&signal.reason()) {
        parts.reap_turn_shells(&stalled_thread, asked_at);
        failed(signal.reason(), Value::Null)
    } else {
        outcome
    };
    hints.finish().await;
    // The guard state that outlives one turn lives on the session record, as the loop leaves it, and so does the turn's
    // result as its owner gets it: the last text the turn committed. A turn that did not finish, or committed no text,
    // leaves none, so the stored readers fall back to the rows.
    let mut set = calls.repeat_saved();
    if let Some(check) = guards.saved() {
        set.insert("todoCheck".to_owned(), check);
    }
    let mut unset = Vec::new();
    match &outcome {
        RunOutcome::Completed(result) if !mixdog_js::js_trim(result.report_content.as_deref().unwrap_or(&result.content)).is_empty() => {
            let said = result.report_content.as_deref().unwrap_or(&result.content);
            set.insert("lastHandoff".to_owned(), Value::String(redactor.redact_text(said)));
            set.insert("lastHandoffTurn".to_owned(), Value::String(turn_id.as_str().to_owned()));
        }
        _ => unset.extend(["lastHandoff".to_owned(), "lastHandoffTurn".to_owned()]),
    }
    let _ = end_port.save_header(mixdog_store::schema::record::HeaderChange { set, unset, patch: Default::default() }).await;
    match &outcome {
        // `settleAskTurn`: the ask's usage, over the conversation as the turn left it, reaches the header and the usage
        // the statusline reads, as a finished turn of the loop settles its own. An agent that reported no usage for the
        // turn has nothing to settle: the session's readings and the ask books stay as they were.
        RunOutcome::Completed(result) if lock(&report.usage).is_some() => {
            let (usage, input_excludes_cache) = lock(&report.usage).take().unwrap_or_default();
            let rows = conversation_after(&redactor).await.unwrap_or_default();
            let transcript = settled_transcript(system, rows, held.load(Ordering::SeqCst), &ended_input);
            let settled = mixdog_core_session::session::run::Settled {
                transcript,
                usage: usage.clone(),
                last_turn_usage: usage,
                tool_calls_total: result.tool_calls_total,
                send_tools: Arc::from(Vec::new()),
                response_model: model,
                asked_at_ms: asked_at,
                input_excludes_cache,
            };
            let _ = end_port.settled(settled).await;
        }
        // A stopped turn closes as the loop closes one that produced nothing (its prompt handed back on a user's stop) when
        // neither the loop half nor the agent added work after the prompt: no reply text, call or result.
        RunOutcome::Interrupted if cancel.is_cancelled() || signal.is_aborted() => {
            let produced = loop_produced
                || report.output_produced()
                || conversation_after(&redactor).await.is_none_or(|rows| {
                    let at = held.load(Ordering::SeqCst).min(rows.len());
                    rows[at..].iter().any(|(iid, _)| !preloaded_ids.contains(iid))
                });
            if !produced {
                close_stopped_prompt(&end_port, &stopped_item, &ended_input, signal.close_reason()).await;
            }
        }
        _ => {}
    }
    outcome
}

/// The session's model context after a turn of an agent, without the turn's input row; `None` when it cannot be read.
async fn conversation_after(context: &mixdog_core_session::session::run::ModelContext) -> Option<Vec<(ItemId, Value)>> {
    match context.read().await {
        Ok(rows) => Some(rows),
        Err(error) => {
            tracing::warn!("[session] the conversation an agent's turn left could not be read: {error:?}");
            None
        }
    }
}

/// The session's model context as a finished turn of an agent left it, as the loop's settlement reads `session.messages`:
/// the request's `system` messages, the `held` rows of `rows` ahead of the turn's input less the stale system rows they
/// lead with, the input, and the rows the turn added after it.
fn settled_transcript(system: Vec<AgentMessage>, rows: Vec<(ItemId, Value)>, held: usize, input: &Value) -> Vec<AgentMessage> {
    let at = held.min(rows.len());
    let mut transcript = system;
    let mut leading = true;
    for row in rows[..at].iter().map(|(_, row)| row).chain(std::iter::once(input)).chain(rows[at..].iter().map(|(_, row)| row)) {
        match message_of(row) {
            Ok(message) if leading && is_stale_system_row(&message) => {}
            Ok(message) => {
                leading = false;
                transcript.push(message);
            }
            Err(error) => tracing::warn!("[session] a row of the settled conversation could not be read: {error}"),
        }
    }
    transcript
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A context that holds only the summary a compaction left (a session moved onto the agent right after one) hands
    /// that summary over as it stands; one the user spoke in since is summarized anew, and an empty one hands nothing.
    #[test]
    fn a_context_that_holds_only_a_compaction_summary_hands_that_summary_over() {
        let summary =
            json!({ "role": "user", "content": format!("{}the user asked for a parser; it is half written", mixdog_agent::compact::fresh::SUMMARY_PREFIX) });
        let system = json!({ "role": "system", "content": "rules" });
        let kept = json!({ "role": "assistant", "content": "I will finish the parser." });
        let said = json!({ "role": "user", "content": "go on" });

        let handed = History::standing_summary(&[&system, &summary, &kept], None).expect("a summary stands").expect("readable rows");
        assert!(handed.starts_with("## User\n"), "{handed}");
        assert!(handed.contains("the user asked for a parser; it is half written"), "{handed}");
        assert!(handed.ends_with("## Assistant\nI will finish the parser."), "{handed}");
        assert!(!handed.contains("rules"), "the session's prompt is no part of the summary: {handed}");

        assert!(History::standing_summary(&[&summary, &kept, &said], None).is_none(), "a conversation since the summary is summarized anew");
        assert!(History::standing_summary(&[&system], None).is_none());
    }

    /// A compaction keeps the latest request beside its summary: with nothing said since, an agent starting on that
    /// context is handed it as it stands, where a second summary would cost the turn a model call.
    #[test]
    fn a_request_the_compaction_kept_does_not_summarize_its_summary_again() {
        let summary = json!({ "role": "user", "content": format!("{}the parser is half written", mixdog_agent::compact::fresh::SUMMARY_PREFIX) });
        let kept = json!({ "role": "user", "content": "read parser.rs", "meta": { "transcript": { "at": 100 } } });
        let reply = json!({ "role": "assistant", "content": "parser.rs has 40 lines" });
        let since = json!({ "role": "user", "content": "now fix it", "meta": { "transcript": { "at": 300 } } });

        let handed = History::standing_summary(&[&summary, &kept, &reply], Some(200.0)).expect("the compaction's context stands").expect("readable rows");
        assert!(handed.contains("read parser.rs") && handed.contains("parser.rs has 40 lines"), "{handed}");
        assert!(History::standing_summary(&[&summary, &kept, &reply, &since], Some(200.0)).is_none(), "a request since the compaction is summarized");
    }

    /// A failed user turn after a compaction left no reply behind: the earlier summary still stands for hand-over
    /// without re-summarizing or including the failed prompt.
    #[test]
    fn a_standing_summary_followed_only_by_a_failed_user_turn_still_hands_over_the_summary() {
        let summary = json!({ "role": "user", "content": format!("{}the parser is half written", mixdog_agent::compact::fresh::SUMMARY_PREFIX) });
        let failed = json!({
            "role": "user",
            "content": "finish the parser",
            "meta": { "transcript": { "completion": { "status": "failed" } } }
        });

        let handed = History::standing_summary(&[&summary, &failed], None).expect("the standing summary still holds").expect("readable rows");
        assert!(handed.contains("the parser is half written"), "{handed}");
        assert!(!handed.contains("finish the parser"), "the failed prompt is not part of the standing summary: {handed}");

        let partial_reply = json!({ "role": "assistant", "content": "I started editing parser.rs" });
        assert!(
            History::standing_summary(&[&summary, &failed, &partial_reply], None).is_none(),
            "a failed turn that produced a reply before failing is re-summarized"
        );
    }

    /// An agent's session compacts on the reading a provider's does: what its context holds, against the trigger of
    /// the session's policy over the window the session holds. At the trigger it is due; below it, with no reading
    /// (none yet, or one a compaction left behind) and with automatic compaction off it is not.
    #[test]
    fn a_context_is_due_for_compaction_once_the_agents_reading_reaches_the_sessions_trigger() {
        use mixdog_agent::boundary::CompactPolicy;
        use mixdog_agent::boundary::CompactSettings;
        let settings = |auto: bool| CompactSettings { auto, context_window: Some(1_048_576), token_calibration: 1.0, ..CompactSettings::default() };
        let policy = CompactPolicy::resolve(&settings(true)).expect("a policy over the agent's window");
        let trigger = policy.trigger_tokens;
        assert_eq!(due(Some(&policy), Some(trigger)), Some((trigger, trigger)));
        assert_eq!(due(Some(&policy), Some(trigger + 9)), Some((trigger + 9, trigger)));
        assert_eq!(due(Some(&policy), Some(trigger - 1)), None);
        assert_eq!(due(Some(&policy), None), None);
        assert_eq!(due(CompactPolicy::resolve(&settings(false)).as_ref(), Some(trigger)), None);
        // An explicit limit below the window is the trigger, as it is for a provider's session.
        let limited = CompactPolicy::resolve(&CompactSettings { auto_limit: Some(200_000), ..settings(true) }).expect("a policy");
        assert_eq!(due(Some(&limited), Some(200_000)), Some((200_000, 200_000)));
    }

    /// A window the user selected below the agent's reported size is the boundary an agent's session compacts at: the
    /// header the agent's report leaves states the selection as the window and the boundary, the agent's size as the raw
    /// window, and the reading that is under the agent's size but at the selection is due. With no selection the whole
    /// reported window is the boundary, as before.
    #[test]
    fn a_selected_window_below_the_agents_size_is_where_its_context_is_due() {
        use mixdog_agent::boundary::CompactPolicy;
        use mixdog_agent::boundary::CompactSettings;
        let policy = |window: u64| {
            CompactPolicy::resolve(&CompactSettings {
                auto: true,
                context_window: Some(window),
                explicit_boundary: Some(window),
                token_calibration: 1.0,
                ..CompactSettings::default()
            })
            .expect("a policy over the window")
        };
        let (selected, reported) = (policy(400_000), policy(1_048_576));
        assert_eq!(due(Some(&selected), Some(450_000)), Some((450_000, 400_000)));
        assert_eq!(due(Some(&reported), Some(450_000)), None, "with no selection the agent's whole window is the boundary");
        assert_eq!(due(Some(&reported), Some(reported.trigger_tokens)), Some((reported.trigger_tokens, reported.trigger_tokens)));
    }

    struct At(i64);

    impl Clock for At {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    /// The approval wait of a call an outside agent's turn runs is a counted wait of the session's progress for as
    /// long as it is open: what the agent's turn reads to mark the spinner.
    #[test]
    fn the_approval_wait_of_a_handed_call_is_counted_in_the_progress_while_it_is_open() {
        let (progress, watched) = watch::channel(RunProgress::default());
        progress.send_modify(|progress| progress.ask_start(1));
        let observer = HandedObserver { progress, clock: Arc::new(At(2)) };
        let awaiting = || watched.borrow().snapshot(3).is_some_and(|snapshot| snapshot.awaiting_user);

        observer.event(RunEvent::Stage(Stage::ApprovalWait { waiting: true }));
        assert!(awaiting());
        observer.event(RunEvent::Stage(Stage::ApprovalWait { waiting: false }));
        assert!(!awaiting());
    }

    #[test]
    fn told_replaces_images_with_text_marks_instead_of_carrying_image_bytes() {
        use mixdog_agent::message::AgentMessage;
        use mixdog_agent::message::ToolKind;
        use mixdog_agent::message_row::row_of;
        use mixdog_core_api::domain::provider::BinarySource;
        use mixdog_core_api::domain::provider::Content;
        use mixdog_core_api::domain::provider::ContentPart;
        use mixdog_core_api::domain::provider::ImageSource;
        use mixdog_core_api::domain::provider::ToolCall;

        let user_msg = row_of(&AgentMessage::user_content(Content::Parts(vec![
            ContentPart::Text("Check this screenshot".into(), None),
            ContentPart::File {
                source: BinarySource::AttachmentRef("deadbeef".into()),
                mime_type: "image/png".into(),
                filename: Some("screen.png".into()),
                text: None,
            },
        ])));
        let tool_call =
            row_of(&AgentMessage::assistant("", vec![ToolCall { id: "call-1".into(), name: "computer".into(), arguments: json!({}), native_type: None }]));
        let tool_res = row_of(&AgentMessage::tool_result(
            "call-1",
            Content::Parts(vec![ContentPart::Image(ImageSource::Base64 {
                data: "QUJDREVGRw==".into(),
                mime_type: "image/jpeg".into(),
                width: Some(1456),
                height: Some(819),
            })]),
            ToolKind::Normal,
        ));

        let summary = History::told([&user_msg, &tool_call, &tool_res]).expect("summary text");
        assert!(summary.contains("Check this screenshot"), "{summary}");
        assert!(summary.contains("[image omitted from summary: screen.png]"), "{summary}");
        assert!(!summary.contains("screen.png; capture or read again"), "user-attached image must not tell the agent to capture or read again: {summary}");
        assert!(summary.contains("[image omitted from summary: computer (image/jpeg); capture or read again if needed]"), "{summary}");
        assert!(!summary.contains("QUJDREVGRw=="), "raw image base64 must never appear in handover summary: {summary}");
    }
}
