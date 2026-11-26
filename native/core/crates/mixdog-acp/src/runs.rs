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
use crate::agents::Refusal;
use crate::agents::lock;
use crate::preset::AgentPreset;
use crate::preset::Distribution;
use crate::preset::ProcessScope;
use crate::surface::TurnSurface;
use crate::turn::Ask;
use crate::turn::Pictures;
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

    /// The session's automatic compaction trigger (in tokens) when running under `effective_window`, or `None` when
    /// automatic compaction is off.
    fn auto_compaction_trigger(&self, _effective_window: u64) -> Option<u64> {
        None
    }

    /// The session's own compaction of the conversation it holds, as a manual Compact makes it: the header stops
    /// naming the agent's session, the summary becomes the stored context, and the summary is returned as text for the
    /// session the agent starts next. `None` for a session with nothing to compact; an error may come after the header
    /// stopped naming the session.
    async fn compact(&self) -> Result<Option<String>, String> {
        self.hand_over().await
    }

    /// Compacts the live in-progress conversation mid-turn (including work committed during this turn), leaves the
    /// agent's session behind, stores Mixdog's summary as the session's context, and returns it as text for the fresh
    /// agent session.
    async fn compact_mid_turn(&self, _effective_window: Option<u64>) -> Result<Option<String>, String> {
        self.compact().await
    }
}

/// The token occupancy at which Mixdog compacts an ACP session before the agent compacts itself: the lower of the
/// session's automatic compaction trigger and the preset's compaction cliff. `None` when automatic compaction is off
/// or no effective window is known.
pub(crate) fn effective_compaction_trigger(preset: &AgentPreset, conversation: &dyn Conversation, effective_window: u64) -> Option<u64> {
    if effective_window == 0 {
        return None;
    }
    let policy_trigger = conversation.auto_compaction_trigger(effective_window)?;
    let cliff = preset.quirks.mid_turn_compaction_cliff(effective_window);
    Some(cliff.map_or(policy_trigger, |cliff| policy_trigger.min(cliff)).max(1))
}

fn header_positive_u64(header: &Header, key: &str) -> Option<u64> {
    let n = header.get(key).and_then(Value::as_f64)?.floor();
    (n.is_finite() && n >= 1.0).then_some(n as u64)
}

fn header_context_tokens(header: &Header) -> Option<u64> {
    if header.get("lastContextTokensStaleAfterCompact") == Some(&Value::Bool(true)) {
        return None;
    }
    header_positive_u64(header, "lastContextTokens")
}

fn header_context_window(header: &Header) -> Option<u64> {
    header_positive_u64(header, "rawContextWindow").or_else(|| header_positive_u64(header, "contextWindow"))
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

/// The attachments the session's rows name, and where the pictures its agent shows are kept.
#[async_trait]
pub trait Attachments: Send + Sync {
    /// The bytes of the stored attachment `reference` names.
    async fn bytes(&self, reference: &str) -> Option<Vec<u8>>;

    /// The file the stored attachment `reference` names is kept in, for an agent that reads it there; `None` for
    /// attachments that are in no file the agent can open.
    fn path(&self, _reference: &str) -> Option<String> {
        None
    }

    /// Keeps `image`, a picture the agent showed, as Mixdog keeps a picture its own media generation made; `None` where
    /// nothing keeps one, or it could not be kept.
    async fn keep_image(&self, _image: ShownImage) -> Option<KeptImage> {
        None
    }
}

/// A picture the agent showed, to keep.
#[derive(Clone, Debug, PartialEq)]
pub struct ShownImage {
    pub bytes: Vec<u8>,
    pub mime: String,
    /// What the agent made it from, where it says.
    pub prompt: String,
    /// How it was asked for (`aspect`), where the agent says.
    pub options: Value,
    /// The agent's route and the model it ran on.
    pub provider: String,
    pub model: String,
}

/// A kept picture: its media asset, and the file that holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeptImage {
    pub asset_id: String,
    pub path: Option<String>,
}

pub(crate) struct NoAttachments;

#[async_trait]
impl Attachments for NoAttachments {
    async fn bytes(&self, _reference: &str) -> Option<Vec<u8>> {
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
    /// The session's last measured context occupancy from the header, when fresh.
    pub last_context_tokens: Option<u64>,
    /// The context window persisted on the session header (raw or effective), if any.
    pub context_window: Option<u64>,
}

/// What of a message did not reach the agent: how many images, and the name of each file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct LeftOut {
    pub(crate) images: usize,
    pub(crate) files: Vec<String>,
}

impl LeftOut {
    pub(crate) async fn notify(&self, surface: &dyn TurnSurface, label: &str, supports_images: bool) {
        if self.images > 0 {
            let why = if supports_images { "could not be read".to_owned() } else { format!("{label} takes no images") };
            let _ = surface.notice(format!("{} image(s) of this message were not sent to {label}: {why}.", self.images), true).await;
        }
        if !self.files.is_empty() {
            let named = self.files.iter().map(|name| format!("\"{name}\"")).collect::<Vec<_>>().join(", ");
            let notice = format!("Not sent to {label} (not readable where the session keeps its attachments): {named}.");
            let _ = surface.notice(notice, true).await;
        }
    }
}

/// The name a file part is shown under.
fn file_name(part: &Value) -> &str {
    ["filename", "name"].iter().find_map(|key| part.get(*key).and_then(Value::as_str).filter(|name| !name.is_empty())).unwrap_or("attachment")
}

/// The text of a file that goes into the prompt itself; a longer one is read by the agent from where it is stored.
const EMBEDDED_TEXT_MAX_BYTES: usize = 256 * 1024;

/// `text` as the path of a URI: every byte that is not a path character of one percent-encoded.
fn uri_path(text: &str) -> String {
    let mut path = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => path.push(char::from(byte)),
            other => path.push_str(&format!("%{other:02X}")),
        }
    }
    path
}

/// `path` as a `file:` URI.
fn file_uri(path: &str) -> String {
    let path = path.replace('\\', "/");
    format!("{}{}", if path.starts_with('/') { "file://" } else { "file:///" }, uri_path(&path))
}

/// The block an attached file reaches the agent as, together with its stored path when linked from outside `cwd`. A
/// file that is text is in the prompt: an embedded resource where the agent takes one (`embedded`), else a text block
/// under the file's name. Any other file (a PDF, a document), and a text too long for the prompt, is a link to where
/// the attachment is stored, which the agent reads with a tool of its own: every agent takes a link, and none is sent
/// bytes it may drop. `None` for a file that can be neither read nor linked.
async fn file_block(part: &Value, embedded: bool, attachments: &dyn Attachments, max_embedded_bytes: usize) -> (Option<Value>, Option<String>) {
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
    let in_prompt = text.filter(|text| text.len() <= max_embedded_bytes || stored.is_none());
    match (in_prompt, stored) {
        (Some(text), stored) => {
            let block = if embedded {
                let uri = stored.as_deref().map_or_else(|| format!("attachment:///{}", uri_path(name)), file_uri);
                json!({ "type": "resource", "resource": { "uri": uri, "mimeType": mime.unwrap_or("text/plain"), "text": text } })
            } else {
                json!({ "type": "text", "text": format!("[Attached file: {name}]\n{text}") })
            };
            (Some(block), stored)
        }
        (None, Some(stored)) => {
            let mut link = json!({ "type": "resource_link", "uri": file_uri(&stored), "name": name });
            if let Some(mime) = mime {
                link["mimeType"] = json!(mime);
            }
            (Some(link), Some(stored))
        }
        (None, None) => (None, None),
    }
}

/// Pure syntactic check of whether `input` has any part that could produce a prompt block when `images` is allowed.
fn has_candidate_parts(input: &Value, images: bool) -> bool {
    let Some(Value::Array(parts)) = input.get("content") else {
        return true;
    };
    parts.iter().any(|part| {
        let kind = part.get("type").and_then(Value::as_str);
        let mime = ["mimeType", "mediaType"].iter().find_map(|key| part.get(*key).and_then(Value::as_str).filter(|mime| !mime.is_empty()));
        let is_image = kind == Some("image") || mime.is_some_and(|mime| mime.starts_with("image/"));
        let has_payload = ["data", "attachmentRef"].iter().any(|key| part.get(*key).and_then(Value::as_str).is_some_and(|s| !s.is_empty()));
        match kind {
            Some("text") if part.get("text").is_some_and(Value::is_string) => true,
            Some("image" | "file") if is_image => images && has_payload,
            Some("text" | "file") => has_payload,
            _ => false,
        }
    })
}

/// The input row as the blocks of a prompt: its text parts as text, its images as image blocks where the agent takes
/// them (`images`), its files as [`file_block`] makes them. Also returns the non-text/file attachment blocks separately
/// so a mid-turn rollover can resend the turn's attachments to the fresh session, along with what was left out and any
/// stored attachment paths to allow for this session.
async fn prompt_blocks_with_attachments(
    input: &Value,
    (images, embedded): (bool, bool),
    attachments: &dyn Attachments,
) -> (Vec<Value>, Vec<Value>, LeftOut, Vec<String>) {
    prompt_blocks_with_attachments_and_limit(input, (images, embedded), attachments, EMBEDDED_TEXT_MAX_BYTES).await
}

async fn prompt_blocks_with_attachments_and_limit(
    input: &Value,
    (images, embedded): (bool, bool),
    attachments: &dyn Attachments,
    max_embedded_bytes: usize,
) -> (Vec<Value>, Vec<Value>, LeftOut, Vec<String>) {
    let text = |text: &str| json!({ "type": "text", "text": text });
    let parts = match input.get("content") {
        Some(Value::Array(parts)) => parts,
        Some(Value::String(content)) => return (vec![text(content)], Vec::new(), LeftOut::default(), Vec::new()),
        _ => return (vec![text("")], Vec::new(), LeftOut::default(), Vec::new()),
    };
    let (mut blocks, mut attachment_blocks, mut left_out, mut attached) = (Vec::new(), Vec::new(), LeftOut::default(), Vec::new());
    for part in parts {
        let kind = part.get("type").and_then(Value::as_str);
        let mime = ["mimeType", "mediaType"].iter().find_map(|key| part.get(*key).and_then(Value::as_str).filter(|mime| !mime.is_empty()));
        let is_image = kind == Some("image") || mime.is_some_and(|mime| mime.starts_with("image/"));
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
                        let block = json!({ "type": "image", "mimeType": mime.unwrap_or("image/png"), "data": data });
                        attachment_blocks.push(block.clone());
                        blocks.push(block);
                    }
                    None => left_out.images += 1,
                }
            }
            // A stored text attachment is a text part that names its attachment in place of its text.
            Some("text" | "file") => match file_block(part, embedded, attachments, max_embedded_bytes).await {
                (Some(block), stored) => {
                    attachment_blocks.push(block.clone());
                    blocks.push(block);
                    if let Some(stored) = stored {
                        attached.push(stored);
                    }
                }
                (None, _) => left_out.files.push(file_name(part).to_owned()),
            },
            _ => {}
        }
    }
    (blocks, attachment_blocks, left_out, attached)
}

/// The input row as the blocks of a prompt: its text parts as text, its images as image blocks where the agent takes
/// them (`images`), its files as [`file_block`] makes them. Also what was left out and any stored attachment paths to
/// allow for this session.
pub(crate) async fn prompt_blocks(input: &Value, capabilities: (bool, bool), attachments: &dyn Attachments) -> (Vec<Value>, LeftOut, Vec<String>) {
    prompt_blocks_with_text_limit(input, capabilities, attachments, EMBEDDED_TEXT_MAX_BYTES).await
}

/// The input row as the blocks of a prompt: its text parts as text, its images as image blocks where the agent takes
/// them (`images`), its files as [`file_block`] makes them, capping inline expansion of stored text files/pastes at
/// `max_embedded_bytes` (clamped to [`EMBEDDED_TEXT_MAX_BYTES`]).
pub(crate) async fn prompt_blocks_with_text_limit(
    input: &Value,
    capabilities: (bool, bool),
    attachments: &dyn Attachments,
    max_embedded_bytes: usize,
) -> (Vec<Value>, LeftOut, Vec<String>) {
    let limit = max_embedded_bytes.min(EMBEDDED_TEXT_MAX_BYTES);
    let (blocks, _, left_out, attached) = prompt_blocks_with_attachments_and_limit(input, capabilities, attachments, limit).await;
    (blocks, left_out, attached)
}

/// One turn of a thread on `preset`'s agent, reported to `surface`: the agent's process is found or started, its
/// session opened and recorded, its model chosen, and the input sent as a prompt, or, for the wake an agent's own
/// reply asked for, that reply shown. Every wait in it ends with the turn's cancel or the agent's exit.
pub async fn serve(agents: &Arc<Agents>, preset: &AgentPreset, request: TurnRequest, surface: Arc<dyn TurnSurface>, context: TurnContext) -> TurnEnd {
    serve_with_refusal(agents, preset, request, surface, context).await.0
}

/// Wraps a [`TurnSurface`] to record whether the turn emitted any visible output.
/// Pre-prompt stages, compaction events, notices, header saves, and hidden commits do not flip the flag.
#[derive(Clone)]
struct TrackedSurface {
    inner: Arc<dyn TurnSurface>,
    output_produced: Arc<std::sync::atomic::AtomicBool>,
}

impl TrackedSurface {
    fn mark_output(&self) {
        self.output_produced.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[async_trait]
impl TurnSurface for TrackedSurface {
    async fn item_started(&self, item: mixdog_protocol::ThreadItem) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.mark_output();
        self.inner.item_started(item).await
    }
    async fn delta(&self, item: mixdog_protocol::ItemId, text: String) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.mark_output();
        self.inner.delta(item, text).await
    }
    async fn text_settled(&self, item: mixdog_protocol::ItemId) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.inner.text_settled(item).await
    }
    async fn reasoning_delta(&self, item: mixdog_protocol::ItemId, text: String) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.mark_output();
        self.inner.reasoning_delta(item, text).await
    }
    async fn reasoning_completed(&self, item: mixdog_protocol::ItemId, text: String) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.mark_output();
        self.inner.reasoning_completed(item, text).await
    }
    async fn commit(&self, item: mixdog_core_session::session::ItemCommit) -> Result<(), mixdog_core_session::session::run::RunError> {
        if item.visible {
            self.mark_output();
        }
        self.inner.commit(item).await
    }
    async fn notice(&self, text: String, warn: bool) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.inner.notice(text, warn).await
    }
    async fn context_update(&self, usage: crate::surface::TurnUsage) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.inner.context_update(usage).await
    }
    async fn usage(&self, usage: crate::surface::TurnUsage) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.inner.usage(usage).await
    }
    async fn draft(&self, body: Value) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.inner.draft(body).await
    }
    async fn save_header(&self, change: HeaderChange) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.inner.save_header(change).await
    }
    async fn approve(&self, ask: mixdog_core_api::domain::approval::ApprovalAsk) -> mixdog_protocol::ApprovalResolution {
        self.inner.approve(ask).await
    }
    async fn stage(&self, stage: &str) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.inner.stage(stage).await
    }
    async fn compact_event(&self, event: crate::surface::CompactEvent) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.inner.compact_event(event).await
    }
    async fn call_mark(&self, mark: crate::surface::CallMark) -> Result<(), mixdog_core_session::session::run::RunError> {
        self.inner.call_mark(mark).await
    }
    fn call_epoch(&self) -> u64 {
        self.inner.call_epoch()
    }
    async fn peek_steers(&self) -> Result<Vec<crate::surface::SteerDelivery>, mixdog_core_session::session::run::RunError> {
        self.inner.peek_steers().await
    }
    async fn commit_steers(
        &self,
        queued_ids: Vec<mixdog_core_api::ids::QueuedId>,
        now_ms: i64,
        cancel: CancellationToken,
    ) -> Result<Vec<crate::surface::SteerDelivery>, mixdog_core_session::session::run::RunError> {
        self.inner.commit_steers(queued_ids, now_ms, cancel).await
    }
    fn closing(&self) -> Arc<dyn TurnSurface> {
        Arc::new(Self { inner: self.inner.closing(), output_produced: self.output_produced.clone() })
    }
}

fn clone_turn_context(base: &TurnContext, record: Option<HeaderChange>, mid_turn_compaction: Option<crate::turn::MidTurnCompaction>) -> TurnContext {
    TurnContext {
        turn: base.turn.clone(),
        model: base.model.clone(),
        effort: base.effort.clone(),
        now_ms: base.now_ms.clone(),
        cancel: base.cancel.clone(),
        progress: base.progress.clone(),
        calls: base.calls.clone(),
        on_tool_result: base.on_tool_result.clone(),
        record,
        selected_window: base.selected_window,
        attachments: base.attachments.clone(),
        pictures: base.pictures.clone(),
        transcript: base.transcript.clone(),
        output_produced: base.output_produced.clone(),
        mid_turn_compaction,
        cpu: base.cpu,
    }
}

fn mid_turn_compaction_for(
    preset: &AgentPreset,
    conversation: &Arc<dyn Conversation>,
    after_rollover: bool,
    left_behind: &Arc<std::sync::atomic::AtomicBool>,
) -> crate::turn::MidTurnCompaction {
    let preset = preset.clone();
    let conversation = conversation.clone();
    crate::turn::MidTurnCompaction {
        trigger: Arc::new(move |effective_window| effective_compaction_trigger(&preset, conversation.as_ref(), effective_window)),
        after_rollover,
        left_behind: left_behind.clone(),
    }
}

fn pre_turn_compaction_due(
    agents: &Agents,
    preset: &AgentPreset,
    thread: &ThreadId,
    context: &TurnContext,
    last_context_tokens: Option<u64>,
    header_window: Option<u64>,
    conversation: &dyn Conversation,
) -> Option<Due> {
    let policy_due = conversation.compaction_due();
    let cliff_due = last_context_tokens.and_then(|used| {
        let running = agents.running(thread).filter(|session| session.preset.id == preset.id);
        let active_model = running.as_ref().and_then(|session| session.models().current);
        let raw_window = header_window
            .or_else(|| agents.reported_window(preset, &context.model))
            .or_else(|| active_model.as_deref().and_then(|model| preset.quirks.context_window_cap(model)))
            .or_else(|| preset.quirks.context_window_cap(&context.model))
            .or(preset.quirks.default_context_window_cap)?;
        let capped = preset.quirks.effective_context_window_for(&context.model, active_model.as_deref(), raw_window);
        let effective = context.selected_window.map_or(capped, |selected| selected.min(capped));
        let trigger = effective_compaction_trigger(preset, conversation, effective)?;
        (used >= trigger).then_some(Due { used, trigger })
    });
    match (policy_due, cliff_due) {
        (Some(a), Some(b)) => Some(if b.trigger < a.trigger { b } else { a }),
        (Some(due), None) | (None, Some(due)) => Some(due),
        (None, None) => None,
    }
}

async fn serve_with_refusal(
    agents: &Arc<Agents>,
    preset: &AgentPreset,
    request: TurnRequest,
    surface: Arc<dyn TurnSurface>,
    context: TurnContext,
) -> (TurnEnd, bool) {
    let surface: Arc<dyn TurnSurface> = match &context.output_produced {
        Some(output_produced) => Arc::new(TrackedSurface { inner: surface, output_produced: output_produced.clone() }),
        None => surface,
    };
    let thread = request.thread.clone();
    let cwd = request.cwd.clone();
    let rules = request.rules.clone();
    let conversation = request.conversation.clone();
    let mut context = context;
    if context.attachments.is_none() {
        context.attachments = Some(request.attachments.clone());
    }
    if is_wake(&request.input) {
        // The reply is in the session that asked for this turn. One opened since has none of it, a prompt's turn that ran
        // first has shown it, and one of another preset (the route moved meanwhile) is not this route's to show: the wake
        // then has nothing to show, and is never a prompt.
        let session = agents
            .running(&thread)
            .filter(|running| running.preset.id == preset.id && running.woken() && !running.gone().is_cancelled())
            .and_then(|running| running.try_enter_use().ok().map(|use_guard| (running, use_guard)));
        let Some((session, _use)) = session else {
            let end = TurnEnd::Completed { text: String::new(), stop_reason: None, tool_calls: 0 };
            context.settle_progress(&end);
            return (end, false);
        };
        return (crate::turn::run(&session, surface, Ask::Reply, context).await, false);
    }
    let Begun { mut session, mut session_use, mut prompt, mut record, attached, attachment_blocks } =
        match begin(agents, preset, request, &surface, &context).await {
            Ok(begun) => begun,
            // The turn ended before the agent was asked anything: what the agent queued for it is answered here, whatever
            // step of the start it ended at.
            Err((end, pre_prompt_refusal)) => {
                account_learned(agents, preset, &end).await;
                let why = match &end {
                    TurnEnd::Failed { message, .. } => message.as_str(),
                    _ => "the turn was stopped before it started",
                };
                agents.unrun(&thread, why).await;
                context.settle_progress(&end);
                return (end, pre_prompt_refusal);
            }
        };
    let model = context.model.clone();
    let mut accumulated_tool_calls: u64 = 0;
    let mut after_rollover = false;
    let mut needs_settle: bool;
    let left_behind = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let end = loop {
        let reports = session.reported_context_reports();
        let compaction = Some(mid_turn_compaction_for(preset, &conversation, after_rollover, &left_behind));
        let segment_context = clone_turn_context(&context, record.take(), compaction);
        let segment_end = crate::turn::run(&session, surface.clone(), Ask::Prompt(prompt), segment_context).await;
        // Only a window the agent reported in this turn is the turn's model's.
        if let Some(reported) = session.context_use().filter(|_| session.reported_context_reports() > reports) {
            let capped = preset.quirks.effective_context_window_for(&model, session.models().current.as_deref(), reported.size);
            agents.window_reported(preset, &model, capped).await;
        }
        match segment_end {
            TurnEnd::CompactNeeded { due, effective_window, tool_calls } => {
                accumulated_tool_calls += tool_calls;
                after_rollover = true;
                needs_settle = true;
                let held = session.hold_server();
                drop(session_use.take());
                if preset.scope == ProcessScope::Shared {
                    agents.abandon_shared(preset, &session.session_id);
                }
                agents.end_process(&thread);
                let _ = surface.stage("compacting").await;
                let began = (context.now_ms)();
                let made = tokio::select! {
                    biased;
                    () = context.cancel.cancelled() => {
                        drop(held);
                        break TurnEnd::Interrupted;
                    }
                    made = conversation.compact_mid_turn(Some(effective_window)) => made,
                };
                let _ = surface.stage("requesting").await;
                let summary = match made {
                    Ok(Some(summary)) => {
                        let _ = surface.compact_event(pass(due, (context.now_ms)() - began, CompactStatus::Compacted)).await;
                        summary
                    }
                    Ok(None) => {
                        drop(held);
                        break TurnEnd::Failed {
                            message: format!("The conversation could not be summarized mid-turn for {}: nothing to compact.", preset.label),
                            code: None,
                            reported: false,
                        };
                    }
                    Err(why) => {
                        tracing::warn!(
                            "[acp] {}'s context reached the mid-turn compaction trigger ({} of {} tokens) and was not summarized: {why}",
                            preset.id,
                            due.used,
                            due.trigger
                        );
                        let _ = surface.compact_event(pass(due, (context.now_ms)() - began, CompactStatus::Failed)).await;
                        drop(held);
                        break TurnEnd::Failed {
                            message: format!("The conversation could not be summarized mid-turn for {}: {why}", preset.label),
                            code: None,
                            reported: false,
                        };
                    }
                };
                let (new_session, new_use) = tokio::select! {
                    biased;
                    () = context.cancel.cancelled() => {
                        drop(held);
                        break TurnEnd::Interrupted;
                    }
                    // The session left behind answered its cancelled prompt: no server is suspected wedged, and one this
                    // open starts (the last session left the one before) is not bounded, as no first open is.
                    opened = agents.open_session(&thread, preset, cwd.clone(), None, rules.clone(), false) => match opened {
                        Ok(opened) => opened,
                        Err(refusal) => {
                            drop(held);
                            break TurnEnd::Failed {
                                message: refusal.message(preset),
                                code: refusal.signed_out().then_some(AUTH_REQUIRED),
                                reported: false,
                            };
                        }
                    },
                };
                drop(held);
                if context.model != DEFAULT_MODEL {
                    let agent_model = crate::tiers::agent_model(&new_session.models(), &preset.quirks.effort_tiers, &context.model, context.effort.as_deref());
                    let selected = tokio::select! {
                        biased;
                        () = context.cancel.cancelled() => {
                            drop(new_use);
                            cancel_started_session(agents, preset, &thread, &new_session.session_id, None, &surface).await;
                            break TurnEnd::Interrupted;
                        }
                        selected = new_session.select_model(&agent_model) => selected,
                    };
                    if let Err(fault) = selected {
                        drop(new_use);
                        if preset.scope == ProcessScope::Shared {
                            agents.abandon_shared(preset, &new_session.session_id);
                        }
                        agents.end_process(&thread);
                        break TurnEnd::Failed { message: Refusal::Fault(fault).message(preset), code: None, reported: false };
                    }
                }
                for path in &attached {
                    new_session.allow_attached(path);
                }
                let lead = format!(
                    "# The conversation before this session\nThis session continues a conversation held in Mixdog. Mixdog summarized it; take what follows as what was said and done before the continuation below.\n\n{summary}"
                );
                let continuation = "[mixdog-runtime] Mixdog compacted the session context mid-turn and started this fresh session. Continue the in-progress turn from the summary above without repeating already-completed work.";
                let mut next_prompt: Vec<Value> =
                    new_session.take_unsent_prompt().into_iter().chain([lead]).map(|text| json!({ "type": "text", "text": text })).collect();
                next_prompt.extend(attachment_blocks.iter().cloned());
                next_prompt.push(json!({ "type": "text", "text": continuation }));
                let next_record = {
                    let value = json!({ "agent": preset.id, "sessionId": new_session.session_id, "prompt": new_session.prompt });
                    HeaderChange { set: std::iter::once((SESSION_KEY.to_owned(), value)).collect(), unset: Vec::new(), patch: Default::default() }
                };
                session = new_session;
                session_use = new_use;
                prompt = next_prompt;
                record = Some(next_record);
            }
            TurnEnd::Completed { text, stop_reason, tool_calls } => {
                needs_settle = false;
                break TurnEnd::Completed { text, stop_reason, tool_calls: accumulated_tool_calls + tool_calls };
            }
            other => {
                needs_settle = false;
                break other;
            }
        }
    };
    drop(session_use);
    if needs_settle {
        context.settle_progress(&end);
    }
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
        let _ = surface.save_header(unset_session_change()).await;
    }
    // The agent's session was cancelled for a rollover that never came: it holds answers given only to move on to a
    // fresh session, so the conversation stops naming it and the next turn hands the conversation over to a new one.
    if left_behind.load(std::sync::atomic::Ordering::SeqCst) {
        agents.abandon_shared(preset, &session.session_id);
        agents.end_process(&thread);
        unset_session(&surface).await;
    }
    (end, false)
}

/// What a turn of `preset`'s agent, a session's or a one-off question's, learned of the account is the agent's state
/// from here. A refusal stands, in the agent's words, through every check and a restart of the app, until a sign-in
/// succeeds or the agent answers a turn.
async fn account_learned(agents: &Agents, preset: &AgentPreset, end: &TurnEnd) {
    match end {
        TurnEnd::Refused { message } => agents.refused(preset, message).await,
        TurnEnd::Completed { .. } => agents.answered(preset).await,
        TurnEnd::Failed { message, code: Some(AUTH_REQUIRED), .. } => agents.signed_out(preset, message.clone()).await,
        _ => {}
    }
}

fn unset_session_change() -> HeaderChange {
    HeaderChange { set: Default::default(), unset: vec![SESSION_KEY.to_owned()], patch: Default::default() }
}

async fn unset_session(surface: &Arc<dyn TurnSurface>) {
    let _ = surface.closing().save_header(unset_session_change()).await;
}

async fn cancel_started_session(
    agents: &Agents,
    preset: &AgentPreset,
    thread: &ThreadId,
    session_id: &str,
    stored: Option<&Stored>,
    surface: &Arc<dyn TurnSurface>,
) {
    if preset.scope == ProcessScope::Shared {
        agents.abandon_shared(preset, session_id);
        if let Some(stored) = stored {
            agents.abandon_shared(preset, &stored.session_id);
            unset_session(surface).await;
        }
    }
    agents.end_process(thread);
}

struct Begun {
    session: Arc<crate::session::AgentSession>,
    session_use: Option<crate::shared::SessionUse>,
    prompt: Vec<Value>,
    record: Option<HeaderChange>,
    attached: Vec<String>,
    attachment_blocks: Vec<Value>,
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
) -> Result<Begun, (TurnEnd, bool)> {
    let TurnRequest { thread, cwd, stored, rules, input, conversation, attachments, last_context_tokens, context_window } = request;
    let refused = |refusal: Refusal| {
        let eligible = !matches!(refusal, Refusal::Closed);
        (TurnEnd::Failed { message: refusal.message(preset), code: refusal.signed_out().then_some(AUTH_REQUIRED), reported: false }, eligible)
    };
    // A model of another preset of the agent is never asked of this one: the route goes nowhere until it names that preset.
    if let Some(why) = agents.refuses_model(preset, &context.model) {
        return Err((TurnEnd::Failed { message: why, code: None, reported: false }, true));
    }
    // Reject prompts with no sendable candidate parts before compaction, opening a new session, or running handover.
    let known_images = agents.running(&thread).filter(|running| running.preset.id == preset.id).is_none_or(|running| running.images);
    if !has_candidate_parts(&input, known_images) {
        let (_, left_out, _) = prompt_blocks(&input, (known_images, false), attachments.as_ref()).await;
        left_out.notify(surface.as_ref(), &preset.label, known_images).await;
        return Err((TurnEnd::Failed { message: format!("Nothing of this message could be sent to {}.", preset.label), code: None, reported: false }, false));
    }
    // The session compacts where a provider's does: before the request is sent, once the context the last turn left
    // has reached the session's trigger (or the preset's capped compaction cliff). The agent owns the context, so the
    // compaction is the one a manual Compact makes of an agent's session: Mixdog's summary becomes the stored context,
    // the agent's session is left behind, and this turn opens a new one on the summary. A summary that cannot be made
    // leaves the agent's session as it is.
    let mut stored = stored;
    let mut compacted = None;
    // A compaction that failed may have left the agent's session behind first: the session the turn goes on in is
    // recorded again.
    let mut record_again = false;
    if let (Some(_), Some(due)) =
        (&stored, pre_turn_compaction_due(agents, preset, &thread, context, last_context_tokens, context_window, conversation.as_ref()))
    {
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
                return Err((TurnEnd::Interrupted, false));
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
    // The shared server the ended session ran on serves the session opened next on it, with no close in between.
    let held = if stored.is_none() {
        let held = agents.hold_shared(&thread, preset);
        // The conversation holds no agent session to continue (its first agent turn, or a fork, a rewind, a clear or
        // Mixdog's own turns since): a process still running for the thread holds one that is not this conversation's.
        agents.end_process(&thread);
        held
    } else {
        None
    };
    let resolved = tokio::select! {
        biased;
        () = context.cancel.cancelled() => {
            // The stop ended a wait for an agent that has not closed the prompt cancelled before: it is not waited on again.
            if let Some(running) = agents.running(&thread).filter(|running| running.holds_cancelled_prompt()) {
                agents.abandon_shared(preset, &running.session_id);
                agents.end_process(&thread);
                if preset.scope == ProcessScope::Shared && stored.is_some() {
                    unset_session(surface).await;
                }
            } else if preset.scope == ProcessScope::Shared && stored.as_ref().is_some_and(|stored| agents.is_abandoned(preset, &stored.session_id)) {
                unset_session(surface).await;
            }
            return Err((TurnEnd::Interrupted, false));
        }
        resolved = agents.resolve_running(&thread, preset, &cwd, stored.clone(), rules.as_deref()) => match resolved {
            Ok(resolved) => resolved,
            Err(refusal) => return Err(refused(refusal)),
        },
    };
    let (session, session_use, header_cleared) = match resolved {
        crate::agents::ExistingSession::Reuse(session, session_use) => (session, session_use, false),
        crate::agents::ExistingSession::Open { stored: open_stored, abandoned } => {
            // Unset an abandoned SESSION_KEY promptly before blocking on opening a replacement session.
            let header_cleared = abandoned && stored.is_some();
            if header_cleared {
                unset_session(surface).await;
            }
            let (session, session_use) = tokio::select! {
                biased;
                () = context.cancel.cancelled() => return Err((TurnEnd::Interrupted, false)),
                opened = agents.open_session(&thread, preset, cwd, open_stored, rules, abandoned) => match opened {
                    Ok(opened) => opened,
                    Err(refusal) => return Err(refused(refusal)),
                },
            };
            (session, session_use, header_cleared)
        }
    };
    drop(held);
    let newly_opened = session.handoff_pending() || stored.as_ref().map(|stored| stored.session_id.as_str()) != Some(session.session_id.as_str());
    // Build the prompt blocks before running handover or selecting a model so an all-dropped prompt never triggers
    // handover or leaves a newly opened session orphaned.
    let (mut blocks, attachment_blocks, left_out, attached) =
        prompt_blocks_with_attachments(&input, (session.images, session.embedded), attachments.as_ref()).await;
    left_out.notify(surface.as_ref(), &preset.label, session.images).await;
    if blocks.is_empty() {
        drop(session_use);
        if newly_opened {
            session.close().await;
            agents.end_process(&thread);
        }
        return Err((TurnEnd::Failed { message: format!("Nothing of this message could be sent to {}.", preset.label), code: None, reported: false }, false));
    }
    // What rides the prompt ahead of the user's own blocks.
    let mut lead: Vec<String> = Vec::new();
    let fresh = session.handoff_pending() || header_cleared || newly_opened;
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
                        drop(session_use);
                        cancel_started_session(agents, preset, &thread, &session.session_id, stored.as_ref(), surface).await;
                        return Err((TurnEnd::Interrupted, false));
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
                // An automatic compaction shows as a provider's does, by the divider of what it stored;
                // a fresh hand-over emits no notice, only a restarted session that could not be reopened does.
                if !automatic && session.restarted {
                    let notice = format!("{} could not reopen its earlier session: the conversation above was summarized for the new one.", preset.label);
                    let _ = surface.notice(notice, false).await;
                }
            }
            Ok(None) => {}
            Err(why) => {
                drop(session_use);
                agents.end_process(&thread);
                return Err((
                    TurnEnd::Failed { message: format!("The conversation could not be summarized for {}: {why}", preset.label), code: None, reported: false },
                    false,
                ));
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
                drop(session_use);
                cancel_started_session(agents, preset, &thread, &session.session_id, stored.as_ref(), surface).await;
                return Err((TurnEnd::Interrupted, false));
            }
            selected = session.select_model(&model) => selected,
        };
        if let Err(fault) = selected {
            return Err(refused(Refusal::Fault(fault)));
        }
    }
    for path in &attached {
        session.allow_attached(path);
    }
    // An agent whose system prompt takes nothing from its client is given Mixdog's prompt in the text of the first
    // prompt its session gets, and again when the prompt changed.
    let mut prompt: Vec<Value> = session.take_unsent_prompt().into_iter().chain(lead).map(|text| json!({ "type": "text", "text": text })).collect();
    prompt.append(&mut blocks);
    Ok(Begun { session, session_use, prompt, record, attached, attachment_blocks })
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
    /// Set once the turn emits any visible output (text, reasoning, tool call, image card, or visible row).
    pub output_produced: Option<Arc<std::sync::atomic::AtomicBool>>,
}

/// The folders the agent writes what it makes in: the home Mixdog keeps for an agent it installs, and the agent/user
/// homes for a CLI.
fn agent_homes(agents: &Agents, preset: &AgentPreset) -> Vec<AbsPath> {
    let mut homes = Vec::new();
    match preset.distribution {
        Distribution::Registry { .. } => homes.extend(AbsPath::new(agents.home(preset))),
        Distribution::Cli { .. } => {
            for key in ["GEMINI_HOME", if cfg!(windows) { "USERPROFILE" } else { "HOME" }] {
                homes.extend((agents.parts.env)(key).and_then(AbsPath::new));
            }
        }
    }
    homes
}

/// Runs `turn` on `preset`'s agent to the run's outcome.
pub async fn drive(agents: &Arc<Agents>, preset: &AgentPreset, now_ms: Arc<dyn Fn() -> i64 + Send + Sync>, turn: AgentTurn) -> RunOutcome {
    let AgentTurn {
        thread,
        turn,
        header,
        input,
        rules,
        surface,
        cancel,
        progress,
        transcript,
        calls,
        conversation,
        attachments,
        on_tool_result,
        output_produced,
    } = turn;
    let Some(cwd) = header.get("cwd").and_then(Value::as_str).and_then(AbsPath::new) else {
        return failed("The session has no working folder to start the agent in.".to_owned(), "acpAgent");
    };
    let thread_id = thread.clone();
    let pictures = Pictures { keep: attachments.clone(), files: agents.parts.files.clone(), homes: agent_homes(agents, preset) };
    let request = TurnRequest {
        thread,
        cwd,
        stored: stored_session(&header, preset),
        rules,
        input,
        conversation,
        attachments: attachments.clone(),
        last_context_tokens: header_context_tokens(&header),
        context_window: header_context_window(&header),
    };
    let model = header.get("model").and_then(Value::as_str).unwrap_or(DEFAULT_MODEL).to_owned();
    let effort = header.get("effort").and_then(Value::as_str).filter(|effort| !effort.is_empty()).map(str::to_owned);
    let clock = now_ms.clone();
    let selected_window = header.get("selectedContextWindow").and_then(Value::as_u64).filter(|window| *window > 0);
    let context = TurnContext {
        turn,
        model: model.clone(),
        effort,
        now_ms,
        cancel,
        progress,
        calls,
        on_tool_result,
        record: None,
        selected_window,
        attachments: Some(attachments),
        pictures: Some(pictures),
        transcript: transcript.clone(),
        output_produced,
        mid_turn_compaction: None,
        cpu: agents.parts.cpu,
    };
    let stop = context.cancel.clone();
    match serve_with_refusal(agents, preset, request, surface, context).await {
        (TurnEnd::Failed { message, code, reported }, pre_prompt_refusal) => {
            // Only what the agent itself reported for the prompt is the account's quota speaking; a lost session is not.
            let current = agents.running(&thread_id).and_then(|session| session.models().current);
            let now_ms = clock();
            let check = (reported && code != Some(crate::turn::SESSION_NOT_FOUND)).then(|| crate::agents::QuotaCheck {
                model: &model,
                current: current.as_deref(),
                now_ms,
                stop: &stop,
            });
            let data = if pre_prompt_refusal {
                json!({ "reason": "acpAgent", "code": code, "prePromptRefusal": true })
            } else {
                json!({ "reason": "acpAgent", "code": code })
            };
            RunOutcome::Failed(agents.failure(preset, message, code, data, check).await)
        }
        (end, _) => outcome(&preset.provider, end, transcript.as_ref()),
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

/// Ends the process of a question's own session when the question is over, however it ends: a server whose preset shares
/// one among its sessions as the end of its input closes it, so it clears away what it unpacked; a CLI by force.
/// The app's stop waits for such a close.
struct Ended(Arc<crate::session::AgentSession>, Arc<Agents>);

impl Drop for Ended {
    fn drop(&mut self) {
        match self.0.preset.scope {
            ProcessScope::PerSession => self.0.connection.kill(),
            ProcessScope::Shared => {
                let connection = self.0.connection.clone();
                self.1.track_stop(mixdog_rt::spawn("acp.question.close", mixdog_rt::TaskClass::Work, async move {
                    connection.close_gracefully(crate::shared::grace(1)).await;
                }));
            }
        }
    }
}

/// The model a one-off question runs on: a bare model id (no effort) or `(model, effort)` for a route carrying an effort tier.
pub trait AskModel<'a> {
    fn into_model_effort(self) -> (&'a str, Option<&'a str>);
}

impl<'a> AskModel<'a> for &'a str {
    fn into_model_effort(self) -> (&'a str, Option<&'a str>) {
        (self, None)
    }
}

impl<'a> AskModel<'a> for (&'a str, Option<&'a str>) {
    fn into_model_effort(self) -> (&'a str, Option<&'a str>) {
        self
    }
}

/// Asks `preset`'s agent `prompt` under the instructions `system`, in a process and a session of its own that hold
/// no conversation, are handed no tools and end with the answer: what writes a session's summary when the session's
/// own model is the agent. `model` and `effort` are the route's, as a turn's are. Nothing the agent does in it is
/// approved, and a caller that stops waiting ends it. An answer the agent stopped short of (a refusal, a limit it
/// reached) is no answer: the error says why it stopped.
pub async fn ask_once<'a>(
    agents: &Arc<Agents>,
    preset: &AgentPreset,
    model: impl AskModel<'a>,
    system: &str,
    prompt: &str,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
) -> Result<Answered, String> {
    let (model, effort) = model.into_model_effort();
    if !agents.enabled() {
        return Err(Refusal::Off.message(preset));
    }
    if let Some(why) = agents.refuses_model(preset, model) {
        return Err(why);
    }
    let cwd = AbsPath::new(agents.parts.probe_cwd.clone()).ok_or_else(|| "the agents have no folder to start a question's session in".to_owned())?;
    // Held to the answer: the CLI is not replaced under a process no session holds.
    let (program, _starting) = agents.ready_program(preset).await.map_err(|refusal| refusal.message(preset))?;
    // A question has a short-lived process of its own, never the preset's shared server: on such a preset it has a
    // temporary folder of its own as the server has.
    let temp = match preset.scope {
        ProcessScope::PerSession => None,
        ProcessScope::Shared => Some(agents.server_temp().await.map_err(|fault| Refusal::Fault(fault).message(preset))?),
    };
    let open = crate::session::Open {
        preset,
        program: &program,
        cwd,
        definitions: &agents.parts.definitions,
        stored: None,
        rules: Some(system.to_owned()),
        held: None,
        grants: Arc::default(),
        handed: None,
        temp,
    };
    let opened = crate::session::AgentSession::open(agents.parts.processes.clone(), agents.parts.files.clone(), open, Arc::new(|| {}), Box::new(|| {})).await;
    let session = match opened {
        Ok(session) => session,
        Err(fault) => {
            agents.open_failed(preset, &fault).await;
            return Err(Refusal::Fault(fault).message(preset));
        }
    };
    let _ended = Ended(session.clone(), agents.clone());
    let answered = async {
        if model != DEFAULT_MODEL {
            let model = crate::tiers::agent_model(&session.models(), &preset.quirks.effort_tiers, model, effort);
            session.select_model(&model).await.map_err(|fault| Refusal::Fault(fault).message(preset))?;
        }
        let surface = Unshown::default();
        let blocks = session.take_unsent_prompt().into_iter().chain([prompt.to_owned()]).map(|text| json!({ "type": "text", "text": text })).collect();
        let context = TurnContext {
            turn: TurnId::from("question"),
            model: model.to_owned(),
            effort: effort.map(str::to_owned),
            now_ms,
            cancel: CancellationToken::new(),
            progress: None,
            calls: None,
            on_tool_result: None,
            record: None,
            selected_window: None,
            attachments: None,
            pictures: None,
            transcript: None,
            output_produced: None,
            mid_turn_compaction: None,
            cpu: agents.parts.cpu,
        };
        let end = crate::turn::run(&session, Arc::new(surface.clone()), Ask::Prompt(blocks), context).await;
        account_learned(agents, preset, &end).await;
        match end {
            TurnEnd::Completed { text, stop_reason, .. } => {
                if let Some(why) = crate::turn::cut_short(stop_reason.as_deref()) {
                    Err(format!("{} stopped before it answered: {why}.", preset.label))
                } else {
                    let usage = lock(&surface.0).take();
                    Ok(Answered { text, stop_reason, usage })
                }
            }
            TurnEnd::Interrupted | TurnEnd::CompactNeeded { .. } => Err(format!("{} stopped before it answered.", preset.label)),
            TurnEnd::Failed { message, .. } | TurnEnd::Refused { message } => Err(message),
        }
    }
    .await;
    // The question's session is no conversation of the user's: the agent is asked to forget it before its process ends.
    tokio::select! {
        biased;
        () = agents.stop_token.cancelled() => {}
        () = session.close() => {}
    }
    answered
}

fn outcome(provider: &str, end: TurnEnd, transcript: Option<&TurnTranscript>) -> RunOutcome {
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
        TurnEnd::Interrupted | TurnEnd::CompactNeeded { .. } => RunOutcome::Interrupted,
        TurnEnd::Failed { message, code, .. } => {
            RunOutcome::Failed(TurnError { message, data: json!({ "reason": "acpAgent", "code": code }), provider_error: None })
        }
        TurnEnd::Refused { message } => {
            RunOutcome::Failed(mixdog_core_session::session::failure_record::auth_turn_error(message, provider, json!({ "reason": "acpAgentAccount" })))
        }
    }
}

/// A turn of Mixdog's own loop begins on a session whose header is `header`: an agent the session ran on before has no
/// part in it, and that agent's session is not continued after turns it never saw. The change that forgets it, if the
/// header holds one.
pub fn loop_turn(agents: &Agents, thread: &ThreadId, header: &Header) -> Option<HeaderChange> {
    agents.end_process(thread);
    header.contains_key(SESSION_KEY).then(unset_session_change)
}

#[cfg(test)]
mod output_tracking_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn tracked_surface_marks_visible_output_and_ignores_compaction_and_hidden_commits() {
        let produced = Arc::new(AtomicBool::new(false));
        let surface = TrackedSurface { inner: Arc::new(Unshown::default()), output_produced: produced.clone() };

        surface.stage("compacting").await.unwrap();
        surface.compact_event(pass(Due { used: 10_000, trigger: 8_000 }, 12, CompactStatus::Compacted)).await.unwrap();
        surface.notice("info".into(), false).await.unwrap();
        surface.save_header(unset_session_change()).await.unwrap();
        surface
            .commit(mixdog_core_session::session::ItemCommit {
                iid: mixdog_protocol::ItemId::from("hidden-1"),
                role: Some("user".into()),
                model: true,
                visible: false,
                body: json!({ "role": "user", "content": "<skill>hidden</skill>" }),
                prompt: None,
            })
            .await
            .unwrap();
        surface.call_mark(crate::surface::CallMark::ToolPhaseCompleted).await.unwrap();
        assert!(!produced.load(Ordering::SeqCst), "pre-prompt compaction, notices, header saves, and hidden rows must not mark output");

        // Visible commit (such as an image card from `show_picture`) flips output_produced.
        surface
            .commit(mixdog_core_session::session::ItemCommit {
                iid: mixdog_protocol::ItemId::from("card-1"),
                role: Some("assistant".into()),
                model: true,
                visible: true,
                body: json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "name": "media", "arguments": {} }] }),
                prompt: None,
            })
            .await
            .unwrap();
        assert!(produced.load(Ordering::SeqCst), "visible commit must mark output_produced");

        // Text delta, reasoning delta, reasoning completed, and closing visible commit each mark output_produced.
        for kind in ["delta", "reasoning_delta", "reasoning_completed", "closing_commit"] {
            let flag = Arc::new(AtomicBool::new(false));
            let s = TrackedSurface { inner: Arc::new(Unshown::default()), output_produced: flag.clone() };
            match kind {
                "delta" => s.delta(mixdog_protocol::ItemId::from("i1"), "hi".into()).await.unwrap(),
                "reasoning_delta" => s.reasoning_delta(mixdog_protocol::ItemId::from("i1"), "think".into()).await.unwrap(),
                "reasoning_completed" => s.reasoning_completed(mixdog_protocol::ItemId::from("i1"), "done".into()).await.unwrap(),
                "closing_commit" => s
                    .closing()
                    .commit(mixdog_core_session::session::ItemCommit {
                        iid: mixdog_protocol::ItemId::from("i2"),
                        role: Some("tool".into()),
                        model: true,
                        visible: true,
                        body: json!({ "role": "tool", "content": "ok" }),
                        prompt: None,
                    })
                    .await
                    .unwrap(),
                _ => unreachable!(),
            }
            assert!(flag.load(Ordering::SeqCst), "{kind} must mark output_produced");
        }
    }
}
