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

use crate::runs::KeptImage;

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
    /// The files the agent says the call touches, in its order, each with the line it names.
    pub locations: Vec<(String, Option<u64>)>,
}

/// What the agent's content block `block` shows as text: its text, a resource's text, else a line that names what it
/// is. `None` for a picture, which is kept and shown as one ([`picture`]), and for a kind the protocol does not have.
pub fn block_text(block: &Value) -> Option<String> {
    let field = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
    // A `data:` URI is the payload itself, not a place.
    let uri = |value: &Value| field(value, "uri").filter(|uri| !uri.to_ascii_lowercase().starts_with("data:"));
    let named = |what: &str, mime: Option<String>, uri: Option<String>| {
        let mime = mime.map(|mime| format!(" ({mime})")).unwrap_or_default();
        format!("[{what}{mime}{}]", uri.map(|uri| format!(": {uri}")).unwrap_or_default())
    };
    match block.get("type").and_then(Value::as_str)? {
        "text" => block.get("text").and_then(Value::as_str).map(str::to_owned),
        "resource_link" => {
            let label = field(block, "title").or_else(|| field(block, "name")).unwrap_or_else(|| "resource".to_owned());
            let label = field(block, "description").map_or_else(|| label.clone(), |description| format!("{label}: {description}"));
            Some(uri(block).map_or_else(|| label.clone(), |uri| format!("{label}\n{uri}")))
        }
        "resource" => {
            let resource = block.get("resource").unwrap_or(&Value::Null);
            let text = resource.get("text").and_then(Value::as_str).map(str::to_owned);
            Some(text.unwrap_or_else(|| named("binary resource", field(resource, "mimeType"), uri(resource))))
        }
        "audio" => Some(named("audio", field(block, "mimeType"), None)),
        _ => None,
    }
}

/// A picture the agent showed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Picture {
    /// Its bytes in base64, and their type.
    Inline { data: String, mime: String },
    /// The file the agent says it saved the picture in.
    File(String),
}

/// Textual fallback for an `image` content block when the picture cannot be stored as a media asset (never raw base64).
pub fn image_fallback_text(block: &Value) -> Option<String> {
    if block.get("type").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let field = |key: &str| block.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
    let mime = field("mimeType").map(|mime| format!(" ({mime})")).unwrap_or_default();
    let uri = field("uri").filter(|uri| !uri.to_ascii_lowercase().starts_with("data:"));
    Some(format!("[image{mime}{}]", uri.map(|uri| format!(": {uri}")).unwrap_or_default()))
}

/// The picture the agent's content block `block` holds.
pub fn picture(block: &Value) -> Option<Picture> {
    if block.get("type").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let text = |key: &str| block.get(key).and_then(Value::as_str).filter(|text| !text.trim().is_empty()).map(str::to_owned);
    if let Some(data) = text("data") {
        return Some(Picture::Inline { data, mime: text("mimeType").unwrap_or_else(|| "image/png".to_owned()) });
    }
    text("uri").filter(|uri| !uri.to_ascii_lowercase().starts_with("data:")).map(Picture::File)
}

/// What the agy CLI answers a call of its image generation with, the file's path between the two.
const SAVED_PICTURE: (&str, &str) = ("Generated image is saved at ", ".");

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
            self.locations = locations
                .iter()
                .filter_map(|location| Some((location.get("path")?.as_str()?.to_owned(), location.get("line").and_then(Value::as_u64))))
                .collect();
        }
    }

    /// Whether this call is Antigravity's `generate_image` tool (either named directly, titled `"Run generate_image?"` /
    /// `"Running generate_image"` under kind `other` with `name` absent, or carrying `{imageName, imagePath}` output).
    pub fn is_generate_image(&self) -> bool {
        if self.tool == "generate_image" {
            return true;
        }
        if self.tool.is_empty() && (self.kind.is_empty() || self.kind == "other") {
            let title = self.title.trim().to_ascii_lowercase();
            if matches!(title.as_str(), "run generate_image?" | "running generate_image" | "generate_image") {
                return true;
            }
        }
        self.output.as_ref().is_some_and(|output| {
            output.get("imagePath").and_then(Value::as_str).is_some_and(|p| !p.trim().is_empty())
                && output.get("imageName").and_then(Value::as_str).is_some_and(|n| !n.trim().is_empty())
        })
    }

    /// The pictures the call's result shows: its image blocks, else the file the agy CLI says it saved one in or
    /// `rawOutput.imagePath`.
    pub fn pictures(&self) -> Vec<Picture> {
        let mut found: Vec<Picture> = self
            .content
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("content") {
                    picture(block.get("content")?)
                } else {
                    picture(block)
                }
            })
            .collect();
        if found.is_empty() {
            let (before, after) = SAVED_PICTURE;
            let find_saved = |text: &str| {
                text.lines().find_map(|line| {
                    let rest = line.split_once(before)?.1.trim();
                    let path = rest.strip_suffix(after).unwrap_or(rest).trim();
                    (!path.is_empty()).then(|| path.to_owned())
                })
            };
            let saved = find_saved(&self.result_text()).or_else(|| self.output.as_ref().and_then(Value::as_str).and_then(find_saved));
            found.extend(saved.map(Picture::File));
        }
        if found.is_empty()
            && let Some(path) = self.output.as_ref().and_then(|o| o.get("imagePath")).and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty())
        {
            found.push(Picture::File(path.to_owned()));
        }
        found
    }

    /// Takes the bytes of the pictures out of the call's content once they are kept: a picture block keeps its type and
    /// its place, so nothing of it is held again.
    pub fn drop_pictures(&mut self) {
        for block in &mut self.content {
            if let Some(content) = block.get_mut("content").and_then(Value::as_object_mut)
                && content.get("type").and_then(Value::as_str) == Some("image")
            {
                content.remove("data");
            } else if let Some(obj) = block.as_object_mut()
                && obj.get("type").and_then(Value::as_str) == Some("image")
            {
                obj.remove("data");
            }
        }
    }

    /// What the call's pictures were made from and the aspect asked for, where its input or its output says.
    pub fn picture_request(&self) -> (String, Option<String>) {
        let text = |keys: &[&str]| {
            [self.output.as_ref(), Some(&self.input)]
                .into_iter()
                .flatten()
                .find_map(|value| keys.iter().find_map(|key| value.get(*key).and_then(Value::as_str)).filter(|text| !text.trim().is_empty()))
                .map(str::to_owned)
        };
        (text(&["prompt", "Prompt"]).unwrap_or_default(), text(&["aspectRatio", "AspectRatio", "aspect"]))
    }
}

/// The tool result JSON string for a kept picture, matching Mixdog's `media` tool output so the transcript renders an
/// image card.
pub fn picture_result(kept: &KeptImage, prompt: &str, (lane, model): (&str, &str)) -> String {
    let mut result = json!({ "ok": true, "status": "done", "kind": "image", "assetId": kept.asset_id, "lane": lane, "model": model, "prompt": prompt });
    if let Some(path) = &kept.path {
        result["output"] = json!(path);
    }
    result.to_string()
}

/// The card a kept picture is shown as: a call of Mixdog's `media` tool that generated it, and its result, which names
/// the kept asset as that tool's result does.
pub fn picture_card(kept: &KeptImage, prompt: &str, aspect: Option<&str>, (lane, model): (&str, &str)) -> (String, Value, String) {
    let mut arguments = json!({ "action": "generate", "kind": "image", "prompt": prompt });
    if let Some(aspect) = aspect {
        arguments["aspect"] = json!(aspect);
    }
    ("media".to_owned(), arguments, picture_result(kept, prompt, (lane, model)))
}

impl AgentTool {

    /// The call as calls of the Mixdog tool that does the same kind of work (`read`, `edit`, `shell`), for the session's
    /// permissions to judge: that tool's name, and its arguments for each file the call touches or for the command
    /// line it runs. `None` for a kind Mixdog has no such tool for, and for a call that names no file or no command
    /// line: there is nothing to judge it on.
    pub fn as_session_call(&self) -> Option<(&'static str, Vec<Value>)> {
        let files = || Some(self.files().into_iter().map(|(file, _)| json!({ "file_path": file })).collect::<Vec<_>>()).filter(|files| !files.is_empty());
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

    /// The files the call touches, each with the line the agent names: the ones the agent lists, then the one its input
    /// names.
    fn files(&self) -> Vec<(String, Option<u64>)> {
        let mut files = self.locations.clone();
        if let Some(file) = self.input_text(&["file_path", "path", "Path", "AbsolutePath", "TargetFile"])
            && !files.iter().any(|(listed, _)| *listed == file)
        {
            files.push((file, None));
        }
        files
    }

    /// The card the call is shown as: the Mixdog tool that does the same work (`read`, `shell`, `grep`, `media`) with
    /// that tool's arguments, so the transcript shows it as that tool's card; any other call is shown as the agent's own
    /// ([`Self::name`], [`Self::arguments`]). A call that names no file, command or pattern is shown as the agent's.
    pub fn card(&self, agent: &str) -> (String, Value) {
        if self.is_generate_image() {
            let (prompt, aspect) = self.picture_request();
            let mut arguments = json!({ "action": "generate", "kind": "image", "prompt": prompt });
            if let Some(aspect) = aspect {
                arguments["aspect"] = json!(aspect);
            }
            return ("media".to_owned(), arguments);
        }
        // A line the agent names is where the read starts: `read`'s 1-based `offset`.
        let read = |(file, line): &(String, Option<u64>)| match line.filter(|line| *line > 0) {
            Some(line) => json!({ "file_path": file, "offset": line }),
            None => json!({ "file_path": file }),
        };
        let mixdog = match self.kind.as_str() {
            "read" => match self.files().as_slice() {
                [] => None,
                [file] => Some(("read", read(file))),
                files => Some((
                    "read",
                    json!({ "file_path": files.iter().map(|file| if file.1.is_some_and(|line| line > 0) { read(file) } else { json!(file.0) }).collect::<Vec<_>>() }),
                )),
            },
            "execute" => self.input_text(&["command", "CommandLine", "cmd"]).map(|command| ("shell", json!({ "command": command }))),
            "search" => self.input_text(&["pattern", "Pattern", "query", "Query", "regex"]).map(|pattern| {
                let mut arguments = json!({ "pattern": pattern });
                if let Some((path, _)) = self.files().into_iter().next() {
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
        if self.is_generate_image() {
            return "media".to_owned();
        }
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
        } else if self.is_generate_image() {
            GrantKey::tool(&format!("{agent}:generate_image"))?
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

    /// The text of the result: what the call's content shows as text ([`block_text`]), else its raw output, else its
    /// title.
    pub fn result_text(&self) -> String {
        let texts: Vec<String> = self
            .content
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("content"))
            .filter_map(|block| block_text(block.get("content")?))
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
        AgentTool { kind: kind.into(), input, locations: locations.iter().map(|path| ((*path).to_owned(), None)).collect(), ..AgentTool::default() }
    }

    /// The line a location names is where the read card starts.
    #[test]
    fn the_line_a_location_names_is_where_the_read_card_starts() {
        let mut read = AgentTool::default();
        read.merge(&json!({ "kind": "read", "locations": [{ "path": "/w/a.txt", "line": 40 }] }));
        assert_eq!(read.card("antigravity"), ("read".to_owned(), json!({ "file_path": "/w/a.txt", "offset": 40 })));
        read.merge(&json!({ "locations": [{ "path": "/w/a.txt", "line": 40 }, { "path": "/w/b.txt" }] }));
        assert_eq!(read.card("antigravity"), ("read".to_owned(), json!({ "file_path": [{ "file_path": "/w/a.txt", "offset": 40 }, "/w/b.txt"] })));
    }

    /// What the agent sends besides text is shown as text where it has some, named where it has none, and a picture is
    /// left to be kept and shown as one: the result's text never holds its bytes.
    #[test]
    fn content_besides_text_reaches_the_result_and_a_picture_is_found_and_not_written_as_text() {
        let blocks = [
            json!({ "type": "content", "content": { "type": "resource_link", "name": "spec.md", "uri": "file:///w/spec.md" } }),
            json!({ "type": "content", "content": { "type": "resource", "resource": { "uri": "file:///w/a.txt", "text": "inline text" } } }),
            json!({ "type": "content", "content": { "type": "resource", "resource": { "uri": "file:///w/a.bin", "mimeType": "application/zip", "blob": "UEs=" } } }),
            json!({ "type": "content", "content": { "type": "audio", "mimeType": "audio/wav", "data": "UklG" } }),
            json!({ "type": "content", "content": { "type": "image", "mimeType": "image/png", "data": "aW1n", "uri": "file:///w/i.png" } }),
        ];
        let tool = AgentTool { content: blocks.to_vec(), ..AgentTool::default() };
        assert_eq!(tool.result_text(), "spec.md\nfile:///w/spec.md\ninline text\n[binary resource (application/zip): file:///w/a.bin]\n[audio (audio/wav)]");
        assert_eq!(tool.pictures(), [Picture::Inline { data: "aW1n".into(), mime: "image/png".into() }]);
        // The agy CLI names the file it saved its picture in.
        let saved = AgentTool { output: Some(json!("Generated image is saved at C:\\w\\cat.png.")), ..AgentTool::default() };
        assert_eq!(saved.pictures(), [Picture::File("C:\\w\\cat.png".into())]);
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

    #[test]
    fn generate_image_official_and_cli_shapes_map_to_media_card_without_retaining_base64() {
        let mut tool = AgentTool { id: "g1".into(), ..AgentTool::default() };
        tool.merge(&json!({ "title": "Run generate_image?", "kind": "other", "status": "pending", "rawInput": { "Prompt": "a red fox" } }));
        assert!(tool.is_generate_image());
        assert_eq!(tool.card("antigravity"), ("media".to_owned(), json!({ "action": "generate", "kind": "image", "prompt": "a red fox" })));
        let key = tool.grant_key("antigravity");
        assert!(key.is_some());

        tool.merge(&json!({ "title": "Running generate_image", "kind": "other", "status": "in_progress" }));
        assert_eq!(tool.grant_key("antigravity"), key, "card identity stays stable across permission and running updates");

        tool.merge(&json!({
            "status": "completed",
            "rawOutput": { "imageName": "fox.png", "imagePath": "/home/antigravity-acp/brain/c1/fox.png", "prompt": "a red fox", "aspectRatio": "16:9" },
            "content": [{ "type": "content", "content": { "type": "image", "data": "aW1n", "mimeType": "image/png", "uri": "file:///home/antigravity-acp/brain/c1/fox.png" } }]
        }));
        assert_eq!(tool.pictures(), [Picture::Inline { data: "aW1n".into(), mime: "image/png".into() }]);
        assert_eq!(tool.picture_request(), ("a red fox".into(), Some("16:9".into())));
        tool.drop_pictures();
        assert!(tool.content[0]["content"].get("data").is_none(), "raw base64 is dropped from tool content");

        let cli = AgentTool {
            content: vec![json!({ "type": "content", "content": { "type": "text", "text": "Generated image is saved at C:\\home\\fox.png." } })],
            ..AgentTool::default()
        };
        assert_eq!(cli.pictures(), [Picture::File("C:\\home\\fox.png".into())]);
    }
}
