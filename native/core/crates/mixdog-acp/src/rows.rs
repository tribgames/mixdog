//! The agent's work as the rows Mixdog stores: an assistant row carries the text shown before a
//! tool call and the call itself, a tool row its result and its diff.

use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::ToolKind;
use mixdog_agent::message_row::row_of;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_review::turn_review::line_diff::LineDiffBudget;
use mixdog_core_review::turn_review::line_diff::LineDiffer;
use mixdog_core_review::turn_review::line_diff::unified_hunks_body;
use mixdog_core_session::session::ItemCommit;
use mixdog_protocol::ItemId;
use mixdog_tools::policy::GrantKey;
use serde_json::Value;
use serde_json::json;

/// One tool call of the agent as its `tool_call` and `tool_call_update` messages describe it so far.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentTool {
    pub id: String,
    /// The agent's own name of the tool it calls, where it gives one.
    pub tool: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub input: Value,
    pub output: Option<Value>,
    pub content: Vec<Value>,
    /// The files the agent says the call touches, in its order.
    pub locations: Vec<String>,
}

impl AgentTool {
    /// Folds a `tool_call`, a `tool_call_update` or a permission request's `toolCall` into the call: a field the
    /// message leaves out stays as it was.
    pub fn merge(&mut self, update: &Value) {
        let text = |key: &str| update.get(key).and_then(Value::as_str).map(str::to_owned);
        if let Some(tool) = text("name") {
            self.tool = tool;
        }
        if let Some(title) = text("title") {
            self.title = title;
        }
        if let Some(kind) = text("kind") {
            self.kind = kind;
        }
        if let Some(status) = text("status") {
            self.status = status;
        }
        if let Some(input) = update.get("rawInput").filter(|input| !input.is_null()) {
            self.input = input.clone();
        }
        if let Some(output) = update.get("rawOutput").filter(|output| !output.is_null()) {
            self.output = Some(output.clone());
        }
        if let Some(content) = update.get("content").and_then(Value::as_array) {
            self.content.clone_from(content);
        }
        if let Some(locations) = update.get("locations").and_then(Value::as_array) {
            self.locations = locations.iter().filter_map(|location| location.get("path").and_then(Value::as_str).map(str::to_owned)).collect();
        }
    }

    /// The call as calls of the Mixdog tool that does the same kind of work (`read`, `edit`, `shell`), for the session's
    /// permissions to judge: that tool's name, and its arguments for each file the call touches or for the command
    /// line it runs. `None` for a kind Mixdog has no such tool for, and for a call that names no file or no command
    /// line: there is nothing to judge it on.
    pub fn as_session_call(&self) -> Option<(&'static str, Vec<Value>)> {
        let files = || Some(self.files().into_iter().map(|file| json!({ "file_path": file })).collect::<Vec<_>>()).filter(|files| !files.is_empty());
        match self.kind.as_str() {
            "read" => Some(("read", files()?)),
            "edit" => Some(("edit", files()?)),
            "execute" => Some(("shell", vec![json!({ "command": self.input_text(&["command", "CommandLine", "cmd"])? })])),
            _ => None,
        }
    }

    fn input_text(&self, keys: &[&str]) -> Option<String> {
        keys.iter().find_map(|key| self.input.get(*key).and_then(Value::as_str)).filter(|text| !text.is_empty()).map(str::to_owned)
    }

    /// The files the call touches: the ones the agent lists, then the one its input names.
    fn files(&self) -> Vec<String> {
        let mut files = self.locations.clone();
        if let Some(file) = self.input_text(&["file_path", "path", "Path", "AbsolutePath", "TargetFile"])
            && !files.contains(&file)
        {
            files.push(file);
        }
        files
    }

    /// The card the call is shown as: the Mixdog tool that does the same work (`read`, `shell`, `grep`) with that tool's
    /// arguments, so the transcript shows it as that tool's card; any other call is shown as the agent's own
    /// ([`Self::name`], [`Self::arguments`]). A call that names no file, command or pattern is shown as the agent's.
    pub fn card(&self, agent: &str) -> (String, Value) {
        let mixdog = match self.kind.as_str() {
            "read" => match self.files().as_slice() {
                [] => None,
                [file] => Some(("read", json!({ "file_path": file }))),
                files => Some(("read", json!({ "file_path": files }))),
            },
            "execute" => self.input_text(&["command", "CommandLine", "cmd"]).map(|command| ("shell", json!({ "command": command }))),
            "search" => self.input_text(&["pattern", "Pattern", "query", "Query", "regex"]).map(|pattern| {
                let mut arguments = json!({ "pattern": pattern });
                if let Some(path) = self.files().into_iter().next() {
                    arguments["path"] = json!(path);
                }
                ("grep", arguments)
            }),
            _ => None,
        };
        match mixdog {
            Some((name, arguments)) => (name.to_owned(), arguments),
            None => (self.name(agent), self.arguments()),
        }
    }

    pub fn ended(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed")
    }

    /// The card's tool name: the agent's kind of the call, after the agent's id so it is never read as a Mixdog tool.
    /// The row can later be sent to any provider, so the name keeps to what every provider takes as a tool's name:
    /// letters, digits, `_` and `-`, at most 64 of them.
    pub fn name(&self, agent: &str) -> String {
        let name = format!("{agent}_{}", if self.kind.is_empty() { "tool" } else { &self.kind });
        name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).take(64).collect()
    }

    /// What an approval of this call for the rest of the session is remembered under, by the policy's own key of an
    /// action: the tool the agent names, as Mixdog remembers a tool of its own, so the approval covers that tool's
    /// later calls and no other tool's. `None` for what the policy never remembers (a deletion) and for a call whose
    /// tool the agent does not name: each such call is asked about.
    pub fn grant_key(&self, agent: &str) -> Option<GrantKey> {
        let key = if self.kind == "delete" {
            GrantKey::Kind(ActionKind::Delete)
        } else {
            GrantKey::tool(&format!("{agent}:{}", self.tool)).filter(|_| !self.tool.is_empty())?
        };
        key.rememberable().then_some(key)
    }

    /// The card's arguments: the call's input, with the agent's title of it.
    pub fn arguments(&self) -> Value {
        let mut arguments = match &self.input {
            Value::Object(input) => input.clone(),
            Value::Null => serde_json::Map::new(),
            other => std::iter::once(("input".to_owned(), other.clone())).collect(),
        };
        if !self.title.is_empty() && !arguments.contains_key("title") {
            arguments.insert("title".into(), json!(self.title));
        }
        Value::Object(arguments)
    }

    /// [`Self::card`] for the item that shows this call's result in a later turn than the call: the card's own
    /// arguments, and `resultOf`, the id the call has in the turn that made it.
    pub fn late_card(&self, agent: &str, earlier: &str) -> (String, Value) {
        let (name, mut arguments) = self.card(agent);
        arguments["resultOf"] = json!(earlier);
        (name, arguments)
    }

    /// The text of the result: the call's text content, else its raw output, else its title.
    pub fn result_text(&self) -> String {
        let texts: Vec<&str> = self
            .content
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("content"))
            .filter_map(|block| block.pointer("/content/text")?.as_str())
            .collect();
        if !texts.is_empty() {
            return texts.join("\n");
        }
        match &self.output {
            Some(Value::String(output)) => output.clone(),
            Some(output) => output.to_string(),
            None if self.status == "failed" => format!("{} failed", self.label()),
            None => self.label().to_owned(),
        }
    }

    fn label(&self) -> &str {
        if self.title.is_empty() { "The tool call" } else { &self.title }
    }

    /// The card's diff: every `diff` block of the call as one patch.
    pub fn diff(&self, differ: &LineDiffer) -> Option<String> {
        let mut patch = String::new();
        for block in self.content.iter().filter(|block| block.get("type").and_then(Value::as_str) == Some("diff")) {
            let path = block.get("path").and_then(Value::as_str).unwrap_or("unknown file").replace('\\', "/");
            let old = block.get("oldText").and_then(Value::as_str);
            let new = block.get("newText").and_then(Value::as_str).unwrap_or_default();
            let hunks = differ.hunks(old.unwrap_or_default(), new, &mut LineDiffBudget::default(), [None, None]);
            let old_header = if old.is_some() { format!("a/{path}") } else { "/dev/null".to_owned() };
            patch.push_str(&format!("diff --git a/{path} b/{path}\n"));
            if old.is_none() {
                patch.push_str("new file mode 100644\n");
            }
            patch.push_str(&unified_hunks_body(&old_header, &format!("b/{path}"), &hunks.hunks));
        }
        (!patch.is_empty()).then_some(patch)
    }
}

fn commit(iid: ItemId, role: &str, body: Value) -> ItemCommit {
    ItemCommit { iid, role: Some(role.to_owned()), model: true, visible: true, body, prompt: None }
}

/// The assistant row of `text` and the calls it made.
pub fn assistant(iid: ItemId, text: &str, calls: Vec<(String, String, Value)>) -> ItemCommit {
    let calls = calls.into_iter().map(|(id, name, arguments)| ToolCall { id, name, arguments, native_type: None }).collect();
    commit(iid, "assistant", row_of(&AgentMessage::assistant(text, calls)))
}

/// The tool row that ends the call `call`.
pub fn tool_result(iid: ItemId, call: &str, text: String, failed: bool, diff: Option<String>) -> ItemCommit {
    let mut message = AgentMessage::tool_text(call, text, if failed { ToolKind::Error } else { ToolKind::Normal });
    message.ui_diff = diff;
    commit(iid, "tool", row_of(&message))
}

/// The tool row of a call Mixdog's own pipeline ran: the loop's tool message as it is, with its card diff and timing.
pub fn tool_message(iid: ItemId, message: &AgentMessage) -> ItemCommit {
    commit(iid, "tool", row_of(message))
}

/// The agent's plan as Mixdog's own step list: the arguments of a `todo` call and the text of its result.
pub fn plan(update: &Value) -> (Value, String) {
    let entries: Vec<(String, &str)> = update
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let content = entry.get("content").and_then(Value::as_str)?.to_owned();
            let status = match entry.get("status").and_then(Value::as_str) {
                Some("in_progress") => "in_progress",
                Some("completed") => "completed",
                _ => "pending",
            };
            Some((content, status))
        })
        .collect();
    let items: Vec<Value> = entries.iter().map(|(content, status)| json!({ "content": content, "status": status })).collect();
    let text = entries
        .iter()
        .map(|(content, status)| {
            let mark = match *status {
                "completed" => "[x]",
                "in_progress" => "[>]",
                _ => "[ ]",
            };
            format!("{mark} {content}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    (json!({ "op": "set", "items": items }), text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(kind: &str, input: Value, locations: &[&str]) -> AgentTool {
        AgentTool { kind: kind.into(), input, locations: locations.iter().map(|path| (*path).to_owned()).collect(), ..AgentTool::default() }
    }

    #[test]
    fn the_agents_read_command_and_search_are_shown_as_mixdogs_cards() {
        let read = call("read", json!({ "Path": "/w/a.txt" }), &["/w/a.txt"]);
        assert_eq!(read.card("antigravity"), ("read".to_owned(), json!({ "file_path": "/w/a.txt" })));
        let several = call("read", Value::Null, &["/w/a.txt", "/w/b.txt"]);
        assert_eq!(several.card("antigravity"), ("read".to_owned(), json!({ "file_path": ["/w/a.txt", "/w/b.txt"] })));
        let shell = call("execute", json!({ "CommandLine": "echo hi" }), &[]);
        assert_eq!(shell.card("antigravity"), ("shell".to_owned(), json!({ "command": "echo hi" })));
        let search = call("search", json!({ "Query": "needle" }), &["/w/src"]);
        assert_eq!(search.card("antigravity"), ("grep".to_owned(), json!({ "pattern": "needle", "path": "/w/src" })));
    }

    #[test]
    fn a_call_with_no_mixdog_equivalent_or_no_target_stays_the_agents_own_card() {
        for tool in [
            call("edit", json!({ "Path": "/w/a.txt" }), &["/w/a.txt"]),
            call("read", Value::Null, &[]),
            call("execute", json!({}), &[]),
            call("search", json!({}), &[]),
        ] {
            assert_eq!(tool.card("antigravity"), (tool.name("antigravity"), tool.arguments()), "{tool:?}");
        }
        let late = call("read", Value::Null, &["/w/a.txt"]).late_card("antigravity", "turn-1.t1");
        assert_eq!(late, ("read".to_owned(), json!({ "file_path": "/w/a.txt", "resultOf": "turn-1.t1" })));
    }
}
