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
    /// `lastContextTokens` at recovery (`restoreCheckpointContext`): absent, explicitly cleared, or measured.
    pub context_tokens: Option<Option<u64>>,
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
        match body.get("contextTokens") {
            Some(Value::Null) => self.context_tokens = Some(None),
            Some(value) => {
                if let Some(tokens) = value.as_u64() {
                    self.context_tokens = Some(Some(tokens));
                }
            }
            None => {}
        }
        // Before the body's own results: a call run again takes back what its first run told, then tells its result.
        for call in withdrawn(body) {
            self.results.retain(|result| result_call(result) != Some(call));
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
    /// its text to the draft). A result whose call `answered` finds a row of in the log is the log's and leaves the draft:
    /// a call's id is its alone in its session (`mixdog_agent::repair::ToolCallIds`), so the row in the log is the one
    /// fact that says so, nothing else has to reach the disk for it, and a kill at any point leaves each result in the
    /// log or in the draft.
    pub fn apply_file(&mut self, bodies: &[Value], landed: impl Fn(&str) -> bool, answered: impl Fn(&str) -> bool) {
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
        self.results.retain(|result| !result_call(result).is_some_and(&answered));
    }
}

/// The call a drafted result answers.
fn result_call(result: &Value) -> Option<&str> {
    result.get("toolCallId").and_then(Value::as_str)
}

/// The calls a draft body takes the drafted result back of (`withdrawn`): each was run again, and the result its first
/// run told is not the call's.
fn withdrawn(body: &Value) -> impl Iterator<Item = &str> {
    body.get("withdrawn").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
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
    /// Kept after appending so a full rewrite of the file still carries the reading (including a clear).
    context: Option<Option<u64>>,
    context_pending: bool,
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

    /// The draft's first body, written as the run starts (Node's checkpoint header, written before the provider runs): it holds
    /// nothing of the response yet, and makes the file exist.
    pub fn open(&mut self) -> Value {
        self.written = true;
        serde_json::json!({ "open": true })
    }

    /// The draft's file was removed: the next write starts it again whole.
    pub fn lost(&mut self) {
        self.lost = true;
        self.written = false;
    }

    /// A request's context reading, written with the draft's next chunk.
    pub fn context(&mut self, tokens: Option<u64>) {
        self.context = Some(tokens);
        self.context_pending = true;
    }

    fn with_context(&mut self, out: &mut serde_json::Map<String, Value>, whole: bool) {
        if (whole || self.context_pending)
            && let Some(tokens) = self.context
        {
            out.insert("contextTokens".into(), serde_json::json!(tokens));
            self.context_pending = false;
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

    /// Whether the draft holds a result of the call `call`.
    pub fn holds_result(&self, call: &str) -> bool {
        self.results.iter().any(|result| result_call(result) == Some(call))
    }

    /// The row of the call `call` is on disk (its write was acknowledged): the draft holds that call's result no longer.
    /// Not before: a row accepted and not yet written can still fail, and a rewrite of the file meanwhile would leave the
    /// result in neither place. Kept past that, every result of a turn stayed here until the turn ended. The file is not
    /// written for it: that row in the log is what a later read goes by ([`RunDraft::apply_file`]).
    pub fn result_landed(&mut self, call: &str) {
        self.results.retain(|result| result_call(result) != Some(call));
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
        for call in withdrawn(body) {
            self.results.retain(|result| result_call(result) != Some(call));
        }
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
                whole["sealed"] = marks.redacted(thread, std::slice::from_ref(row)).into_iter().next().unwrap_or_default();
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
        if let Some(calls) = body.get("withdrawn").filter(|calls| calls.as_array().is_some_and(|calls| !calls.is_empty())) {
            out.insert("withdrawn".into(), calls.clone());
        }
        if !results.is_empty() {
            out.insert("results".into(), Value::Array(marks.redacted(thread, &results)));
        }
        if let Some(tools) = body.get("tools") {
            out.insert("tools".into(), tools.clone());
        }
        if let Some(row) = body.get("sealed") {
            out.insert("sealed".into(), marks.redacted(thread, std::slice::from_ref(row)).into_iter().next().unwrap_or_default());
        }
        self.with_context(&mut out, false);
        if out.is_empty() {
            return None;
        }
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
        out.insert("results".into(), Value::Array(marks.redacted(thread, &self.results)));
        if let Some(tools) = self.tools {
            out.insert("tools".into(), Value::Bool(tools));
        }
        self.with_context(&mut out, true);
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
    marks.redacted(thread, &[message]).into_iter().next().and_then(|message| message.get("toolCalls").cloned()).unwrap_or(Value::Array(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recovery_keeps_an_explicit_context_clear_through_a_draft_rewrite() {
        let marks = super::super::store::SensitiveMarksOf::new(std::sync::Arc::new(mixdog_services::memory::sensitive::SensitiveStore::default()));
        let thread = ThreadId::from("draft-context-test");
        let mut journal = DraftJournal::default();
        let mut draft = RunDraft::default();
        for (tokens, expected) in [(Some(8000), json!(8000)), (Some(0), json!(0)), (None, Value::Null)] {
            journal.context(tokens);
            let (append, whole) = journal.chunk(&json!({}), &marks, &thread).unwrap();
            assert!(!whole);
            assert_eq!(append.get("contextTokens"), Some(&expected));
            draft.apply_file(&[append, json!({ "text": "continued" })], |_| false, |_| false);
            assert_eq!(draft.context_tokens, Some(tokens));
        }
        let mut recovered = RunDraft::default();
        recovered.apply_file(&[journal.reset(&marks, &thread)], |_| false, |_| false);
        assert_eq!(recovered.context_tokens, Some(None));
    }

    #[test]
    fn a_result_that_became_a_row_leaves_the_draft_and_one_still_waiting_stays() {
        let marks = super::super::store::SensitiveMarksOf::new(std::sync::Arc::new(mixdog_services::memory::sensitive::SensitiveStore::default()));
        let thread = ThreadId::from("draft-results-test");
        let mut journal = DraftJournal::default();
        let result = |call: &str| json!({ "role": "tool", "toolCallId": call, "content": format!("result of {call}") });
        for call in ["c1", "c2", "c3"] {
            let (append, whole) = journal.chunk(&json!({ "results": [result(call)] }), &marks, &thread).unwrap();
            assert_eq!((append["results"].clone(), whole), (json!([result(call)]), false));
        }
        assert!(journal.holds_result("c1") && !journal.holds_result("unknown"));
        journal.result_landed("c1");
        journal.result_landed("c3");
        journal.result_landed("unknown");
        assert!(!journal.holds_result("c1"));
        assert_eq!(journal.reset(&marks, &thread)["results"], json!([result("c2")]), "the whole draft holds the results no row holds yet");
        journal.result_landed("c2");
        assert_eq!(journal.reset(&marks, &thread)["results"], json!([]));
    }

    /// What a kill leaves is read by each result's call. A result whose call has a row in the log is the log's, at
    /// whatever point of that row's landing the kill came; one whose call has none is what the draft is for. A draft
    /// file an earlier build wrote names a row beside each result, which is not read.
    #[test]
    fn a_result_read_back_from_the_file_is_the_logs_exactly_when_its_calls_row_is_there() {
        let result = |call: &str| json!({ "role": "tool", "toolCallId": call, "content": format!("result of {call}") });
        let read = |bodies: &[Value], answered: &[&str]| {
            let mut draft = RunDraft::default();
            draft.apply_file(bodies, |_| false, |call| answered.contains(&call));
            draft.results
        };
        let (a, b) = (json!({ "results": [result("a")] }), json!({ "results": [result("b")] }));
        assert_eq!(read(&[a.clone()], &["a"]), Vec::<Value>::new(), "a's row landed: nothing is left to recover");
        assert_eq!(read(&[a.clone()], &[]), [result("a")], "a's row never landed");
        assert_eq!(read(&[a.clone(), b.clone()], &["a"]), [result("b")]);
        assert_eq!(read(&[a.clone(), b.clone()], &["a", "b"]), Vec::<Value>::new());
        assert_eq!(read(&[a, b], &[]), [result("a"), result("b")]);
        let whole = json!({ "reset": true, "results": [result("a"), result("b")], "resultRows": [null, "r-b"] });
        assert_eq!(read(&[whole, json!({ "results": [result("c")] })], &["b"]), [result("a"), result("c")]);
    }

    /// A call run again takes back the result its first run drafted and drafts its own: the journal, a whole rewrite of
    /// it and the file read back all hold the last execution's result alone, or none between the two.
    #[test]
    fn a_withdrawn_result_leaves_the_draft_and_the_result_of_the_calls_last_run_takes_its_place() {
        let marks = super::super::store::SensitiveMarksOf::new(std::sync::Arc::new(mixdog_services::memory::sensitive::SensitiveStore::default()));
        let thread = ThreadId::from("draft-withdrawn-test");
        let result = |call: &str, content: &str| json!({ "role": "tool", "toolCallId": call, "content": content });
        let read = |bodies: &[Value]| {
            let mut draft = RunDraft::default();
            draft.apply_file(bodies, |_| false, |_| false);
            draft.results
        };
        let mut journal = DraftJournal::default();
        let mut file = Vec::new();
        let mut write = |journal: &mut DraftJournal, body: Value| {
            let (written, whole) = journal.chunk(&body, &marks, &thread).expect("a body to write");
            assert!(!whole);
            file.push(written);
            read(&file)
        };
        let kept = write(&mut journal, json!({ "results": [result("r", "before the edit"), result("other", "kept")] }));
        assert_eq!(kept.len(), 2);
        assert_eq!(write(&mut journal, json!({ "withdrawn": ["r"] })), [result("other", "kept")], "between the two runs the call has no result");
        assert_eq!(journal.reset(&marks, &thread)["results"], json!([result("other", "kept")]));
        let last = write(&mut journal, json!({ "results": [result("r", "after the edit")] }));
        assert_eq!(last, [result("other", "kept"), result("r", "after the edit")]);
        assert_eq!(journal.reset(&marks, &thread)["results"], json!(last));
        // One body may hold both: the result follows the withdrawal.
        assert_eq!(read(&[json!({ "results": [result("r", "one")] }), json!({ "withdrawn": ["r"], "results": [result("r", "two")] })]), [result("r", "two")]);
    }
}
