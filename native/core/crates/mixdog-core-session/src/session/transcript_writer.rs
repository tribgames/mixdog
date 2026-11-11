//! The conversation transcript the memory watcher tails: `<home>/projects/<slug>/<id>.jsonl`, one
//! JSON line per user prompt and assistant text (Node's `createTranscriptWriter`,
//! `runtime/shared/transcript-writer.mjs`, created per session and cwd by
//! `session-runtime/session-transcript.mjs`, appended by `session-runtime/turn/turn-run/transcript.mjs`).
//!
//! The memory service's transcript watcher (`mixdog_services::memory::transcript`) ingests these
//! lines with a read position it persists per file, so a turn written here reaches memory once,
//! also across a restart between the write and the ingest.
//!
//! A session's sensitive values are redacted in every line (`node-fix-memory-sensitive.patch`:
//! 1.4.5 wrote them in plain text). The appends of one session run in call order on one task,
//! each file operation a durability-lane job; a failure is logged and never fails the turn.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_services::memory::sensitive::SensitiveStore;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use super::Clock;

/// `TRANSCRIPT_ROTATE_BYTES`: past this size the file becomes `<path>.1`.
const ROTATE_BYTES: u64 = 10 * 1024 * 1024;
/// `ROTATE_CHECK_BYTE_STRIDE`: appended bytes between two size checks.
const ROTATE_STRIDE: u64 = 64 * 1024;
/// `MAX_TRACKED_SESSIONS`: the writers kept, oldest dropped first.
const MAX_WRITERS: usize = 4096;

/// `conversationText(content)`: a string, or the strings and text blocks of a block array joined
/// by newlines; anything else has no text.
fn conversation_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                Value::String(text) => Some(text.as_str()),
                Value::Object(map) if map.get("type").and_then(Value::as_str) == Some("text") => map.get("text").and_then(Value::as_str),
                _ => None,
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The transcripts of the process's sessions.
pub struct TranscriptFiles {
    projects: PathBuf,
    lane: DurabilityIo,
    clock: Arc<dyn Clock>,
    sensitive: Arc<SensitiveStore>,
    /// Each session's writer and the session+cwd it was made for, oldest first.
    writers: Mutex<Vec<(String, String, mpsc::UnboundedSender<Op>)>>,
}

/// What a session's writer task does next, in order.
enum Op {
    /// `ensureSessionTranscriptWriter`'s backfill and empty-file creation over the conversation so far.
    Ensure(Vec<Value>),
    /// `appendUser` (empties the last appended assistant text).
    User(String),
    /// `appendAssistantText`.
    Assistant(String),
    /// `appendFinalAssistant`: written unless it is the last appended assistant text.
    Final(String),
    Flushed(oneshot::Sender<()>),
}

/// The writer of one session and cwd (`createTranscriptWriter`).
struct Writer {
    path: PathBuf,
    session: String,
    cwd: String,
    memory_eligible: bool,
    clock: Arc<dyn Clock>,
    sensitive: Arc<SensitiveStore>,
    /// `createRotationTracker`'s state.
    size_checked: bool,
    last_known: u64,
    since_check: u64,
    /// `rt._lastAppendedAssistant`.
    last_assistant: String,
}

impl TranscriptFiles {
    /// The transcripts under `mixdog_home`'s `projects`.
    pub fn new(mixdog_home: &Path, lane: DurabilityIo, clock: Arc<dyn Clock>, sensitive: Arc<SensitiveStore>) -> Arc<Self> {
        Arc::new(Self { projects: mixdog_home.join("projects"), lane, clock, sensitive, writers: Mutex::default() })
    }

    /// `ensureSessionTranscriptWriter` at a turn's preparation: the writer of the session `header`
    /// describes in its current cwd (a new one when the cwd moved), seeded once from `prior`, the
    /// conversation before the turn. `None` for a session whose memory is off: its conversation
    /// never reaches memory (Node runs it in a pristine home that is removed afterwards).
    pub fn turn(&self, thread: &str, header: &Header, prior: &[Value]) -> Option<TurnTranscript> {
        if super::session_options::memory_off(header) || thread.is_empty() {
            return None;
        }
        let cwd = header.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty())?;
        let cwd = super::user_cwd::node_resolve(cwd);
        let key = format!("{thread}\u{0}{cwd}");
        let mut writers = self.writers.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let found = writers.iter().position(|(id, made_for, tx)| id == thread && *made_for == key && !tx.is_closed());
        let tx = match found {
            Some(at) => writers[at].2.clone(),
            None => {
                writers.retain(|(id, _, _)| id != thread);
                let writer = Writer {
                    path: self.projects.join(super::purge::project_slug(&cwd)).join(format!("{thread}.jsonl")),
                    session: thread.to_owned(),
                    cwd,
                    memory_eligible: !super::thread_switches::agent_owner(header),
                    clock: self.clock.clone(),
                    sensitive: self.sensitive.clone(),
                    size_checked: false,
                    last_known: 0,
                    since_check: 0,
                    last_assistant: String::new(),
                };
                let tx = writer.spawn(self.lane);
                writers.push((thread.to_owned(), key, tx.clone()));
                if writers.len() > MAX_WRITERS {
                    writers.remove(0);
                }
                tx
            }
        };
        let _ = tx.send(Op::Ensure(prior.to_vec()));
        Some(TurnTranscript(tx))
    }
}

/// A turn's appends to its session's transcript.
#[derive(Clone)]
pub struct TurnTranscript(mpsc::UnboundedSender<Op>);

impl TurnTranscript {
    /// `appendUser(prompt)`: the prompt's text (`content` as the input row holds it).
    pub fn user(&self, content: &Value) {
        let _ = self.0.send(Op::User(conversation_text(content)));
    }

    /// `appendAssistantText(text)`: assistant text surfaced mid-turn.
    pub fn assistant_text(&self, text: &str) {
        let _ = self.0.send(Op::Assistant(text.to_owned()));
    }

    /// `appendFinalAssistant(result)`: the turn's terminal text (`historyContent ?? content`).
    pub fn final_text(&self, text: &str) {
        let _ = self.0.send(Op::Final(text.to_owned()));
    }

    /// Resolves once every append sent before it is on disk (or failed).
    pub async fn flushed(&self) {
        let (tx, rx) = oneshot::channel();
        if self.0.send(Op::Flushed(tx)).is_ok() {
            let _ = rx.await;
        }
    }
}

impl Writer {
    fn spawn(self, lane: DurabilityIo) -> mpsc::UnboundedSender<Op> {
        let (tx, mut rx) = mpsc::unbounded_channel::<Op>();
        drop(mixdog_rt::spawn("session-transcript", mixdog_rt::TaskClass::Work, async move {
            let mut writer = Some(self);
            while let Some(op) = rx.recv().await {
                if let Op::Flushed(done) = op {
                    let _ = done.send(());
                    continue;
                }
                let Some(mut current) = writer.take() else { break };
                let job = lane.submit(&mixdog_rt::CancellationToken::new(), move |lane| {
                    current.apply(lane, op);
                    current
                });
                match job {
                    Ok(handle) => match handle.await {
                        Ok(back) => writer = Some(back),
                        Err(error) => {
                            tracing::warn!(?error, "transcript-writer: a write did not run");
                            break;
                        }
                    },
                    Err(error) => {
                        tracing::warn!(?error, "transcript-writer: a write was refused");
                        break;
                    }
                }
            }
        }));
        tx
    }

    fn apply(&mut self, lane: &InLane<DurabilityIo>, op: Op) {
        match op {
            Op::Ensure(messages) => {
                self.backfill(lane, &messages);
                self.ensure_file(lane);
            }
            Op::User(text) => {
                self.last_assistant.clear();
                self.append_text(lane, "user", &text);
            }
            Op::Assistant(text) => {
                if mixdog_js::js_trim(&text).is_empty() {
                    return;
                }
                self.append_text(lane, "assistant", &text);
                self.last_assistant = text;
            }
            Op::Final(text) => {
                if mixdog_js::js_trim(&text).is_empty() || text == self.last_assistant {
                    return;
                }
                self.append_text(lane, "assistant", &text);
                self.last_assistant = text;
            }
            Op::Flushed(_) => {}
        }
    }

    fn redact(&self, text: &str) -> String {
        match self.sensitive.redact_content(&self.session, &Value::String(text.to_owned())) {
            Value::String(text) => text,
            _ => text.to_owned(),
        }
    }

    fn ensure_dir(&self, lane: &InLane<DurabilityIo>) {
        if let Some(dir) = self.path.parent()
            && let Err(error) = mixdog_statefile::create_dir_all(lane, dir)
        {
            tracing::warn!(?error, "transcript-writer: the project folder could not be made");
        }
    }

    /// `ensureTranscriptFile`: an empty file the watchers can attach to, never truncating one.
    fn ensure_file(&self, lane: &InLane<DurabilityIo>) {
        self.ensure_dir(lane);
        match mixdog_statefile::create_new(lane, &self.path, mixdog_statefile::Access::Inherit, 0o600) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => tracing::warn!(?error, "transcript-writer: the transcript could not be made"),
        }
    }

    /// `ensureConversationBackfill`: an empty or missing file is seeded once with the
    /// conversation's user and assistant texts; a file with content is never rewritten.
    fn backfill(&mut self, lane: &InLane<DurabilityIo>, messages: &[Value]) {
        self.ensure_dir(lane);
        if mixdog_statefile::metadata(lane, &self.path).is_ok_and(|meta| meta.len() > 0) {
            return;
        }
        let mut lines = Vec::new();
        for message in messages {
            let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
            if role != "user" && role != "assistant" {
                continue;
            }
            let text = self.redact(&conversation_text(message.get("content").unwrap_or(&Value::Null)));
            if mixdog_js::js_trim(&text).is_empty() {
                continue;
            }
            let mut entry = Map::new();
            entry.insert("type".into(), json!(role));
            entry.insert("sessionId".into(), json!(self.session));
            entry.insert("cwd".into(), json!(self.cwd));
            if !self.memory_eligible {
                entry.insert("memoryEligible".into(), json!(false));
            }
            match (message.get("timestamp").filter(|v| !v.is_null()), message.get("ts").filter(|v| !v.is_null())) {
                (Some(timestamp), _) => {
                    entry.insert("timestamp".into(), timestamp.clone());
                }
                (None, Some(ts)) => {
                    entry.insert("ts".into(), ts.clone());
                }
                (None, None) => {}
            }
            entry.insert("message".into(), json!({ "content": [{ "type": "text", "text": text }] }));
            lines.push(mixdog_js::json_stringify(&Value::Object(entry)));
        }
        if lines.is_empty() {
            return;
        }
        let payload = format!("{}\n", lines.join("\n"));
        let opts = mixdog_statefile::Opts::default();
        match mixdog_statefile::write_file(lane, &self.path, payload.as_bytes(), &opts) {
            Ok(_) => {
                self.size_checked = true;
                self.last_known = payload.len() as u64;
                self.since_check = 0;
            }
            Err(error) => tracing::warn!(?error, "transcript-writer: the backfill could not be written"),
        }
    }

    /// `appendText`: the redacted text as one line, unless it is blank.
    fn append_text(&mut self, lane: &InLane<DurabilityIo>, kind: &str, text: &str) {
        let value = self.redact(text);
        if mixdog_js::js_trim(&value).is_empty() {
            return;
        }
        let mut entry = Map::new();
        entry.insert("type".into(), json!(kind));
        entry.insert("sessionId".into(), json!(self.session));
        entry.insert("message".into(), json!({ "content": [{ "type": "text", "text": value }] }));
        entry.insert("cwd".into(), json!(self.cwd));
        entry.insert("timestamp".into(), json!(mixdog_agent::agent_tool::stamp::iso_from_ms(self.clock.now_ms())));
        if !self.memory_eligible {
            entry.insert("memoryEligible".into(), json!(false));
        }
        self.ensure_dir(lane);
        self.rotate_if_needed(lane);
        let line = format!("{}\n", mixdog_js::json_stringify(&Value::Object(entry)));
        match mixdog_statefile::append_file(lane, &self.path, line.as_bytes()) {
            Ok(()) => self.since_check += line.len() as u64,
            Err(error) => tracing::warn!(?error, "transcript-writer: a line could not be appended"),
        }
    }

    /// `rotateIfNeeded`: the size is checked when unknown, after a stride of appends, or when the
    /// known size could have reached the limit; a file at the limit becomes `<path>.1`.
    fn rotate_if_needed(&mut self, lane: &InLane<DurabilityIo>) {
        if self.size_checked && self.since_check < ROTATE_STRIDE && self.last_known + self.since_check < ROTATE_BYTES {
            return;
        }
        let size = mixdog_statefile::metadata(lane, &self.path).map(|meta| meta.len()).unwrap_or(0);
        self.size_checked = true;
        self.last_known = size;
        self.since_check = 0;
        if size < ROTATE_BYTES {
            return;
        }
        let mut rotated = self.path.clone().into_os_string();
        rotated.push(".1");
        match mixdog_statefile::rename_with_retry(lane, &self.path, Path::new(&rotated)) {
            Ok(()) => self.last_known = 0,
            Err(error) => tracing::warn!(?error, "transcript-writer: the transcript could not be rotated"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Now;
    impl Clock for Now {
        fn now_ms(&self) -> i64 {
            1_772_600_767_890
        }
    }

    /// `fixtures/session-transcript/writer.json`: Node's writer and turn appends (`createSessionTranscript`,
    /// `createTurnTranscript`) driven step by step; the same steps here leave the same files: the one-time backfill of a
    /// conversation, an agent's lines kept out of memory, blank texts skipped, the final text not repeated, a file past
    /// the size limit rotated out, a marked value redacted everywhere.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_writer_writes_what_nodes_writer_wrote() {
        let recorded: Value = serde_json::from_str(include_str!("../../../../fixtures/session-transcript/writer.json")).expect("the recording");
        assert_eq!(recorded["now"], mixdog_agent::agent_tool::stamp::iso_from_ms(Now.now_ms()));
        for case in recorded["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().unwrap();
            let home = tempfile::tempdir().unwrap();
            let cwd = home.path().join("work");
            std::fs::create_dir_all(&cwd).unwrap();
            let cwd = cwd.to_string_lossy().into_owned();
            let sensitive = Arc::new(SensitiveStore::default());
            let session = case["session"]["id"].as_str().unwrap();
            if case["file"]["text"].as_str().is_some_and(|text| text.contains("[redacted]")) {
                sensitive.remember(session, std::slice::from_ref(&recorded["sensitiveCall"]));
            }
            let files = TranscriptFiles::new(home.path(), mixdog_rt::testing::tokens().durability_io, Arc::new(Now), sensitive);
            let mut header = Header::new();
            header.insert("cwd".into(), json!(cwd));
            if let Some(owner) = case["session"]["owner"].as_str() {
                header.insert("owner".into(), json!(owner));
            }
            let path = home.path().join("projects").join(super::super::purge::project_slug(&cwd)).join(format!("{session}.jsonl"));
            if case["rotated"].is_object() {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, format!("{}\n", "x".repeat(10 * 1024 * 1024))).unwrap();
            }
            let messages = case["session"]["messages"].as_array().cloned().unwrap_or_default();
            let mut turn: Option<TurnTranscript> = None;
            for step in case["steps"].as_array().unwrap() {
                let text = step.get(1).and_then(Value::as_str).unwrap_or_default();
                match step[0].as_str().unwrap() {
                    "ensure" => turn = files.turn(session, &header, &messages),
                    "appendUser" => turn.as_ref().unwrap().user(&json!(text)),
                    "appendAssistantText" => turn.as_ref().unwrap().assistant_text(text),
                    "final" => turn.as_ref().unwrap().final_text(text),
                    other => panic!("{name}: unknown step {other}"),
                }
            }
            turn.as_ref().unwrap().flushed().await;
            let escaped = serde_json::to_string(&cwd).unwrap();
            let written = std::fs::read_to_string(&path).unwrap().replace(&escaped[1..escaped.len() - 1], "<cwd>");
            assert_eq!(Some(written.as_str()), case["file"]["text"].as_str(), "{name}");
            let mut rotated = path.clone().into_os_string();
            rotated.push(".1");
            let rotated = std::fs::metadata(&rotated).ok().map(|meta| meta.len());
            assert_eq!(rotated, case["rotated"]["size"].as_u64(), "{name}: the rotated generation");
        }
    }

    #[test]
    fn conversation_text_reads_strings_and_text_blocks() {
        assert_eq!(conversation_text(&json!("plain")), "plain");
        assert_eq!(
            conversation_text(&json!([{ "type": "image", "attachmentRef": "a" }, "s", { "type": "text", "text": "t" }, { "type": "text", "text": "" }])),
            "s\nt"
        );
        assert_eq!(conversation_text(&json!({ "type": "text" })), "");
    }
}
