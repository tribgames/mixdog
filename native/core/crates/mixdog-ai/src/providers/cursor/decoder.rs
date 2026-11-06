//! The agent run's server side: Connect frames of `AgentServerMessage`.
//!
//! Text and thinking deltas become stream events; tool calls come from exec
//! messages (the model's MCP calls, or native reads/writes/shell redirected to
//! Mixdog tools) and are reported once their batch is complete, ending the
//! attempt. Everything the server asks of the client in between (request
//! context, blob reads and writes, refused interactions and execs) is answered
//! through [`CursorDecoder::take_outbound`]; the stream writes those messages
//! back on the open request body.

use std::collections::HashSet;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ItemKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireDecoder;
use serde_json::Value;
use serde_json::json;

use super::request::BlobStore;
use super::request::MAX_CONNECT_FRAME_BYTES;
use super::request::random_uuid;
use super::request::request_context;
use super::schema::ExecEcho;
use super::schema::ExecResult;
use super::schema::ExecServer;
use super::schema::InteractionUpdate;
use super::schema::McpToolDefinition;
use super::schema::QueryCase;
use super::schema::QueryReply;
use super::schema::ServerMessage;
use super::schema::UnavailableKind;
use super::schema::checkpoint_used_tokens;
use super::schema::decode_json_value;
use super::schema::exec_client_message;
use super::schema::exec_throw;
use super::schema::interaction_response;
use super::schema::kv_client_message;
use crate::providers::connect::ConnectFailure;
use crate::providers::connect::frame::FrameReader;
use crate::providers::connect::provider_error;
use crate::retry::advice;

const UNAVAILABLE: &str = "Tool not available in this environment. Use a Mixdog tool instead.";
const REJECT_REASON: &str = "This Cursor-side interaction is unavailable. Use the Mixdog tools instead.";
const BACKGROUND_SHELL_REASON: &str = "Cursor background shell is not supported. Use the mixdog MCP shell tool with {\"command\":\"...\"}; if it returns task_id, use the mixdog task tool with {\"action\":\"wait\",\"task_id\":\"<returned id>\"}. Use load_tool {\"names\":\"task\"} if task is not loaded.";
const BRIDGE_NAME_MAX_CHARS: usize = 256;
const BRIDGE_META_TOOLS: [&str; 3] = ["load_tool", "call_tool", "tool_search"];

/// Splits assistant text into answer and reasoning around `<think>`-style
/// tags, holding back a possible partial tag at the end of a delta.
#[derive(Default)]
struct ThinkFilter {
    buffer: String,
    reasoning: bool,
}

const TAG_NAMES: [&str; 5] = ["think", "thinking", "reasoning", "thought", "think_intent"];

/// `(length, closing)` of a think tag at the start of `s`.
fn match_tag(s: &str) -> Option<(usize, bool)> {
    let mut chars = s.char_indices().peekable();
    chars.next()?; // '<'
    let closing = matches!(chars.peek(), Some((_, '/')));
    if closing {
        chars.next();
    }
    let name_start = chars.peek().map_or(s.len(), |(i, _)| *i);
    let mut name_end = name_start;
    while let Some((i, c)) = chars.peek().copied() {
        if c.is_ascii_alphabetic() || c == '_' {
            name_end = i + c.len_utf8();
            chars.next();
        } else {
            break;
        }
    }
    let name = &s[name_start..name_end];
    if !TAG_NAMES.iter().any(|t| t.eq_ignore_ascii_case(name)) {
        return None;
    }
    while let Some((_, c)) = chars.peek().copied() {
        if c.is_whitespace() {
            chars.next();
        } else {
            break;
        }
    }
    match chars.next() {
        Some((i, '>')) => Some((i + 1, closing)),
        _ => None,
    }
}

fn is_partial_tag(s: &str) -> bool {
    let rest = s.strip_prefix('<').unwrap_or(s);
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    rest.chars().all(|c| c.is_ascii_alphabetic() || c == '_')
}

impl ThinkFilter {
    /// `(content, reasoning)` of this delta.
    fn process(&mut self, delta: &str) -> (String, String) {
        let input = format!("{}{delta}", std::mem::take(&mut self.buffer));
        let (mut content, mut thought) = (String::new(), String::new());
        let mut cursor = 0;
        let mut at = 0;
        while let Some(rel) = input[at..].find('<') {
            let start = at + rel;
            if let Some((len, closing)) = match_tag(&input[start..]) {
                let segment = &input[cursor..start];
                if self.reasoning {
                    thought.push_str(segment);
                } else {
                    content.push_str(segment);
                }
                self.reasoning = !closing;
                cursor = start + len;
                at = cursor;
            } else {
                at = start + 1;
            }
        }
        let rest = &input[cursor..];
        let target = if self.reasoning { &mut thought } else { &mut content };
        match rest.rfind('<') {
            Some(partial) if rest[partial..].chars().count() < 18 && is_partial_tag(&rest[partial..]) => {
                target.push_str(&rest[..partial]);
                self.buffer = rest[partial..].to_owned();
            }
            _ => target.push_str(rest),
        }
        (content, thought)
    }

    fn flush(&mut self) -> (String, String) {
        let value = std::mem::take(&mut self.buffer);
        if self.reasoning {
            (String::new(), value)
        } else {
            (value, String::new())
        }
    }
}

/// A tool call the server asked the client to execute.
#[derive(Debug, Clone)]
struct Pending {
    exec_key: String,
    tool_call_id: String,
    tool_name: String,
    arguments: Value,
}

pub struct CursorDecoder {
    frames: FrameReader,
    blobs: BlobStore,
    tools: Vec<McpToolDefinition>,
    cloud_rule: Option<String>,
    filter: ThinkFilter,
    saw_turn_ended: bool,
    saw_end: bool,
    output_tokens: u64,
    context_tokens: Option<u64>,
    pending: Vec<Pending>,
    executions: HashSet<String>,
    boundary_ready: bool,
    outbound: Vec<Vec<u8>>,
    exposure: Exposure,
    reasoning_started: bool,
    text_started: bool,
    terminal: bool,
    /// The catalog model a pinned suffix id bills as, reported with the usage.
    pricing_model: Option<String>,
}

impl CursorDecoder {
    pub fn with_pricing_model(mut self, pricing_model: Option<String>) -> Self {
        self.pricing_model = pricing_model;
        self
    }

    pub fn new(blobs: BlobStore, tools: Vec<McpToolDefinition>, cloud_rule: Option<String>) -> Self {
        Self {
            frames: FrameReader::new(MAX_CONNECT_FRAME_BYTES),
            blobs,
            tools,
            cloud_rule,
            filter: ThinkFilter::default(),
            saw_turn_ended: false,
            saw_end: false,
            output_tokens: 0,
            context_tokens: None,
            pending: Vec::new(),
            executions: HashSet::new(),
            boundary_ready: false,
            outbound: Vec::new(),
            exposure: Exposure::default(),
            reasoning_started: false,
            text_started: false,
            terminal: false,
            pricing_model: None,
        }
    }

    /// `AgentClientMessage` bytes the stream must write back, in order.
    pub fn take_outbound(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.outbound)
    }

    fn text(&mut self, content: String, reasoning: String, events: &mut Vec<StreamEvent>) {
        if !reasoning.is_empty() {
            self.reasoning(reasoning, events);
        }
        if !content.is_empty() {
            if !self.text_started {
                self.text_started = true;
                events.push(StreamEvent::ItemStart {
                    kind: ItemKind::Text,
                    phase: None,
                });
            }
            self.exposure.text_emitted = true;
            events.push(StreamEvent::TextDelta(content));
        }
    }

    fn reasoning(&mut self, text: String, events: &mut Vec<StreamEvent>) {
        if !self.reasoning_started {
            self.reasoning_started = true;
            events.push(StreamEvent::ItemStart {
                kind: ItemKind::Reasoning,
                phase: None,
            });
        }
        events.push(StreamEvent::ReasoningDelta(text));
    }

    fn interaction(&mut self, update: InteractionUpdate, events: &mut Vec<StreamEvent>) {
        if let Some(delta) = update.text_delta.filter(|t| !t.is_empty()) {
            let (content, reasoning) = self.filter.process(&delta);
            self.text(content, reasoning, events);
        }
        if let Some(thinking) = update.thinking_delta.filter(|t| !t.is_empty()) {
            self.reasoning(thinking, events);
        }
        if update.turn_ended {
            self.saw_turn_ended = true;
            self.boundary();
        }
        if update.step_completed {
            self.boundary();
        }
        self.output_tokens += update.token_delta.max(0) as u64;
    }

    /// A tool batch ends at the first batch boundary after its calls.
    fn boundary(&mut self) {
        if !self.pending.is_empty() {
            self.boundary_ready = true;
        }
    }

    fn reply_exec(&mut self, exec: &ExecServer, result: ExecResult, echo: ExecEcho) {
        self.outbound
            .push(exec_client_message(exec.id, &exec.exec_id, &result, &echo));
    }

    fn unavailable(&mut self, exec: &ExecServer, kind: UnavailableKind, reason: &str, echo: ExecEcho) {
        self.reply_exec(exec, ExecResult::Unavailable(kind, reason.to_owned()), echo);
    }

    fn tool_named(&self, names: &[&str]) -> Option<&McpToolDefinition> {
        self.tools.iter().find(|t| names.contains(&t.name.as_str()))
    }

    fn announce(&mut self, exec: &ExecServer, mut pending: Pending) {
        let key = if exec.exec_id.is_empty() {
            exec.id.to_string()
        } else {
            exec.exec_id.clone()
        };
        if !self.executions.insert(key.clone()) {
            return;
        }
        // A parent call can issue distinct executions; each needs its own id.
        if self.pending.iter().any(|p| p.tool_call_id == pending.tool_call_id) {
            pending.tool_call_id = random_uuid();
        }
        pending.exec_key = key;
        self.pending.push(pending);
    }

    fn mcp_exec(&mut self, exec: &ExecServer) {
        let Some(args) = &exec.mcp else { return };
        let requested = if args.tool_name.is_empty() {
            args.name.clone()
        } else {
            args.tool_name.clone()
        };
        let direct = self.tool_named(&[requested.as_str()]).map(|t| t.name.clone());
        let mut tool = direct.clone().or_else(|| {
            (!requested.is_empty())
                .then(|| self.tool_named(&["call_tool"]).map(|t| t.name.clone()))
                .flatten()
        });
        let Some(first) = tool.clone() else {
            let shown = if requested.is_empty() { "unknown" } else { &requested };
            self.reply_exec(
                exec,
                ExecResult::McpError(format!("Tool not available: {shown}")),
                ExecEcho::default(),
            );
            return;
        };
        let mut decoded = serde_json::Map::new();
        for (key, bytes) in &args.args {
            let value = decode_json_value(bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned()));
            decoded.insert(key.clone(), value);
        }
        let mut arguments = Value::Object(decoded.clone());
        if requested == "call_tool"
            && direct.is_some()
            && decoded.len() == 2
            && let (Some(Value::String(name)), Some(Value::Object(inner))) =
                (decoded.get("name"), decoded.get("arguments"))
            && !name.is_empty()
            && name.chars().count() <= BRIDGE_NAME_MAX_CHARS
            && !BRIDGE_META_TOOLS.contains(&name.to_ascii_lowercase().as_str())
            && let Some(target) = self.tool_named(&[name.as_str()]).map(|t| t.name.clone())
        {
            tool = Some(target);
            arguments = Value::Object(inner.clone());
        }
        let name = tool.unwrap_or(first);
        let arguments = if direct.is_some() {
            arguments
        } else {
            json!({ "name": requested, "arguments": arguments })
        };
        let id = if args.tool_call_id.is_empty() {
            random_uuid()
        } else {
            args.tool_call_id.clone()
        };
        self.announce(
            exec,
            Pending {
                exec_key: String::new(),
                tool_call_id: id,
                tool_name: name,
                arguments,
            },
        );
    }

    fn schema_arg(tool: &McpToolDefinition, candidates: &[&str], fallback: &str) -> String {
        let props = tool.input_schema.get("properties").and_then(Value::as_object);
        candidates
            .iter()
            .find(|c| props.is_some_and(|p| p.contains_key(**c)))
            .unwrap_or(&fallback)
            .to_string()
    }

    /// A native exec a Mixdog tool serves: `Some(true)` redirected,
    /// `Some(false)` answered with an error, `None` not served.
    fn native_redirect(&mut self, exec: &ExecServer) -> Option<bool> {
        let (tool, args, id) = if let Some(a) = &exec.read {
            let tool = self.tool_named(&["read"])?;
            let mut args = serde_json::Map::new();
            args.insert(Self::schema_arg(tool, &["file_path", "filePath", "path"], "file_path"), json!(a.path));
            if a.offset != 0 {
                args.insert("offset".into(), json!(a.offset));
            }
            if a.limit != 0 {
                args.insert("limit".into(), json!(a.limit));
            }
            (tool.name.clone(), Value::Object(args), a.tool_call_id.clone())
        } else if let Some(a) = &exec.write {
            let tool = self.tool_named(&["edit"])?;
            let text = if a.file_bytes.is_empty() {
                a.file_text.clone()
            } else if let Ok(text) = String::from_utf8(a.file_bytes.clone()) {
                text
            } else {
                self.outbound.push(exec_client_message(
                    exec.id,
                    &exec.exec_id,
                    &ExecResult::Unavailable(
                        UnavailableKind::PathError { field: 3, error_field: 5 },
                        "Native Write fileBytes must be valid UTF-8; no file was written".to_owned(),
                    ),
                    &ExecEcho {
                        path: a.path.clone(),
                        ..ExecEcho::default()
                    },
                ));
                return Some(false);
            };
            let mut args = serde_json::Map::new();
            args.insert(Self::schema_arg(tool, &["file_path", "filePath", "path"], "file_path"), json!(a.path));
            args.insert("old_string".into(), json!(""));
            args.insert("new_string".into(), json!(text));
            (tool.name.clone(), Value::Object(args), a.tool_call_id.clone())
        } else if let Some(a) = &exec.fetch {
            let tool = self.tool_named(&["web_fetch", "webfetch", "fetch"])?;
            (tool.name.clone(), json!({ "url": a.url }), a.tool_call_id.clone())
        } else if let Some(a) = exec.shell.as_ref().or(exec.shell_stream.as_ref()) {
            let tool = self.tool_named(&["shell", "bash"])?;
            let mut args = serde_json::Map::new();
            args.insert("command".into(), json!(a.command));
            if a.timeout != 0 {
                args.insert("timeout_ms".into(), json!(a.timeout));
            }
            (tool.name.clone(), Value::Object(args), a.tool_call_id.clone())
        } else if let Some(a) = &exec.ls {
            let tool = self.tool_named(&["glob"])?;
            (tool.name.clone(), json!({ "pattern": "*", "path": a.path }), a.tool_call_id.clone())
        } else if let Some(a) = &exec.grep {
            let tool = self.tool_named(&["grep"])?;
            let mut args = serde_json::Map::new();
            args.insert("pattern".into(), json!(if a.pattern.is_empty() { "." } else { &a.pattern }));
            if !a.path.is_empty() {
                args.insert("path".into(), json!(a.path));
            }
            if !a.glob.is_empty() {
                args.insert("glob".into(), json!(a.glob));
            }
            let mode = match a.output_mode.as_str() {
                "files_with_matches" => "files",
                "" => "content",
                other => other,
            };
            args.insert("mode".into(), json!(mode));
            args.insert("context".into(), json!(0));
            if a.head_limit > 0 {
                args.insert("limit".into(), json!(a.head_limit));
            }
            (tool.name.clone(), Value::Object(args), a.tool_call_id.clone())
        } else {
            return None;
        };
        let tool_call_id = if id.is_empty() { random_uuid() } else { id };
        self.announce(
            exec,
            Pending {
                exec_key: String::new(),
                tool_call_id,
                tool_name: tool,
                arguments: args,
            },
        );
        Some(true)
    }

    /// Answers an exec no tool serves with its unavailable result.
    fn reject_exec(&mut self, exec: &ExecServer) {
        use UnavailableKind as K;
        let path = |p: &str| ExecEcho {
            path: p.to_owned(),
            ..ExecEcho::default()
        };
        if let Some(a) = &exec.read {
            self.unavailable(exec, K::Path { field: 7 }, UNAVAILABLE, path(&a.path));
        } else if let Some(a) = &exec.write {
            self.unavailable(exec, K::Path { field: 3 }, UNAVAILABLE, path(&a.path));
        } else if let Some(a) = &exec.delete {
            self.unavailable(exec, K::Path { field: 4 }, UNAVAILABLE, path(&a.path));
        } else if let Some(a) = &exec.ls {
            self.unavailable(exec, K::Path { field: 8 }, UNAVAILABLE, path(&a.path));
        } else if exec.grep.is_some() {
            self.unavailable(exec, K::Error { field: 5, error_field: 2 }, UNAVAILABLE, ExecEcho::default());
        } else if let Some(a) = &exec.fetch {
            self.unavailable(exec, K::PathError { field: 20, error_field: 2 }, UNAVAILABLE, path(&a.url));
        } else if let Some(a) = exec.shell.as_ref().or(exec.shell_stream.as_ref()) {
            self.unavailable(
                exec,
                K::Shell { field: 2 },
                UNAVAILABLE,
                ExecEcho {
                    command: a.command.clone(),
                    working_directory: a.working_directory.clone(),
                    ..ExecEcho::default()
                },
            );
        } else if let Some(a) = &exec.background_shell {
            self.unavailable(
                exec,
                K::Shell { field: 16 },
                BACKGROUND_SHELL_REASON,
                ExecEcho {
                    command: a.command.clone(),
                    working_directory: a.working_directory.clone(),
                    ..ExecEcho::default()
                },
            );
        } else if exec.write_shell_stdin {
            self.unavailable(exec, K::Error { field: 23, error_field: 2 }, UNAVAILABLE, ExecEcho::default());
        } else if exec.diagnostics {
            self.unavailable(exec, K::Empty { field: 9 }, "", ExecEcho::default());
        } else {
            self.outbound
                .push(exec_throw(exec.id, "Unsupported Cursor native exec. Use a Mixdog tool instead."));
        }
    }

    fn exec(&mut self, exec: ExecServer) {
        if exec.request_context {
            let context = request_context(&self.tools, self.cloud_rule.as_deref());
            self.reply_exec(&exec, ExecResult::RequestContext(context), ExecEcho::default());
        } else if exec.mcp.is_some() {
            self.mcp_exec(&exec);
        } else {
            match self.native_redirect(&exec) {
                // Native execs await their result before the server completes
                // a step: their batch is handed over at once.
                Some(true) => self.boundary_ready = true,
                Some(false) => {}
                None => self.reject_exec(&exec),
            }
        }
    }

    fn kv(&mut self, kv: super::schema::KvServer) -> Result<(), ProviderError> {
        if let Some(id) = kv.get_blob {
            let data = self.blobs.get(&id).map(<[u8]>::to_vec);
            self.outbound.push(kv_client_message(kv.id, Some(data.as_deref())));
        } else if let Some((id, data)) = kv.set_blob {
            self.blobs.put(&id, data)?;
            self.outbound.push(kv_client_message(kv.id, None));
        }
        Ok(())
    }

    fn query(&mut self, id: u64, case: QueryCase) -> Result<(), ProviderError> {
        let (reply, reason) = match case {
            QueryCase::WebSearch => (QueryReply::Rejected { field: 2 }, REJECT_REASON),
            QueryCase::ExaSearch => (QueryReply::Rejected { field: 5 }, REJECT_REASON),
            QueryCase::ExaFetch => (QueryReply::Rejected { field: 6 }, REJECT_REASON),
            QueryCase::SwitchMode => (QueryReply::Rejected { field: 4 }, REJECT_REASON),
            QueryCase::AskQuestion => (QueryReply::AskQuestion, REJECT_REASON),
            QueryCase::CreatePlan => (QueryReply::CreatePlan, REJECT_REASON),
            QueryCase::SetupVm => (QueryReply::SetupVmAck, ""),
            QueryCase::WebFetch => (QueryReply::Rejected { field: 9 }, REJECT_REASON),
            QueryCase::Unknown(field) => {
                return Err(drift(&format!("Unsupported Cursor interaction query: field_{field}")));
            }
        };
        self.outbound.push(interaction_response(id, reply, reason));
        Ok(())
    }

    fn message(&mut self, bytes: &[u8], events: &mut Vec<StreamEvent>) -> Result<(), ProviderError> {
        let message = ServerMessage::decode(bytes).map_err(|e| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            error.code = Some("protocol_error".to_owned());
            error.message = format!("Cursor protobuf: {e}");
            error
        })?;
        if let Some(update) = message.interaction {
            self.interaction(update, events);
        } else if let Some(kv) = message.kv {
            self.kv(kv)?;
        } else if let Some(checkpoint) = message.checkpoint {
            self.context_tokens = checkpoint_used_tokens(&checkpoint).or(self.context_tokens);
            self.boundary();
        } else if let Some(exec) = message.exec {
            self.exec(exec);
        } else if let Some(query) = message.query {
            self.query(query.id, query.case)?;
        } else if message.exec_abort {
            return Err(drift_named("exec_aborted", "Cursor aborted the active exec"));
        } else if let Some(field) = message.unknown.first() {
            return Err(drift(&format!("Unsupported Cursor server message field {field}")));
        }
        Ok(())
    }

    fn end_stream_error(&self, payload: &[u8]) -> Option<ProviderError> {
        let parsed: Value = match serde_json::from_slice(payload) {
            Ok(v) => v,
            Err(_) => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
                error.code = Some("protocol_error".to_owned());
                error.message = "Cursor returned an invalid end-stream frame".to_owned();
                return Some(error);
            }
        };
        let object = parsed.get("error")?.as_object()?;
        let code = object
            .get("code")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .unwrap_or("error")
            .to_ascii_lowercase();
        let detail = object
            .get("message")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .unwrap_or("request failed");
        let advice_text = |v: &Value| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Array(items) => items.first().and_then(|i| i.as_str().map(str::to_owned)),
            _ => None,
        };
        let retry_after = object
            .get("retryAfter")
            .or_else(|| object.get("retry_after"))
            .or_else(|| parsed.get("metadata").and_then(|m| m.get("retry-after")))
            .or_else(|| parsed.get("metadata").and_then(|m| m.get("retryAfter")))
            .and_then(advice_text)
            .and_then(|text| {
                advice::from_headers(&[("retry-after".to_owned(), text)], std::time::SystemTime::now())
            });
        let mut error = provider_error(
            ConnectFailure {
                code: code.clone(),
                message: format!("Cursor {code}: {detail}"),
                http_status: None,
                retry_after,
            },
            DeliveryState::Accepted,
        );
        error.exposure = self.exposure;
        // The product reports every end-stream failure as an aborted stream;
        // the kind above keeps the retry verdict of the stream's own code.
        error.code = Some("stream_aborted".to_owned());
        error.status = None;
        Some(error)
    }

    /// The events of a finished run.
    fn finalize(&mut self) -> Vec<StreamEvent> {
        self.terminal = true;
        let mut events = Vec::new();
        let (content, reasoning) = self.filter.flush();
        self.text(content, reasoning, &mut events);
        let pending = std::mem::take(&mut self.pending);
        let tool_use = !pending.is_empty();
        for call in pending {
            events.push(StreamEvent::ItemStart {
                kind: ItemKind::Tool,
                phase: None,
            });
            events.push(StreamEvent::ToolCallStart {
                id: call.tool_call_id.clone(),
                name: call.tool_name.clone(),
            });
            self.exposure.tool_dispatched = true;
            events.push(StreamEvent::ToolCallDone(ToolCall {
                id: call.tool_call_id,
                name: call.tool_name,
                arguments: call.arguments,
                native_type: None,
            }));
        }
        // Checkpoint occupancy is not per-request prompt usage and supplies
        // no cache split: the input side is unknown.
        events.push(StreamEvent::Usage(Usage {
            cost: None,
            input_tokens: 0,
            output_tokens: self.output_tokens,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cache_write_1h_tokens: 0,
            reasoning_tokens: None,
            reasoning_incomplete: false,
            raw: Some(json!({
                "completion_tokens": self.output_tokens,
                "input_tokens_known": false,
                "cache_tokens_known": false,
                "context_tokens": self.context_tokens,
            })),
        }));
        events.push(StreamEvent::Completed {
            pricing_model: self.pricing_model.clone(),
            request_ms: None,
            stop: Some(if tool_use { StopReason::ToolUse } else { StopReason::EndTurn }),
        });
        events
    }

    fn incomplete(&self, message: &str) -> ProviderError {
        let mut error = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        error.code = Some("incomplete_stream".to_owned());
        error.message = message.to_owned();
        error.exposure = self.exposure;
        error
    }
}

fn drift_named(code: &str, message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
    error.code = Some(code.to_owned());
    error.status = Some(400);
    error.message = message.to_owned();
    error
}

fn drift(message: &str) -> ProviderError {
    drift_named("protocol_drift", message)
}

impl WireDecoder for CursorDecoder {
    fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
        let frames = self.frames.push(unit).map_err(|e| {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            error.code = Some("protocol_error".to_owned());
            error.message = format!("Cursor frame exceeds {} bytes", e.max);
            error
        })?;
        let mut events = Vec::new();
        for frame in frames {
            if self.terminal {
                break;
            }
            if frame.is_compressed() {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
                error.code = Some("protocol_error".to_owned());
                error.message = "Cursor returned an unsupported compressed frame".to_owned();
                return Err(error);
            }
            if frame.flags & !crate::providers::connect::frame::END_STREAM != 0 {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
                error.code = Some("protocol_error".to_owned());
                error.message = format!("Cursor returned unsupported frame flags: {}", frame.flags);
                return Err(error);
            }
            if frame.is_end_stream() {
                self.saw_end = true;
                if let Some(mut error) = self.end_stream_error(&frame.payload) {
                    error.exposure = self.exposure;
                    return Err(error);
                }
                if !self.pending.is_empty() || self.saw_turn_ended {
                    events.extend(self.finalize());
                    return Ok(events);
                }
                return Err(self.incomplete("Cursor stream ended before turnEnded"));
            }
            self.message(&frame.payload, &mut events)?;
        }
        // Never hand over a batch with a partial frame still buffered.
        if !self.terminal && self.boundary_ready && !self.pending.is_empty() && self.frames.buffered() == 0 {
            events.extend(self.finalize());
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
        if self.terminal {
            return Ok(Vec::new());
        }
        if self.frames.buffered() > 0 {
            return Err(self.incomplete("Cursor stream ended with a truncated frame"));
        }
        // Tool calls already announced stay actionable even if the transport
        // vanished; a close after turnEnded only ends a completed turn.
        if !self.pending.is_empty() || self.saw_turn_ended {
            return Ok(self.finalize());
        }
        if !self.saw_end {
            return Err(self.incomplete("Cursor stream closed before its end frame"));
        }
        Ok(self.finalize())
    }

    fn terminal_seen(&self) -> bool {
        self.terminal
    }

    fn exposure(&self) -> Exposure {
        self.exposure
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pinned suffix id's catalog model rides the terminal event, not the usage.
    #[test]
    fn the_pricing_model_rides_the_completed_event() {
        let mut decoder = CursorDecoder::new(BlobStore::default(), Vec::new(), None)
            .with_pricing_model(Some("zen-3".to_owned()));
        let events = decoder.finalize();
        assert!(matches!(
            events.last(),
            Some(StreamEvent::Completed { pricing_model: Some(model), .. }) if model == "zen-3"
        ));
        assert!(events.iter().all(|e| !matches!(e, StreamEvent::Usage(u) if u.raw.as_ref().is_some_and(|r| r.get("pricingModel").is_some()))));
    }

    #[test]
    fn think_tags_split_reasoning_from_content() {
        let mut f = ThinkFilter::default();
        assert_eq!(f.process("a<think>b</think>c"), ("ac".into(), "b".into()));
    }

    #[test]
    fn partial_tag_is_held_until_it_completes() {
        let mut f = ThinkFilter::default();
        assert_eq!(f.process("hi <thi"), ("hi ".into(), String::new()));
        assert_eq!(f.process("nk>x"), (String::new(), "x".into()));
        assert_eq!(f.flush(), (String::new(), String::new()));
    }

    #[test]
    fn non_tag_angle_brackets_pass_through() {
        let mut f = ThinkFilter::default();
        assert_eq!(f.process("a < b <c> d"), ("a < b <c> d".into(), String::new()));
    }

    #[test]
    fn tag_names_match_case_insensitively_with_space() {
        let mut f = ThinkFilter::default();
        assert_eq!(f.process("<THINKING >z</Thinking>"), (String::new(), "z".into()));
    }
}
