//! One turn of a session whose route names an agent preset. The turn has begun as every turn of the session does
//! (its settings reconciled, its prompt current, its input carrying the turn's context and reminders); from here it
//! runs in that agent.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use mixdog_agent::agent_tool::flow::seams::TurnResult;
use mixdog_agent::env::CompactEvent;
use mixdog_agent::env::CompactStatus;
use mixdog_agent::env::CompactTrigger;
use mixdog_agent::response::Termination;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_run::run_host::progress::RunProgress;
use mixdog_core_session::session::RunOutcome;
use mixdog_core_session::session::transcript_writer::TurnTranscript;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnError;
use mixdog_protocol::TurnId;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::agents::AUTH_REQUIRED;
use crate::agents::Agents;
use crate::agents::DEFAULT_MODEL;
use crate::agents::Readiness;
use crate::agents::Refusal;
use crate::agents::lock;
use crate::preset::AgentPreset;
use crate::surface::TurnSurface;
use crate::turn::Ask;
use crate::turn::TurnContext;
use crate::turn::TurnEnd;

/// The header key a session keeps its agent's own session under: `{ agent, sessionId, prompt }`, `prompt` telling
/// which text of Mixdog's prompt that session holds. The session layer drops it at a fork, a rewind and a clear.
pub const SESSION_KEY: &str = mixdog_core_session::session::turn_ops::AGENT_SESSION;

/// The text of the input row a reply the agent began on its own is shown under.
pub const WAKE_TEXT: &str = "The agent continued after a background command finished.";

/// The agent's session a conversation holds.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stored {
    pub session_id: String,
    /// [`crate::session::digest`] of Mixdog's prompt as that session holds it.
    pub prompt: Option<String>,
}

/// The conversation a session holds from before a turn, for an agent whose own session starts without it.
#[async_trait]
pub trait Conversation: Send + Sync {
    /// Summarizes the conversation with Mixdog's own compaction, makes the summary the session's stored context and
    /// returns it as text; `None` for a session with no earlier conversation. `Err` tells why no summary was made.
    async fn hand_over(&self) -> Result<Option<String>, String>;

    /// Whether [`Self::hand_over`] has a summary to make now, which takes a model request: `false` for a session with no
    /// earlier conversation, or one whose earlier summary is handed over as it stands.
    fn hand_over_summarizes(&self) -> bool {
        false
    }

    /// The agent's context, as its last turn left the session's reading, has reached the session's compaction
    /// trigger: the reading and the trigger. `None` for a session below it, with automatic compaction off, or with
    /// no reading.
    fn compaction_due(&self) -> Option<Due> {
        None
    }

    /// The session's own compaction of the conversation it holds, as a manual Compact makes it: the header stops
    /// naming the agent's session, the summary becomes the stored context, and the summary is returned as text for the
    /// session the agent starts next. `None` for a session with nothing to compact; an error may come after the header
    /// stopped naming the session.
    async fn compact(&self) -> Result<Option<String>, String> {
        self.hand_over().await
    }
}

/// A context that reached the session's compaction trigger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Due {
    pub used: u64,
    pub trigger: u64,
}

/// The loop's event of an automatic compaction pass over the context `due` holds, `duration_ms` long, that ended `status`.
fn pass(due: Due, duration_ms: i64, status: CompactStatus) -> CompactEvent {
    CompactEvent {
        dropped_count: 0,
        dropped: None,
        trigger: CompactTrigger::Auto,
        status,
        before_tokens: due.used,
        duration_ms: duration_ms.max(0) as u64,
        after_tokens: due.used,
        before_messages: 0,
        after_messages: 0,
        pressure_tokens: due.used,
        trigger_tokens: due.trigger,
        boundary_tokens: 0,
        target_budget_tokens: 0,
    }
}

/// The attachments the session's rows name.
#[async_trait]
pub trait Attachments: Send + Sync {
    /// The bytes of the stored attachment `reference` names.
    async fn bytes(&self, reference: &str) -> Option<Vec<u8>>;

    /// The file the stored attachment `reference` names is kept in, for an agent that reads it there; `None` for
    /// attachments that are in no file the agent can open.
    fn path(&self, _reference: &str) -> Option<String> {
        None
    }
}

fn failed(message: String, reason: &str) -> RunOutcome {
    RunOutcome::Failed(TurnError { message, data: json!({ "reason": reason }), provider_error: None })
}

/// The input row's text: its content, a string or its text parts.
fn prompt_text(input: &Value) -> String {
    match input.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The input row is the wake an agent's own reply asked for, not something to tell the agent: every other
/// notification of the session (a Goal's continuation, a routine, a shell's end) is a prompt.
pub fn is_wake(input: &Value) -> bool {
    input.pointer("/meta/source").and_then(Value::as_str) == Some("task-notification") && prompt_text(input).contains(WAKE_TEXT)
}

/// The session of `preset`'s agent the conversation holds, if its header holds one of that agent's.
pub fn stored_session(header: &Header, preset: &AgentPreset) -> Option<Stored> {
    let stored = header.get(SESSION_KEY)?;
    let text = |key: &str| stored.get(key).and_then(Value::as_str).map(str::to_owned);
    (text("agent").as_deref() == Some(preset.id.as_str())).then(|| text("sessionId")).flatten().map(|session_id| Stored { session_id, prompt: text("prompt") })
}

/// What one turn of a thread on an agent is asked with.
pub struct TurnRequest {
    pub thread: ThreadId,
    pub cwd: AbsPath,
    /// The agent's session the conversation holds (its header's [`SESSION_KEY`]), if it holds one of this agent's.
    pub stored: Option<Stored>,
    /// Mixdog's prompt for the session.
    pub rules: Option<String>,
    /// The turn's input row, as it is sent: the turn's context ahead of the prompt, its reminders behind it.
    pub input: Value,
    pub conversation: Arc<dyn Conversation>,
    pub attachments: Arc<dyn Attachments>,
}

/// What of a message did not reach the agent: how many images, and the name of each file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct LeftOut {
    pub(crate) images: usize,
    pub(crate) files: Vec<String>,
}

/// The name a file part is shown under.
fn file_name(part: &Value) -> &str {
    part.get("filename").and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or("attachment")
}

/// The text of a file that goes into the prompt itself; a longer one is read by the agent from where it is stored.
const EMBEDDED_TEXT_MAX_BYTES: usize = 256 * 1024;

/// `path` as a `file:` URI.
fn file_uri(path: &str) -> String {
    let path = path.replace('\\', "/");
    let mut uri = String::from(if path.starts_with('/') { "file://" } else { "file:///" });
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => uri.push(char::from(byte)),
            other => uri.push_str(&format!("%{other:02X}")),
        }
    }
    uri
}

/// The block an attached file reaches the agent as. A file that is text is in the prompt: an embedded resource
/// where the agent takes one (`embedded`), else a text block under the file's name. Any other file (a PDF, a
/// document), and a text too long for the prompt, is a link to where the attachment is stored, which the agent
/// reads with a tool of its own: every agent takes a link, and none is sent bytes it may drop. `None` for a file
/// that can be neither read nor linked.
async fn file_block(part: &Value, embedded: bool, attachments: &dyn Attachments) -> Option<Value> {
    let field = |key: &str| part.get(key).and_then(Value::as_str).filter(|text| !text.is_empty());
    let reference = field("attachmentRef");
    let name = file_name(part);
    let stored = reference.and_then(|reference| attachments.path(reference));
    let bytes = match (field("data"), reference) {
        (Some(data), _) => base64::engine::general_purpose::STANDARD.decode(data).ok(),
        (None, Some(reference)) => attachments.bytes(reference).await,
        (None, None) => None,
    };
    let text = bytes.and_then(|bytes| String::from_utf8(bytes).ok()).filter(|text| !text.contains('\0'));
    let mime = field("mimeType").or_else(|| field("mediaType"));
    let in_prompt = text.filter(|text| text.len() <= EMBEDDED_TEXT_MAX_BYTES || stored.is_none());
    match (in_prompt, stored) {
        (Some(text), stored) => Some(if embedded {
            let uri = stored.as_deref().map_or_else(|| format!("attachment:///{name}"), file_uri);
            json!({ "type": "resource", "resource": { "uri": uri, "mimeType": mime.unwrap_or("text/plain"), "text": text } })
        } else {
            json!({ "type": "text", "text": format!("[Attached file: {name}]\n{text}") })
        }),
        (None, Some(stored)) => {
            let mut link = json!({ "type": "resource_link", "uri": file_uri(&stored), "name": name });
            if let Some(mime) = mime {
                link["mimeType"] = json!(mime);
            }
            Some(link)
        }
        (None, None) => None,
    }
}

/// The input row as the blocks of a prompt: its text parts as text, its images as image blocks where the agent takes
/// them (`images`), its files as [`file_block`] makes them. Also what was left out.
async fn prompt_blocks(input: &Value, (images, embedded): (bool, bool), attachments: &dyn Attachments) -> (Vec<Value>, LeftOut) {
    let text = |text: &str| json!({ "type": "text", "text": text });
    let parts = match input.get("content") {
        Some(Value::Array(parts)) => parts,
        Some(Value::String(content)) => return (vec![text(content)], LeftOut::default()),
        _ => return (vec![text("")], LeftOut::default()),
    };
    let (mut blocks, mut left_out) = (Vec::new(), LeftOut::default());
    for part in parts {
        let kind = part.get("type").and_then(Value::as_str);
        let is_image = kind == Some("image") || part.get("mimeType").and_then(Value::as_str).is_some_and(|mime| mime.starts_with("image/"));
        match kind {
            Some("text") if part.get("text").is_some_and(Value::is_string) => blocks.extend(part.get("text").and_then(Value::as_str).map(text)),
            Some("image" | "file") if is_image => {
                let data = match (part.get("data").and_then(Value::as_str), part.get("attachmentRef").and_then(Value::as_str)) {
                    _ if !images => None,
                    (Some(data), _) => Some(data.to_owned()),
                    (None, Some(reference)) => attachments.bytes(reference).await.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
                    (None, None) => None,
                };
                match data {
                    Some(data) => {
                        let mime = part.get("mimeType").and_then(Value::as_str).unwrap_or("image/png");
                        blocks.push(json!({ "type": "image", "mimeType": mime, "data": data }));
                    }
                    None => left_out.images += 1,
                }
            }
            // A stored text attachment is a text part that names its attachment in place of its text.
            Some("text" | "file") => match file_block(part, embedded, attachments).await {
                Some(block) => blocks.push(block),
                None => left_out.files.push(file_name(part).to_owned()),
            },
            _ => {}
        }
    }
    (blocks, left_out)
}

/// One turn of a thread on `preset`'s agent, reported to `surface`: the agent's process is found or started, its
/// session opened and recorded, its model chosen, and the input sent as a prompt, or, for the wake an agent's own
/// reply asked for, that reply shown. Every wait in it ends with the turn's cancel or the agent's exit.
pub async fn serve(agents: &Arc<Agents>, preset: &AgentPreset, request: TurnRequest, surface: Arc<dyn TurnSurface>, context: TurnContext) -> TurnEnd {
    let thread = request.thread.clone();
    if is_wake(&request.input) {
        // The reply is in the process that asked for this turn. A process started since has none of it, and a
        // prompt's turn that ran first has shown it: the wake then has nothing to show, and is never a prompt.
        let Some(session) = agents.running(&thread).filter(|running| running.woken() && !running.connection.exited().is_cancelled()) else {
            return TurnEnd::Completed { text: String::new(), stop_reason: None, tool_calls: 0 };
        };
        return crate::turn::run(&session, surface, Ask::Reply, context).await;
    }
    let mut context = context;
    let (session, prompt) = match begin(agents, preset, request, &surface, &context).await {
        Ok((session, prompt, record)) => {
            context.record = record;
            (session, prompt)
        }
        // The turn ended before the agent was asked anything: what the agent queued for it is answered here, whatever
        // step of the start it ended at.
        Err(end) => {
            let why = match &end {
                TurnEnd::Failed { message, .. } => message.as_str(),
                _ => "the turn was stopped before it started",
            };
            agents.unrun(&thread, why).await;
            return end;
        }
    };
    let end = crate::turn::run(&session, surface.clone(), Ask::Prompt(prompt), context).await;
    // The agent connects to the session's tool server while it opens the session, or after it when that attempt took
    // too long: one that has not by the end of a turn it answered works with its own tools only.
    if matches!(end, TurnEnd::Completed { .. }) && session.take_unconnected() {
        let _ = surface
            .notice(
                format!("{} did not take Mixdog's tools: it never connected to the session's tool server, and works with its own tools only.", preset.label),
                true,
            )
            .await;
    }
    account_learned(agents, preset, &end).await;
    // The agent's session is gone: the conversation stops naming it, and the next turn starts a new one with the
    // conversation handed over. A record that cannot be dropped fails to reopen there, which hands it over too.
    if matches!(end, TurnEnd::Failed { code: Some(crate::turn::SESSION_NOT_FOUND), .. }) {
        agents.end_process(&thread);
        let _ = surface.save_header(HeaderChange { set: Default::default(), unset: vec![SESSION_KEY.to_owned()], patch: Default::default() }).await;
    }
    end
}

/// What a turn of `preset`'s agent, a session's or a one-off question's, learned of the account is the agent's state
/// from here. A refusal stands, in the agent's words, through every check and a restart of the app, until a sign-in
/// succeeds or the agent answers a turn.
async fn account_learned(agents: &Agents, preset: &AgentPreset, end: &TurnEnd) {
    match end {
        TurnEnd::Refused { message } => agents.refused(preset, message).await,
        TurnEnd::Completed { .. } => agents.answered(preset).await,
        TurnEnd::Failed { message, code: Some(AUTH_REQUIRED), .. } => {
            agents.not_ready(preset, |version| Readiness::SignedOut { version, message: message.clone() })
        }
        _ => {}
    }
}

/// The start of a prompt's turn: the agent's process found or started, its session opened, its model chosen, and the
/// prompt's blocks made, with the header change that records the session with the conversation once the prompt is
/// sent (`None` when the record stands). `Err` is the end of a turn that never reached the agent.
async fn begin(
    agents: &Arc<Agents>,
    preset: &AgentPreset,
    request: TurnRequest,
    surface: &Arc<dyn TurnSurface>,
    context: &TurnContext,
) -> Result<(Arc<crate::session::AgentSession>, Vec<Value>, Option<HeaderChange>), TurnEnd> {
    let TurnRequest { thread, cwd, stored, rules, input, conversation, attachments } = request;
    let refused = |refusal: Refusal| TurnEnd::Failed { message: refusal.message(preset), code: refusal.signed_out().then_some(AUTH_REQUIRED), reported: false };
    // The session compacts where a provider's does: before the request is sent, once the context the last turn left
    // has reached the session's trigger. The agent owns the context, so the compaction is the one a manual Compact
    // makes of an agent's session: Mixdog's summary becomes the stored context, the agent's session is left behind,
    // and this turn opens a new one on the summary. A summary that cannot be made leaves the agent's session as it is.
    let mut stored = stored;
    let mut compacted = None;
    // A compaction that failed may have left the agent's session behind first: the session the turn goes on in is
    // recorded again.
    let mut record_again = false;
    if let (Some(_), Some(due)) = (&stored, conversation.compaction_due()) {
        // The pass shows as a provider's does: the spinner's `compacting` while the summary is made, the divider of the
        // compaction it stores, and the loop's marker of the pass, which the session shows where the loop's would be.
        let _ = surface.stage("compacting").await;
        let began = (context.now_ms)();
        let made = tokio::select! {
            biased;
            // The process holds the session the compaction was leaving behind: it ends with the stop, as the session
            // is not to be continued past a compaction that may have been stored.
            () = context.cancel.cancelled() => {
                agents.end_process(&thread);
                return Err(TurnEnd::Interrupted);
            }
            made = conversation.compact() => made,
        };
        let _ = surface.stage("requesting").await;
        match made {
            Ok(Some(summary)) => {
                let _ = surface.compact_event(pass(due, (context.now_ms)() - began, CompactStatus::Compacted)).await;
                compacted = Some(summary);
                stored = None;
            }
            Ok(None) => {}
            Err(why) => {
                tracing::warn!(
                    "[acp] {}'s context reached the compaction trigger ({} of {} tokens) and was not summarized: {why}",
                    preset.id,
                    due.used,
                    due.trigger
                );
                let _ = surface.compact_event(pass(due, (context.now_ms)() - began, CompactStatus::Failed)).await;
                record_again = true;
            }
        }
    }
    if stored.is_none() {
        // The conversation holds no agent session to continue (its first agent turn, or a fork, a rewind, a clear or
        // Mixdog's own turns since): a process still running for the thread holds one that is not this conversation's.
        agents.end_process(&thread);
    }
    let session = tokio::select! {
        biased;
        () = context.cancel.cancelled() => {
            // The stop ended a wait for an agent that has not closed the prompt cancelled before: it is not waited on again.
            if agents.running(&thread).is_some_and(|running| running.holds_cancelled_prompt()) {
                agents.end_process(&thread);
            }
            return Err(TurnEnd::Interrupted);
        }
        opened = agents.session(&thread, preset, cwd, stored.clone(), rules) => match opened {
            Ok(session) => session,
            Err(refusal) => return Err(refused(refusal)),
        },
    };
    // What rides the prompt ahead of the user's own blocks.
    let mut lead: Vec<String> = Vec::new();
    let fresh = stored.as_ref().map(|stored| stored.session_id.as_str()) != Some(session.session_id.as_str());
    if fresh {
        // The agent's session starts without the conversation the Mixdog session holds (the route came to the agent in
        // the middle of it, a fork, a rewind, or a session the agent could not reopen): Mixdog's own compaction
        // summarizes it once, the summary becomes the session's stored context, and the agent reads it ahead of the
        // user's message. Its session is recorded only once the prompt that carries the summary is written to it, so
        // a summary that failed, or one the turn was stopped before sending, is handed over by the next turn and the
        // agent never goes on blind.
        let automatic = compacted.is_some();
        let handed = match compacted {
            // The automatic compaction above made the summary and told of it.
            Some(summary) => Ok(Some(summary)),
            // The summary is the session's compaction too: the spinner shows it as one while it is made.
            None => {
                let summarizes = conversation.hand_over_summarizes();
                if summarizes {
                    let _ = surface.stage("compacting").await;
                }
                let handed = tokio::select! {
                    biased;
                    () = context.cancel.cancelled() => {
                        agents.end_process(&thread);
                        return Err(TurnEnd::Interrupted);
                    }
                    handed = conversation.hand_over() => handed,
                };
                if summarizes {
                    let _ = surface.stage("requesting").await;
                }
                handed
            }
        };
        match handed {
            Ok(Some(summary)) => {
                lead.push(format!(
                    "# The conversation before this session\nThis session continues a conversation held in Mixdog. Mixdog summarized it; take what follows as what was said and done before the request below.\n\n{summary}"
                ));
                // An automatic compaction shows as a provider's does, by the divider of what it stored.
                if !automatic {
                    let notice = if session.restarted {
                        format!("{} could not reopen its earlier session: the conversation above was summarized for the new one.", preset.label)
                    } else {
                        format!("The conversation above was summarized for {}, which starts a session of its own here.", preset.label)
                    };
                    let _ = surface.notice(notice, false).await;
                }
            }
            Ok(None) => {}
            Err(why) => {
                agents.end_process(&thread);
                return Err(TurnEnd::Failed {
                    message: format!("The conversation could not be summarized for {}: {why}", preset.label),
                    code: None,
                    reported: false,
                });
            }
        }
    }
    // Saved by the turn once the prompt is written: a session is never recorded as holding a summary or a prompt the
    // turn was stopped before sending.
    let record = (fresh || record_again || stored.as_ref().and_then(|stored| stored.prompt.as_deref()) != session.prompt.as_deref()).then(|| {
        let record = json!({ "agent": preset.id, "sessionId": session.session_id, "prompt": session.prompt });
        HeaderChange { set: std::iter::once((SESSION_KEY.to_owned(), record)).collect(), unset: Vec::new(), patch: Default::default() }
    });
    if context.model != DEFAULT_MODEL {
        // The route names the model; the agent's own id of it at the route's effort is what is run.
        let model = crate::tiers::agent_model(&session.models(), &preset.quirks.effort_tiers, &context.model, context.effort.as_deref());
        let selected = tokio::select! {
            biased;
            // A request the agent never answers leaves its process in a state nobody knows: it is not kept.
            () = context.cancel.cancelled() => {
                agents.end_process(&thread);
                return Err(TurnEnd::Interrupted);
            }
            selected = session.select_model(&model) => selected,
        };
        if let Err(fault) = selected {
            return Err(refused(Refusal::Fault(fault)));
        }
    }
    let (mut blocks, left_out) = prompt_blocks(&input, (session.images, session.embedded), attachments.as_ref()).await;
    if left_out.images > 0 {
        let why = if session.images { "could not be read".to_owned() } else { format!("{} takes no images", preset.label) };
        let _ = surface.notice(format!("{} image(s) of this message were not sent to {}: {why}.", left_out.images, preset.label), true).await;
    }
    if !left_out.files.is_empty() {
        let named = left_out.files.iter().map(|name| format!("\"{name}\"")).collect::<Vec<_>>().join(", ");
        let notice = format!("Not sent to {} (not readable where the session keeps its attachments): {named}.", preset.label);
        let _ = surface.notice(notice, true).await;
    }
    // An agent whose system prompt takes nothing from its client is given Mixdog's prompt in the text of the first
    // prompt its session gets, and again when the prompt changed.
    let mut prompt: Vec<Value> = session.take_unsent_prompt().into_iter().chain(lead).map(|text| json!({ "type": "text", "text": text })).collect();
    prompt.append(&mut blocks);
    Ok((session, prompt, record))
}

/// One turn of a session on `preset`'s agent, begun.
pub struct AgentTurn {
    pub thread: ThreadId,
    pub turn: TurnId,
    /// The header the turn runs on.
    pub header: Header,
    /// The turn's input row, as it is sent.
    pub input: Value,
    /// Mixdog's prompt for the session, as the header holds it.
    pub rules: Option<String>,
    pub surface: Arc<dyn TurnSurface>,
    pub cancel: CancellationToken,
    pub progress: Option<watch::Sender<RunProgress>>,
    pub transcript: Option<TurnTranscript>,
    /// The session's tools, each call run as the loop runs one.
    pub calls: Option<Arc<mixdog_agent::handed::HandedCalls>>,
    pub conversation: Arc<dyn Conversation>,
    pub attachments: Arc<dyn Attachments>,
    /// The hook of the job that owns a sub-agent's turn: told each tool result the turn gains.
    pub on_tool_result: Option<crate::turn::ToolResultHook>,
}

/// Runs `turn` on `preset`'s agent to the run's outcome.
pub async fn drive(agents: &Arc<Agents>, preset: &AgentPreset, now_ms: Arc<dyn Fn() -> i64 + Send + Sync>, turn: AgentTurn) -> RunOutcome {
    let AgentTurn { thread, turn, header, input, rules, surface, cancel, progress, transcript, calls, conversation, attachments, on_tool_result } = turn;
    let Some(cwd) = header.get("cwd").and_then(Value::as_str).and_then(AbsPath::new) else {
        return failed("The session has no working folder to start the agent in.".to_owned(), "acpAgent");
    };
    let thread_id = thread.clone();
    let request = TurnRequest { thread, cwd, stored: stored_session(&header, preset), rules, input, conversation, attachments };
    let model = header.get("model").and_then(Value::as_str).unwrap_or(DEFAULT_MODEL).to_owned();
    let effort = header.get("effort").and_then(Value::as_str).filter(|effort| !effort.is_empty()).map(str::to_owned);
    let clock = now_ms.clone();
    let context = TurnContext { turn, model: model.clone(), effort, now_ms, cancel, progress, calls, on_tool_result, record: None };
    let stop = context.cancel.clone();
    match serve(agents, preset, request, surface, context).await {
        TurnEnd::Failed { message, code, reported } => {
            // Only what the agent itself reported for the prompt is the account's quota speaking; a lost session is not.
            let current = agents.running(&thread_id).and_then(|session| session.models().current);
            let now_ms = clock();
            let check = (reported && code != Some(crate::turn::SESSION_NOT_FOUND)).then(|| crate::agents::QuotaCheck {
                model: &model,
                current: current.as_deref(),
                now_ms,
                stop: &stop,
            });
            RunOutcome::Failed(agents.failure(preset, message, code, json!({ "reason": "acpAgent", "code": code }), check).await)
        }
        end => outcome(end, transcript.as_ref()),
    }
}

/// What an agent answered a question asked outside every conversation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Answered {
    pub text: String,
    pub stop_reason: Option<String>,
    pub usage: Option<crate::surface::TurnUsage>,
}

/// Where the turn of a question asked outside every conversation reports: nothing of it is shown, no call of the
/// agent's is approved, and its usage is kept for the asker.
#[derive(Clone, Default)]
struct Unshown(Arc<std::sync::Mutex<Option<crate::surface::TurnUsage>>>);

#[async_trait]
impl TurnSurface for Unshown {
    async fn item_started(&self, _: mixdog_protocol::ThreadItem) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn delta(&self, _: mixdog_protocol::ItemId, _: String) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn text_settled(&self, _: mixdog_protocol::ItemId) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn reasoning_delta(&self, _: mixdog_protocol::ItemId, _: String) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn reasoning_completed(&self, _: mixdog_protocol::ItemId, _: String) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn commit(&self, _: mixdog_core_session::session::ItemCommit) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn notice(&self, _: String, _: bool) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn usage(&self, usage: crate::surface::TurnUsage) -> Result<(), mixdog_core_session::session::run::RunError> {
        *lock(&self.0) = Some(usage);
        Ok(())
    }
    async fn draft(&self, _: Value) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn save_header(&self, _: HeaderChange) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    /// Nobody is asked: the agent is refused the call, as a session with nobody to approve refuses it, and goes on.
    async fn approve(&self, _: mixdog_core_api::domain::approval::ApprovalAsk) -> mixdog_protocol::ApprovalResolution {
        mixdog_protocol::ApprovalResolution::Unavailable { at: 0 }
    }
    async fn stage(&self, _: &str) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn compact_event(&self, _: crate::surface::CompactEvent) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    async fn call_mark(&self, _: crate::surface::CallMark) -> Result<(), mixdog_core_session::session::run::RunError> {
        Ok(())
    }
    fn call_epoch(&self) -> u64 {
        0
    }
    fn closing(&self) -> Arc<dyn TurnSurface> {
        Arc::new(self.clone())
    }
}

/// Ends the process of a question's own session when the question is over, however it ends.
struct Ended(Arc<crate::session::AgentSession>);

impl Drop for Ended {
    fn drop(&mut self) {
        self.0.connection.kill();
    }
}

/// Asks `preset`'s agent `prompt` under the instructions `system`, in a process and a session of its own that hold
/// no conversation, are handed no tools and end with the answer: what writes a session's summary when the session's
/// own model is the agent. `model` is the route's name of the model, as a turn's is. Nothing the agent does in it is
/// approved, and a caller that stops waiting ends it.
pub async fn ask_once(
    agents: &Arc<Agents>,
    preset: &AgentPreset,
    model: &str,
    system: &str,
    prompt: &str,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
) -> Result<Answered, String> {
    if !agents.enabled() {
        return Err(Refusal::Off.message(preset));
    }
    let cwd = AbsPath::new(agents.parts.probe_cwd.clone()).ok_or_else(|| "the agents have no folder to start a question's session in".to_owned())?;
    // Held to the answer: the CLI is not replaced under a process no session holds.
    let (program, _starting) = agents.ready_program(preset).await.map_err(|refusal| refusal.message(preset))?;
    let open =
        crate::session::Open { preset, program: &program, cwd, stored: None, rules: Some(system.to_owned()), held: None, grants: Arc::default(), handed: None };
    let session = crate::session::AgentSession::open(agents.parts.processes.clone(), agents.parts.files.clone(), open, Arc::new(|| {}), Box::new(|| {}))
        .await
        .map_err(|fault| {
            agents.open_failed(preset, &fault);
            Refusal::Fault(fault).message(preset)
        })?;
    let _ended = Ended(session.clone());
    let answered = async {
        if model != DEFAULT_MODEL {
            let model = crate::tiers::agent_model(&session.models(), &preset.quirks.effort_tiers, model, None);
            session.select_model(&model).await.map_err(|fault| Refusal::Fault(fault).message(preset))?;
        }
        let surface = Unshown::default();
        let blocks = session.take_unsent_prompt().into_iter().chain([prompt.to_owned()]).map(|text| json!({ "type": "text", "text": text })).collect();
        let context = TurnContext {
            turn: TurnId::from("question"),
            model: model.to_owned(),
            effort: None,
            now_ms,
            cancel: CancellationToken::new(),
            progress: None,
            calls: None,
            on_tool_result: None,
            record: None,
        };
        let end = crate::turn::run(&session, Arc::new(surface.clone()), Ask::Prompt(blocks), context).await;
        account_learned(agents, preset, &end).await;
        match end {
            TurnEnd::Completed { text, stop_reason, .. } => {
                let usage = lock(&surface.0).take();
                Ok(Answered { text, stop_reason, usage })
            }
            TurnEnd::Interrupted => Err(format!("{} stopped before it answered.", preset.label)),
            TurnEnd::Failed { message, .. } | TurnEnd::Refused { message } => Err(message),
        }
    }
    .await;
    // The question's session is no conversation of the user's: the agent is asked to forget it before its process ends.
    session.close().await;
    answered
}

fn outcome(end: TurnEnd, transcript: Option<&TurnTranscript>) -> RunOutcome {
    match end {
        TurnEnd::Completed { text, stop_reason, tool_calls } => {
            if let Some(transcript) = transcript {
                transcript.final_text(&text);
            }
            let termination = match stop_reason.as_deref() {
                Some("refusal") => Some(Termination::Refusal),
                Some("max_tokens" | "max_turn_requests") => Some(Termination::Truncated),
                _ => None,
            };
            RunOutcome::Completed(Box::new(TurnResult {
                content: text,
                report_content: None,
                termination,
                iterations: 1,
                tool_calls_total: tool_calls,
                stop_reason,
            }))
        }
        TurnEnd::Interrupted => RunOutcome::Interrupted,
        TurnEnd::Failed { message, code, .. } => {
            RunOutcome::Failed(TurnError { message, data: json!({ "reason": "acpAgent", "code": code }), provider_error: None })
        }
        TurnEnd::Refused { message } => RunOutcome::Failed(TurnError { message, data: json!({ "reason": "acpAgentAccount" }), provider_error: None }),
    }
}

/// A turn of Mixdog's own loop begins on a session whose header is `header`: an agent the session ran on before has no
/// part in it, and that agent's session is not continued after turns it never saw. The change that forgets it, if the
/// header holds one.
pub fn loop_turn(agents: &Agents, thread: &ThreadId, header: &Header) -> Option<HeaderChange> {
    agents.end_process(thread);
    header.contains_key(SESSION_KEY).then(|| HeaderChange { set: Default::default(), unset: vec![SESSION_KEY.to_owned()], patch: Default::default() })
}
