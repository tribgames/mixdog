//! An open run's draft (`draft` records): what its interrupted response produced that no row holds yet, the 1.4.5
//! turn checkpoint's interruption snapshot (`turn-interruption.mjs` `snapshot()`). A run writes it while it streams;
//! recovery at open commits it, finalized as Node's restart recovery finalizes a checkpoint (`replayCheckpoint`).

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
}

impl RunDraft {
    /// The draft `folded` over the whole log, onto this run (whose input row the window named).
    pub fn restore(&mut self, folded: RunDraft) {
        let input = self.input.take();
        *self = RunDraft { input, ..folded };
    }

    /// One `draft` record's body, in log order.
    pub fn apply(&mut self, body: &Value) {
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
    }

    /// The run's assistant message is a row now (`markAssistantMessageCommitted`): it holds the draft's message.
    pub fn message_committed(&mut self) {
        self.text.clear();
        self.reasoning.clear();
        self.calls.clear();
    }
}
