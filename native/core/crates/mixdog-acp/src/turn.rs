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
use std::time::Duration;

use base64::Engine;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::handed::Handed;
use mixdog_agent::handed::HandedCalls;
use mixdog_agent::handed::Judged;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::UsdTicks;
use mixdog_core_review::turn_review::line_diff::LineDiffer;
use mixdog_core_run::run_host::progress::RunProgress;
use mixdog_core_run::run_host::progress::StreamKind;
use mixdog_core_session::session::ItemCommit;
use mixdog_core_session::session::run::RunError;
use mixdog_core_session::session::run::new_item_id;
use mixdog_core_session::session::transcript_writer::TurnTranscript;
use mixdog_protocol::ApprovalRemember;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ItemId;
use mixdog_protocol::ItemMeta;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_rt::TaskClass;
use mixdog_store::schema::record::HeaderChange;
use mixdog_tools::orch::agent::TaskResult;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::connection::Incoming;
use crate::connection::RpcError;
use crate::mcp::Handover;
use crate::mcp::ToolAsk;
use crate::rows;
use crate::rows::AgentTool;
use crate::rows::Picture;
use crate::runs::ShownImage;
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
    /// The agent's context reached Mixdog's compaction trigger mid-turn at a quiet point; the old prompt was cancelled
    /// and its response observed so the caller can compact Mixdog's transcript and continue on a fresh session.
    CompactNeeded {
        due: crate::runs::Due,
        effective_window: u64,
        tool_calls: u64,
    },
    Interrupted,
    Failed {
        message: String,
        code: Option<i64>,
        /// The agent itself reported the failure for the prompt (its error answer or its notice), as against one of
        /// the turn's own (the process ended, a step before the prompt failed).
        reported: bool,
    },
    /// The agent answered that the signed-in account may not use it; `message` is what it said.
    Refused {
        message: String,
    },
}

/// Callback returning Mixdog's mid-turn automatic compaction trigger (in tokens) for a live effective context window.
pub type MidTurnCompactionTrigger = Arc<dyn Fn(u64) -> Option<u64> + Send + Sync>;

/// Mid-turn automatic compaction configuration for a single ACP turn segment.
#[derive(Clone)]
pub struct MidTurnCompaction {
    pub trigger: MidTurnCompactionTrigger,
    /// Set on fresh sessions opened after a mid-turn rollover: if the session's first live `usage_update` is already
    /// at or over the trigger, mid-turn rollover is disabled for the rest of the turn.
    pub after_rollover: bool,
    /// Set by a turn that sent the rollover's `session/cancel` and then ended without rolling over (the agent failed or
    /// answered otherwise, its process ended, or the user stopped the turn): the agent's session holds answers Mixdog
    /// gave only to move it to a fresh session, and is not to be continued.
    pub left_behind: Arc<std::sync::atomic::AtomicBool>,
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
    /// The window the user selected for the session, below the agent's own: it sets the effective window and the
    /// compaction boundary, and the agent's reports move only the raw window.
    pub selected_window: Option<u64>,
    /// The session's attachments, used to resolve `AttachmentRef` parts in mid-turn steers and tool results.
    pub attachments: Option<Arc<dyn crate::runs::Attachments>>,
    /// Where the pictures the agent shows are kept; `None` for a turn whose pictures are shown nowhere.
    pub pictures: Option<Pictures>,
    /// The session's conversation transcript writer for mid-turn assistant text and human steers.
    pub transcript: Option<TurnTranscript>,
    /// Set once the turn emits any visible output (text, reasoning, tool call, image card, or visible row).
    pub output_produced: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// Live automatic compaction policy for mid-turn `usage_update` readings; `None` when mid-turn compaction is off.
    pub mid_turn_compaction: Option<MidTurnCompaction>,
    /// The lane the images of the turn's tool results are fitted on.
    pub fit: Arc<dyn mixdog_core_api::domain::ext::ToolImageFitter>,
}

/// Where the pictures an agent shows are kept, and what reads a file it names as one.
#[derive(Clone)]
pub struct Pictures {
    pub keep: Arc<dyn crate::runs::Attachments>,
    pub files: Arc<dyn crate::files::TextFiles>,
    /// The folders the agent writes what it makes in: a file it names there, or in the session's folder, is read.
    pub homes: Vec<AbsPath>,
}

/// The largest picture file of the agent's that is kept, matching `MediaStore::MAX_INLINE_BYTES`.
pub const PICTURE_MAX_BYTES: u64 = 48 * 1024 * 1024;

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn local_file_path(raw: &str) -> String {
    let Some(rest) = raw.strip_prefix("file://").or_else(|| raw.strip_prefix("FILE://")) else {
        return raw.to_owned();
    };
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let raw_bytes = rest.as_bytes();
    let mut decoded_bytes = Vec::with_capacity(raw_bytes.len());
    let mut i = 0;
    while i < raw_bytes.len() {
        if raw_bytes[i] == b'%'
            && i + 2 < raw_bytes.len()
            && let (Some(hi), Some(lo)) = (hex_val(raw_bytes[i + 1]), hex_val(raw_bytes[i + 2]))
        {
            decoded_bytes.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        decoded_bytes.push(raw_bytes[i]);
        i += 1;
    }
    let decoded = String::from_utf8_lossy(&decoded_bytes).into_owned();
    let bytes = decoded.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' { decoded[1..].to_owned() } else { decoded }
}

impl Pictures {
    /// The bytes and the type of `picture`: decoded, or read from the file it names where that file is in the session's
    /// folder `cwd` or the agent's homes and is a picture by its name.
    async fn bytes(&self, picture: Picture, cwd: &AbsPath) -> Option<(Vec<u8>, String)> {
        match picture {
            Picture::Inline { data, mime } => {
                let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()?;
                (!bytes.is_empty() && bytes.len() as u64 <= PICTURE_MAX_BYTES).then_some((bytes, mime))
            }
            Picture::File(path) => {
                let path = local_file_path(&path);
                let extension = std::path::Path::new(&path).extension()?.to_str()?.to_ascii_lowercase();
                let mime = match extension.as_str() {
                    "png" => "image/png",
                    "jpg" | "jpeg" => "image/jpeg",
                    "webp" => "image/webp",
                    "gif" => "image/gif",
                    _ => return None,
                };
                let roots: Vec<AbsPath> = std::iter::once(cwd.clone()).chain(self.homes.iter().cloned()).collect();
                let place = crate::files::inside_file(self.files.as_ref(), &roots, &path).await?;
                let bytes = self.files.read_bytes(place, 0, PICTURE_MAX_BYTES + 1).await.ok()?;
                (!bytes.is_empty() && bytes.len() as u64 <= PICTURE_MAX_BYTES).then(|| (bytes, mime.to_owned()))
            }
        }
    }
}

/// Why the agent stopped short of an answer, by the stop reason it closed its prompt with; `None` for a turn it ended
/// itself.
pub fn cut_short(stop_reason: Option<&str>) -> Option<&'static str> {
    match stop_reason? {
        "refusal" => Some("it refused to go on"),
        "max_tokens" => Some("it reached its limit of output tokens"),
        "max_turn_requests" => Some("it reached its limit of model requests for one turn"),
        _ => None,
    }
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

    pub(crate) fn settle_progress(&self, end: &TurnEnd) {
        let stage = if matches!(end, TurnEnd::Failed { .. } | TurnEnd::Refused { .. }) { "error" } else { "done" };
        self.mark(|progress, now| progress.settle(stage, now, false));
    }
}

/// The time the agent's model spent producing output in a turn: the sum of its streaming windows. A window runs from
/// the first output or thought chunk after the turn's start or after a tool result to the last chunk before the next
/// tool call or the turn's end. The prompt's dispatch, the agent's start, the wait for a first chunk, a tool's
/// execution and an approval wait are in no window, so the output over this time is a decode speed. A turn that streamed
/// no chunk has no time.
#[derive(Debug, Default)]
struct ModelTime {
    /// The first and the last chunk of the window that is open.
    window: Option<(i64, i64)>,
    closed_ms: i64,
    /// A chunk has arrived in this turn.
    started: bool,
}

impl ModelTime {
    /// A chunk of the agent's output or thought arrived; whether it is the turn's first.
    fn chunk(&mut self, now: i64) -> bool {
        match &mut self.window {
            Some((_, last)) => *last = now,
            None => self.window = Some((now, now)),
        }
        !std::mem::replace(&mut self.started, true)
    }

    /// The window ends at its last chunk when the agent turns to a call or waits on the user.
    fn mark(&mut self, mark: CallMark) {
        if matches!(mark, CallMark::ToolCall | CallMark::ToolApproval)
            && let Some((first, last)) = self.window.take()
        {
            self.closed_ms += (last - first).max(0);
        }
    }

    fn worked_ms(&self) -> u64 {
        (self.closed_ms + self.window.map_or(0, |(first, last)| (last - first).max(0))) as u64
    }
}

/// `TURN_CHECKPOINT_THROTTLE_MS`: streamed text is recorded at most this often, as the loop's run records its own.
const DRAFT_THROTTLE: std::time::Duration = std::time::Duration::from_millis(150);

/// The turn's progress record as it streams: what no record and no row holds yet, and when the last record was written.
#[derive(Debug, Default)]
struct Draft {
    text: String,
    reasoning: String,
    written_at: Option<tokio::time::Instant>,
}

impl Draft {
    /// When what is held is to be written: at once for the turn's first record, else a throttle after the last one;
    /// `None` while nothing is held.
    fn due(&self) -> Option<tokio::time::Instant> {
        if self.text.is_empty() && self.reasoning.is_empty() {
            return None;
        }
        Some(self.written_at.map_or_else(tokio::time::Instant::now, |at| at + DRAFT_THROTTLE))
    }

    /// The record of what is held, taken.
    fn take(&mut self) -> Option<Value> {
        let mut body = serde_json::Map::new();
        for (key, held) in [("text", &mut self.text), ("reasoning", &mut self.reasoning)] {
            if !held.is_empty() {
                body.insert(key.to_owned(), Value::String(std::mem::take(held)));
            }
        }
        (!body.is_empty()).then(|| {
            self.written_at = Some(tokio::time::Instant::now());
            Value::Object(body)
        })
    }

    /// An assistant row holds what the turn streamed: the record has nothing of it to keep.
    fn message_committed(&mut self) {
        self.text.clear();
        self.reasoning.clear();
    }
}

/// Resolves at `due`, and never without one.
async fn until(due: Option<tokio::time::Instant>) {
    match due {
        Some(at) => mixdog_rt::time::sleep(at.saturating_duration_since(tokio::time::Instant::now())).await,
        None => std::future::pending().await,
    }
}

/// A call of a Mixdog tool the agent made, as far as it got.
type Running = std::pin::Pin<Box<dyn std::future::Future<Output = Handed> + Send>>;

struct LaunchedAnswer {
    ask: ToolAsk,
    answer: Value,
    due: Due,
    handed_off: bool,
    aborted: bool,
}

/// Result of a finished launched call, handed back to the turn loop so its row is committed and (for MCP tool calls)
/// its answer is delivered with mid-turn steers once all concurrent calls finish.
struct LaunchedResult {
    row: ItemCommit,
    /// Loaded `<skill>` bodies returned by `Skill` / `skill_view` calls, committed as sourced `Source::Skill` rows.
    skill_bodies: Vec<String>,
    reply: Option<LaunchedAnswer>,
}

fn is_skill_call(name: &str, arguments: &Value) -> bool {
    matches!(name, "Skill" | "skill_view") || (name == "call_tool" && matches!(arguments.get("name").and_then(Value::as_str), Some("Skill" | "skill_view")))
}

/// A call the agent made of a Mixdog tool, run as a task of its own beside the turn's other work: the agent's other
/// calls, its reports and its questions are taken while it runs.
struct Launch {
    ask: ToolAsk,
    /// The call's id in the rows.
    id: String,
    handover: Handover,
    calls: Arc<HandedCalls>,
    session: Arc<AgentSession>,
    attachments: Option<Arc<dyn crate::runs::Attachments>>,
    cwd: String,
    /// The turn's stop: it ends the call where it is.
    stop: CancellationToken,
    /// The turn ends without the call: it goes on as a background task.
    release: CancellationToken,
    /// Takes the call's finished result back to the turn loop.
    ended: tokio::sync::mpsc::UnboundedSender<LaunchedResult>,
    fit: Arc<dyn mixdog_core_api::domain::ext::ToolImageFitter>,
}

fn image_output_for<'a>(session: &AgentSession, fit: &'a dyn mixdog_core_api::domain::ext::ToolImageFitter) -> crate::mcp::ImageOutput<'a> {
    crate::mcp::ImageOutput {
        supports_images: session.images,
        max_raw_bytes: session.preset.quirks.mcp_max_output_bytes,
        max_inline_text_bytes: session.preset.quirks.max_inline_text_bytes,
        fit,
    }
}

impl Launch {
    /// Runs the call until `due` where there is one, its tool's own hold ending by then, and hands the turn its result
    /// row and answer: its result; for a call not over by then, or one the turn ends without, the answer that it goes
    /// on as a background task, no longer the turn's; for one the session's loss or the turn's stop ended where it was
    /// (an approval it waits on included), that.
    async fn run(self, due: Due) {
        let Self { ask, id, handover, calls, session, attachments, cwd, stop, release, ended, fit } = self;
        let call = ToolCall { id: id.clone(), name: ask.name.clone(), arguments: ask.arguments.clone(), native_type: None };
        let held = calls.clone();
        let mut running: Running = Box::pin(async move { held.call_by(call, due.hold).await });
        let over = tokio::select! {
            biased;
            outcome = &mut running => Ok(outcome),
            () = session.gone().cancelled() => Err(Some("The agent's session ended before this call did.")),
            () = stop.cancelled() => Err(Some("Cancelled")),
            () = until(due.answer) => Err(None),
            () = release.cancelled() => Err(None),
        };
        let image_output = image_output_for(&session, fit.as_ref());
        let artifacts = calls.artifacts();
        let (row, skill_bodies, answer, handed_off, aborted) = match over {
            Ok(outcome) => {
                let skill_bodies = if is_skill_call(&ask.name, &ask.arguments) {
                    outcome.follow_ups.iter().filter(|text| text.trim_start().starts_with("<skill>")).cloned().collect()
                } else {
                    Vec::new()
                };
                let fallback = crate::runs::NoAttachments;
                let attachments: &dyn crate::runs::Attachments = attachments.as_deref().unwrap_or(&fallback);
                let answer = crate::mcp::rendered(&outcome, &ask.name, image_output, attachments, artifacts.as_deref()).await;
                (rows::tool_message(new_item_id(), &outcome.message), skill_bodies, answer, false, false)
            }
            Err(Some(text)) => {
                drop(running);
                (rows::tool_result(new_item_id(), &id, text.to_owned(), true, None), Vec::new(), crate::mcp::result_text(text.to_owned(), true), false, true)
            }
            Err(None) => {
                calls.let_go(&id).await;
                let task = keep(&handover, &cwd, &ask.name, (calls, id.clone()), (image_output, fit.clone()), attachments, artifacts, running);
                session.keep_call(ask.name.clone(), ask.arguments.clone(), task.clone());
                let text = crate::mcp::kept(&ask.name, &task);
                (rows::tool_result(new_item_id(), &id, text.clone(), false, None), Vec::new(), crate::mcp::result_text(text, false), true, false)
            }
        };
        let _ = ended.send(LaunchedResult { row, skill_bodies, reply: Some(LaunchedAnswer { ask, answer, due, handed_off, aborted }) });
    }
}

/// Lets `running`, a call of the Mixdog tool `tool` that the turn's `calls` let go of under its id, go on as a
/// background task of the session on its table of tool calls, which its `task` tool reads: the task ends with the call
/// and keeps its result whole, images included, its end is delivered to the session, and a cancel of the task stops
/// the call. However the call ends, what it still asks the person is closed. The task's id.
#[allow(clippy::too_many_arguments)]
fn keep(
    handed: &Handover,
    cwd: &str,
    tool: &str,
    (calls, id): (Arc<HandedCalls>, String),
    (image_output, fit): (crate::mcp::ImageOutput<'_>, Arc<dyn mixdog_core_api::domain::ext::ToolImageFitter>),
    attachments: Option<Arc<dyn crate::runs::Attachments>>,
    artifacts: Option<Arc<dyn mixdog_agent::offload::ArtifactStore>>,
    running: Running,
) -> String {
    let (supports_images, max_raw_bytes, max_inline_text_bytes) =
        (image_output.supports_images, image_output.max_raw_bytes, image_output.max_inline_text_bytes);
    let call = mixdog_rt::spawn("acp.kept-call", TaskClass::Work, mixdog_rt::carry_task_locals(running));
    let stop = call.abort_handle();
    let render: Arc<dyn Fn(&Value) -> String + Send + Sync> = Arc::new(|result: &Value| result["content"].as_str().unwrap_or_default().to_owned());
    let tool_name = tool.to_owned();
    let job = NewJob {
        operation: tool.to_owned(),
        owner: JobOwner { caller_session_id: Some(handed.thread.as_str().to_owned()), ..JobOwner::default() },
        cancel: Some(Arc::new(move || stop.abort())),
        cwd: Some(cwd.to_owned()),
        render: Some(render),
        ..NewJob::default()
    };
    let started = handed.tools.tasks().start(job, move |_| async move {
        let ended = call.await;
        calls.released(&id).await;
        let image_output = crate::mcp::ImageOutput { supports_images, max_raw_bytes, max_inline_text_bytes, fit: fit.as_ref() };
        let fallback = crate::runs::NoAttachments;
        let attachments: &dyn crate::runs::Attachments = attachments.as_deref().unwrap_or(&fallback);
        match ended {
            Ok(ended) if !ended.failed => {
                let kept = crate::mcp::kept_result(&ended, &tool_name, image_output, attachments, artifacts.as_deref()).await;
                let text_only = kept["images"].as_array().is_none_or(Vec::is_empty);
                Ok(Some(if text_only { TaskResult::Content(kept["content"].as_str().unwrap_or_default().to_owned()) } else { TaskResult::Json(kept) }))
            }
            Ok(ended) => Err(crate::mcp::text_of(&ended, &tool_name, image_output, attachments, artifacts.as_deref()).await),
            Err(_) => Err("The call was stopped before it ended.".to_owned()),
        }
    });
    started.expect("the table gives a task that names no id a new one")
}

/// When a call of a Mixdog tool that reached the session's server at `received` is answered at the latest, for an agent
/// that gives such a call up after `deadline`: a tenth of the deadline before it, for the answer's way back. `None`
/// for an agent that waits until the call ends.
fn answer_due(deadline: Option<Duration>, received: tokio::time::Instant) -> Option<tokio::time::Instant> {
    // The tenth covers the answer's way back: the call's row stored, the MCP reply sent and read by the agent's CLI.
    deadline.map(|deadline| received + deadline - deadline / 10)
}

/// When a tool that holds its answer for work to end (`shell`'s foreground wait, `task` wait) ends its hold, for such a
/// call: a fifth of the deadline before it, so the tool answers as it does at its own limit before [`answer_due`].
fn hold_due(deadline: Option<Duration>, received: tokio::time::Instant) -> Option<std::time::Instant> {
    // The tenth beyond `answer_due`'s covers what follows the hold: the tool's own answer (its output read, a command moved
    // to the background) and the pipeline after it (hooks, the result's offload).
    deadline.map(|deadline| (received + deadline - deadline / 5).into_std())
}

/// When the call is answered at the latest ([`answer_due`]) and when the tool's own hold ends ([`hold_due`]).
#[derive(Clone, Copy, Default)]
struct Due {
    answer: Option<tokio::time::Instant>,
    hold: Option<std::time::Instant>,
}

impl Due {
    fn of(deadline: Option<Duration>, received: tokio::time::Instant) -> Self {
        Self { answer: answer_due(deadline, received), hold: hold_due(deadline, received) }
    }
}

struct Call {
    /// The call's id in the turn's rows.
    id: String,
    tool: AgentTool,
    /// Its tool row is committed.
    closed: bool,
    /// Its assistant card was opened as a `media` tool call.
    opened_as_media: bool,
}

/// State of mid-turn compaction when a live `usage_update` reaches Mixdog's trigger.
#[derive(Clone, Copy, Debug)]
enum MidTurnCompact {
    /// Context crossed the trigger while quiet; wait to see whether the agent finishes (`Incoming::Response`) or starts new work.
    Armed { due: crate::runs::Due, effective_window: u64 },
    /// Work was open when the trigger was crossed, or new work began after arming; roll over at the next provably quiet point.
    Trigger { due: crate::runs::Due, effective_window: u64 },
    /// Quiet point reached: `session/cancel` was sent and the loop is observing updates until the agent answers the prompt.
    Cancelling { due: crate::runs::Due, effective_window: u64 },
}

struct Reply<'a> {
    session: &'a Arc<AgentSession>,
    surface: Arc<dyn TurnSurface>,
    context: &'a TurnContext,
    replying: bool,
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
    model_time: ModelTime,
    plans: u64,
    /// Calls of Mixdog tools the agent made through the session's server.
    handed: u64,
    /// How many of those run now, and their tasks.
    running: usize,
    launches: Vec<tokio::task::JoinHandle<()>>,
    /// Where a call of a Mixdog tool tells the turn it ended, with its result row and answer.
    launched: tokio::sync::mpsc::UnboundedSender<LaunchedResult>,
    /// Ends the calls of Mixdog tools still running where they are: the turn's cancel, or its end on a failure.
    stop: CancellationToken,
    /// Lets the calls of Mixdog tools still running go on as background tasks: the turn ends without them.
    release: CancellationToken,
    /// Pictures the agent's messages showed.
    pictures: u64,
    /// The cards of the pictures the turn showed.
    shown: HashSet<String>,
    /// The agent's ids of its own reports of those calls: Mixdog shows each as its tool's call, once.
    reports: HashSet<String>,
    /// The names of the tools the session's server lists, as last read in this turn.
    listed: Option<Vec<String>>,
    /// The `tools/list` digest observed when `listed` was populated.
    tools_digest: Option<String>,
    /// Everything the agent said in the turn.
    said: String,
    differ: LineDiffer,
    /// The latest unreported context report actually observed and surfaced by this turn, with its report count.
    seen_context: Option<(u64, ContextUse)>,
    /// The window the session was last told the agent holds its context in.
    window: Option<u64>,
    /// The occupancy the session was last told the agent's context holds.
    occupancy: Option<u64>,
    /// Mid-turn compaction state once live context occupancy reaches Mixdog's trigger.
    mid_turn_compact: Option<MidTurnCompact>,
    /// Whether this segment has already observed a live `usage_update` with `used > 0`.
    saw_live_usage: bool,
    /// Set when a fresh post-rollover session's first live `usage_update` is already at or over the trigger.
    mid_turn_disabled: bool,
    /// The cost the agent reported in `usage_update` during this turn.
    cost: Option<UsdTicks>,
    /// The last text chunk, held back while it has the form of the agent's notice of a failure of its own: the prompt's
    /// end tells whether it is one, and anything the agent sends after it shows it as the reply's.
    held: Option<String>,
    draft: Draft,
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
        // A session with nobody to ask refuses, as it refuses Mixdog's own calls.
        ApprovalResolution::Decided { .. } | ApprovalResolution::Unavailable { .. } => rejection(options),
        _ => None,
    }
}

/// The agent's option that refuses a call: for this one call where it offers that, else the only refusal it offers.
fn rejection(options: &[(String, String)]) -> Option<String> {
    let of = |kind: &str| options.iter().find(|(_, k)| k == kind).map(|(id, _)| id.clone());
    of("reject_once").or_else(|| of("reject_always"))
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

/// The cost reported by a `usage_update` when given in USD.
fn cost_of(update: &Value) -> Option<UsdTicks> {
    let cost = update.get("cost")?.as_object()?;
    if let Some(currency) = cost.get("currency").and_then(Value::as_str)
        && !currency.eq_ignore_ascii_case("usd")
    {
        return None;
    }
    UsdTicks::from_usd(cost.get("amount").and_then(Value::as_f64)?)
}

impl Reply<'_> {
    fn agent(&self) -> &str {
        &self.session.preset.id
    }

    /// What the cards of the agent's own tools' calls are named after.
    fn cards(&self) -> &str {
        &self.session.preset.tool_prefix
    }

    fn meta(&self) -> ItemMeta {
        ItemMeta { turn_id: Some(self.context.turn.clone()), ..ItemMeta::default() }
    }

    /// Tells the spinner the step the turn is at, once per change: it reads as a turn of the loop does. A surface that
    /// is gone has no spinner to tell.
    async fn mark(&mut self, mark: CallMark) {
        if self.marked != Some(mark) {
            self.marked = Some(mark);
            self.model_time.mark(mark);
            let _ = self.surface.call_mark(mark).await;
        }
    }

    /// The step after a call ended: another call still runs, or the calls are over and the agent goes on.
    async fn mark_after_call(&mut self) {
        let running = self.running > 0 || self.calls.values().any(|call| !call.closed);
        self.mark(if running { CallMark::ToolCall } else { CallMark::ToolPhaseCompleted }).await;
    }

    /// Calls of Mixdog tools run: the spinner shows them running, or waiting on the user for as long as the session's
    /// `progress` counts an approval wait.
    async fn calls_progress(&mut self, progress: Option<&watch::Receiver<RunProgress>>) {
        let now = (self.context.now_ms)();
        let waiting = progress.is_some_and(|progress| progress.borrow().snapshot(now).is_some_and(|snapshot| snapshot.awaiting_user));
        self.mark(if waiting { CallMark::ToolApproval } else { CallMark::ToolCall }).await;
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

    /// The agent reported its context or cost: the window it names is the session's, and any reported cost is kept.
    async fn context_reported(&mut self, update: &Value, is_live: bool) -> Result<(), RunError> {
        let cost_changed = match cost_of(update) {
            Some(cost) => {
                let changed = self.cost != Some(cost);
                self.cost = Some(cost);
                changed
            }
            None => false,
        };
        let reported =
            if update.is_null() { self.session.unreported_context() } else { ContextUse::of(update).map(|context| (self.session.context_reports(), context)) };
        if let Some((count, mut context)) = reported {
            let active_model = self.session.models().current;
            context.size = self.session.preset.quirks.effective_context_window_for(&self.context.model, active_model.as_deref(), context.size);
            self.seen_context = Some((count, context));
            if self.window != Some(context.size) {
                self.window = Some(context.size);
                self.surface.window(context.size, self.context.selected_window).await?;
            }
            let occupancy_changed = self.occupancy != Some(context.used) && context.used > 0;
            if occupancy_changed || cost_changed {
                if context.used > 0 {
                    self.occupancy = Some(context.used);
                }
                let usage = TurnUsage {
                    context: Some(context),
                    cost: self.cost,
                    model: self.context.model.clone(),
                    started_at_ms: (self.context.now_ms)(),
                    ..TurnUsage::default()
                };
                self.surface.context_update(usage).await?;
            }
            let effective = self.context.selected_window.map_or(context.size, |selected| selected.min(context.size));
            let auto_config = (!self.replying)
                .then(|| self.context.mid_turn_compaction.as_ref().and_then(|cfg| (cfg.trigger)(effective).map(|trigger| (trigger, cfg.after_rollover))))
                .flatten();
            if let Some((trigger, after_rollover)) = auto_config {
                if is_live && context.used > 0 {
                    let first_live = !self.saw_live_usage;
                    self.saw_live_usage = true;
                    if first_live && after_rollover && context.used >= trigger {
                        self.mid_turn_disabled = true;
                        if matches!(self.mid_turn_compact, Some(MidTurnCompact::Armed { .. } | MidTurnCompact::Trigger { .. })) {
                            self.mid_turn_compact = None;
                        }
                    }
                }
                if is_live && !self.mid_turn_disabled && context.used >= trigger {
                    let due = crate::runs::Due { used: context.used, trigger };
                    self.mid_turn_compact = Some(match self.mid_turn_compact {
                        Some(MidTurnCompact::Cancelling { .. }) => MidTurnCompact::Cancelling { due, effective_window: effective },
                        Some(MidTurnCompact::Trigger { .. }) => MidTurnCompact::Trigger { due, effective_window: effective },
                        _ if !self.is_quiet() => MidTurnCompact::Trigger { due, effective_window: effective },
                        _ => MidTurnCompact::Armed { due, effective_window: effective },
                    });
                } else if is_live
                    && context.used > 0
                    && context.used < trigger
                    && matches!(self.mid_turn_compact, Some(MidTurnCompact::Armed { .. } | MidTurnCompact::Trigger { .. }))
                {
                    // The agent compacted its own context before the prompt was cancelled: nothing is left to compact.
                    self.mid_turn_compact = None;
                }
            }
        } else if cost_changed {
            let usage = TurnUsage { cost: self.cost, model: self.context.model.clone(), started_at_ms: (self.context.now_ms)(), ..TurnUsage::default() };
            self.surface.context_update(usage).await?;
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

    fn mark_output(&self) {
        if let Some(flag) = &self.context.output_produced {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// Commits an assistant row of `text` and the `calls` it makes. The row holds what the progress record held of the
    /// reply, and text it holds is the turn's last word so far.
    async fn commit_assistant(&mut self, surface: &dyn TurnSurface, item: ItemId, text: &str, calls: Vec<(String, String, Value)>) -> Result<(), RunError> {
        self.mark_output();
        self.draft.message_committed();
        if !text.trim().is_empty() {
            self.last_text = text.to_owned();
            if !calls.is_empty()
                && let Some(transcript) = &self.context.transcript
            {
                transcript.assistant_text(text);
            }
        }
        surface.commit(rows::assistant(item, text, calls)).await
    }

    /// Commits the text shown so far as an assistant row of its own.
    async fn end_text(&mut self, surface: &dyn TurnSurface) -> Result<(), RunError> {
        self.blank.clear();
        let Some((item, text)) = self.text.take() else { return Ok(()) };
        self.commit_assistant(surface, item, &text, Vec::new()).await
    }

    /// Writes the turn's progress record of what it streamed since the last one, when that is due or `now`.
    async fn write_draft(&mut self, now: bool) -> Result<(), RunError> {
        if !now && self.draft.due().is_none_or(|due| due > tokio::time::Instant::now()) {
            return Ok(());
        }
        match self.draft.take() {
            Some(body) => self.surface.draft(body).await,
            None => Ok(()),
        }
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
        self.said.push_str(chunk);
        if self.text.is_none() && chunk.trim().is_empty() {
            self.blank.push_str(chunk);
            return Ok(());
        }
        self.mark_output();
        self.context.mark(|progress, now| progress.stream_delta(StreamKind::Text, now));
        self.mark(CallMark::Streaming).await;
        self.note_chunk();
        let shown = match &mut self.text {
            Some((_, text)) => {
                text.push_str(chunk);
                chunk.to_owned()
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
        self.draft.text.push_str(&shown);
        let (item, _) = self.text.as_ref().expect("the text item is open");
        self.surface.delta(item.clone(), shown).await?;
        self.write_draft(false).await
    }

    /// A chunk of the agent's output or thought arrived; the turn's first is logged, so the log times the wait for it.
    fn note_chunk(&mut self) {
        if self.model_time.chunk((self.context.now_ms)()) {
            mixdog_rt::turn_trace!("[acp] agent session {} gave the first output of its turn", self.session.session_id);
        }
    }

    async fn thought(&mut self, chunk: &str) -> Result<(), RunError> {
        self.context.mark(|progress, now| progress.stream_delta(StreamKind::Reasoning, now));
        self.mark(CallMark::Streaming).await;
        self.note_chunk();
        let surface = self.surface.clone();
        self.end_text(surface.as_ref()).await?;
        if self.reasoning.is_none() {
            let item = new_item_id();
            self.surface.item_started(ThreadItem::Reasoning { id: item.clone(), summary: Vec::new(), content: Vec::new(), meta: self.meta() }).await?;
            self.reasoning = Some((item, String::new()));
        }
        let (item, text) = self.reasoning.as_mut().expect("the reasoning item was just opened");
        text.push_str(chunk);
        let item = item.clone();
        self.draft.reasoning.push_str(chunk);
        self.surface.reasoning_delta(item, chunk.to_owned()).await?;
        self.write_draft(false).await
    }

    /// The result of a call an earlier turn made, which that turn closed as still running: an item of its own that
    /// names the earlier call, so no call id is in two turns.
    async fn late_result(&mut self, agent_id: &str, mut earlier: Background) -> Result<(), RunError> {
        self.end_reasoning().await?;
        let surface = self.surface.clone();
        self.end_text(surface.as_ref()).await?;
        let id = self.session.call_id(agent_id, self.context.turn.as_str(), self.epoch);
        self.late += 1;
        let (name, arguments) = earlier.tool.late_card(self.cards(), &earlier.id);
        let opened_as_media = name == "media";
        let embed = opened_as_media && earlier.tool.status != "failed";
        let pictures = if embed { earlier.tool.pictures() } else { Vec::new() };
        let prompt_aspect = if embed { earlier.tool.picture_request() } else { (String::new(), None) };
        if embed {
            earlier.tool.drop_pictures();
        }
        self.commit_assistant(surface.as_ref(), new_item_id(), "", vec![(id.clone(), name, arguments)]).await?;
        let mut extra = Vec::new();
        let result_text = if embed && !pictures.is_empty() {
            let (prompt, aspect) = prompt_aspect;
            let mut iter = pictures.into_iter().enumerate();
            let first_kept = match iter.next() {
                Some((n, pic)) => self.keep_picture(pic, &prompt, aspect.as_deref(), &format!("{agent_id}-picture-{}", n + 1)).await,
                None => None,
            };
            extra.extend(iter.map(|(n, pic)| (n, pic, prompt.clone(), aspect.clone())));
            match first_kept {
                Some(kept) => rows::picture_result(&kept, &prompt, (&self.session.preset.provider, &self.context.model)),
                None => earlier.tool.result_text(),
            }
        } else {
            earlier.tool.result_text()
        };
        self.commit_result(rows::tool_result(new_item_id(), &id, result_text, earlier.tool.status == "failed", earlier.tool.diff(&self.differ))).await?;
        for (n, pic, prompt, aspect) in extra {
            let _ = self.show_picture(pic, &prompt, aspect.as_deref(), &format!("{agent_id}-picture-{}", n + 1)).await?;
        }
        if !embed {
            self.show_pictures_of(agent_id, &earlier.tool).await?;
        }
        Ok(())
    }

    /// The item and text of the assistant row a new call is made under: the text shown before it, settled, or a new item.
    async fn text_before_call(&mut self) -> Result<(ItemId, String), RunError> {
        self.end_reasoning().await?;
        self.blank.clear();
        match self.text.take() {
            Some((item, text)) => {
                self.surface.text_settled(item.clone()).await?;
                Ok((item, text))
            }
            None => Ok((new_item_id(), String::new())),
        }
    }

    /// The call's state after `update`; a call first heard of gets its card: the assistant row that makes it,
    /// under the item of the text shown before it. `None` for an update of no call of this turn.
    async fn call(&mut self, update: &Value) -> Result<Option<String>, RunError> {
        let Some(agent_id) = update.get("toolCallId").and_then(Value::as_str).map(str::to_owned) else { return Ok(None) };
        self.context.mark(|progress, now| progress.stream_delta(StreamKind::Tool, now));
        if self.reports.contains(&agent_id) {
            if update.get("sessionUpdate").and_then(Value::as_str) == Some("tool_call") {
                self.arm_mid_turn_trigger();
            }
            return Ok(None);
        }
        if !self.calls.contains_key(&agent_id) && self.is_mixdog_call(update).await {
            self.reports.insert(agent_id);
            self.arm_mid_turn_trigger();
            return Ok(None);
        }
        let was_closed = self.calls.get(&agent_id).is_some_and(|call| call.closed);
        let handled = self.call_card(update).await?;
        if handled.is_some() && !was_closed {
            self.arm_mid_turn_trigger();
        }
        Ok(handled)
    }

    /// [`Self::call`] for a call that is shown as the agent's own, whatever it is a call of.
    async fn call_card(&mut self, update: &Value) -> Result<Option<String>, RunError> {
        let Some(agent_id) = update.get("toolCallId").and_then(Value::as_str).map(str::to_owned) else { return Ok(None) };
        if let Some(call) = self.calls.get_mut(&agent_id) {
            // A call whose result row is stored has a later report that changes its result shown as a result of its own.
            let shown = call.closed.then(|| (call.tool.status.clone(), call.tool.result_text(), call.tool.diff(&self.differ)));
            call.tool.merge(update);
            if let Some(shown) = shown {
                if shown != (call.tool.status.clone(), call.tool.result_text(), call.tool.diff(&self.differ)) {
                    self.result_updated(&agent_id).await?;
                } else {
                    self.show_pictures(&agent_id).await?;
                }
                return Ok(Some(agent_id));
            }
        } else if let Some(ended) = self.session.background_update(&agent_id, update) {
            if ended && let Some(earlier) = self.session.background_shown(&agent_id) {
                self.late_result(&agent_id, earlier).await?;
            }
            return Ok(None);
        } else {
            let mut tool = AgentTool { id: agent_id.clone(), ..AgentTool::default() };
            tool.merge(update);
            let (item, text) = self.text_before_call().await?;
            let id = self.session.call_id(&agent_id, self.context.turn.as_str(), self.epoch);
            let (name, arguments) = tool.card(self.cards());
            let opened_as_media = name == "media";
            self.context.mark(|progress, now| progress.tool_call(Some(&name), now));
            // The call is the turn's once its row is stored, and from then on the turn's end gives it a result: a row
            // the session did not take leaves no call to close, so no result is written for a call that is not there.
            let surface = self.surface.clone();
            self.commit_assistant(surface.as_ref(), item, &text, vec![(id.clone(), name, arguments)]).await?;
            self.mark(CallMark::ToolCall).await;
            self.order.push(agent_id.clone());
            self.calls.insert(agent_id.clone(), Call { id, tool, closed: false, opened_as_media });
        }
        let ended = self.calls.get(&agent_id).is_some_and(|call| !call.closed && call.tool.ended());
        if ended {
            let surface = self.surface.clone();
            self.close_call(surface.as_ref(), &agent_id, None).await?;
            self.show_pictures(&agent_id).await?;
            self.mark_after_call().await;
        }
        Ok(Some(agent_id))
    }

    /// The result of the call `agent_id` changed after its result row was stored: an item of its own that names the call
    /// shows the new result, as a call has one result row.
    async fn result_updated(&mut self, agent_id: &str) -> Result<(), RunError> {
        self.end_reasoning().await?;
        let surface = self.surface.clone();
        self.end_text(surface.as_ref()).await?;
        let cards = self.cards().to_owned();
        let (earlier, tool, name, arguments, embed, pictures, prompt_aspect) = {
            let Some(call) = self.calls.get_mut(agent_id) else { return Ok(()) };
            let (name, arguments) = call.tool.late_card(&cards, &call.id);
            let embed = name == "media" && call.tool.status != "failed";
            let pictures = if embed { call.tool.pictures() } else { Vec::new() };
            let prompt_aspect = if embed { call.tool.picture_request() } else { (String::new(), None) };
            if embed {
                call.tool.drop_pictures();
            }
            (call.id.clone(), call.tool.clone(), name, arguments, embed, pictures, prompt_aspect)
        };
        self.late += 1;
        let id = format!("{earlier}.update-{}", self.late);
        self.commit_assistant(surface.as_ref(), new_item_id(), "", vec![(id.clone(), name, arguments)]).await?;
        let mut extra = Vec::new();
        let result_text = if embed && !pictures.is_empty() {
            let (prompt, aspect) = prompt_aspect;
            let mut iter = pictures.into_iter().enumerate();
            let first_kept = match iter.next() {
                Some((n, pic)) => self.keep_picture(pic, &prompt, aspect.as_deref(), &format!("{agent_id}-picture-{}", n + 1)).await,
                None => None,
            };
            extra.extend(iter.map(|(n, pic)| (n, pic, prompt.clone(), aspect.clone())));
            match first_kept {
                Some(kept) => rows::picture_result(&kept, &prompt, (&self.session.preset.provider, &self.context.model)),
                None => tool.result_text(),
            }
        } else {
            tool.result_text()
        };
        self.commit_result(rows::tool_result(new_item_id(), &id, result_text, tool.status == "failed", tool.diff(&self.differ))).await?;
        for (n, pic, prompt, aspect) in extra {
            let _ = self.show_picture(pic, &prompt, aspect.as_deref(), &format!("{agent_id}-picture-{}", n + 1)).await?;
        }
        self.show_pictures(agent_id).await
    }

    /// Keeps the pictures the result of the call `agent_id` shows, each shown as a picture's card; their bytes leave the
    /// call.
    async fn show_pictures(&mut self, agent_id: &str) -> Result<(), RunError> {
        let Some(call) = self.calls.get_mut(agent_id) else { return Ok(()) };
        let tool = call.tool.clone();
        call.tool.drop_pictures();
        self.show_pictures_of(agent_id, &tool).await
    }

    /// [`Self::show_pictures`] of `tool`, the agent's call `agent_id`: each picture's card is named after the call, so
    /// it is the same card whatever report of the call showed it.
    async fn show_pictures_of(&mut self, agent_id: &str, tool: &AgentTool) -> Result<(), RunError> {
        let (prompt, aspect) = tool.picture_request();
        for (n, picture) in tool.pictures().into_iter().enumerate() {
            let _ = self.show_picture(picture, &prompt, aspect.as_deref(), &format!("{agent_id}-picture-{}", n + 1)).await?;
        }
        Ok(())
    }

    /// Keeps `picture`, made from `prompt` at `aspect` where the agent says, as Mixdog keeps a picture it made. Returns
    /// `None` if storage is unavailable, the picture cannot be read, or `card` was already kept.
    async fn keep_picture(&mut self, picture: Picture, prompt: &str, aspect: Option<&str>, card: &str) -> Option<crate::runs::KeptImage> {
        let pictures = self.context.pictures.clone()?;
        if self.shown.contains(card) {
            return None;
        }
        let (bytes, mime) = pictures.bytes(picture, &self.session.cwd).await?;
        let options = aspect.map_or_else(|| json!({}), |aspect| json!({ "aspect": aspect }));
        let (lane, model) = (self.session.preset.provider.clone(), self.context.model.clone());
        let shown = ShownImage { bytes, mime, prompt: prompt.to_owned(), options, provider: lane, model };
        let kept = pictures.keep.keep_image(shown).await?;
        self.shown.insert(card.to_owned());
        Some(kept)
    }

    /// Keeps `picture`, made from `prompt` at `aspect` where the agent says, as Mixdog keeps a picture it made, and shows it
    /// as the card of the call `card` of Mixdog's `media` tool that made it. Returns whether a card was shown.
    async fn show_picture(&mut self, picture: Picture, prompt: &str, aspect: Option<&str>, card: &str) -> Result<bool, RunError> {
        let Some(kept) = self.keep_picture(picture, prompt, aspect, card).await else { return Ok(false) };
        self.end_reasoning().await?;
        let surface = self.surface.clone();
        self.end_text(surface.as_ref()).await?;
        let id = self.session.call_id(card, self.context.turn.as_str(), self.epoch);
        let (lane, model) = (self.session.preset.provider.clone(), self.context.model.clone());
        let (name, arguments, result) = rows::picture_card(&kept, prompt, aspect, (&lane, &model));
        self.commit_assistant(surface.as_ref(), new_item_id(), "", vec![(id.clone(), name, arguments)]).await?;
        self.commit_result(rows::tool_result(new_item_id(), &id, result, false, None)).await?;
        Ok(true)
    }

    /// `call` (a `tool_call`, a `tool_call_update` or a permission request's `toolCall`) is the agent's call of a tool
    /// of this session's Mixdog server: the session shows that call itself, and its pipeline asks the user what it must.
    /// Told by the agent's structured fields alone, each compared whole: `_meta.mcp.server` with the server's name and
    /// `_meta.mcp.tool` with a tool the server lists, else `rawInput.ServerName` and `rawInput.ToolName` so, else the
    /// call's `name` with the name the agent gives such a tool. What the call's title or any other text says decides
    /// nothing.
    async fn is_mixdog_call(&mut self, call: &Value) -> bool {
        let Some(handed) = self.session.handed.clone() else { return false };
        let server_and_tool = |server: &str, tool: &str| {
            call.pointer(server)
                .and_then(Value::as_str)
                .map(|server| (server == crate::mcp::SERVER_NAME).then(|| call.pointer(tool).and_then(Value::as_str).unwrap_or_default().to_owned()))
        };
        let named = server_and_tool("/_meta/mcp/server", "/_meta/mcp/tool").or_else(|| server_and_tool("/rawInput/ServerName", "/rawInput/ToolName"));
        let name = call.get("name").and_then(Value::as_str);
        let format = self.session.preset.quirks.mcp_tool_name.as_deref();
        let mcp_prefix = format!("mcp_{}_", crate::mcp::SERVER_NAME);
        let is_listed = |listed: &[String]| match &named {
            // The agent names the server: that name alone decides (accepting both bare and `mcp_mixdog_`-prefixed names).
            Some(tool) => tool.as_ref().is_some_and(|tool| {
                let bare = tool.strip_prefix(&mcp_prefix).unwrap_or(tool.as_str());
                listed.iter().any(|entry| entry == tool || entry == bare)
            }),
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
        let current_digest = self.session.served_tools_digest();
        if self.tools_digest != current_digest {
            self.tools_digest = current_digest;
            self.listed = None;
        }
        if self.listed.as_deref().is_some_and(is_listed) {
            return true;
        }
        // The session's surface may have moved since it was last read: a name it does not hold is looked for once more.
        let definitions = tokio::select! {
            biased;
            () = self.context.cancel.cancelled() => return false,
            () = self.session.gone().cancelled() => return false,
            definitions = handed.tools.definitions(&handed.thread) => definitions,
        };
        let Ok(tools) = definitions else { return false };
        let listed: Vec<String> = tools.into_iter().map(|tool| tool.name).collect();
        let found = is_listed(&listed);
        self.listed = Some(listed);
        found
    }

    /// Opens the card of the agent's call of the Mixdog tool `name` with `arguments`: the assistant row that makes it,
    /// under the item of the text shown before it. Returns the call's id in the rows.
    async fn open_handed(&mut self, name: &str, arguments: &Value) -> Result<String, RunError> {
        let (item, text) = self.text_before_call().await?;
        self.handed += 1;
        let id = self.session.call_id(&format!("mixdog-{}", self.handed), self.context.turn.as_str(), self.epoch);
        self.context.mark(|progress, now| progress.tool_call(Some(name), now));
        let surface = self.surface.clone();
        self.commit_assistant(surface.as_ref(), item, &text, vec![(id.clone(), name.to_owned(), arguments.clone())]).await?;
        Ok(id)
    }

    async fn send_answer(
        &self,
        answer_tx: tokio::sync::oneshot::Sender<Value>,
        name: &str,
        mut answer: Value,
        protected_from: usize,
        max_inline_text_bytes: Option<usize>,
        artifacts: Option<&dyn mixdog_agent::offload::ArtifactStore>,
    ) -> bool {
        if let Some(max_bytes) = max_inline_text_bytes.filter(|b| *b > 0) {
            crate::mcp::enforce_answer_text_budget(&mut answer, name, protected_from, max_bytes, artifacts).await;
        }
        let sent = answer_tx.send(answer).is_ok();
        if !sent {
            tracing::warn!("[acp] {} gave up its call of {} before it was answered; the call's row holds its answer", self.agent(), name);
        }
        sent
    }

    /// Delivers `base` to `ask`, attaching any ready mid-turn user messages or task notifications once no sibling
    /// Mixdog tool calls are still in flight (`self.running == 0`). Steers are peeked for attachment resolution, then
    /// atomically claimed and committed BEFORE `ask.answer.send` so a concurrently stopped submission is never
    /// delivered to the agent without being recorded, while a racing Stop or `due` expiration during attachment
    /// resolution leaves queued entries untouched.
    async fn deliver_answer(&mut self, ask: ToolAsk, base: Value, due: Due, handed_off: bool) -> Result<(), RunError> {
        let name = ask.name;
        let base_len = base.get("content").and_then(Value::as_array).map_or(0, Vec::len);
        let max_inline_text_bytes = self.session.preset.quirks.max_inline_text_bytes;
        let artifacts = self.context.calls.as_ref().and_then(|calls| calls.artifacts());
        let expired = || due.answer.is_some_and(|deadline| tokio::time::Instant::now() >= deadline);
        if self.running > 0 || handed_off || expired() || ask.answer.is_closed() || self.context.cancel.is_cancelled() || self.session.gone().is_cancelled() {
            self.send_answer(ask.answer, &name, base, base_len, max_inline_text_bytes, artifacts.as_deref()).await;
            return Ok(());
        }
        let peeked = tokio::select! {
            biased;
            () = self.context.cancel.cancelled() => None,
            () = self.session.gone().cancelled() => None,
            () = until(due.answer) => None,
            steers = self.surface.peek_steers() => Some(steers),
        };
        let steers = match peeked {
            None | Some(Err(RunError::Cancelled)) => {
                self.send_answer(ask.answer, &name, base, base_len, max_inline_text_bytes, artifacts.as_deref()).await;
                return Ok(());
            }
            Some(Ok(steers)) if steers.is_empty() => {
                self.send_answer(ask.answer, &name, base, base_len, max_inline_text_bytes, artifacts.as_deref()).await;
                return Ok(());
            }
            Some(Ok(steers)) => steers,
            Some(Err(error)) => {
                self.send_answer(ask.answer, &name, base, base_len, max_inline_text_bytes, artifacts.as_deref()).await;
                return Err(error);
            }
        };
        let fallback = crate::runs::NoAttachments;
        let attachments: &dyn crate::runs::Attachments = self.context.attachments.as_deref().unwrap_or(&fallback);
        let capabilities = (self.session.images, self.session.embedded);
        let resolved = tokio::select! {
            biased;
            () = self.context.cancel.cancelled() => None,
            () = self.session.gone().cancelled() => None,
            () = until(due.answer) => None,
            resolved = async {
                let mut entries = Vec::with_capacity(steers.len());
                for steer in &steers {
                    let (blocks, left, attached) =
                        crate::mcp::steer_blocks(std::slice::from_ref(steer), capabilities, attachments, max_inline_text_bytes).await;
                    entries.push((steer, blocks, left, attached));
                }
                entries
            } => Some(resolved),
        };
        let Some(mut resolved) = resolved else {
            self.send_answer(ask.answer, &name, base, base_len, max_inline_text_bytes, artifacts.as_deref()).await;
            return Ok(());
        };
        if expired() || ask.answer.is_closed() || self.context.cancel.is_cancelled() || self.session.gone().is_cancelled() {
            self.send_answer(ask.answer, &name, base, base_len, max_inline_text_bytes, artifacts.as_deref()).await;
            return Ok(());
        }
        let queued_ids = steers.iter().flat_map(|steer| steer.queued_ids.iter().cloned()).collect();
        // Bound pre-dequeue waiting by turn stop, session loss, and the MCP call deadline without
        // ever dropping `commit_fut` mid-commit: once the actor dequeues, the committed steers are
        // returned and delivered rather than discarded.
        let commit_cancel = self.context.cancel.child_token();
        let commit_fut = self.surface.commit_steers(queued_ids, (self.context.now_ms)(), commit_cancel.clone());
        tokio::pin!(commit_fut);
        let commit_result = loop {
            tokio::select! {
                biased;
                res = &mut commit_fut => break res,
                () = self.session.gone().cancelled(), if !commit_cancel.is_cancelled() => commit_cancel.cancel(),
                () = until(due.answer), if !commit_cancel.is_cancelled() => commit_cancel.cancel(),
            }
        };
        let claimed = match commit_result {
            Ok(claimed) if claimed.is_empty() => {
                self.send_answer(ask.answer, &name, base, base_len, max_inline_text_bytes, artifacts.as_deref()).await;
                return Ok(());
            }
            Ok(claimed) => claimed,
            Err(RunError::Cancelled) => {
                self.send_answer(ask.answer, &name, base, base_len, max_inline_text_bytes, artifacts.as_deref()).await;
                return Ok(());
            }
            Err(error) => {
                self.send_answer(ask.answer, &name, base, base_len, max_inline_text_bytes, artifacts.as_deref()).await;
                return Err(error);
            }
        };
        let mut steer_blocks = Vec::new();
        let mut left_out = crate::runs::LeftOut::default();
        let mut attached_paths = Vec::new();
        for entry in &claimed {
            if let Some(pos) =
                resolved.iter().position(|(steer, _, _, _)| steer.queued_ids == entry.queued_ids && steer.task_notification == entry.task_notification)
            {
                let (_, mut entry_blocks, entry_left, mut entry_attached) = resolved.remove(pos);
                steer_blocks.append(&mut entry_blocks);
                left_out.images += entry_left.images;
                left_out.files.extend(entry_left.files);
                attached_paths.append(&mut entry_attached);
            }
        }
        for path in attached_paths {
            self.session.allow_attached(&path);
        }
        if let Some(transcript) = &self.context.transcript {
            for entry in &claimed {
                if !entry.task_notification {
                    let content = match &entry.content {
                        mixdog_core_api::domain::provider::Content::Text(text) => Value::String(text.to_string()),
                        mixdog_core_api::domain::provider::Content::Parts(parts) => {
                            Value::Array(parts.iter().map(mixdog_agent::message_row::part_row).collect())
                        }
                    };
                    transcript.user(&content);
                }
            }
        }
        let mut answer = base;
        if let Some(blocks) = answer.get_mut("content").and_then(Value::as_array_mut) {
            blocks.append(&mut steer_blocks);
        } else {
            answer["content"] = Value::Array(steer_blocks);
        }
        if !self.send_answer(ask.answer, &name, answer, base_len, max_inline_text_bytes, artifacts.as_deref()).await {
            return Ok(());
        }
        left_out.notify(self.surface.closing().as_ref(), &self.session.preset.label, self.session.images).await;
        Ok(())
    }

    /// A call the agent made of a Mixdog tool through the session's server: shown as that tool's call and run through
    /// Mixdog's pipeline as a task beside the turn's other work ([`Launch`]), so the agent's other calls run beside it
    /// and its reports and questions are taken meanwhile. A call of a tool the session's surface does not hold is
    /// refused, and the same call made again while it goes on is answered with its task: neither has a card, and
    /// neither runs.
    async fn handed(&mut self, ask: ToolAsk) -> Result<(), RunError> {
        let Some(handed) = self.session.handed.clone() else {
            ask.refuse("This session hands out no tools.");
            return Ok(());
        };
        if let Some(ex) = self.session.excluded_tools().into_iter().find(|ex| ex.name == ask.name) {
            let why = format!("{} is excluded from this session because its schema is incompatible ({}).", ask.name, ex.reason);
            ask.refuse(&why);
            return Ok(());
        }
        // The agent is handed the session's surface as it is now, and nothing beyond it.
        let definitions = tokio::select! {
            biased;
            () = self.context.cancel.cancelled() => {
                ask.refuse("Cancelled");
                return Ok(());
            }
            () = self.session.gone().cancelled() => {
                ask.refuse("The agent's session ended before this call did.");
                return Ok(());
            }
            definitions = handed.tools.definitions(&handed.thread) => definitions,
        };
        match definitions {
            Ok(tools) => {
                let Some(tool) = tools.iter().find(|tool| tool.name == ask.name) else {
                    let why = format!("{} is not a tool of this session.", ask.name);
                    ask.refuse(&why);
                    return Ok(());
                };
                if let Err(reason) = crate::mcp::check_tool_schema_for_gemini(tool) {
                    let why = format!("{} is excluded from this session because its schema is incompatible ({reason}).", ask.name);
                    ask.refuse(&why);
                    return Ok(());
                }
            }
            Err(message) => {
                ask.refuse(&message);
                return Ok(());
            }
        }
        let due = Due::of(self.session.preset.quirks.mcp_call_deadline, ask.received);
        let running = |task: &str| handed.tools.tasks().get(task, &Scope::default()).is_some_and(|row| !row.is_terminal());
        if let Some(task) = self.session.kept_call(&ask.name, &ask.arguments, running) {
            let base = crate::mcp::result_text(crate::mcp::kept_again(&ask.name, &task), false);
            return self.deliver_answer(ask, base, due, false).await;
        }
        let id = match self.open_handed(&ask.name, &ask.arguments).await {
            Ok(id) => id,
            Err(error) => {
                ask.refuse("The session stopped taking this turn's work; the call was not run.");
                return Err(error);
            }
        };
        let Some(calls) = self.context.calls.clone() else {
            let outcome = crate::mcp::unrun(&id, "This turn runs no Mixdog tools.");
            let stored = self.commit_result(rows::tool_message(new_item_id(), &outcome.message)).await;
            let answer =
                crate::mcp::rendered(&outcome, &ask.name, image_output_for(self.session, self.context.fit.as_ref()), &crate::runs::NoAttachments, None).await;
            if stored.is_err() {
                let _ = ask.answer.send(answer);
                return stored;
            }
            return self.deliver_answer(ask, answer, due, false).await;
        };
        let launch = Launch {
            ask,
            id,
            handover: handed,
            calls,
            session: self.session.clone(),
            attachments: self.context.attachments.clone(),
            cwd: self.cwd.clone(),
            stop: self.stop.clone(),
            release: self.release.clone(),
            ended: self.launched.clone(),
            fit: self.context.fit.clone(),
        };
        self.running += 1;
        self.mark(CallMark::ToolCall).await;
        self.launches.push(mixdog_rt::spawn("acp.handed-call", TaskClass::Work, mixdog_rt::carry_task_locals(launch.run(due))));
        Ok(())
    }

    /// A call of a Mixdog tool ended: store its result row and deliver its answer (with ready steers once no sibling
    /// calls remain in flight), or return the ask when this completion reaches a quiet mid-turn compaction point so
    /// the caller can send `session/cancel` before refusing the MCP answer.
    async fn launch_ended(&mut self, finished: LaunchedResult) -> Result<Option<ToolAsk>, RunError> {
        self.running -= 1;
        self.context.mark(|progress, now| progress.tool_call(None, now));
        let mut stored = self.commit_result(finished.row).await;
        if stored.is_ok() {
            for body in finished.skill_bodies {
                if let Err(err) = self.commit_result(rows::skill_body(new_item_id(), body)).await {
                    stored = Err(err);
                    break;
                }
            }
        }
        self.mark_after_call().await;
        let Some(reply) = finished.reply else {
            return stored.map(|()| None);
        };
        if stored.is_err() || reply.aborted {
            if reply.ask.answer.send(reply.answer).is_err() {
                tracing::warn!("[acp] {} gave up its call of {} before it was answered; the call's row holds its answer", self.agent(), reply.ask.name);
            }
            return stored.map(|()| None);
        }
        if self.is_quiet() && matches!(self.mid_turn_compact, Some(MidTurnCompact::Trigger { .. })) {
            return Ok(Some(reply.ask));
        }
        self.deliver_answer(reply.ask, reply.answer, reply.due, reply.handed_off).await.map(|()| None)
    }

    fn arm_mid_turn_trigger(&mut self) {
        if let Some(MidTurnCompact::Armed { due, effective_window }) = self.mid_turn_compact {
            self.mid_turn_compact = Some(MidTurnCompact::Trigger { due, effective_window });
        }
    }

    fn has_open_agent_calls(&self) -> bool {
        self.calls.values().any(|call| !call.closed) || self.session.has_open_background_calls()
    }

    fn is_quiet(&self) -> bool {
        self.running == 0 && !self.has_open_agent_calls()
    }

    /// Ends the calls of Mixdog tools still running as `end` tells them to (the turn's stop, or its release of them),
    /// stores their result rows on `surface`, and sends their answers.
    async fn launches_ended(&mut self, surface: &dyn TurnSurface, end: &CancellationToken, rows: &mut tokio::sync::mpsc::UnboundedReceiver<LaunchedResult>) {
        end.cancel();
        for launch in std::mem::take(&mut self.launches) {
            let _ = launch.await;
        }
        while let Ok(finished) = rows.try_recv() {
            self.running = self.running.saturating_sub(1);
            self.result_told(finished.row.body.get("uiDiff").and_then(Value::as_str).map(str::to_owned));
            let _ = surface.commit(finished.row).await;
            for body in finished.skill_bodies {
                let _ = surface.commit(rows::skill_body(new_item_id(), body)).await;
            }
            if let Some(reply) = finished.reply {
                let _ = reply.ask.answer.send(reply.answer);
            }
        }
    }

    /// Stores the result row of a call whose assistant row is stored. A stop of the turn that lands while the row is on
    /// its way refuses it on the turn's own surface; the surface that outlives the turn's token takes it then, so a
    /// stored call is never left without its result.
    async fn commit_result(&self, row: ItemCommit) -> Result<(), RunError> {
        if row.visible {
            self.mark_output();
        }
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
        let (call_id, embed_media, failed, pictures, prompt_aspect, fallback_text, diff) = {
            let Some(call) = self.calls.get_mut(agent_id) else { return Ok(()) };
            call.closed = true;
            // Embed `picture_result` directly on this call only when its assistant card was opened as `media`;
            // otherwise let `show_pictures` emit a standalone `media` artifact card once.
            let embed_media = instead.is_none() && call.opened_as_media && call.tool.status != "failed";
            let pictures = if embed_media { call.tool.pictures() } else { Vec::new() };
            let prompt_aspect = if embed_media { call.tool.picture_request() } else { (String::new(), None) };
            if embed_media {
                call.tool.drop_pictures();
            }
            let (text, failed) = match instead {
                Some((text, failed)) => (text.to_owned(), failed),
                None => (call.tool.result_text(), call.tool.status == "failed"),
            };
            let diff = call.tool.diff(&self.differ);
            (call.id.clone(), embed_media, failed, pictures, prompt_aspect, text, diff)
        };
        if embed_media && !pictures.is_empty() {
            let (prompt, aspect) = prompt_aspect;
            let mut iter = pictures.into_iter().enumerate();
            let first_kept = match iter.next() {
                Some((n, pic)) => self.keep_picture(pic, &prompt, aspect.as_deref(), &format!("{agent_id}-picture-{}", n + 1)).await,
                None => None,
            };
            let result = match first_kept {
                Some(kept) => rows::picture_result(&kept, &prompt, (&self.session.preset.provider, &self.context.model)),
                None => fallback_text,
            };
            let row = rows::tool_result(new_item_id(), &call_id, result, failed, diff.clone());
            self.result_told(diff);
            surface.commit(row).await?;
            for (n, pic) in iter {
                let _ = self.show_picture(pic, &prompt, aspect.as_deref(), &format!("{agent_id}-picture-{}", n + 1)).await?;
            }
            return Ok(());
        }
        let row = rows::tool_result(new_item_id(), &call_id, fallback_text, failed, diff.clone());
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
        self.commit_assistant(surface.as_ref(), new_item_id(), "", vec![(id.clone(), name.to_owned(), arguments.clone())]).await?;
        // The session has one step list, the one its `todo` tool keeps: where the agent is handed that tool, its own
        // plan is written into the same list by the same call, launched beside the turn's other work so it never
        // stalls the turn loop. A session that hands no tools shows the plan as the call's card only.
        match self.context.calls.clone() {
            Some(calls) if !arguments["items"].as_array().is_none_or(Vec::is_empty) => {
                let call = ToolCall { id: id.clone(), name: name.to_owned(), arguments, native_type: None };
                let gone = self.session.gone().clone();
                let stop = self.stop.clone();
                let ended = self.launched.clone();
                self.running += 1;
                self.mark(CallMark::ToolCall).await;
                self.launches.push(mixdog_rt::spawn(
                    "acp.handed-plan",
                    TaskClass::Work,
                    mixdog_rt::carry_task_locals(async move {
                        let outcome = tokio::select! {
                            biased;
                            outcome = calls.call_by(call, None) => Some(outcome),
                            () = gone.cancelled() => None,
                            () = stop.cancelled() => None,
                        };
                        let row = match outcome {
                            Some(written) => rows::tool_message(new_item_id(), &written.message),
                            None => rows::tool_result(new_item_id(), &id, text, false, None),
                        };
                        let _ = ended.send(LaunchedResult { row, skill_bodies: Vec::new(), reply: None });
                    }),
                ));
                Ok(())
            }
            _ => self.commit_result(rows::tool_result(new_item_id(), &id, text, false, None)).await,
        }
    }

    /// A chunk of the agent's message whose `content` is no text: a picture is kept and shown as a picture's card (or a
    /// textual placeholder when storage is unavailable, never raw base64), and other content shows as the text it reads
    /// as ([`rows::block_text`]).
    async fn content_chunk(&mut self, content: Option<&Value>) -> Result<(), RunError> {
        let Some(content) = content.filter(|content| content.get("type").and_then(Value::as_str) != Some("text")) else { return Ok(()) };
        if let Some(picture) = rows::picture(content) {
            self.pictures += 1;
            let card = format!("picture-{}", self.pictures);
            if self.show_picture(picture, "", None, &card).await? {
                return Ok(());
            }
            return match rows::image_fallback_text(content) {
                Some(text) => self.text(&text).await,
                None => Ok(()),
            };
        }
        match rows::block_text(content) {
            Some(text) => self.text(&text).await,
            None => Ok(()),
        }
    }

    async fn update(&mut self, update: &Value, is_live: bool) -> Result<(), RunError> {
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
                None => self.content_chunk(update.get("content")).await,
            },
            "agent_thought_chunk" => {
                match chunk().map(str::to_owned).or_else(|| update.get("content").and_then(|c| rows::block_text(c).or_else(|| rows::image_fallback_text(c)))) {
                    Some(text) => self.thought(&text).await,
                    None => Ok(()),
                }
            }
            "tool_call" | "tool_call_update" => self.call(update).await.map(drop),
            "plan" => self.plan(update).await,
            "usage_update" => self.context_reported(update, is_live).await,
            _ => Ok(()),
        }
    }

    /// `session/request_permission`: the session's permissions' answer as the agent's option, or the user's, asked on
    /// the session's approval card. A tool the user approved for the rest of the session is answered without a card.
    async fn permission(&mut self, params: &Value) -> Result<Value, RunError> {
        let request = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let options = options_of(params);
        let once = options.iter().find(|(_, kind)| kind == "allow_once").map(|(id, _)| id.clone());
        let lasting = options.iter().find(|(_, kind)| kind == "allow_always").map(|(id, _)| id.clone());
        // Every call of a Mixdog tool is asked about by that tool's own pipeline, which asks the user what it must: the
        // agent's question about the tool is answered yes for good, which grants nothing that pipeline does not judge
        // again, and the agent stops asking.
        if (lasting.is_some() || once.is_some()) && self.is_mixdog_call(&request).await {
            if let Some(id) = request.get("toolCallId").and_then(Value::as_str) {
                self.reports.insert(id.to_owned());
            }
            return Ok(outcome(lasting.or(once)));
        }
        if let Some(id) = request.get("toolCallId").and_then(Value::as_str) {
            // The question is the user's to answer: the call gets its card.
            self.reports.remove(id);
        }
        let was_closed = request.get("toolCallId").and_then(Value::as_str).and_then(|id| self.calls.get(id)).is_some_and(|call| call.closed);
        let Some(agent_id) = self.call_card(&request).await? else { return Ok(outcome(None)) };
        if !was_closed {
            self.arm_mid_turn_trigger();
        }
        let call = &self.calls[&agent_id];
        let name = call.tool.name(self.cards());
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
                    return Ok(outcome(rejection(&options)));
                }
                Judged::Cancelled => return Ok(outcome(None)),
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
        let always = lasting.is_some();
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

    /// Surfaces a one-time notice per session for any tools excluded by `Rule::Gemini` schema repair on this session's MCP server.
    async fn report_tool_exclusions(&mut self) {
        let fresh = self.session.take_unwarned_exclusions();
        if fresh.is_empty() {
            return;
        }
        let summary = fresh.iter().map(|(name, reason)| format!("{name} ({reason})")).collect::<Vec<_>>().join(", ");
        let _ = self.surface.notice(format!("Excluded incompatible tool(s) from {}: {summary}.", self.session.preset.label), true).await;
    }

    /// Closes what the reply left open on `surface`; `open_calls` is the result a call still running gets. The
    /// calls it closed that way are returned by the agent's id of each. Every close step is attempted even after an
    /// earlier write failure, and the first error (if any) is returned so normal completion can fail honestly instead
    /// of silently dropping the terminal reply.
    async fn close(&mut self, surface: &dyn TurnSurface, open_calls: (&str, bool)) -> Result<Vec<(String, Background)>, RunError> {
        let mut first_err: Option<RunError> = None;
        if let Some((item, text)) = self.reasoning.take()
            && let Err(err) = surface.reasoning_completed(item, text).await
            && first_err.is_none()
        {
            first_err = Some(err);
        }
        let open: Vec<String> = self.order.iter().filter(|id| self.calls.get(*id).is_some_and(|call| !call.closed)).cloned().collect();
        for id in &open {
            if let Err(err) = self.close_call(surface, id, Some(open_calls)).await
                && first_err.is_none()
            {
                first_err = Some(err);
            }
        }
        if let Err(err) = self.end_text(surface).await
            && first_err.is_none()
        {
            first_err = Some(err);
        }
        let background =
            open.into_iter().filter_map(|agent_id| self.calls.remove(&agent_id).map(|call| (agent_id, Background { id: call.id, tool: call.tool }))).collect();
        match first_err {
            Some(err) => Err(err),
            None => Ok(background),
        }
    }
}

enum Ended {
    /// The agent closed the prompt, or what had arrived of a reply it began on its own is shown (`None`).
    Agent(Option<Result<Value, RpcError>>),
    /// Mid-turn compaction triggered before the agent could start another round; the agent's answer of the cancel.
    Compact(crate::runs::Due, u64, Value),
    Stopped,
    /// The agent's process ended.
    Gone,
    /// The session stopped taking the turn's reports: it is closing, or the run was cancelled.
    Surface,
}

/// What the turn reports of its tokens: the prompt answer's usage, and the agent's own report of its context
/// (`reported`). `None` for a turn that has neither. `(started_at_ms, request_ms, run_ms)`: when the turn started, how
/// long the agent's model streamed in it (what its speed is read over), and how long the whole turn ran (what the ledger
/// records it over).
fn usage_of(
    answer: &Value,
    reported: Option<ContextUse>,
    cost: Option<UsdTicks>,
    context: &TurnContext,
    (started_at_ms, request_ms, run_ms): (i64, u64, u64),
    tool_calls: u64,
) -> Option<TurnUsage> {
    let usage = answer.get("usage").filter(|usage| usage.is_object());
    if usage.is_none() && reported.is_none() && cost.is_none() {
        return None;
    }
    let count = |key: &str| usage.and_then(|usage| usage.get(key)).and_then(Value::as_u64);
    Some(TurnUsage {
        input_tokens: count("inputTokens").unwrap_or(0),
        output_tokens: count("outputTokens").unwrap_or(0),
        cached_read_tokens: count("cachedReadTokens").unwrap_or(0),
        cached_write_tokens: count("cachedWriteTokens").unwrap_or(0),
        thought_tokens: count("thoughtTokens"),
        total_tokens: count("totalTokens"),
        context: reported,
        model: context.model.clone(),
        tool_calls,
        started_at_ms,
        request_ms,
        run_ms,
        cost,
    })
}

/// A turn's timing at its end `now_ms`: `(started_at_ms, request_ms, run_ms)` of [`usage_of`].
fn timing_of(started_at_ms: i64, time: &ModelTime, now_ms: i64) -> (i64, u64, u64) {
    (started_at_ms, time.worked_ms(), (now_ms - started_at_ms).max(0) as u64)
}

/// The protocol's answer to a request about a resource the agent does not hold (`RESOURCE_NOT_FOUND`): the code a
/// turn whose agent lost its session fails with, and the one an agent answers a prompt of a session it lost with.
pub(crate) const SESSION_NOT_FOUND: i64 = -32002;

/// The turn failed with what the agent said, `message`, any structured `data`, and the error code it answered with, if
/// any. A failure that says the sign-in no longer holds is the protocol's `AUTH_REQUIRED`, and one that says the
/// agent's session is gone is [`SESSION_NOT_FOUND`], whatever code the agent gave it.
fn failure(quirks: &crate::preset::Quirks, message: String, data: Option<String>, code: Option<i64>) -> TurnEnd {
    let says = |markers: &[String]| {
        markers.iter().any(|marker| message.contains(marker.as_str()) || data.as_deref().is_some_and(|detail| detail.contains(marker.as_str())))
    };
    let code = if says(&quirks.signed_out_failures) {
        Some(crate::agents::AUTH_REQUIRED)
    } else if says(&quirks.lost_session_failures) {
        Some(SESSION_NOT_FOUND)
    } else {
        code
    };
    let message = match data {
        Some(detail) if !detail.is_empty() && !message.contains(&detail) => format!("{message}: {detail}"),
        _ => message,
    };
    TurnEnd::Failed { message, code, reported: true }
}

async fn abort_grant_write(
    session: &Arc<AgentSession>,
    refuse_budget: &mut crate::session::RefuseBudget,
    write_state: &std::sync::atomic::AtomicU8,
    id: Value,
    why: &str,
) {
    let state = write_state.load(std::sync::atomic::Ordering::SeqCst);
    if state == GRANT_BEFORE_WRITE || state == GRANT_CANCELLED_BEFORE_WRITE {
        refuse_budget.refuse(session, id).await;
    } else {
        session.break_connection(why);
    }
}

async fn handle_permission_request(
    reply: &mut Reply<'_>,
    session: &Arc<AgentSession>,
    context: &TurnContext,
    refuse_budget: &mut crate::session::RefuseBudget,
    id: Value,
    params: Value,
) -> Result<Option<Ended>, RunError> {
    // A session that is gone or a turn that is cancelled while its question is open drops the pending
    // permission future (releasing any held approval request) and answers cancelled.
    let answered = tokio::select! {
        biased;
        () = context.cancel.cancelled() => Err(Ended::Stopped),
        () = session.gone().cancelled() => Err(Ended::Gone),
        answered = reply.permission(&params) => Ok(answered),
    };
    match answered {
        // A shared server goes on with its other sessions: its question is not left without an answer.
        // Bound the write by the turn's shared refusal budget so a stalled pipe never blocks turn exit.
        Err(end) => {
            context.mark(|progress, now| progress.approval_wait(false, now));
            refuse_budget.refuse(session, id).await;
            Ok(Some(end))
        }
        Ok(Ok(answer)) => {
            if context.cancel.is_cancelled() {
                refuse_budget.refuse(session, id).await;
                return Ok(Some(Ended::Stopped));
            }
            // Arm synchronous cancellation hooks before polling `respond`: if Stop or session-loss fires
            // once bytes may already be admitted to stdin (`GRANT_WRITING`), the hook calls
            // `Connection::break_off` synchronously inside `CancellationToken::cancel()` so the process
            // is killed before stdin can drain ahead of this turn task being rescheduled.
            let write_state = Arc::new(std::sync::atomic::AtomicU8::new(GRANT_BEFORE_WRITE));
            let cancel_hook = SyncGrantCancelHook::arm(
                &context.cancel,
                write_state.clone(),
                session.connection.clone(),
                "permission response write stalled past turn stop",
                false,
            );
            let gone_hook = SyncGrantCancelHook::arm(
                session.gone(),
                write_state.clone(),
                session.connection.clone(),
                "permission response write stalled on ended session",
                true,
            );
            let write_id = id.clone();
            let write_state_for_send = write_state.clone();
            let respond = async move {
                if write_state_for_send
                    .compare_exchange(GRANT_BEFORE_WRITE, GRANT_WRITING, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
                    .is_err()
                {
                    return false;
                }
                session.connection.respond(write_id, Ok(answer)).await;
                write_state_for_send.store(GRANT_DONE, std::sync::atomic::Ordering::SeqCst);
                true
            };
            tokio::select! {
                biased;
                () = context.cancel.cancelled() => {
                    cancel_hook.disarm();
                    gone_hook.disarm();
                    abort_grant_write(session, refuse_budget, &write_state, id, "permission response write stalled past turn stop").await;
                    Ok(Some(Ended::Stopped))
                }
                () = session.gone().cancelled() => {
                    cancel_hook.disarm();
                    gone_hook.disarm();
                    if !session.connection.exited().is_cancelled() {
                        abort_grant_write(session, refuse_budget, &write_state, id, "permission response write stalled on ended session").await;
                    }
                    Ok(Some(Ended::Gone))
                }
                wrote = respond => {
                    cancel_hook.disarm();
                    gone_hook.disarm();
                    if wrote {
                        Ok(None)
                    } else if context.cancel.is_cancelled() {
                        refuse_budget.refuse(session, id).await;
                        Ok(Some(Ended::Stopped))
                    } else {
                        if !session.connection.exited().is_cancelled() {
                            refuse_budget.refuse(session, id).await;
                        }
                        Ok(Some(Ended::Gone))
                    }
                }
            }
        }
        Ok(Err(error)) => {
            refuse_budget.refuse(session, id).await;
            Err(error)
        }
    }
}

/// Runs one turn on `session` and reports it to `surface`.
pub async fn run(session: &Arc<AgentSession>, surface: Arc<dyn TurnSurface>, ask: Ask, mut context: TurnContext) -> TurnEnd {
    let record = context.record.take();
    let started_at_ms = (context.now_ms)();
    let (waiting, mut stream) = session.attach(matches!(ask, Ask::Prompt(_)));
    let mut queued: VecDeque<Incoming> = waiting.into();
    let (launched, mut launched_rows) = tokio::sync::mpsc::unbounded_channel();
    let stop = CancellationToken::new();
    let release = CancellationToken::new();
    let mut progress_rx = context.progress.as_ref().map(watch::Sender::subscribe);
    context.mark(|progress, now| progress.ask_start(now));
    let replying = matches!(ask, Ask::Reply);
    let mut reply = Reply {
        session,
        surface: surface.clone(),
        context: &context,
        replying,
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
        model_time: ModelTime::default(),
        plans: 0,
        handed: 0,
        running: 0,
        launches: Vec::new(),
        launched,
        stop: stop.clone(),
        release: release.clone(),
        pictures: 0,
        shown: HashSet::new(),
        reports: HashSet::new(),
        listed: None,
        tools_digest: session.served_tools_digest(),
        said: String::new(),
        differ: LineDiffer::new(),
        seen_context: None,
        window: None,
        occupancy: None,
        mid_turn_compact: None,
        saw_live_usage: false,
        mid_turn_disabled: false,
        cost: None,
        held: None,
        draft: Draft::default(),
    };
    let mut refuse_budget = crate::session::RefuseBudget::new();
    let prompt = match ask {
        Ask::Prompt(blocks) => {
            // The prompt is the turn's request: the watchdog times the agent's first answer from its send, as it times a
            // provider's from the request's start.
            context.mark(|progress, now| progress.stage_change("requesting", now));
            let sent = tokio::select! {
                biased;
                () = context.cancel.cancelled() => None,
                sent = session.prompt(blocks) => Some(sent),
            };
            match sent {
                Some(Ok(id)) => {
                    // Written, the prompt is the agent's: what is left to wait for is its first answer.
                    mixdog_rt::turn_trace!("[acp] agent session {} holds the turn's prompt", session.session_id);
                    session.mark_handoff_sent();
                    context.mark(|progress, now| progress.stream_delta(StreamKind::Transport, now));
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
                // The process ended, or stopped reading, while the prompt was written: it may have read the prompt and
                // written to it before it ended. The session is ended (on a shared server it alone leaves it), and the
                // turn reads what was sent of it up to its end and fails as one whose agent exited.
                Some(Err(_)) => {
                    session.end();
                    None
                }
                // The agent stopped reading while the prompt was written: how much of it it holds is unknown.
                None => {
                    session.end();
                    session.detach_with_budget(stream, Vec::new(), &mut refuse_budget).await;
                    context.mark(|progress, now| progress.settle("done", now, false));
                    return TurnEnd::Interrupted;
                }
            }
        }
        Ask::Reply => None,
    };
    // Deliver any late context report that arrived while the session was detached between turns.
    if !context.cancel.is_cancelled() && reply.context_reported(&Value::Null, false).await.is_err() {
        session.cancel(prompt);
        let closing = surface.closing();
        reply.launches_ended(closing.as_ref(), &stop, &mut launched_rows).await;
        let _ = reply.close(closing.as_ref(), ("Cancelled", true)).await;
        session.detach_with_budget(stream, Vec::new(), &mut refuse_budget).await;
        context.mark(|progress, now| progress.settle("done", now, false));
        return TurnEnd::Interrupted;
    }
    // What the agent sent on its own before a prompt's turn began is shown first, as rows of its own: it is no part of
    // the answer to the prompt.
    let mut backlog = !replying && !queued.is_empty();
    let ended = loop {
        let mut surface_failed = false;
        while let Ok(row) = launched_rows.try_recv() {
            match reply.launch_ended(row).await {
                Ok(Some(ask)) => {
                    if let Some(MidTurnCompact::Trigger { due, effective_window }) = reply.mid_turn_compact {
                        reply.mid_turn_compact = Some(MidTurnCompact::Cancelling { due, effective_window });
                        refuse_budget.notify(session, "session/cancel", json!({ "sessionId": session.session_id })).await;
                    }
                    ask.refuse("Context compacted; continuing in a fresh session.");
                }
                Ok(None) => {}
                Err(_) => {
                    surface_failed = true;
                    break;
                }
            }
        }
        if surface_failed {
            break Ended::Surface;
        }
        if reply.is_quiet()
            && let Some(MidTurnCompact::Trigger { due, effective_window }) = reply.mid_turn_compact
        {
            reply.mid_turn_compact = Some(MidTurnCompact::Cancelling { due, effective_window });
            refuse_budget.notify(session, "session/cancel", json!({ "sessionId": session.session_id })).await;
        }
        if backlog && queued.is_empty() {
            backlog = false;
            if reply.end_reasoning().await.is_err() || reply.end_text(surface.as_ref()).await.is_err() {
                break Ended::Surface;
            }
        }
        let incoming = match queued.pop_front() {
            Some(incoming) => incoming,
            None if context.cancel.is_cancelled() => break Ended::Stopped,
            // A reply the agent began on its own is shown as far as it has arrived, once its launched tools finish.
            None if replying && reply.running == 0 => match stream.try_recv() {
                Ok(incoming) => incoming,
                Err(_) => break Ended::Agent(None),
            },
            // What streamed since the last progress record is written once it is due, whether or not more arrives.
            None => {
                let due = reply.draft.due();
                let running = reply.running > 0;
                let slot = (!running && !replying).then(|| context.calls.as_ref().and_then(|c| c.slot())).flatten();
                if let Some(slot) = slot {
                    enum IdleEvent {
                        Incoming(Incoming),
                        Ended(Ended),
                        WriteDraft,
                    }
                    let mut idle: Option<IdleEvent> = None;
                    let idle_slot = &mut idle;
                    let cancel = &context.cancel;
                    let yielded = slot
                        .run_yielded(
                            Box::pin(async {
                                tokio::select! {
                                    biased;
                                    () = cancel.cancelled() => {
                                        *idle_slot = Some(IdleEvent::Ended(Ended::Stopped));
                                        false
                                    }
                                    next = stream.recv() => match next {
                                        Some(incoming) => {
                                            *idle_slot = Some(IdleEvent::Incoming(incoming));
                                            true
                                        }
                                        None => {
                                            *idle_slot = Some(IdleEvent::Ended(Ended::Gone));
                                            false
                                        }
                                    },
                                    () = until(due) => {
                                        *idle_slot = Some(IdleEvent::WriteDraft);
                                        true
                                    }
                                }
                            }),
                            None,
                        )
                        .await;
                    if yielded.is_err() {
                        break Ended::Stopped;
                    }
                    match idle {
                        Some(IdleEvent::Incoming(incoming)) => incoming,
                        Some(IdleEvent::Ended(ended)) => break ended,
                        Some(IdleEvent::WriteDraft) => {
                            if reply.write_draft(true).await.is_err() {
                                break Ended::Surface;
                            }
                            continue;
                        }
                        None => break Ended::Stopped,
                    }
                } else {
                    tokio::select! {
                        biased;
                        () = context.cancel.cancelled() => break Ended::Stopped,
                        Some(row) = launched_rows.recv() => {
                            match reply.launch_ended(row).await {
                                Ok(Some(ask)) => {
                                    if let Some(MidTurnCompact::Trigger { due, effective_window }) = reply.mid_turn_compact {
                                        reply.mid_turn_compact = Some(MidTurnCompact::Cancelling { due, effective_window });
                                        refuse_budget.notify(session, "session/cancel", json!({ "sessionId": session.session_id })).await;
                                    }
                                    ask.refuse("Context compacted; continuing in a fresh session.");
                                }
                                Ok(None) => {}
                                Err(_) => break Ended::Surface,
                            }
                            continue;
                        }
                        Some(Ok(())) = async {
                            if running {
                                Some(progress_rx.as_mut()?.changed().await)
                            } else {
                                std::future::pending().await
                            }
                        } => {
                            reply.calls_progress(progress_rx.as_ref()).await;
                            continue;
                        }
                        next = stream.recv() => match next {
                            Some(incoming) => incoming,
                            None => break Ended::Gone,
                        },
                        () = until(due) => {
                            if reply.write_draft(true).await.is_err() {
                                break Ended::Surface;
                            }
                            continue;
                        }
                    }
                }
            }
        };
        let step = match incoming {
            Incoming::Notification { method, params } if method == "session/update" => {
                let update = params.get("update").unwrap_or(&Value::Null);
                // What the agent says once its prompt is cancelled for a compaction is its answer to the cancel
                // ("The request was cancelled by the client."), no part of the turn: it is neither shown nor stored,
                // or the summary would read it as the work having been interrupted.
                let acknowledges_cancel = matches!(reply.mid_turn_compact, Some(MidTurnCompact::Cancelling { .. }))
                    && matches!(update.get("sessionUpdate").and_then(Value::as_str), Some("agent_message_chunk" | "agent_thought_chunk"));
                if acknowledges_cancel { Ok(()) } else { reply.update(update, !backlog).await }
            }
            Incoming::Request { id, params, .. } => match reply.mid_turn_compact {
                Some(MidTurnCompact::Cancelling { .. }) => {
                    refuse_budget.refuse(session, id).await;
                    Ok(())
                }
                _ => match handle_permission_request(&mut reply, session, &context, &mut refuse_budget, id, params).await {
                    Ok(Some(ended)) => break ended,
                    Ok(None) => Ok(()),
                    Err(error) => Err(error),
                },
            },
            Incoming::Response { id, result } if Some(id) == prompt => match reply.mid_turn_compact {
                Some(MidTurnCompact::Cancelling { due, effective_window }) if matches!(&result, Ok(answer) if answer.get("stopReason").and_then(Value::as_str) == Some("cancelled")) =>
                {
                    break Ended::Compact(due, effective_window, result.unwrap_or_default());
                }
                _ => break Ended::Agent(Some(result)),
            },
            Incoming::Tool(ask) => {
                if context.cancel.is_cancelled() {
                    ask.refuse("Cancelled");
                    break Ended::Stopped;
                }
                match reply.mid_turn_compact {
                    Some(MidTurnCompact::Cancelling { .. }) => {
                        ask.refuse("Context compacted; continuing in a fresh session.");
                        Ok(())
                    }
                    Some(MidTurnCompact::Armed { due, effective_window } | MidTurnCompact::Trigger { due, effective_window }) if reply.is_quiet() => {
                        reply.mid_turn_compact = Some(MidTurnCompact::Cancelling { due, effective_window });
                        refuse_budget.notify(session, "session/cancel", json!({ "sessionId": session.session_id })).await;
                        ask.refuse("Context compacted; continuing in a fresh session.");
                        Ok(())
                    }
                    _ => {
                        let handed = reply.handed(ask).await;
                        // A call the session's loss ended ends the turn with it.
                        if session.gone().is_cancelled() {
                            break Ended::Gone;
                        }
                        handed
                    }
                }
            }
            _ => Ok(()),
        };
        if step.is_err() {
            break Ended::Surface;
        }
    };
    let refuse_reason = if matches!(ended, Ended::Compact(..)) { "Context compacted; continuing in a fresh session." } else { "Cancelled" };
    let left_behind = matches!(reply.mid_turn_compact, Some(MidTurnCompact::Cancelling { .. })) && !matches!(ended, Ended::Compact(..));
    if left_behind && let Some(compaction) = &context.mid_turn_compaction {
        compaction.left_behind.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    for leftover in queued.drain(..) {
        match leftover {
            Incoming::Request { id, .. } => {
                refuse_budget.refuse(session, id).await;
            }
            Incoming::Tool(ask) => {
                ask.refuse(refuse_reason);
            }
            _ => {}
        }
    }
    let tool_calls = reply.order.len() as u64 + reply.late + reply.handed;
    // Report only context updates actually observed and surfaced by this turn (including late updates from between turns).
    let reported = reply.seen_context.map(|(_, context)| context);
    if let Some((count, _)) = reply.seen_context {
        session.mark_context_reported(count);
    }
    let cancelled_by_agent = matches!(&ended, Ended::Agent(Some(Ok(answer))) if answer.get("stopReason").and_then(Value::as_str) == Some("cancelled"));
    let end = match ended {
        Ended::Agent(Some(Err(error))) => {
            reply.launches_ended(surface.as_ref(), &stop, &mut launched_rows).await;
            reply.report_tool_exclusions().await;
            let _ = reply.show_held().await;
            let _ = reply.close(surface.as_ref(), ("The agent's turn failed before this call ended.", true)).await;
            session.detach_with_budget(stream, Vec::new(), &mut refuse_budget).await;
            let timing = timing_of(started_at_ms, &reply.model_time, (context.now_ms)());
            if let Some(usage) = usage_of(&Value::Null, reported, reply.cost, &context, timing, tool_calls) {
                let _ = surface.usage(usage).await;
            }
            let detail = error.data_text();
            failure(&session.preset.quirks, error.message, detail, Some(error.code))
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
            let stop_reason = answer.as_ref().and_then(|answer| answer.get("stopReason").and_then(Value::as_str)).map(str::to_owned);
            let short = cut_short(stop_reason.as_deref());
            reply.report_tool_exclusions().await;
            // A call still open when the agent closes its turn normally is work it keeps running in its own process;
            // on a refusal, token/request limit, or failure notice, open calls are closed with why it stopped.
            let (background, close_err) = if let Some(why) = short {
                reply.launches_ended(surface.as_ref(), &stop, &mut launched_rows).await;
                let text = format!("{} stopped before this call ended ({why}).", session.preset.label);
                let close_err = reply.close(surface.as_ref(), (&text, true)).await.err();
                (Vec::new(), close_err)
            } else if notice.is_some() {
                reply.launches_ended(surface.as_ref(), &stop, &mut launched_rows).await;
                let _ = reply.close(surface.as_ref(), ("The agent's turn failed before this call ended.", true)).await;
                (Vec::new(), None)
            } else {
                reply.launches_ended(surface.as_ref(), &release, &mut launched_rows).await;
                match reply.close(surface.as_ref(), ("Still running in the agent's background.", false)).await {
                    Ok(background) => (background, None),
                    Err(err) => (Vec::new(), Some(err)),
                }
            };
            session.detach_with_budget(stream, background, &mut refuse_budget).await;
            let answer = answer.unwrap_or(Value::Null);
            let timing = timing_of(started_at_ms, &reply.model_time, (context.now_ms)());
            if let Some(usage) = usage_of(&answer, reported, reply.cost, &context, timing, tool_calls) {
                let _ = surface.usage(usage).await;
            }
            // A reply, or a notice, that is the agent's word that the account may not use it is no answer to the
            // prompt: the turn is refused, in the agent's own words. A notice of another failure fails the turn.
            let refuses = |said: &str| {
                let said = said.to_lowercase();
                quirks.account_refusals.iter().any(|refusal| said.contains(&refusal.to_lowercase()))
            };
            match (notice, close_err) {
                (Some(notice), _) if refuses(&notice) => TurnEnd::Refused { message: notice },
                (Some(notice), _) => failure(quirks, notice, None, None),
                (None, Some(err)) => TurnEnd::Failed { message: format!("The turn's final reply could not be saved: {err:?}"), code: None, reported: false },
                (None, None) if tool_calls == 0 && refuses(&reply.said) => TurnEnd::Refused { message: reply.said.trim().to_owned() },
                (None, None) => {
                    if let Some(why) = short {
                        let _ = surface.notice(format!("{} stopped early: {why}.", session.preset.label), true).await;
                    }
                    TurnEnd::Completed { text: std::mem::take(&mut reply.last_text), stop_reason, tool_calls }
                }
            }
        }
        Ended::Compact(due, effective_window, answer) => {
            reply.launches_ended(surface.as_ref(), &stop, &mut launched_rows).await;
            let _ = reply.show_held().await;
            let _ = reply.close(surface.as_ref(), ("Cancelled", true)).await;
            session.detach_with_budget(stream, Vec::new(), &mut refuse_budget).await;
            let timing = timing_of(started_at_ms, &reply.model_time, (context.now_ms)());
            if let Some(usage) = usage_of(&answer, reported, reply.cost, &context, timing, tool_calls) {
                let _ = surface.usage(usage).await;
            }
            TurnEnd::CompactNeeded { due, effective_window, tool_calls }
        }
        Ended::Gone => {
            reply.launches_ended(surface.as_ref(), &stop, &mut launched_rows).await;
            let _ = reply.show_held().await;
            let _ = reply.close(surface.as_ref(), ("The agent's process ended before this call did.", true)).await;
            session.detach_with_budget(stream, Vec::new(), &mut refuse_budget).await;
            TurnEnd::Failed { message: session.closed().to_string(), code: None, reported: false }
        }
        // The agent cancelled the prompt itself: keep any usage it reported with the cancel answer.
        Ended::Agent(answer) => {
            let answer = answer.and_then(Result::ok).unwrap_or(Value::Null);
            let closing = surface.closing();
            reply.launches_ended(closing.as_ref(), &stop, &mut launched_rows).await;
            let _ = reply.close(closing.as_ref(), ("Cancelled", true)).await;
            session.detach_with_budget(stream, Vec::new(), &mut refuse_budget).await;
            let timing = timing_of(started_at_ms, &reply.model_time, (context.now_ms)());
            if let Some(usage) = usage_of(&answer, reported, reply.cost, &context, timing, tool_calls) {
                let _ = closing.usage(usage).await;
            }
            TurnEnd::Interrupted
        }
        // The user stopped the turn, or the session is gone from under the turn: the agent is told to stop, and what
        // the turn showed is closed on a surface whose waits outlive the turn's token.
        Ended::Stopped | Ended::Surface => {
            session.cancel(prompt);
            let closing = surface.closing();
            reply.launches_ended(closing.as_ref(), &stop, &mut launched_rows).await;
            let _ = reply.close(closing.as_ref(), ("Cancelled", true)).await;
            session.detach_with_budget(stream, Vec::new(), &mut refuse_budget).await;
            let timing = timing_of(started_at_ms, &reply.model_time, (context.now_ms)());
            if let Some(usage) = usage_of(&Value::Null, reported, reply.cost, &context, timing, tool_calls) {
                let _ = closing.usage(usage).await;
            }
            TurnEnd::Interrupted
        }
    };
    if !matches!(end, TurnEnd::CompactNeeded { .. }) {
        context.settle_progress(&end);
    }
    end
}

const GRANT_BEFORE_WRITE: u8 = 0;
const GRANT_WRITING: u8 = 1;
const GRANT_DONE: u8 = 2;
const GRANT_CANCELLED_BEFORE_WRITE: u8 = 3;

struct GrantCancelWaker {
    armed: std::sync::atomic::AtomicBool,
    state: Arc<std::sync::atomic::AtomicU8>,
    connection: Arc<crate::connection::Connection>,
    why: &'static str,
    skip_if_exited: bool,
}

impl std::task::Wake for GrantCancelWaker {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        if !self.armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        if self.skip_if_exited && self.connection.exited().is_cancelled() {
            return;
        }
        if self
            .state
            .compare_exchange(GRANT_BEFORE_WRITE, GRANT_CANCELLED_BEFORE_WRITE, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
            .is_err()
            && self.state.load(std::sync::atomic::Ordering::SeqCst) == GRANT_WRITING
        {
            self.connection.break_off(self.why);
        }
    }
}

struct SyncGrantCancelHook {
    waker_state: Arc<GrantCancelWaker>,
    _waiter: std::pin::Pin<Box<tokio_util::sync::WaitForCancellationFutureOwned>>,
}

impl SyncGrantCancelHook {
    fn arm(
        token: &CancellationToken,
        state: Arc<std::sync::atomic::AtomicU8>,
        connection: Arc<crate::connection::Connection>,
        why: &'static str,
        skip_if_exited: bool,
    ) -> Self {
        let waker_state = Arc::new(GrantCancelWaker { armed: std::sync::atomic::AtomicBool::new(true), state, connection, why, skip_if_exited });
        let mut waiter = Box::pin(token.clone().cancelled_owned());
        let waker = std::task::Waker::from(waker_state.clone());
        let mut cx = std::task::Context::from_waker(&waker);
        if waiter.as_mut().poll(&mut cx).is_ready() {
            std::task::Wake::wake_by_ref(&waker_state);
        }
        Self { waker_state, _waiter: waiter }
    }

    fn disarm(&self) {
        self.waker_state.armed.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Drop for SyncGrantCancelHook {
    fn drop(&mut self) {
        self.disarm();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The turn's output speed as the session's readout shows it: its output tokens over the model time the turn reports,
    /// `None` where the readout folds no speed.
    fn speed(time: &ModelTime, output_tokens: u64) -> Option<f64> {
        let delta = serde_json::json!({ "deltaOutput": output_tokens, "requestMs": time.worked_ms() });
        let readout = mixdog_agent::compact::pressure::fold_usage_readout(None, &delta, delta.get("requestMs"));
        let (tokens, ms) = (readout["requestOutputTokens"].as_f64()?, readout["requestMs"].as_f64()?);
        (ms > 0.0).then(|| tokens / (ms / 1000.0))
    }

    /// Turn 1 of the recorded session: 172 output tokens, a thinking stream of 524 ms that began 5187 ms into a turn of
    /// 5711 ms. The wall time (prompt dispatch, agent start, the wait for the first chunk) is in no window, so the speed
    /// is the decode speed and not the 30 tok/s the wall time gives.
    #[test]
    fn a_turns_model_time_is_its_streaming_window_and_not_its_wall_time() {
        let mut time = ModelTime::default();
        for at in [5_187, 5_300, 5_450, 5_711] {
            time.chunk(at);
        }
        assert_eq!(time.worked_ms(), 524);
        let speed = speed(&time, 172).expect("a speed");
        assert!((speed - 328.2).abs() < 0.1, "{speed}");
        assert!(172.0 / 5.711 < 31.0, "the wall time would have given about 30 tok/s");
    }

    /// Streamed segments with a call between them: the model time is the segments' sum; the call's execution and its
    /// approval wait are outside every window, as is the wait for the first chunk after the call's result.
    #[test]
    fn a_turns_model_time_leaves_out_its_calls_their_approval_waits_and_the_waits_for_a_chunk() {
        let mut time = ModelTime::default();
        time.mark(CallMark::Streaming);
        time.chunk(1_000);
        time.chunk(1_500);
        time.mark(CallMark::ToolCall);
        time.mark(CallMark::ToolApproval);
        time.mark(CallMark::ToolCall);
        time.mark(CallMark::ToolPhaseCompleted);
        time.mark(CallMark::Streaming);
        assert_eq!(time.worked_ms(), 500, "the first segment, closed by the call");
        time.chunk(4_200);
        time.chunk(4_700);
        assert_eq!(time.worked_ms(), 1_000, "the second segment opens at its first chunk, 2.7 s after the call began");
        time.mark(CallMark::ToolCall);
        assert_eq!(time.worked_ms(), 1_000, "a call still running at the end adds nothing");
        assert_eq!(speed(&time, 300), Some(300.0));
    }

    /// A turn with a call between streamed segments reports two spans: the streaming windows' sum, which its speed in the
    /// session's readout is read over, and the whole run, which the ledger records it over so the quota table's spread of
    /// the turn's meter rises covers all of it.
    #[test]
    fn a_turn_with_calls_between_its_segments_reports_its_windows_to_the_readout_and_its_whole_run_to_the_ledger() {
        let mut time = ModelTime::default();
        time.chunk(1_000);
        time.chunk(1_500);
        time.mark(CallMark::ToolCall);
        time.mark(CallMark::ToolPhaseCompleted);
        time.chunk(4_200);
        time.chunk(4_700);
        assert_eq!(timing_of(200, &time, 5_000), (200, 1_000, 4_800));
        assert_eq!(timing_of(200, &ModelTime::default(), 5_000), (200, 0, 4_800), "no chunk: no model time, the same run");
    }

    /// A call of an agent that gives a call up after a deadline is answered a tenth of that deadline before it, and a
    /// tool's own hold of the answer ends a fifth before it, ahead of that; one of an agent that waits until the call ends
    /// is answered when it ends, its tool holding as long as it holds.
    #[test]
    fn a_call_is_answered_a_tenth_of_the_agents_deadline_before_it() {
        let received = tokio::time::Instant::from_std(std::time::Instant::now());
        assert_eq!(answer_due(Some(Duration::from_secs(180)), received), Some(received + Duration::from_secs(162)));
        assert_eq!(hold_due(Some(Duration::from_secs(180)), received), Some((received + Duration::from_secs(144)).into_std()));
        assert_eq!((answer_due(None, received), hold_due(None, received)), (None, None));
    }

    /// A turn that streamed no chunk, or whose chunks all came at once, has no model time, and the readout shows no
    /// speed for it, never one over the wall time.
    #[test]
    fn a_turn_without_a_streaming_window_has_no_speed() {
        let none = ModelTime::default();
        assert_eq!((none.worked_ms(), speed(&none, 172)), (0, None));
        let mut once = ModelTime::default();
        once.chunk(5_000);
        assert_eq!((once.worked_ms(), speed(&once, 172)), (0, None));
    }

    struct OpenEvents(tokio::sync::Notify);

    #[async_trait::async_trait]
    impl mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent> for OpenEvents {
        async fn next(&mut self) -> Option<mixdog_core_api::domain::process::ProcessEvent> {
            self.0.notified().await;
            None
        }
    }

    struct ActiveGuard(Arc<std::sync::atomic::AtomicUsize>);

    impl Drop for ActiveGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    struct GatedStdinProcesses {
        active_writes: Arc<std::sync::atomic::AtomicUsize>,
        total_writes: Arc<std::sync::atomic::AtomicUsize>,
        write_started: Arc<tokio::sync::Notify>,
        drain_gate: Arc<tokio::sync::Notify>,
        delivered: Arc<std::sync::Mutex<Vec<String>>>,
        killed: Arc<std::sync::atomic::AtomicBool>,
        kill_notify: Arc<tokio::sync::Notify>,
        block_all: bool,
        pass_immediately: bool,
    }

    #[async_trait::async_trait]
    impl mixdog_core_api::domain::process::ProcessManager for GatedStdinProcesses {
        async fn spawn(
            &self,
            request: mixdog_core_api::domain::process::SpawnRequest,
        ) -> Result<mixdog_core_api::domain::process::SpawnedProcess, mixdog_core_api::domain::process::ProcessError> {
            Ok(mixdog_core_api::domain::process::SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(
            &self,
            _handle: &mixdog_protocol::ProcessHandle,
            _from_seq: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            Ok(Box::new(OpenEvents(tokio::sync::Notify::new())))
        }

        fn subscribe_holding(
            &self,
            handle: &mixdog_protocol::ProcessHandle,
            from_seq: Option<u64>,
        ) -> Result<
            Box<dyn mixdog_core_api::domain::common::EventSource<mixdog_core_api::domain::process::ProcessEvent>>,
            mixdog_core_api::domain::process::ProcessError,
        > {
            self.subscribe(handle, from_seq)
        }

        async fn write_stdin(&self, _handle: &mixdog_protocol::ProcessHandle, bytes: Vec<u8>) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            if self.killed.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(mixdog_core_api::domain::process::ProcessError::StdinClosed);
            }
            let line = String::from_utf8_lossy(&bytes).into_owned();
            // Ignore session/cancel notifications spawned by session.cancel so assertions track permission writes cleanly.
            if line.contains("\"session/cancel\"") {
                return Ok(());
            }
            self.total_writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.pass_immediately {
                self.delivered.lock().unwrap().push(line);
                self.write_started.notify_waiters();
                return Ok(());
            }
            self.active_writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let guard = ActiveGuard(self.active_writes.clone());
            self.write_started.notify_waiters();
            // Faithfully model LocalProcessManager::queue_input_whole post-admission semantics:
            // once admitted, dropping this future does NOT un-admit the queued bytes — they will still
            // be delivered when `drain_gate` opens UNLESS `kill()` aborts the process and its input queue.
            let delivered = self.delivered.clone();
            let drain_gate = self.drain_gate.clone();
            let killed = self.killed.clone();
            let kill_notify = self.kill_notify.clone();
            let block_all = self.block_all;
            let delivery = tokio::spawn(async move {
                let _guard = guard;
                if killed.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err(mixdog_core_api::domain::process::ProcessError::StdinClosed);
                }
                if block_all {
                    kill_notify.notified().await;
                    return Err(mixdog_core_api::domain::process::ProcessError::StdinClosed);
                }
                tokio::select! {
                    biased;
                    () = kill_notify.notified() => Err(mixdog_core_api::domain::process::ProcessError::StdinClosed),
                    () = drain_gate.notified() => {
                        if killed.load(std::sync::atomic::Ordering::SeqCst) {
                            Err(mixdog_core_api::domain::process::ProcessError::StdinClosed)
                        } else {
                            delivered.lock().unwrap().push(line);
                            Ok(())
                        }
                    }
                }
            });
            delivery.await.unwrap_or(Err(mixdog_core_api::domain::process::ProcessError::StdinClosed))
        }

        fn close_stdin(&self, _handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }

        fn resize_pty(
            &self,
            _handle: &mixdog_protocol::ProcessHandle,
            _size: mixdog_core_api::domain::process::PtySize,
        ) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            Ok(())
        }

        fn kill(&self, _handle: &mixdog_protocol::ProcessHandle) -> Result<(), mixdog_core_api::domain::process::ProcessError> {
            self.killed.store(true, std::sync::atomic::Ordering::SeqCst);
            self.kill_notify.notify_waiters();
            Ok(())
        }

        fn list(&self) -> Vec<mixdog_core_api::domain::process::ProcessInfo> {
            Vec::new()
        }
    }

    #[derive(Clone)]
    struct TestApproveSurface {
        on_approve: Arc<dyn Fn() -> ApprovalResolution + Send + Sync>,
        commit_delay: Duration,
    }

    impl TestApproveSurface {
        fn new(on_approve: impl Fn() -> ApprovalResolution + Send + Sync + 'static) -> Self {
            Self { on_approve: Arc::new(on_approve), commit_delay: Duration::ZERO }
        }
    }

    #[async_trait::async_trait]
    impl TurnSurface for TestApproveSurface {
        async fn item_started(&self, _: ThreadItem) -> Result<(), RunError> {
            Ok(())
        }
        async fn delta(&self, _: ItemId, _: String) -> Result<(), RunError> {
            Ok(())
        }
        async fn text_settled(&self, _: ItemId) -> Result<(), RunError> {
            Ok(())
        }
        async fn reasoning_delta(&self, _: ItemId, _: String) -> Result<(), RunError> {
            Ok(())
        }
        async fn reasoning_completed(&self, _: ItemId, _: String) -> Result<(), RunError> {
            Ok(())
        }
        async fn commit(&self, _: mixdog_core_session::session::ItemCommit) -> Result<(), RunError> {
            if !self.commit_delay.is_zero() {
                mixdog_rt::time::sleep(self.commit_delay).await;
            }
            Ok(())
        }
        async fn notice(&self, _: String, _: bool) -> Result<(), RunError> {
            Ok(())
        }
        async fn usage(&self, _: TurnUsage) -> Result<(), RunError> {
            Ok(())
        }
        async fn draft(&self, _: Value) -> Result<(), RunError> {
            Ok(())
        }
        async fn save_header(&self, _: HeaderChange) -> Result<(), RunError> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalAsk) -> ApprovalResolution {
            (self.on_approve)()
        }
        async fn stage(&self, _: &str) -> Result<(), RunError> {
            Ok(())
        }
        async fn compact_event(&self, _: crate::surface::CompactEvent) -> Result<(), RunError> {
            Ok(())
        }
        async fn call_mark(&self, _: CallMark) -> Result<(), RunError> {
            Ok(())
        }
        fn call_epoch(&self) -> u64 {
            0
        }
        fn closing(&self) -> Arc<dyn TurnSurface> {
            Arc::new(self.clone())
        }
    }

    fn permission_request(id: u64, call_id: &str) -> Incoming {
        Incoming::Request {
            id: json!(id),
            method: "session/request_permission".into(),
            params: json!({
                "toolCall": { "toolCallId": call_id, "title": "Run command", "kind": "execute", "status": "pending" },
                "options": [
                    { "optionId": "once", "name": "Allow", "kind": "allow_once" },
                    { "optionId": "no", "name": "Reject", "kind": "reject_once" }
                ]
            }),
        }
    }

    fn test_context(cancel: CancellationToken) -> TurnContext {
        TurnContext {
            turn: TurnId::from("t-1"),
            model: "default".into(),
            effort: None,
            now_ms: Arc::new(|| 1_000),
            cancel,
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
            fit: crate::mcp::in_process_fit(),
        }
    }

    /// Cancelling a turn while an affirmative permission response is admitted/stalled on stdin
    /// breaks/invalidates the connection rather than returning cleanly on a live connection where the admitted
    /// grant would land ahead of `session/cancel` once stdin drains.
    #[tokio::test]
    async fn stop_during_blocked_affirmative_permission_response_never_sends_grant() {
        let _ = mixdog_rt::testing::tokens();
        let active_writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let total_writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let write_started = Arc::new(tokio::sync::Notify::new());
        let drain_gate = Arc::new(tokio::sync::Notify::new());
        let delivered = Arc::new(std::sync::Mutex::new(Vec::new()));
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let kill_notify = Arc::new(tokio::sync::Notify::new());
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(GatedStdinProcesses {
            active_writes: active_writes.clone(),
            total_writes: total_writes.clone(),
            write_started: write_started.clone(),
            drain_gate: drain_gate.clone(),
            delivered: delivered.clone(),
            killed: killed.clone(),
            kill_notify,
            block_all: false,
            pass_immediately: false,
        });
        let cwd = mixdog_core_api::domain::common::AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, _incoming) = crate::connection::Connection::start(
            processes,
            crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd },
        )
        .await
        .expect("connection");
        let session = AgentSession::test_session_for(connection);
        session.take(permission_request(42, "p-grant"));

        let approve_once: ApprovalResolution =
            serde_json::from_value(json!({ "kind": "decided", "decision": { "approved": true }, "device": "PC", "connectionKind": "desktop", "at": 0 }))
                .expect("approved resolution");
        let surface: Arc<dyn TurnSurface> = Arc::new(TestApproveSurface::new(move || approve_once.clone()));
        let cancel = CancellationToken::new();

        let started_wait = write_started.notified();
        tokio::pin!(started_wait);
        started_wait.as_mut().enable();
        let turn = run(&session, surface, Ask::Reply, test_context(cancel.clone()));
        let stop = async {
            started_wait.await;
            cancel.cancel();
        };
        let (end, ()) = tokio::join!(turn, stop);
        assert_eq!(end, TurnEnd::Interrupted);
        assert!(killed.load(std::sync::atomic::Ordering::SeqCst), "stalled admitted grant past Stop must break/kill the connection");

        // Drain stdin after Stop: because the connection was broken/killed, no affirmative grant is delivered.
        drain_gate.notify_waiters();
        mixdog_rt::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(active_writes.load(std::sync::atomic::Ordering::SeqCst), 0, "no writer task may remain active after Stop");
        let sent = delivered.lock().unwrap().clone();
        assert!(sent.iter().all(|line| !line.contains("\"once\"")), "interrupted turn must never deliver an affirmative grant after Stop: {sent:?}");
    }

    /// Stop with one active permission request and additional buffered permission requests on stalled stdin
    /// shares a single 200 ms per-turn refusal budget and breaks/kills the wedged connection when the budget expires
    /// instead of leaving orphaned unanswered RPC requests on a live shared connection.
    #[tokio::test]
    async fn active_and_buffered_permission_refusals_share_single_turn_budget_without_lingering_tasks() {
        let _ = mixdog_rt::testing::tokens();
        let active_writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let total_writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let write_started = Arc::new(tokio::sync::Notify::new());
        let drain_gate = Arc::new(tokio::sync::Notify::new());
        let delivered = Arc::new(std::sync::Mutex::new(Vec::new()));
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let kill_notify = Arc::new(tokio::sync::Notify::new());
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(GatedStdinProcesses {
            active_writes: active_writes.clone(),
            total_writes: total_writes.clone(),
            write_started,
            drain_gate,
            delivered,
            killed: killed.clone(),
            kill_notify,
            block_all: true,
            pass_immediately: false,
        });
        let cwd = mixdog_core_api::domain::common::AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, _incoming) = crate::connection::Connection::start(
            processes,
            crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd },
        )
        .await
        .expect("connection");
        let session = AgentSession::test_session_for(connection);
        session.take(permission_request(1, "p-active"));

        let cancel = CancellationToken::new();
        let session_for_approve = session.clone();
        let cancel_for_approve = cancel.clone();
        let surface: Arc<dyn TurnSurface> = Arc::new(TestApproveSurface::new(move || {
            // Buffer additional permission requests into the active turn's stream while the first is being decided,
            // then fire Stop so both the active refusal and detach teardown contend on the same stalled stdin.
            session_for_approve.take(permission_request(2, "p-buf-1"));
            session_for_approve.take(permission_request(3, "p-buf-2"));
            cancel_for_approve.cancel();
            ApprovalResolution::Unavailable { at: 0 }
        }));

        let started = tokio::time::Instant::now();
        let end = run(&session, surface, Ask::Reply, test_context(cancel)).await;
        let elapsed = started.elapsed();
        assert_eq!(end, TurnEnd::Interrupted);
        assert!(elapsed < Duration::from_millis(380), "active + buffered refusals must share one 200 ms turn budget, took {elapsed:?}");
        assert_eq!(
            total_writes.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "buffered refusals in detach must short-circuit after the active refusal exhausted the turn budget"
        );
        assert!(killed.load(std::sync::atomic::Ordering::SeqCst), "exhausting refusal budget must break/kill the wedged connection");
        mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(active_writes.load(std::sync::atomic::Ordering::SeqCst), 0, "no lingering refusal writer task may survive turn exit");
    }

    /// When Stop fires while an active permission request is being approved on a healthy stdin pipe,
    /// the active popped request receives a `"cancelled"` refusal and the healthy connection stays alive.
    #[tokio::test]
    async fn stop_before_permission_write_sends_refusal_for_active_request_on_healthy_connection() {
        let _ = mixdog_rt::testing::tokens();
        let delivered = Arc::new(std::sync::Mutex::new(Vec::new()));
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(GatedStdinProcesses {
            active_writes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            total_writes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            write_started: Arc::new(tokio::sync::Notify::new()),
            drain_gate: Arc::new(tokio::sync::Notify::new()),
            delivered: delivered.clone(),
            killed: killed.clone(),
            kill_notify: Arc::new(tokio::sync::Notify::new()),
            block_all: false,
            pass_immediately: true,
        });
        let cwd = mixdog_core_api::domain::common::AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, _incoming) = crate::connection::Connection::start(
            processes,
            crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd },
        )
        .await
        .expect("connection");
        let session = AgentSession::test_session_for(connection);
        session.take(permission_request(77, "p-refuse-active"));

        let cancel = CancellationToken::new();
        let cancel_on_approve = cancel.clone();
        let approve_once: ApprovalResolution =
            serde_json::from_value(json!({ "kind": "decided", "decision": { "approved": true }, "device": "PC", "connectionKind": "desktop", "at": 0 }))
                .expect("approved resolution");
        let surface: Arc<dyn TurnSurface> = Arc::new(TestApproveSurface::new(move || {
            cancel_on_approve.cancel();
            approve_once.clone()
        }));

        let end = run(&session, surface, Ask::Reply, test_context(cancel)).await;
        assert_eq!(end, TurnEnd::Interrupted);
        assert!(!killed.load(std::sync::atomic::Ordering::SeqCst), "healthy connection must stay alive after clean refusal");
        let sent = delivered.lock().unwrap().clone();
        assert!(
            sent.iter().any(|line| line.contains("\"id\":77") && line.contains("\"cancelled\"")),
            "active popped permission request must receive a cancelled refusal, got: {sent:?}"
        );
        assert!(sent.iter().all(|line| !line.contains("\"once\"")), "grant must never be written after Stop: {sent:?}");
    }

    #[derive(Clone)]
    struct SteerCommitTestSurface {
        steers: Arc<std::sync::Mutex<Vec<crate::surface::SteerDelivery>>>,
        on_commit: Arc<
            dyn Fn(CancellationToken) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<crate::surface::SteerDelivery>, RunError>> + Send>>
                + Send
                + Sync,
        >,
    }

    #[async_trait::async_trait]
    impl TurnSurface for SteerCommitTestSurface {
        async fn item_started(&self, _: ThreadItem) -> Result<(), RunError> {
            Ok(())
        }
        async fn delta(&self, _: ItemId, _: String) -> Result<(), RunError> {
            Ok(())
        }
        async fn text_settled(&self, _: ItemId) -> Result<(), RunError> {
            Ok(())
        }
        async fn reasoning_delta(&self, _: ItemId, _: String) -> Result<(), RunError> {
            Ok(())
        }
        async fn reasoning_completed(&self, _: ItemId, _: String) -> Result<(), RunError> {
            Ok(())
        }
        async fn commit(&self, _: mixdog_core_session::session::ItemCommit) -> Result<(), RunError> {
            Ok(())
        }
        async fn notice(&self, _: String, _: bool) -> Result<(), RunError> {
            Ok(())
        }
        async fn usage(&self, _: TurnUsage) -> Result<(), RunError> {
            Ok(())
        }
        async fn draft(&self, _: Value) -> Result<(), RunError> {
            Ok(())
        }
        async fn save_header(&self, _: HeaderChange) -> Result<(), RunError> {
            Ok(())
        }
        async fn approve(&self, _: ApprovalAsk) -> ApprovalResolution {
            ApprovalResolution::Unavailable { at: 0 }
        }
        async fn stage(&self, _: &str) -> Result<(), RunError> {
            Ok(())
        }
        async fn compact_event(&self, _: crate::surface::CompactEvent) -> Result<(), RunError> {
            Ok(())
        }
        async fn call_mark(&self, _: CallMark) -> Result<(), RunError> {
            Ok(())
        }
        fn call_epoch(&self) -> u64 {
            0
        }
        async fn peek_steers(&self) -> Result<Vec<crate::surface::SteerDelivery>, RunError> {
            Ok(self.steers.lock().unwrap().clone())
        }
        async fn commit_steers(
            &self,
            _queued_ids: Vec<mixdog_core_api::ids::QueuedId>,
            _now_ms: i64,
            cancel: CancellationToken,
        ) -> Result<Vec<crate::surface::SteerDelivery>, RunError> {
            (self.on_commit)(cancel).await
        }
        fn closing(&self) -> Arc<dyn TurnSurface> {
            Arc::new(self.clone())
        }
    }

    /// `deliver_answer` never drops already-committed steers when Stop races after `commit_steers`,
    /// and bounds pre-dequeue `commit_steers` waiting by `due.answer`, leaving steers queued.
    #[tokio::test]
    async fn deliver_answer_preserves_committed_steers_on_stop_and_bounds_pre_dequeue_commit_by_deadline() {
        let _ = mixdog_rt::testing::tokens();
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(GatedStdinProcesses {
            active_writes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            total_writes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            write_started: Arc::new(tokio::sync::Notify::new()),
            drain_gate: Arc::new(tokio::sync::Notify::new()),
            delivered: Arc::new(std::sync::Mutex::new(Vec::new())),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            kill_notify: Arc::new(tokio::sync::Notify::new()),
            block_all: false,
            pass_immediately: true,
        });
        let cwd = mixdog_core_api::domain::common::AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, _incoming) = crate::connection::Connection::start(
            processes,
            crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd },
        )
        .await
        .expect("connection");
        let session = AgentSession::test_session_for(connection);

        // Stop fires after `commit_steers` commits the steer -> committed steer must be delivered.
        let cancel = CancellationToken::new();
        let steer = crate::surface::SteerDelivery {
            queued_ids: vec![mixdog_core_api::ids::QueuedId::from("q-post-commit")],
            content: mixdog_core_api::domain::provider::Content::Text("committed steer survives stop".into()),
            task_notification: false,
        };
        let steers = Arc::new(std::sync::Mutex::new(vec![steer.clone()]));
        let cancel_after_commit = cancel.clone();
        let committed_steer = steer.clone();
        let surface: Arc<dyn TurnSurface> = Arc::new(SteerCommitTestSurface {
            steers: steers.clone(),
            on_commit: Arc::new(move |_commit_cancel| {
                let cancel_after_commit = cancel_after_commit.clone();
                let committed_steer = committed_steer.clone();
                Box::pin(async move {
                    cancel_after_commit.cancel();
                    Ok(vec![committed_steer])
                })
            }),
        });
        let context = test_context(cancel);
        let (launched, _launched_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut reply = Reply {
            session: &session,
            surface,
            context: &context,
            replying: false,
            cwd: String::new(),
            epoch: 0,
            text: None,
            blank: String::new(),
            reasoning: None,
            calls: HashMap::new(),
            order: Vec::new(),
            late: 0,
            last_text: String::new(),
            marked: None,
            model_time: ModelTime::default(),
            plans: 0,
            handed: 0,
            running: 0,
            launches: Vec::new(),
            launched,
            stop: CancellationToken::new(),
            release: CancellationToken::new(),
            pictures: 0,
            shown: HashSet::new(),
            reports: HashSet::new(),
            listed: None,
            tools_digest: None,
            said: String::new(),
            differ: LineDiffer::new(),
            seen_context: None,
            window: None,
            occupancy: None,
            mid_turn_compact: None,
            saw_live_usage: false,
            mid_turn_disabled: false,
            cost: None,
            held: None,
            draft: Draft::default(),
        };
        let (answer_tx, answer_rx) = tokio::sync::oneshot::channel();
        let ask = ToolAsk { name: "read".into(), arguments: json!({}), received: tokio::time::Instant::now(), answer: answer_tx };
        reply.deliver_answer(ask, crate::mcp::result_text("base output".into(), false), Due::default(), false).await.expect("deliver");
        let delivered = answer_rx.await.expect("tool answer");
        let rendered = delivered.to_string();
        assert!(rendered.contains("base output"), "base output missing: {rendered}");
        assert!(rendered.contains("committed steer survives stop"), "already-committed steer must not be discarded on Stop: {rendered}");

        // `commit_steers` stalls before dequeue -> cancelled when `due.answer` expires, base sent on time.
        let queued = Arc::new(std::sync::Mutex::new(vec![crate::surface::SteerDelivery {
            queued_ids: vec![mixdog_core_api::ids::QueuedId::from("q-deadline")],
            content: mixdog_core_api::domain::provider::Content::Text("stalled steer stays queued".into()),
            task_notification: false,
        }]));
        let queued_for_commit = queued.clone();
        let surface2: Arc<dyn TurnSurface> = Arc::new(SteerCommitTestSurface {
            steers: queued.clone(),
            on_commit: Arc::new(move |commit_cancel| {
                let queued_for_commit = queued_for_commit.clone();
                Box::pin(async move {
                    commit_cancel.cancelled().await;
                    // Cancelled prior to mutation: leave `queued_for_commit` untouched.
                    assert_eq!(queued_for_commit.lock().unwrap().len(), 1);
                    Err(RunError::Cancelled)
                })
            }),
        });
        let context2 = test_context(CancellationToken::new());
        let mut reply2 = Reply { surface: surface2, context: &context2, ..reply };
        let (answer_tx2, answer_rx2) = tokio::sync::oneshot::channel();
        let ask2 = ToolAsk { name: "read".into(), arguments: json!({}), received: tokio::time::Instant::now(), answer: answer_tx2 };
        let started = tokio::time::Instant::now();
        let due = Due { answer: Some(started + Duration::from_millis(60)), hold: None };
        reply2.deliver_answer(ask2, crate::mcp::result_text("timely base".into(), false), due, false).await.expect("deliver timely");
        assert!(started.elapsed() < Duration::from_millis(300), "commit_steers stall must be bounded by due.answer");
        let delivered2 = answer_rx2.await.expect("timely answer").to_string();
        assert!(delivered2.contains("timely base"), "{delivered2}");
        assert!(!delivered2.contains("stalled steer stays queued"), "{delivered2}");
        assert_eq!(queued.lock().unwrap().len(), 1, "deadline-aborted steer must stay queued");
    }

    /// When Stop fires while an affirmative grant write is already admitted and stalled on stdin,
    /// `CancellationToken::cancel()` synchronously breaks/kills the connection before returning, so even if
    /// stdin drains immediately before the turn task is rescheduled, the grant is never delivered.
    #[tokio::test]
    async fn stop_kills_stalled_grant_synchronously_before_stdin_drains_without_yielding() {
        let _ = mixdog_rt::testing::tokens();
        let active_writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let total_writes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let write_started = Arc::new(tokio::sync::Notify::new());
        let drain_gate = Arc::new(tokio::sync::Notify::new());
        let delivered = Arc::new(std::sync::Mutex::new(Vec::new()));
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let kill_notify = Arc::new(tokio::sync::Notify::new());
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(GatedStdinProcesses {
            active_writes: active_writes.clone(),
            total_writes: total_writes.clone(),
            write_started: write_started.clone(),
            drain_gate: drain_gate.clone(),
            delivered: delivered.clone(),
            killed: killed.clone(),
            kill_notify,
            block_all: false,
            pass_immediately: false,
        });
        let cwd = mixdog_core_api::domain::common::AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, _incoming) = crate::connection::Connection::start(
            processes,
            crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd },
        )
        .await
        .expect("connection");
        let session = AgentSession::test_session_for(connection);
        session.take(permission_request(42, "p-sync-grant"));

        let approve_once: ApprovalResolution =
            serde_json::from_value(json!({ "kind": "decided", "decision": { "approved": true }, "device": "PC", "connectionKind": "desktop", "at": 0 }))
                .expect("approved resolution");
        let surface: Arc<dyn TurnSurface> = Arc::new(TestApproveSurface::new(move || approve_once.clone()));
        let cancel = CancellationToken::new();

        let started_wait = write_started.notified();
        tokio::pin!(started_wait);
        started_wait.as_mut().enable();
        let mut turn_fut = Box::pin(run(&session, surface, Ask::Reply, test_context(cancel.clone())));
        tokio::select! {
            _ = turn_fut.as_mut() => panic!("turn_fut must stall while grant write is gated"),
            () = started_wait => {}
        }

        // Fire Stop and immediately unblock stdin WITHOUT yielding to the turn task first.
        cancel.cancel();
        assert!(killed.load(std::sync::atomic::Ordering::SeqCst), "cancel() must synchronously kill the stalled grant connection before returning");
        drain_gate.notify_waiters();

        let end = turn_fut.await;
        assert_eq!(end, TurnEnd::Interrupted);
        mixdog_rt::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(active_writes.load(std::sync::atomic::Ordering::SeqCst), 0);
        let sent = delivered.lock().unwrap().clone();
        assert!(
            sent.iter().all(|line| !line.contains("\"once\"")),
            "synchronous kill on Stop must prevent grant delivery even if stdin drains immediately: {sent:?}"
        );
    }

    /// Wall time elapsed while closing open tool cards (`reply.close`) between an active permission
    /// refusal and `detach_with_budget` does not consume `RefuseBudget` or kill a healthy connection.
    #[tokio::test]
    async fn slow_tool_card_close_does_not_exhaust_refuse_budget_on_healthy_connection() {
        let _ = mixdog_rt::testing::tokens();
        let delivered = Arc::new(std::sync::Mutex::new(Vec::new()));
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(GatedStdinProcesses {
            active_writes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            total_writes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            write_started: Arc::new(tokio::sync::Notify::new()),
            drain_gate: Arc::new(tokio::sync::Notify::new()),
            delivered: delivered.clone(),
            killed: killed.clone(),
            kill_notify: Arc::new(tokio::sync::Notify::new()),
            block_all: false,
            pass_immediately: true,
        });
        let cwd = mixdog_core_api::domain::common::AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
        let (connection, _incoming) = crate::connection::Connection::start(
            processes,
            crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd },
        )
        .await
        .expect("connection");
        let session = AgentSession::test_session_for(connection);
        // Queue an open tool call so `reply.close` invokes `surface.commit` (which sleeps > RefuseBudget::LIMIT).
        session.take(Incoming::Notification {
            method: "session/update".into(),
            params: json!({
                "update": { "sessionUpdate": "tool_call", "toolCallId": "tc-slow", "title": "Slow close", "kind": "execute", "status": "in_progress" }
            }),
        });
        session.take(permission_request(10, "p-first"));

        let cancel = CancellationToken::new();
        let session_for_approve = session.clone();
        let cancel_for_approve = cancel.clone();
        let approve_once: ApprovalResolution =
            serde_json::from_value(json!({ "kind": "decided", "decision": { "approved": true }, "device": "PC", "connectionKind": "desktop", "at": 0 }))
                .expect("approved resolution");
        let surface: Arc<dyn TurnSurface> = Arc::new(TestApproveSurface {
            on_approve: Arc::new(move || {
                // Buffer a second permission request to be refused in `detach_with_budget` AFTER `reply.close`.
                session_for_approve.take(permission_request(11, "p-second"));
                cancel_for_approve.cancel();
                approve_once.clone()
            }),
            commit_delay: Duration::from_millis(260),
        });

        let end = run(&session, surface, Ask::Reply, test_context(cancel)).await;
        assert_eq!(end, TurnEnd::Interrupted);
        assert!(
            !killed.load(std::sync::atomic::Ordering::SeqCst),
            "unrelated wall time closing tool cards must never exhaust RefuseBudget or kill a healthy connection"
        );
        let sent = delivered.lock().unwrap().clone();
        assert!(sent.iter().any(|line| line.contains("\"id\":10") && line.contains("\"cancelled\"")), "first refusal missing: {sent:?}");
        assert!(
            sent.iter().any(|line| line.contains("\"id\":11") && line.contains("\"cancelled\"")),
            "second refusal after slow tool-card close missing: {sent:?}"
        );
    }

    #[test]
    fn chosen_option_and_rejection_fall_back_to_reject_always() {
        let options = vec![("allow".to_owned(), "allow_once".to_owned()), ("deny_forever".to_owned(), "reject_always".to_owned())];
        assert_eq!(rejection(&options).as_deref(), Some("deny_forever"));
        assert_eq!(chosen_option(&ApprovalResolution::Unavailable { at: 0 }, &options, false).as_deref(), Some("deny_forever"));
        let refused = ApprovalResolution::Decided {
            decision: mixdog_protocol::ToolApprovalDecision {
                approved: false,
                reason: None,
                answers: None,
                reply: None,
                response: None,
                edited_args: None,
                remember: None,
                scope: None,
            },
            device: "desk".into(),
            connection_kind: mixdog_protocol::ConnectionKind::Desktop,
            at: 0,
        };
        assert_eq!(chosen_option(&refused, &options, false).as_deref(), Some("deny_forever"));
    }

    #[tokio::test]
    async fn leading_blank_whitespace_does_not_mark_output_or_stream_delta_until_visible_text() {
        let _ = mixdog_rt::testing::tokens();

        #[derive(Clone)]
        struct RecordingSurface {
            deltas: Arc<std::sync::Mutex<Vec<String>>>,
            marks: Arc<std::sync::Mutex<Vec<CallMark>>>,
            on_context_update: Arc<dyn Fn() + Send + Sync>,
        }

        #[async_trait::async_trait]
        impl TurnSurface for RecordingSurface {
            async fn item_started(&self, _: ThreadItem) -> Result<(), RunError> {
                Ok(())
            }
            async fn delta(&self, _: ItemId, chunk: String) -> Result<(), RunError> {
                self.deltas.lock().unwrap().push(chunk);
                Ok(())
            }
            async fn text_settled(&self, _: ItemId) -> Result<(), RunError> {
                Ok(())
            }
            async fn reasoning_delta(&self, _: ItemId, _: String) -> Result<(), RunError> {
                Ok(())
            }
            async fn reasoning_completed(&self, _: ItemId, _: String) -> Result<(), RunError> {
                Ok(())
            }
            async fn commit(&self, _: mixdog_core_session::session::ItemCommit) -> Result<(), RunError> {
                Ok(())
            }
            async fn notice(&self, _: String, _: bool) -> Result<(), RunError> {
                Ok(())
            }
            async fn usage(&self, _: TurnUsage) -> Result<(), RunError> {
                Ok(())
            }
            async fn context_update(&self, _: TurnUsage) -> Result<(), RunError> {
                (self.on_context_update)();
                Ok(())
            }
            async fn draft(&self, _: Value) -> Result<(), RunError> {
                Ok(())
            }
            async fn save_header(&self, _: HeaderChange) -> Result<(), RunError> {
                Ok(())
            }
            async fn approve(&self, _: ApprovalAsk) -> ApprovalResolution {
                ApprovalResolution::Unavailable { at: 0 }
            }
            async fn stage(&self, _: &str) -> Result<(), RunError> {
                Ok(())
            }
            async fn compact_event(&self, _: crate::surface::CompactEvent) -> Result<(), RunError> {
                Ok(())
            }
            async fn call_mark(&self, mark: CallMark) -> Result<(), RunError> {
                self.marks.lock().unwrap().push(mark);
                Ok(())
            }
            fn call_epoch(&self) -> u64 {
                0
            }
            fn closing(&self) -> Arc<dyn TurnSurface> {
                Arc::new(self.clone())
            }
        }

        let make_session = || async {
            let write_started = Arc::new(tokio::sync::Notify::new());
            let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(GatedStdinProcesses {
                active_writes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                total_writes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                write_started: write_started.clone(),
                drain_gate: Arc::new(tokio::sync::Notify::new()),
                delivered: Arc::new(std::sync::Mutex::new(Vec::new())),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                kill_notify: Arc::new(tokio::sync::Notify::new()),
                block_all: false,
                pass_immediately: true,
            });
            let cwd = mixdog_core_api::domain::common::AbsPath::new(std::env::current_dir().expect("cwd")).expect("abs cwd");
            let (connection, _incoming) = crate::connection::Connection::start(
                processes,
                crate::connection::Launch { program: "fake".into(), args: Vec::new(), env: Vec::new(), env_remove: Vec::new(), cwd },
            )
            .await
            .expect("connection");
            (AgentSession::test_session_for(connection), write_started)
        };

        let blank_chunk = |text: &str| Incoming::Notification {
            method: "session/update".into(),
            params: json!({
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } }
            }),
        };

        // (a) Blank-only chunk followed by an eligible refusal must not mark visible output or text stream delta.
        {
            let (session, write_started) = make_session().await;
            let feed_session = session.clone();
            let feed_wait = write_started.notified_owned();
            let feeder = tokio::spawn(async move {
                feed_wait.await;
                feed_session.take(blank_chunk("  \n\t "));
                feed_session
                    .take(Incoming::Response { id: 1, result: Err(RpcError { code: -32000, message: "usage limit reached".into(), data: Value::Null }) });
            });
            let deltas = Arc::new(std::sync::Mutex::new(Vec::new()));
            let marks = Arc::new(std::sync::Mutex::new(Vec::new()));
            let surface: Arc<dyn TurnSurface> = Arc::new(RecordingSurface { deltas: deltas.clone(), marks: marks.clone(), on_context_update: Arc::new(|| {}) });
            let mut prog = RunProgress::default();
            prog.ask_start(1_000);
            let (progress_tx, progress_rx) = watch::channel(prog);
            let output_produced = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut ctx = test_context(CancellationToken::new());
            ctx.progress = Some(progress_tx);
            ctx.output_produced = Some(output_produced.clone());

            let end = run(&session, surface, Ask::Prompt(vec![json!({ "type": "text", "text": "hi" })]), ctx).await;
            feeder.await.expect("feeder");
            assert!(matches!(end, TurnEnd::Failed { .. } | TurnEnd::Refused { .. }), "expected refusal/failure, got {end:?}");
            assert!(!output_produced.load(std::sync::atomic::Ordering::SeqCst), "blank-only chunk must not mark output_produced");
            let snap = progress_rx.borrow().snapshot(2_000).expect("progress snapshot");
            assert_eq!(snap.last_visible_text_at, 0, "blank-only chunk must not stamp last_visible_text_at");
            assert!(!snap.has_first_semantic, "blank-only chunk must not set has_first_semantic");
            assert!(!marks.lock().unwrap().contains(&CallMark::Streaming), "blank-only chunk must not emit CallMark::Streaming");
            assert!(deltas.lock().unwrap().is_empty());
        }

        // (b) Blank-only chunk followed by Stop must also leave output_produced and text stream delta unset.
        {
            let (session, write_started) = make_session().await;
            let feed_session = session.clone();
            let feed_wait = write_started.notified_owned();
            let feeder = tokio::spawn(async move {
                feed_wait.await;
                feed_session.take(blank_chunk("\n   "));
                feed_session.take(Incoming::Notification {
                    method: "session/update".into(),
                    params: json!({ "update": { "sessionUpdate": "usage_update", "used": 100, "size": 100000 } }),
                });
            });
            let cancel = CancellationToken::new();
            let cancel_on_usage = cancel.clone();
            let deltas = Arc::new(std::sync::Mutex::new(Vec::new()));
            let marks = Arc::new(std::sync::Mutex::new(Vec::new()));
            let surface: Arc<dyn TurnSurface> =
                Arc::new(RecordingSurface { deltas: deltas.clone(), marks: marks.clone(), on_context_update: Arc::new(move || cancel_on_usage.cancel()) });
            let mut prog = RunProgress::default();
            prog.ask_start(1_000);
            let (progress_tx, progress_rx) = watch::channel(prog);
            let output_produced = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut ctx = test_context(cancel);
            ctx.progress = Some(progress_tx);
            ctx.output_produced = Some(output_produced.clone());

            let end = run(&session, surface, Ask::Prompt(vec![json!({ "type": "text", "text": "hi" })]), ctx).await;
            feeder.await.expect("feeder");
            assert_eq!(end, TurnEnd::Interrupted);
            assert!(!output_produced.load(std::sync::atomic::Ordering::SeqCst), "blank-only chunk before Stop must not mark output_produced");
            let snap = progress_rx.borrow().snapshot(2_000).expect("progress snapshot");
            assert_eq!(snap.last_visible_text_at, 0, "blank-only chunk before Stop must not stamp last_visible_text_at");
            assert!(!snap.has_first_semantic, "blank-only chunk before Stop must not set has_first_semantic");
            assert!(!marks.lock().unwrap().contains(&CallMark::Streaming));
            assert!(deltas.lock().unwrap().is_empty());
        }

        // (c) Blank-only chunk followed by real visible text preserves leading whitespace and marks output.
        {
            let (session, write_started) = make_session().await;
            let feed_session = session.clone();
            let feed_wait = write_started.notified_owned();
            let feeder = tokio::spawn(async move {
                feed_wait.await;
                feed_session.take(blank_chunk("  \n"));
                feed_session.take(blank_chunk("hello"));
                feed_session.take(Incoming::Response { id: 1, result: Ok(json!({ "stopReason": "end_turn" })) });
            });
            let deltas = Arc::new(std::sync::Mutex::new(Vec::new()));
            let marks = Arc::new(std::sync::Mutex::new(Vec::new()));
            let surface: Arc<dyn TurnSurface> = Arc::new(RecordingSurface { deltas: deltas.clone(), marks: marks.clone(), on_context_update: Arc::new(|| {}) });
            let mut prog = RunProgress::default();
            prog.ask_start(1_000);
            let (progress_tx, progress_rx) = watch::channel(prog);
            let output_produced = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut ctx = test_context(CancellationToken::new());
            ctx.progress = Some(progress_tx);
            ctx.output_produced = Some(output_produced.clone());

            let end = run(&session, surface, Ask::Prompt(vec![json!({ "type": "text", "text": "hi" })]), ctx).await;
            feeder.await.expect("feeder");
            assert!(matches!(end, TurnEnd::Completed { .. }), "expected normal completion, got {end:?}");
            assert!(output_produced.load(std::sync::atomic::Ordering::SeqCst), "real text after blank chunk must mark output_produced");
            let snap = progress_rx.borrow().snapshot(2_000).expect("progress snapshot");
            assert!(snap.last_visible_text_at > 0, "real text must stamp last_visible_text_at");
            assert!(snap.has_first_semantic, "real text must set has_first_semantic");
            assert!(marks.lock().unwrap().contains(&CallMark::Streaming));
            assert_eq!(*deltas.lock().unwrap(), vec!["  \nhello".to_owned()]);
        }
    }
}
