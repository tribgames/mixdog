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

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

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
use tokio::sync::watch;

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

/// What the writers and the purge and redaction entry points share.
struct Shared {
    projects: PathBuf,
    lane: DurabilityIo,
    sensitive: Arc<SensitiveStore>,
    /// The memory watcher's ingest, when memory runs: a rewrite goes through it so the watcher's
    /// read position stays on the same line.
    ingest: std::sync::OnceLock<Arc<dyn super::purge::IngestOffsets>>,
    /// Deleted sessions (`purgedSessions`): their writers write nothing more, ids are never reused.
    purged: Mutex<Vec<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Shared {
    fn is_purged(&self, session: &str) -> bool {
        lock(&self.purged).iter().any(|id| id == session)
    }

    /// Every transcript of `session` rewritten with its sensitive values replaced, line for line.
    async fn redact_files(&self, session: &str, files: &[PathBuf]) {
        for path in rotations(files) {
            let (sensitive, id) = (self.sensitive.clone(), session.to_owned());
            let rewrite: mixdog_services::memory::transcript::LineRewrite = Box::new(move |text| redact_lines(&sensitive, &id, &text));
            let rewritten = match self.ingest.get() {
                Some(ingest) => ingest.rewrite_transcript(&path, rewrite).await,
                None => mixdog_services::memory::transcript::rewrite_lines_file(self.lane, &path, rewrite).await.map(|done| done.is_some()),
            };
            if let Err(error) = rewritten {
                tracing::warn!(?error, path = %path.display(), "transcript-writer: a marked value could not be redacted in the transcript");
            }
        }
    }
}

/// Each transcript with its rotated `.1`.
fn rotations(files: &[PathBuf]) -> Vec<PathBuf> {
    let mut all = Vec::new();
    for path in files {
        let mut rotated = path.clone().into_os_string();
        rotated.push(".1");
        all.push(path.clone());
        all.push(PathBuf::from(rotated));
    }
    all
}

/// The header field naming every folder (cwd) a session's transcripts were written under: the delete and a redaction find the files from it.
pub const TRANSCRIPT_CWDS: &str = "transcriptCwds";

fn recorded_cwds(header: &Header) -> Vec<String> {
    header.get(TRANSCRIPT_CWDS).and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
}

/// The lines of a transcript with the session's sensitive values replaced in each line's
/// `message` (what the writer would write for it now); every other line, and every byte between
/// lines, as it was.
fn redact_lines(sensitive: &SensitiveStore, session: &str, text: &str) -> String {
    text.split('\n')
        .map(|line| {
            let Ok(Value::Object(mut entry)) = serde_json::from_str::<Value>(line) else { return line.to_owned() };
            let Some(message) = entry.get("message") else { return line.to_owned() };
            let redacted = sensitive.redact_message(session, message);
            if &redacted == message {
                return line.to_owned();
            }
            entry.insert("message".into(), redacted);
            mixdog_js::json_stringify(&Value::Object(entry))
        })
        .collect::<Vec<_>>()
        .join("\n")
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
    /// A value was marked: the session's transcripts are rewritten redacted, after every line
    /// queued before (each later line is redacted as it is written).
    Redact(Option<oneshot::Sender<()>>),
    Flushed(oneshot::Sender<()>),
}

/// The writer of one session and cwd (`createTranscriptWriter`).
struct Writer {
    path: PathBuf,
    /// Every transcript of the session the record names, this writer's own included.
    files: Vec<PathBuf>,
    session: String,
    cwd: String,
    memory_eligible: bool,
    clock: Arc<dyn Clock>,
    sensitive: Arc<SensitiveStore>,
    shared: Arc<Shared>,
    /// `createRotationTracker`'s state.
    size_checked: bool,
    last_known: u64,
    since_check: u64,
    /// `rt._lastAppendedAssistant`.
    last_assistant: String,
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

struct Draining {
    id: u64,
    files: Vec<PathBuf>,
    tx: mpsc::WeakUnboundedSender<Op>,
    done: watch::Receiver<bool>,
}

struct WriterDone {
    id: u64,
    session: String,
    draining: Arc<Mutex<HashMap<String, Vec<Draining>>>>,
    done: watch::Sender<bool>,
}

impl Drop for WriterDone {
    fn drop(&mut self) {
        let mut map = lock(&self.draining);
        let _ = self.done.send(true);
        if let Some(entries) = map.get_mut(&self.session) {
            entries.retain(|entry| entry.id != self.id);
            if entries.is_empty() {
                map.remove(&self.session);
            }
        }
    }
}

impl Writer {
    fn spawn(
        self,
        lane: DurabilityIo,
        id: u64,
        draining: Arc<Mutex<HashMap<String, Vec<Draining>>>>,
        prev: Vec<watch::Receiver<bool>>,
    ) -> (mpsc::UnboundedSender<Op>, watch::Receiver<bool>) {
        let (tx, mut rx) = mpsc::unbounded_channel::<Op>();
        let (done_tx, done_rx) = watch::channel(false);
        let (session, shared, files) = (self.session.clone(), self.shared.clone(), self.files.clone());
        drop(mixdog_rt::spawn("session-transcript", mixdog_rt::TaskClass::Work, async move {
            let _done = WriterDone { id, session: session.clone(), draining, done: done_tx };
            for mut prior in prev {
                let _ = prior.wait_for(|finished| *finished).await;
            }
            let mut writer = Some(self);
            while let Some(op) = rx.recv().await {
                let op = match op {
                    Op::Flushed(done) => {
                        let _ = done.send(());
                        continue;
                    }
                    Op::Redact(done) => {
                        if !shared.is_purged(&session) {
                            shared.redact_files(&session, &files).await;
                        }
                        if let Some(done) = done {
                            let _ = done.send(());
                        }
                        continue;
                    }
                    // A deleted session's queued lines are discarded (`discardBuffered`), and it
                    // writes nothing more (`isSessionTranscriptPurged`).
                    _ if shared.is_purged(&session) => continue,
                    op => op,
                };
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
        (tx, done_rx)
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
            Op::Redact(_) | Op::Flushed(_) => {}
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

    /// A memory ingest whose rewrites wait for `release`: the writer is held inside a redaction
    /// while lines and marks queue behind it.
    struct HeldIngest(tokio::sync::Semaphore);

    const SESSION: &str = "sess_marks";

    fn mark(sensitive: &SensitiveStore, value: &str) {
        assert!(sensitive.remember(SESSION, &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "text": value, "sensitive": true } } })]));
    }

    /// The texts of the file's lines, in order.
    fn texts(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["message"]["content"][0]["text"].as_str().unwrap().to_owned())
            .collect()
    }

    /// The read position a rewrite carries over ends the same line in the new text.
    #[test]
    fn the_read_position_moves_to_the_same_line() {
        use mixdog_services::memory::transcript::same_line_offset;
        let old = b"{\"a\":\"4711\"}\n{\"b\":1}\n{\"c\":2}\n";
        let new = b"{\"a\":\"[redacted]\"}\n{\"b\":1}\n{\"c\":2}\n";
        assert_eq!(same_line_offset(old, new, 0.0), 0.0);
        assert_eq!(same_line_offset(old, new, 13.0), 19.0);
        assert_eq!(same_line_offset(old, new, 21.0), 27.0);
        assert_eq!(same_line_offset(old, new, old.len() as f64), new.len() as f64);
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

    #[async_trait::async_trait]
    impl super::super::purge::IngestOffsets for HeldIngest {
        async fn forget_transcripts(&self, _: &[PathBuf]) -> usize {
            0
        }

        async fn rewrite_transcript(&self, path: &Path, rewrite: mixdog_services::memory::transcript::LineRewrite) -> std::io::Result<bool> {
            drop(self.0.acquire().await);
            let done = mixdog_services::memory::transcript::rewrite_lines_file(mixdog_rt::testing::tokens().maintenance_io, path, rewrite).await?;
            Ok(done.is_some())
        }
    }

    struct Rig {
        _home: tempfile::TempDir,
        files: Arc<TranscriptFiles>,
        sensitive: Arc<SensitiveStore>,
        header: Header,
        path: PathBuf,
    }
    fn rig() -> Rig {
        let home = tempfile::tempdir().unwrap();
        let cwd = home.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.to_string_lossy().into_owned();
        let sensitive = Arc::new(SensitiveStore::default());
        let files = TranscriptFiles::new(home.path(), mixdog_rt::testing::tokens().durability_io, Arc::new(Now), sensitive.clone());
        let mut header = Header::new();
        header.insert("cwd".into(), json!(cwd));
        let path = home.path().join("projects").join(super::super::purge::project_slug(&cwd)).join(format!("{SESSION}.jsonl"));
        Rig { _home: home, files, sensitive, header, path }
    }
    /// A value marked in the turn that wrote it: the line already on disk is rewritten, the
    /// line written after the mark is redacted as it is written.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_value_marked_in_the_same_turn_leaves_no_plain_copy() {
        let r = rig();
        let turn = r.files.turn(SESSION, &r.header, &[]).unwrap();
        turn.user(&json!("the code is 4711"));
        turn.flushed().await;
        assert_eq!(texts(&r.path), ["the code is 4711"]);
        mark(&r.sensitive, "4711");
        turn.final_text("typed 4711");
        turn.flushed().await;
        assert_eq!(texts(&r.path), ["the code is [redacted]", "typed [redacted]"]);
    }
    /// A value marked while an append is queued or running (the patched Node's "marked while an append is in flight" test): the
    /// append's line is redacted, the line after the mark is written redacted, and none is lost.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_value_marked_while_an_append_is_in_flight_is_redacted_in_that_line_and_none_is_lost() {
        let r = rig();
        let turn = r.files.turn(SESSION, &r.header, &[]).unwrap();
        turn.user(&json!("first line"));
        turn.user(&json!(format!("the pin is 4711 {}", "x".repeat(40_000))));
        mark(&r.sensitive, "4711");
        turn.user(&json!("and again 4711"));
        turn.flushed().await;
        let lines = texts(&r.path);
        assert_eq!(
            lines.iter().map(|text| text.chars().take(20).collect::<String>()).collect::<Vec<_>>(),
            ["first line", "the pin is [redacted", "and again [redacted]"]
        );
        assert!(lines.iter().all(|text| !text.contains("4711")));
    }
    /// A value marked two turns after the one that wrote it: every earlier line of every turn is
    /// rewritten in place, the rest as they were.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_value_marked_two_turns_later_is_redacted_in_the_earlier_lines() {
        let r = rig();
        for (prompt, answer) in [("my pin is 4711", "noted 4711"), ("what now", "wait"), ("fill it", "filling")] {
            let turn = r.files.turn(SESSION, &r.header, &[]).unwrap();
            turn.user(&json!(prompt));
            turn.final_text(answer);
            turn.flushed().await;
        }
        mark(&r.sensitive, "4711");
        r.files.redact_session(SESSION, &[]).await;
        assert_eq!(texts(&r.path), ["my pin is [redacted]", "noted [redacted]", "what now", "wait", "fill it", "filling"]);
    }
    /// A mark while lines are queued behind a held write: the queued line is redacted when it is
    /// written, so no append brings the value back after the rewrite.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_mark_while_a_write_is_queued_reaches_the_queued_line() {
        let r = rig();
        let held = Arc::new(HeldIngest(tokio::sync::Semaphore::new(0)));
        r.files.attach_ingest(held.clone());
        let turn = r.files.turn(SESSION, &r.header, &[]).unwrap();
        turn.user(&json!("first a1b2"));
        turn.flushed().await;
        // The writer enters the rewrite of the first mark and waits there.
        mark(&r.sensitive, "a1b2");
        turn.final_text("then z9y8");
        mark(&r.sensitive, "z9y8");
        held.0.add_permits(16);
        turn.flushed().await;
        assert_eq!(texts(&r.path), ["first [redacted]", "then [redacted]"]);
    }
    /// A deleted session's writer, held mid-write with lines queued: the delete waits for the
    /// running write, discards the queued lines and refuses every later one, so the removed file
    /// never comes back.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_deleted_sessions_writer_never_recreates_its_transcript() {
        let r = rig();
        let held = Arc::new(HeldIngest(tokio::sync::Semaphore::new(0)));
        r.files.attach_ingest(held.clone());
        let turn = r.files.turn(SESSION, &r.header, &[]).unwrap();
        turn.user(&json!("one 4711"));
        turn.flushed().await;
        mark(&r.sensitive, "4711");
        turn.final_text("queued behind the held write");
        let purge = tokio::spawn({
            let files = r.files.clone();
            async move { files.purge(SESSION).await }
        });
        tokio::task::yield_now().await;
        assert!(!purge.is_finished(), "the delete waits for the running write");
        held.0.add_permits(16);
        let paths = purge.await.unwrap();
        assert_eq!(paths, [r.path.clone()]);
        std::fs::remove_file(&r.path).unwrap();
        turn.user(&json!("an append after the delete"));
        turn.flushed().await;
        assert!(r.files.turn(SESSION, &r.header, &[]).is_none(), "no writer is made for a deleted session");
        assert!(!r.path.exists(), "nothing recreated the transcript");
    }
    /// The delete finds the transcript of every folder the session wrote in from the folders its record names: no list of the
    /// paths its writers used is kept per session, and no folder is searched.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_delete_finds_the_transcripts_of_every_folder_the_record_names() {
        let r = rig();
        let other = r._home.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        let other = other.to_string_lossy().into_owned();
        let second = r._home.path().join("projects").join(super::super::purge::project_slug(&other)).join(format!("{SESSION}.jsonl"));
        let stray = r._home.path().join("projects").join("stray").join(format!("{SESSION}.jsonl"));
        std::fs::create_dir_all(stray.parent().unwrap()).unwrap();
        std::fs::write(&stray, "").unwrap();
        let mut header = r.header.clone();
        let first_cwd = header["cwd"].clone();
        for cwd in [first_cwd, json!(other)] {
            header.insert("cwd".into(), cwd);
            if let Some(recorded) = r.files.cwds_to_record(&header) {
                header.insert(TRANSCRIPT_CWDS.into(), json!(recorded));
            }
            let turn = r.files.turn(SESSION, &header, &[]).unwrap();
            turn.user(&json!("a line"));
            turn.flushed().await;
        }
        assert_eq!(header[TRANSCRIPT_CWDS].as_array().map(Vec::len), Some(2), "each folder is recorded once");
        assert!(r.files.cwds_to_record(&header).is_none());
        let mut paths = r.files.purge(SESSION).await;
        paths.sort();
        let mut written = vec![r.path.clone(), second];
        written.sort();
        assert_eq!(paths, written, "the recorded folders, and nothing found by looking");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retiring_an_unloaded_session_drops_its_writer_and_allows_reopening() {
        let r = rig();
        {
            let turn = r.files.turn(SESSION, &r.header, &[]).unwrap();
            turn.user(&json!("first prompt"));
            turn.assistant_text("first answer");
            // Do not flush before retire: retire must fence the queued ops before reopen/redact/purge.
        }
        assert_eq!(r.files.writers_held(), 1);

        // Concurrent retire + immediate reopen must serialize the new writer behind the draining one.
        let ((), ()) = tokio::join!(r.files.retire(SESSION), async {
            let turn = r.files.turn(SESSION, &r.header, &[json!({"role": "user", "content": "first prompt"})]).unwrap();
            turn.final_text("first answer");
            turn.flushed().await;
        });
        assert_eq!(r.files.writers_held(), 1);
        assert_eq!(r.files.draining_held(), 0);
        let lines = texts(&r.path);
        assert_eq!(
            lines,
            vec!["first prompt", "first answer", "first answer"],
            "old lines kept in order, no duplicate backfill, fresh writer writes with empty last_assistant"
        );

        // Retire completely releases both active and draining maps once drained.
        r.files.retire(SESSION).await;
        assert_eq!((r.files.writers_held(), r.files.draining_held()), (0, 0));

        // Retire followed immediately by redact_session fences queued writes so sensitive values are redacted.
        {
            let turn = r.files.turn(SESSION, &r.header, &[]).unwrap();
            turn.user(&json!("secret-token-xyz"));
        }
        mark(&r.sensitive, "secret-token-xyz");
        let cwds = [r.header.get("cwd").and_then(Value::as_str).unwrap().to_owned()];
        let ((), ()) = tokio::join!(r.files.retire(SESSION), r.files.redact_session(SESSION, &cwds));
        let text = std::fs::read_to_string(&r.path).unwrap();
        assert!(!text.contains("secret-token-xyz"), "redaction waited for retiring writer: {text}");
        assert_eq!((r.files.writers_held(), r.files.draining_held()), (0, 0));

        // Retire followed immediately by purge still fences the draining writer, returns its path, and blocks future turns.
        {
            let turn = r.files.turn(SESSION, &r.header, &[]).unwrap();
            turn.user(&json!("last prompt"));
        }
        let ((), purged) = tokio::join!(r.files.retire(SESSION), r.files.purge(SESSION));
        assert!(purged.contains(&r.path), "purge fenced the retiring writer and returned its path");
        assert!(r.files.turn(SESSION, &r.header, &[]).is_none(), "purged session cannot reopen a writer");
        assert_eq!((r.files.writers_held(), r.files.draining_held()), (0, 0));
    }
}
/// The transcripts of the process's sessions.
pub struct TranscriptFiles {
    lane: DurabilityIo,
    clock: Arc<dyn Clock>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    /// Each session's writer, the session+cwd it was made for and its mark subscription, oldest first.
    writers: Mutex<Vec<WriterEntry>>,
    /// Retired or superseded writers still draining queued ops; each task removes its own entry on exit.
    draining: Arc<Mutex<HashMap<String, Vec<Draining>>>>,
}
struct WriterEntry {
    id: u64,
    session: String,
    made_for: String,
    files: Vec<PathBuf>,
    tx: mpsc::UnboundedSender<Op>,
    done: watch::Receiver<bool>,
    _marks: mixdog_services::memory::sensitive::Subscription,
}
impl TranscriptFiles {
    /// The transcripts under `mixdog_home`'s `projects`.
    pub fn new(mixdog_home: &Path, lane: DurabilityIo, clock: Arc<dyn Clock>, sensitive: Arc<SensitiveStore>) -> Arc<Self> {
        let shared = Arc::new(Shared { projects: mixdog_home.join("projects"), lane, sensitive, ingest: std::sync::OnceLock::new(), purged: Mutex::default() });
        Arc::new(Self { lane, clock, shared, next_id: AtomicU64::new(1), writers: Mutex::default(), draining: Arc::default() })
    }

    fn track_draining_locked(draining: &mut HashMap<String, Vec<Draining>>, entry: &WriterEntry) {
        if !*entry.done.borrow() {
            draining.entry(entry.session.clone()).or_default().push(Draining {
                id: entry.id,
                files: entry.files.clone(),
                tx: entry.tx.downgrade(),
                done: entry.done.clone(),
            });
        }
    }

    /// The memory watcher's ingest, through which a redaction rewrites a transcript.
    pub fn attach_ingest(&self, ingest: Arc<dyn super::purge::IngestOffsets>) {
        let _ = self.shared.ingest.set(ingest);
    }

    /// Every transcript of `thread` rewritten with the session's sensitive values replaced by the
    /// marker later lines get, each line kept in place. Ordered after every line already queued
    /// for the session's writer; a line queued later is redacted as it is written, so no append
    /// brings a marked value back. With the memory service attached the rewrite holds the file's
    /// ingest gate and moves the watcher's read position to the same line of the new file.
    /// Resolves once the files are rewritten. A marked value calls this by itself; a caller that
    /// must not acknowledge the mark before the files are clean awaits it.
    pub async fn redact_session(&self, thread: &str, cwds: &[String]) {
        let live = lock(&self.writers).iter().find(|entry| entry.session == thread && !entry.tx.is_closed()).map(|entry| entry.tx.clone());
        if let Some(tx) = live {
            let (done, rx) = oneshot::channel();
            if tx.send(Op::Redact(Some(done))).is_ok() && rx.await.is_ok() {
                return;
            }
        }
        let (mut wait, draining_files) = {
            let draining = lock(&self.draining);
            match draining.get(thread) {
                Some(entries) => {
                    let wait: Vec<watch::Receiver<bool>> = entries.iter().map(|d| d.done.clone()).collect();
                    let files: Vec<PathBuf> = entries.iter().flat_map(|d| d.files.iter().cloned()).collect();
                    (wait, files)
                }
                None => (Vec::new(), Vec::new()),
            }
        };
        for done in &mut wait {
            let _ = done.wait_for(|finished| *finished).await;
        }
        let mut files: Vec<PathBuf> =
            cwds.iter().filter(|cwd| !cwd.is_empty()).map(|cwd| self.transcript_path(thread, &super::user_cwd::node_resolve(cwd))).collect();
        for path in draining_files {
            if !files.contains(&path) {
                files.push(path);
            }
        }
        self.shared.redact_files(thread, &files).await;
    }

    fn transcript_path(&self, thread: &str, cwd: &str) -> PathBuf {
        self.shared.projects.join(super::purge::project_slug(cwd)).join(format!("{thread}.jsonl"))
    }

    /// The `transcriptCwds` the session's record must hold before its writer opens: `None` when it names the cwd
    /// already, or the session writes no transcript.
    pub fn cwds_to_record(&self, header: &Header) -> Option<Vec<String>> {
        if super::session_options::memory_off(header) {
            return None;
        }
        let cwd = super::user_cwd::node_resolve(header.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty())?);
        let mut held = recorded_cwds(header);
        if held.contains(&cwd) {
            return None;
        }
        held.push(cwd);
        Some(held)
    }

    /// Retires an unloaded session's writer entry and awaits its draining task so its channel,
    /// file list, mark subscription and `last_assistant` buffer leave memory once queued writes
    /// finish. Unlike [`Self::purge`], the session is not marked purged, so a later reload opens
    /// a fresh writer serialized after any still-draining writer.
    pub async fn retire(&self, thread: &str) {
        let (stopped, mut wait) = {
            let mut writers = lock(&self.writers);
            let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut *writers).into_iter().partition(|entry| entry.session == thread);
            *writers = kept;
            let mut draining = lock(&self.draining);
            for entry in &gone {
                Self::track_draining_locked(&mut draining, entry);
            }
            let wait: Vec<watch::Receiver<bool>> = draining.get(thread).map(|entries| entries.iter().map(|d| d.done.clone()).collect()).unwrap_or_default();
            (gone, wait)
        };
        drop(stopped);
        for done in &mut wait {
            let _ = done.wait_for(|finished| *finished).await;
        }
    }

    #[cfg(test)]
    fn writers_held(&self) -> usize {
        lock(&self.writers).len()
    }

    #[cfg(test)]
    fn draining_held(&self) -> usize {
        lock(&self.draining).len()
    }

    /// `purgeSessionTranscripts`' writer half: `thread` is deleted, so its writers write nothing
    /// more (their queued lines are discarded, a later append is refused) and no writer is made
    /// for it again. Resolves once a write already running has ended; returns the paths the
    /// writers used, for the caller to remove.
    pub async fn purge(&self, thread: &str) -> Vec<PathBuf> {
        {
            let mut purged = lock(&self.shared.purged);
            purged.retain(|id| id != thread);
            purged.push(thread.to_owned());
            if purged.len() > MAX_WRITERS {
                purged.remove(0);
            }
        }
        let (stopped, draining_entries) = {
            let mut writers = lock(&self.writers);
            let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut *writers).into_iter().partition(|entry| entry.session == thread);
            *writers = kept;
            let draining = lock(&self.draining);
            let draining_entries: Vec<(Vec<PathBuf>, mpsc::WeakUnboundedSender<Op>, watch::Receiver<bool>)> =
                draining.get(thread).map(|entries| entries.iter().map(|d| (d.files.clone(), d.tx.clone(), d.done.clone())).collect()).unwrap_or_default();
            (gone, draining_entries)
        };
        for entry in &stopped {
            let (done, rx) = oneshot::channel();
            if entry.tx.send(Op::Flushed(done)).is_ok() {
                let _ = rx.await;
            }
        }
        let mut paths: Vec<PathBuf> = Vec::new();
        for entry in stopped {
            for path in entry.files {
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
        for (files, weak_tx, mut done) in draining_entries {
            if let Some(tx) = weak_tx.upgrade() {
                let (flushed_tx, flushed_rx) = oneshot::channel();
                if tx.send(Op::Flushed(flushed_tx)).is_ok() {
                    tokio::select! {
                        _ = flushed_rx => {}
                        _ = done.wait_for(|finished| *finished) => {}
                    }
                } else {
                    let _ = done.wait_for(|finished| *finished).await;
                }
            } else {
                let _ = done.wait_for(|finished| *finished).await;
            }
            for path in files {
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
        paths
    }

    /// `ensureSessionTranscriptWriter` at a turn's preparation: the writer of the session `header`
    /// describes in its current cwd (a new one when the cwd moved), seeded once from `prior`, the
    /// conversation before the turn. `None` for a session whose memory is off: its conversation
    /// never reaches memory (Node runs it in a pristine home that is removed afterwards).
    pub fn turn(&self, thread: &str, header: &Header, prior: &[Value]) -> Option<TurnTranscript> {
        if super::session_options::memory_off(header) || thread.is_empty() || self.shared.is_purged(thread) {
            return None;
        }
        let cwd = header.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty())?;
        let cwd = super::user_cwd::node_resolve(cwd);
        let key = format!("{thread}\u{0}{cwd}");
        let (tx, dropped_old) = {
            let mut writers = lock(&self.writers);
            let found = writers.iter().position(|entry| entry.session == thread && entry.made_for == key && !entry.tx.is_closed());
            match found {
                Some(at) => (writers[at].tx.clone(), Vec::new()),
                None => {
                    let (old, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut *writers).into_iter().partition(|entry| entry.session == thread);
                    *writers = kept;
                    let mut draining = lock(&self.draining);
                    for entry in &old {
                        Self::track_draining_locked(&mut draining, entry);
                    }
                    let prev: Vec<watch::Receiver<bool>> =
                        draining.get(thread).map(|entries| entries.iter().map(|d| d.done.clone()).collect()).unwrap_or_default();
                    let path = self.transcript_path(thread, &cwd);
                    let mut files: Vec<PathBuf> = recorded_cwds(header).iter().map(|recorded| self.transcript_path(thread, recorded)).collect();
                    if !files.contains(&path) {
                        files.push(path.clone());
                    }
                    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                    let writer = Writer {
                        path: path.clone(),
                        files: files.clone(),
                        session: thread.to_owned(),
                        cwd,
                        memory_eligible: !super::thread_switches::agent_owner(header),
                        clock: self.clock.clone(),
                        sensitive: self.shared.sensitive.clone(),
                        shared: self.shared.clone(),
                        size_checked: false,
                        last_known: 0,
                        since_check: 0,
                        last_assistant: String::new(),
                    };
                    let (tx, done) = writer.spawn(self.lane, id, self.draining.clone(), prev);
                    let marked = tx.clone();
                    let marks = self.shared.sensitive.on_marked(thread, move |_| {
                        let _ = marked.send(Op::Redact(None));
                    });
                    writers.push(WriterEntry { id, session: thread.to_owned(), made_for: key, files, tx: tx.clone(), done, _marks: marks });
                    let mut dropped = old;
                    if writers.len() > MAX_WRITERS {
                        let evicted = writers.remove(0);
                        Self::track_draining_locked(&mut draining, &evicted);
                        dropped.push(evicted);
                    }
                    (tx, dropped)
                }
            }
        };
        drop(dropped_old);
        let _ = tx.send(Op::Ensure(prior.to_vec()));
        Some(TurnTranscript(tx))
    }
}
