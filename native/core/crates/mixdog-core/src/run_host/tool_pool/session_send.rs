//! `session action=send` (`sendToSession` of `daemon-session-control.mjs`, `send-turn.mjs`,
//! `task-session-route.mjs`): a prompt queued in another session. The Lead's send is the Lead's
//! message there (`sender: 'lead'`) and reports nothing back; a bot conversation's send is the
//! bot's turn, run and reported by [`TaskSends`] (`agentTasks.send`). The effort, hop and bot-chain
//! checks refuse before anything is queued. A send to a group room's log is a message to one
//! member there, through the room host (`roomAddressee`, `roomSubmitter`).
//! Replayed against Node's answers: `fixtures/session-tool-control/golden.json` (`send-*`).

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::handoff::handoff_content;
use mixdog_agent::agent_tool::flow::spawn::assert_bot_chain_target;
use mixdog_ai::effort::normalize_effort_input;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_id_of_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_base::rooms::ids::room_session_id;
use mixdog_core_rooms::rooms::room_ask::Addressee;
use mixdog_core_rooms::rooms::room_ask::Ask;
use mixdog_core_rooms::rooms::room_ask::RoomAsk;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::delegation::bot_chain_of;
use mixdog_core_session::session::delegation::delegation_chain;
use mixdog_services::task_reports::send::Origin;
use mixdog_services::task_reports::send::Submission;
use mixdog_services::task_reports::send::TaskSends;
use mixdog_services::task_reports::send::TurnEnd;
use mixdog_services::task_reports::send::TurnSubmit;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::session::ControlCall;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

/// `MAX_BOT_HOPS` and `BOT_HOP_LIMIT_ERROR` (`bot-hops.mjs`).
pub const MAX_BOT_HOPS: u32 = 3;
pub const BOT_HOP_LIMIT_ERROR: &str = "session: Bot-to-bot chain limit reached; ask the user before continuing.";
/// Why a send from a conversation that is no bot's reports nothing back.
const NOT_BOT_REASON: &str = "only a bot conversation gets session results reported back; check that session for the result";
/// `TITLE_LIMIT` of a report origin's title.
const TITLE_LIMIT: usize = 60;
/// Node's answer without a session service (`getSessionService()` null).
const NO_SERVICE: &str = "session: session service is unavailable";

/// `chainedHop(hop)`: refused past [`MAX_BOT_HOPS`].
pub fn chained_hop(hop: u32) -> Result<u32, String> {
    if hop > MAX_BOT_HOPS { Err(BOT_HOP_LIMIT_ERROR.to_owned()) } else { Ok(hop) }
}

/// The calling turn's place in a bot-to-bot chain: `turnHopOf(rt.session)` and, for a caller
/// acting as a bot, `delegationChainOf(callerSessionId, getSession)` (`workspace-tools.mjs`).
pub struct CallerChains {
    /// `getSession(id)`: a session's record.
    pub record: Arc<dyn Fn(&str) -> Option<Value> + Send + Sync>,
    /// `turnHopOf` / `turnBotChainOf` of a session's current turn.
    pub turn: Arc<dyn Fn(&str) -> (u32, Vec<String>) + Send + Sync>,
}

impl CallerChains {
    pub(super) fn hop(&self, caller: &str) -> u32 {
        (self.turn)(caller).0
    }

    pub(super) fn bot_chain(&self, caller: &str) -> Vec<String> {
        let turn_bots = |id: &str| (self.turn)(id).1;
        delegation_chain(caller, &*self.record, &turn_bots)
    }
}

/// `agentDisplayName(agentId)`: the name a bot goes by in the envelope of its messages.
#[async_trait]
pub trait AgentNames: Send + Sync {
    async fn name(&self, agent_id: &str) -> String;
}

/// `readModelCatalog(service, sessionId)`: the model menu's catalog rows
/// (`listProviderModels`: `provider`, `id`, `display`, `effortOptions`).
#[async_trait]
pub trait ModelRows: Send + Sync {
    async fn rows(&self) -> Result<Vec<Value>, String>;
}

/// `configureSession({ action: 'setEffort', args: [level, { sessionOnly: true }] })`: the
/// session's route takes the level (`None`: auto), never the user's saved settings.
#[async_trait]
pub trait SessionEffort: Send + Sync {
    async fn set_effort(&self, thread: &ThreadId, level: Option<&str>) -> Result<(), String>;
}

/// `rebindDelegation(sessionId, callerSessionId)`: new work from this sender, the target acts as
/// the sender does from now on.
#[async_trait]
pub trait Rebind: Send + Sync {
    async fn rebind(&self, session_id: &str, caller_session_id: &str) -> Result<(), String>;
}

/// [`AgentNames`] over the agent definitions: the manifest's name on one line, else the id; Mixy's
/// display name for the Lead (`mixyDisplayName()`, read on the lane).
pub struct DefinitionNames {
    pub definitions: Arc<mixdog_core_agents::agents::AgentDefinitions>,
    pub data_dir: std::path::PathBuf,
    pub io: mixdog_rt::InteractiveIo,
}

#[async_trait]
impl AgentNames for DefinitionNames {
    async fn name(&self, agent_id: &str) -> String {
        if agent_id == mixdog_core_base::rooms::ids::MIXY_AGENT_ID {
            let dir = self.data_dir.clone();
            return mixdog_core_base::support::on_lane(self.io, &mixdog_rt::CancellationToken::new(), move |lane| mixdog_core_config::config::mixy_display_name(lane, &dir))
                .await
                .unwrap_or_else(|_| agent_id.to_owned());
        }
        let named = match self.definitions.load(agent_id).await {
            Ok(Some(definition)) => definition.name.split(mixdog_js::is_js_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" "),
            _ => String::new(),
        };
        if named.is_empty() { agent_id.to_owned() } else { named }
    }
}

/// [`ModelRows`] over the `model/list` service (`collectProviderModels({})`).
pub struct ModelListRows(pub Arc<mixdog_core_domains::domains::ai_admin::model_list::ModelListService>);

#[async_trait]
impl ModelRows for ModelListRows {
    async fn rows(&self) -> Result<Vec<Value>, String> {
        self.0.rows_for(false, false, None).await
    }
}

/// [`SessionEffort`] over the route service (`setEffort(level, { sessionOnly: true })`).
pub struct RouteEffort(pub Arc<mixdog_core_domains::domains::ai_admin::route_service::RouteService>);

#[async_trait]
impl SessionEffort for RouteEffort {
    async fn set_effort(&self, thread: &ThreadId, level: Option<&str>) -> Result<(), String> {
        let value = level.map_or(Value::Null, |level| json!(level));
        self.0.set_effort(thread, &value, true).await.map(|_| ())
    }
}

/// [`Rebind`] through the agent tool's send path (`AgentSendWorld::rebind_delegation`).
pub struct SendWorldRebind(pub Arc<crate::run_host::agent_send_world::AgentSendWorld>);

#[async_trait]
impl Rebind for SendWorldRebind {
    async fn rebind(&self, session_id: &str, caller_session_id: &str) -> Result<(), String> {
        mixdog_agent::agent_tool::flow::world::SendWorld::rebind_delegation(&*self.0, session_id, Some(caller_session_id)).await
    }
}

/// The intake of a session this process runs: the send's turn (`submitSession`), its end answered
/// as `onSettled` reads it.
pub struct DirectorySubmit(pub Arc<SessionDirectory>);

#[async_trait]
impl TurnSubmit for DirectorySubmit {
    async fn submit(&self, session_id: &str, content: Value, id: &str, submission: Submission) -> Result<Option<oneshot::Receiver<TurnEnd>>, String> {
        let thread = ThreadId::from(session_id);
        let Some(settled) = self.0.submit_chained_turn(&thread, &content, id, submission.hop, &submission.bot_chain, &submission.meta, "").await else {
            return Ok(None);
        };
        let (tx, rx) = oneshot::channel();
        // Nobody follows this turn's end: accepted, and nothing waits on it.
        if !submission.settled {
            return Ok(Some(rx));
        }
        drop(mixdog_rt::spawn("session-send-settle", mixdog_rt::TaskClass::Work, async move {
            let end = settled.await.map_or_else(|_| TurnEnd { status: "cancelled".into(), text: String::new() }, |s| TurnEnd { status: s.status.to_owned(), text: s.text });
            let _ = tx.send(end);
        }));
        Ok(Some(rx))
    }
}

/// What a send needs of the process.
pub struct SessionSend {
    pub directory: Arc<SessionDirectory>,
    pub tasks: Arc<TaskSends>,
    pub chains: CallerChains,
    pub names: Arc<dyn AgentNames>,
    pub catalog: Arc<dyn ModelRows>,
    pub effort: Arc<dyn SessionEffort>,
    pub rebind: Arc<dyn Rebind>,
    /// What `session action=create` starts a task session through.
    pub create: Arc<dyn super::session_create::CreateHost>,
    /// `agentRoomHost()`: a send to a room log goes to one member through it.
    pub rooms: Arc<mixdog_core_rooms::rooms::room_hosts::RoomHostRegistry>,
}

/// `roomSubmitter(room, sessionId, prompt, from)`: a send's turn taken as a message into room log
/// `room_session` for member `agent_id`; the member's turn carries the send's hop, and its bot
/// chain is remembered under every submission id that turn may take.
struct RoomSubmit {
    host: Arc<dyn RoomAsk>,
    room_session: String,
    agent_id: String,
    from_session: String,
    from_agent: String,
}

/// A followed room call's watch, the bot chain remembered under the submission id it follows.
struct RoomFollow {
    chain: Vec<String>,
    follow: mixdog_services::task_reports::send::SubmissionFollow,
}

#[async_trait]
impl mixdog_core_rooms::rooms::calls::CallFollow for RoomFollow {
    async fn follow(&self, submission_id: &str) -> Result<(), String> {
        mixdog_core_session::session::delegation::remember_submission(submission_id, &self.chain);
        (self.follow)(submission_id.to_owned()).await
    }
}

/// `turnStatus(detail)`: a room call's end as a session turn's.
fn turn_end(settled: &mixdog_core_rooms::rooms::calls::Settled) -> TurnEnd {
    let status = match settled.status.as_str() {
        "done" | "completed" => "completed",
        "failed" => "failed",
        _ => "cancelled",
    };
    let text = settled.content.clone().filter(|content| !content.is_empty()).or_else(|| settled.error.clone()).unwrap_or_default();
    TurnEnd { status: status.into(), text }
}

#[async_trait]
impl TurnSubmit for RoomSubmit {
    async fn submit(&self, _: &str, content: Value, id: &str, submission: Submission) -> Result<Option<oneshot::Receiver<TurnEnd>>, String> {
        let id = if submission.settled { id } else { "" };
        mixdog_core_session::session::delegation::remember_submission(id, &submission.bot_chain);
        let (tx, rx) = oneshot::channel();
        let on_settled = submission.settled.then(|| {
            let tx = std::sync::Mutex::new(Some(tx));
            Arc::new(move |settled: &mixdog_core_rooms::rooms::calls::Settled| {
                if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = tx.send(turn_end(settled));
                }
            }) as Arc<dyn Fn(&mixdog_core_rooms::rooms::calls::Settled) + Send + Sync>
        });
        let follow = submission.follow.map(|follow| Arc::new(RoomFollow { chain: submission.bot_chain.clone(), follow }) as Arc<dyn mixdog_core_rooms::rooms::calls::CallFollow>);
        let ask = Ask {
            agent_id: self.agent_id.clone(),
            prompt: content,
            from_session: self.from_session.clone(),
            from_agent: self.from_agent.clone(),
            id: id.to_owned(),
            hop: submission.hop,
            on_settled,
            follow,
        };
        Ok(self.host.ask(&self.room_session, ask).await?.then_some(rx))
    }
}

/// The send's intake, bound once the directory, the report host and the route service exist
/// (after the tool pool is built). Unbound it answers as Node does without a session service.
#[derive(Default)]
pub struct LateSend(OnceLock<Arc<SessionSend>>);

impl LateSend {
    pub fn bind(&self, send: Arc<SessionSend>) -> Result<(), &'static str> {
        self.0.set(send).map_err(|_| "session send")
    }

    pub fn get(&self) -> Result<&Arc<SessionSend>, String> {
        self.0.get().ok_or_else(|| NO_SERVICE.to_owned())
    }
}

impl crate::run_host::late::Bound for LateSend {
    fn cell(&self) -> &'static str {
        "session send"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

fn clean(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).unwrap_or_default()
}

/// `assertSendRequest(args, sessionId)`: a prompt, and no room member's session addressed directly.
fn assert_send_request(args: &Value, session_id: &str) -> Result<(), String> {
    if !args.get("prompt").and_then(Value::as_str).is_some_and(|p| !mixdog_js::js_trim(p).is_empty()) {
        return Err("session: prompt is required for action=send".into());
    }
    if let Some(member) = room_member_of_session(session_id) {
        let room = room_session_id(&member.room_id).unwrap_or_default();
        return Err(format!("session: {session_id} is a group-room member's session; send to its room (session_id {room}) with to: <member>"));
    }
    Ok(())
}

/// `checkEffort(value, route, rows)`: the effort level `value` names for the route (`None`:
/// auto), refused with the model's levels when unknown or unsupported.
pub fn check_effort(value: &Value, provider: &str, model: &str, rows: &[Value]) -> Result<Option<String>, String> {
    let lower = |v: Option<&Value>| clean(v).to_lowercase();
    let row_id = |row: &Value| {
        let id = clean(row.get("id"));
        if id.is_empty() { clean(row.get("model")) } else { id }
    };
    let row = rows.iter().find(|row| row.get("provider").and_then(Value::as_str) == Some(provider) && row_id(row).to_lowercase() == lower(Some(&json!(model))));
    let allowed: Option<Vec<String>> = row.map(|row| {
        row.get("effortOptions").and_then(Value::as_array).map(|options| options.iter().map(|o| o.get("value").map(mixdog_js::value_to_string).unwrap_or_else(|| "undefined".into())).collect()).unwrap_or_default()
    });
    let offer = allowed.as_ref().map_or(String::new(), |allowed| format!("; {provider}/{model} supports: auto{}", allowed.iter().map(|l| format!(", {l}")).collect::<String>()));
    let level = normalize_effort_input(Some(value)).map_err(|error| format!("session: {error}{offer}"))?;
    if let (Some(level), Some(allowed)) = (&level, &allowed)
        && !allowed.contains(level)
    {
        return Err(format!("session: effort \"{level}\" is not supported{offer}"));
    }
    Ok(level)
}

/// `unreportedSendResult(sessionId, addressed, accepted, hop)`; `to`: the room member addressed.
fn unreported(session_id: &str, to: Option<&str>, accepted: bool, hop: u32) -> Value {
    let mut out = Map::new();
    out.insert("sessionId".into(), json!(session_id));
    if let Some(to) = to {
        out.insert("to".into(), json!(to));
    }
    out.insert("accepted".into(), json!(accepted));
    out.insert("reportsBack".into(), json!(false));
    if accepted {
        out.insert("reportsBackReason".into(), json!(NOT_BOT_REASON));
    }
    if hop > 0 {
        out.insert("hop".into(), json!(hop));
    }
    Value::Object(out)
}

impl SessionSend {
    async fn header(&self, session_id: &str) -> Option<Header> {
        self.directory.stored_header(&ThreadId::from(session_id)).await
    }

    /// `sendReportOrigin` (`agentTasks.reportOrigin`): the stored origin of a task session agent
    /// `agent_id` created (reporting to the conversation the send came from), else one for this
    /// send only; none for a caller that is no agent conversation.
    pub async fn report_origin(&self, session_id: &str, agent_id: &str, caller: &str) -> Option<Origin> {
        if agent_id.is_empty() {
            return None;
        }
        let target = self.header(session_id).await;
        let stored = target.as_ref().and_then(|t| t.get("taskOrigin")).filter(|o| o.is_object());
        if let Some(stored) = stored.filter(|o| o.get("agentId").and_then(Value::as_str) == Some(agent_id)) {
            let home = clean(stored.get("sessionId"));
            return Some(Origin {
                agent_id: agent_id.to_owned(),
                session_id: if !caller.is_empty() && caller != home { caller.to_owned() } else { home },
                title: stored.get("title").map(mixdog_js::value_to_string).unwrap_or_default(),
                notify: stored.get("notify") != Some(&Value::Bool(false)),
                target_session: stored.get("target").and_then(Value::as_str) == Some("session"),
                text_only: stored.get("textOnly").is_some_and(|t| !matches!(t, Value::Null | Value::Bool(false))),
                envelope_name: None,
                hop: 0,
                bot_chain: Vec::new(),
            });
        }
        let title = clean(target.as_ref().and_then(|t| t.get("title")));
        let title = mixdog_js::slice_utf16(if title.is_empty() { session_id } else { &title }, TITLE_LIMIT);
        // Files come back only from sessions the agent created or its own room member threads.
        let own = room_member_of_session(session_id).is_some_and(|member| member.agent_id == agent_id);
        Some(Origin {
            agent_id: agent_id.to_owned(),
            session_id: caller.to_owned(),
            title,
            notify: true,
            target_session: true,
            text_only: !own,
            envelope_name: if own { None } else { Some(self.names.name(agent_id).await) },
            hop: 0,
            bot_chain: Vec::new(),
        })
    }

    /// `sendToSession(args, context, sessionId, caller)`.
    pub async fn send(&self, call: &ControlCall, session_id: &str) -> Result<Value, String> {
        let (args, caller) = (&call.args, call.caller_thread.as_str());
        assert_send_request(args, session_id)?;
        // A send to a room's log is a message to one member there (`to`, or a leading @name); the
        // member's turn in its member session is the turn that answers and reports.
        let room = if room_id_of_session(session_id).is_some() { Some(self.room_addressee(session_id, args).await?) } else { None };
        if room.as_ref().is_some_and(|room| room.session_id == caller) {
            return Err("session: send must target another session".into());
        }
        let (agent_id, bot_id) = (call.caller.attended_agent.as_str(), call.caller.acting_bot.as_str());
        // A bot conversation's turn carries its chain on; any other session hands work to any bot.
        let bot_chain = if bot_id.is_empty() { Vec::new() } else { bot_chain_of(self.chains.bot_chain(caller).iter().map(String::as_str)) };
        let this = if bot_id.is_empty() { agent_id } else { bot_id };
        let target_bot = match &room {
            Some(room) => room.agent_id.clone(),
            None => agent_id_of_home_session(session_id).unwrap_or_default(),
        };
        assert_bot_chain_target(&target_bot, &bot_chain, this, "session")?;
        let text = room.as_ref().map_or_else(|| args["prompt"].as_str().unwrap_or_default(), |room| room.text.as_str());
        let prompt = handoff_content(text, &call.attachment_parts);
        let turn_session = room.as_ref().map_or(session_id, |room| room.session_id.as_str()).to_owned();
        let submit = room.as_ref().map(|room| {
            Arc::new(RoomSubmit { host: room.host.clone(), room_session: session_id.to_owned(), agent_id: room.agent_id.clone(), from_session: caller.to_owned(), from_agent: agent_id.to_owned() })
        });
        let to = room.as_ref().map(|room| room.agent_id.as_str());
        let mut origin = self.report_origin(&turn_session, agent_id, caller).await;
        // The menu's effort pick on the target: checked now, applied just before the prompt is queued.
        let mut level: Option<Option<String>> = None;
        if let Some(effort) = args.get("effort") {
            if room.is_some() {
                return Err("session: effort applies to a session, not a group room".into());
            }
            if !this.is_empty() && self.report_origin(session_id, this, caller).await.is_some_and(|o| o.target_session) {
                return Err("session: a bot may set the effort only of the task sessions it created".into());
            }
            let Some(target) = self.header(session_id).await else {
                return Err(format!("session: {session_id} is unavailable"));
            };
            let rows = self.catalog.rows().await?;
            level = Some(check_effort(effort, &clean(target.get("provider")), &clean(target.get("model")), &rows)?);
        }
        // The effort goes on first, then the service takes the prompt: a session it does not hold is refused there
        // (`submitSession`), after the effort check.
        let in_room = room.is_some();
        let apply_effort = |level: Option<Option<String>>| async move {
            if let Some(level) = level {
                self.effort.set_effort(&ThreadId::from(session_id), level.as_deref()).await?;
            }
            if !in_room && self.header(session_id).await.is_none() {
                return Err(format!("session {session_id} is not available"));
            }
            Ok(())
        };
        let turn_hop = self.chains.hop(caller);
        if let Some(origin) = origin.as_mut() {
            let hop = chained_hop(if origin.target_session { turn_hop + 1 } else { turn_hop })?;
            origin.hop = hop;
            origin.bot_chain = bot_chain;
            // The task session a bot created acts as the sending conversation does from now on.
            if !origin.target_session {
                self.rebind.rebind(session_id, caller).await?;
            }
            apply_effort(level).await?;
            let sent = match submit {
                Some(submit) => self.tasks.send_through(&turn_session, &prompt, origin, submit).await?,
                None => self.tasks.send(session_id, &prompt, origin).await?,
            };
            let mut out = Map::new();
            out.insert("sessionId".into(), json!(session_id));
            if let Some(to) = to {
                out.insert("to".into(), json!(to));
            }
            out.extend(sent);
            if hop > 0 {
                out.insert("hop".into(), json!(hop));
            }
            return Ok(Value::Object(out));
        }
        let hop = if turn_hop > 0 { chained_hop(turn_hop + 1)? } else { 0 };
        apply_effort(level).await?;
        let accepted = match submit {
            // The member's turn carries only the hop (`submit({ transcriptMeta: { hop } })`).
            Some(submit) => {
                let submission = Submission { hop, bot_chain: Vec::new(), meta: Map::new(), settled: false, follow: None };
                submit.submit(&turn_session, prompt.clone(), "", submission).await?.is_some()
            }
            None => {
                // New work from this sender: a delegated target acts as the sender does.
                self.rebind.rebind(session_id, caller).await?;
                let meta = Map::from_iter([("sender".to_owned(), json!("lead"))]);
                let id = format!("send_{}", uuid::Uuid::new_v4());
                let submission = Submission { hop, bot_chain, meta, settled: false, follow: None };
                self.tasks.intake().submit(session_id, prompt.clone(), &id, submission).await?.is_some()
            }
        };
        Ok(unreported(session_id, to, accepted, hop))
    }

    /// `roomAddressee(sessionId, args)`: the member a send to room log `session_id` addresses,
    /// through the room host; refused when no host is attached or no member resolves.
    async fn room_addressee(&self, session_id: &str, args: &Value) -> Result<RoomAddressee, String> {
        let host = self.rooms.active_ask().map_err(|error| format!("session: cannot send to {session_id}: {error}"))?;
        let member = host.member(session_id, args.get("to").unwrap_or(&Value::Null), args.get("prompt").unwrap_or(&Value::Null)).await.map_err(|error| format!("session: {error}"))?;
        let Addressee { agent_id, session_id, text, .. } = member;
        Ok(RoomAddressee { host, agent_id, session_id, text })
    }
}

/// `roomAddressee`'s answer: the room host and the member it resolved.
struct RoomAddressee {
    host: Arc<dyn RoomAsk>,
    agent_id: String,
    session_id: String,
    text: String,
}
