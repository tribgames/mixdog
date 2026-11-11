//! An open run's draft: what its interrupted response produced that no row holds yet, the 1.4.5 turn checkpoint's
//! interruption snapshot (`turn-interruption.mjs` `snapshot()`). A run writes it while it streams, to its draft file beside
//! the session's log (`mixdog_store::draft_file`; a log written before held `draft` records, which are still read); recovery
//! at open commits it, finalized as Node's restart recovery finalizes a checkpoint (`replayCheckpoint`).

use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

/// The folded draft of one open run.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunDraft {
    /// `responseStarted`: the run produced output (text, reasoning, a tool call, a tool result, the tool phase).
    pub started: bool,
    /// The message in progress: streamed text and reasoning, and the tool calls it announced.
    pub text: String,
    pub reasoning: String,
    pub calls: Vec<Value>,
    /// Tool results that settled before their call-order commit (`__earlyNotify`).
    pub results: Vec<Value>,
    /// The run is in its tool phase (`phase === 'tools'`); a new request puts it back.
    pub tools: bool,
    /// The run's input row (its `user` row, which precedes `run{started}`).
    pub input: Option<String>,
    /// The turn's final reply as its row would store it, written before that row (the 1.4.5 checkpoint's `sealed`): a
    /// turn whose reply row never landed is recovered finished with it.
    pub sealed: Option<Value>,
    /// The last request's context reading the draft carried (the checkpoint's `contextState`), restored as the session's
    /// `lastContextTokens` at recovery (`restoreCheckpointContext`).
    pub context_tokens: Option<u64>,
}

impl RunDraft {
    /// The draft `folded` over the whole log, onto this run (whose input row the window named, or the log read did).
    pub fn restore(&mut self, folded: RunDraft) {
        let input = self.input.take().or(folded.input);
        *self = RunDraft { input, ..folded };
    }

    /// One `draft` record's body, in log order. A `reset` body holds the whole draft (redacted anew after a value was
    /// marked sensitive) and replaces what the records before it held.
    pub fn apply(&mut self, body: &Value) {
        if body.get("reset") == Some(&Value::Bool(true)) {
            *self = RunDraft { input: self.input.take(), started: self.started, context_tokens: self.context_tokens, ..RunDraft::default() };
        }
        if let Some(tokens) = body.get("contextTokens").and_then(Value::as_u64) {
            self.context_tokens = Some(tokens);
        }
        let text = |key: &str| body.get(key).and_then(Value::as_str).filter(|text| !text.is_empty());
        if let Some(text) = text("text") {
            self.started = true;
            self.text.push_str(text);
        }
        if let Some(reasoning) = text("reasoning") {
            self.started = true;
            self.reasoning.push_str(reasoning);
        }
        for (key, list) in [("calls", &mut self.calls), ("results", &mut self.results)] {
            if let Some(added) = body.get(key).and_then(Value::as_array).filter(|added| !added.is_empty()) {
                self.started = true;
                list.extend(added.iter().cloned());
            }
        }
        if let Some(tools) = body.get("tools").and_then(Value::as_bool) {
            self.tools = tools;
            self.started |= tools;
        }
        if let Some(row) = body.get("sealed").filter(|row| row.is_object()) {
            self.started = true;
            self.sealed = Some(row.clone());
        }
    }

    /// The run's assistant message is a row now (`markAssistantMessageCommitted`): it holds the draft's message.
    pub fn message_committed(&mut self) {
        self.text.clear();
        self.reasoning.clear();
        self.calls.clear();
        self.sealed = None;
    }

    /// The bodies of the run's draft file, in order. A `committed` body names the assistant row that took the message so
    /// far: it ends the draft's message only when `landed` finds that row in the log (a row whose save never landed leaves
    /// its text to the draft).
    pub fn apply_file(&mut self, bodies: &[Value], landed: impl Fn(&str) -> bool) {
        for body in bodies {
            match body.get("committed").and_then(Value::as_str) {
                Some(iid) => {
                    if landed(iid) {
                        self.message_committed();
                    }
                }
                None => self.apply(body),
            }
        }
    }
}

/// A write of a run's draft file (`draft-<rid>.jsonl` beside the session's log, the 1.4.5 checkpoint's place).
#[derive(Clone, Debug, PartialEq)]
pub enum DraftWrite {
    /// One more body.
    Append { rid: String, body: Value },
    /// The whole draft as one body, replacing the file atomically (a value marked sensitive).
    Replace { rid: String, body: Value },
    /// The run ended durably, or its draft could not be redacted: the file goes.
    Remove { rid: String },
    /// At open: the drafts of runs not in `open` (ended, the file left by a kill before its removal) go.
    Sweep { open: Vec<String> },
}

/// The live run's draft as it streamed, and what of its text the log holds: each `draft` chunk is written redacted with
/// the thread's sensitive values (the 1.4.5 checkpoint journals `redactSettledText` of the streaming text and the redacted
/// calls and results), and a newly marked value rewrites the whole draft redacted (`commitHeader` on a new version).
#[derive(Default)]
pub struct DraftJournal {
    text: String,
    reasoning: String,
    calls: Vec<Value>,
    results: Vec<Value>,
    tools: Option<bool>,
    written_text: String,
    written_reasoning: String,
    /// The last request's context reading, not written yet: it goes with the next write.
    context: Option<u64>,
    /// Something of the draft is in its file.
    written: bool,
    /// The file is gone (a redaction that could not be written removed it): the next write is the whole draft.
    lost: bool,
}

impl DraftJournal {
    /// Something of the draft is in its file.
    pub fn written(&self) -> bool {
        self.written
    }

    /// The draft's file was removed: the next write starts it again whole.
    pub fn lost(&mut self) {
        self.lost = true;
        self.written = false;
    }

    /// A request's context reading, written with the draft's next chunk.
    pub fn context(&mut self, tokens: u64) {
        self.context = Some(tokens);
    }

    /// The reading still waiting goes into `out`, when `out` is written.
    fn with_context(&mut self, out: &mut serde_json::Map<String, Value>) {
        if let Some(tokens) = self.context.take() {
            out.insert("contextTokens".into(), Value::from(tokens));
        }
    }

    /// The run's assistant message is a row now: the draft's message is done.
    pub fn message_committed(&mut self) {
        self.text.clear();
        self.reasoning.clear();
        self.calls.clear();
        self.written_text.clear();
        self.written_reasoning.clear();
    }

    /// The body to write for the chunk `body` the run drafted, and whether it is the whole draft (it replaces the file);
    /// `None` when nothing of it can be written yet.
    pub fn chunk(&mut self, body: &Value, marks: &dyn super::seams::SensitiveMarks, thread: &ThreadId) -> Option<(Value, bool)> {
        let part = |key: &str| body.get(key).and_then(Value::as_str).unwrap_or_default();
        self.text.push_str(part("text"));
        self.reasoning.push_str(part("reasoning"));
        let calls = body.get("calls").and_then(Value::as_array).cloned().unwrap_or_default();
        let results = body.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
        self.calls.extend(calls.iter().cloned());
        self.results.extend(results.iter().cloned());
        if let Some(tools) = body.get("tools").and_then(Value::as_bool) {
            self.tools = Some(tools);
        }
        let text = marks.redact_settled(thread, &self.text);
        let reasoning = marks.redact_settled(thread, &self.reasoning);
        if self.lost || !text.starts_with(self.written_text.as_str()) || !reasoning.starts_with(self.written_reasoning.as_str()) {
            // What the file holds is no longer a prefix of the text as it is redacted now, or the file is gone: the whole
            // draft again, with the chunk's seal.
            let mut whole = self.reset(marks, thread);
            if let Some(row) = body.get("sealed") {
                whole["sealed"] = marks.redact_messages(thread, std::slice::from_ref(row)).into_iter().next().unwrap_or_default();
            }
            return Some((whole, true));
        }
        let mut out = serde_json::Map::new();
        for (key, settled, written) in [("text", text, &mut self.written_text), ("reasoning", reasoning, &mut self.written_reasoning)] {
            if settled.len() > written.len() {
                out.insert(key.into(), Value::String(settled[written.len()..].to_owned()));
            }
            *written = settled;
        }
        if !calls.is_empty() {
            out.insert("calls".into(), redact_calls(marks, thread, &calls));
        }
        if !results.is_empty() {
            out.insert("results".into(), Value::Array(marks.redact_messages(thread, &results)));
        }
        if let Some(tools) = body.get("tools") {
            out.insert("tools".into(), tools.clone());
        }
        if let Some(row) = body.get("sealed") {
            out.insert("sealed".into(), marks.redact_messages(thread, std::slice::from_ref(row)).into_iter().next().unwrap_or_default());
        }
        if out.is_empty() {
            return None;
        }
        self.with_context(&mut out);
        self.written = true;
        Some((Value::Object(out), false))
    }

    /// The whole draft, redacted with the thread's values as they are now; `None` for an empty draft.
    pub fn reset(&mut self, marks: &dyn super::seams::SensitiveMarks, thread: &ThreadId) -> Value {
        self.lost = false;
        self.written = true;
        self.written_text = marks.redact_settled(thread, &self.text);
        self.written_reasoning = marks.redact_settled(thread, &self.reasoning);
        let mut out = serde_json::Map::new();
        out.insert("reset".into(), Value::Bool(true));
        out.insert("text".into(), Value::String(self.written_text.clone()));
        out.insert("reasoning".into(), Value::String(self.written_reasoning.clone()));
        out.insert("calls".into(), redact_calls(marks, thread, &self.calls));
        out.insert("results".into(), Value::Array(marks.redact_messages(thread, &self.results)));
        if let Some(tools) = self.tools {
            out.insert("tools".into(), Value::Bool(tools));
        }
        self.with_context(&mut out);
        Value::Object(out)
    }

    /// Nothing drafted yet.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.reasoning.is_empty() && self.calls.is_empty() && self.results.is_empty() && self.tools.is_none()
    }
}

/// Tool calls as an assistant message stores them: their arguments redacted.
fn redact_calls(marks: &dyn super::seams::SensitiveMarks, thread: &ThreadId, calls: &[Value]) -> Value {
    let message = serde_json::json!({ "role": "assistant", "toolCalls": calls });
    marks.redact_messages(thread, &[message]).into_iter().next().and_then(|message| message.get("toolCalls").cloned()).unwrap_or(Value::Array(Vec::new()))
}
