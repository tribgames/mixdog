//! Cursor `agent.v1` protobuf messages: only the fields this client reads or
//! writes. Encoders write exactly the fields the caller supplies, defaults
//! included, in ascending field-number order (the product's codec does not
//! omit defaults); decoders keep presence for the message fields whose
//! presence is the signal (`turnEnded`, `requestContextArgs`, queries).

use std::collections::BTreeMap;

use serde_json::Map;
use serde_json::Value;

use crate::providers::connect::pb::PbError;
use crate::providers::connect::pb::Reader;
use crate::providers::connect::pb::Writer;

// ---------------------------------------------------------------------------
// google.protobuf.Value as Cursor writes tool schemas and reads MCP arguments
// ---------------------------------------------------------------------------

fn json_value(w: &mut Writer, value: &Value) {
    match value {
        Value::Null => w.varint(1, 0),
        Value::Bool(b) => w.varint(4, u64::from(*b)),
        Value::Number(n) => w.double(2, n.as_f64().unwrap_or(0.0)),
        Value::String(s) => w.string(3, s),
        Value::Array(items) => {
            let mut list = Writer::new();
            for item in items {
                list.message(1, json_value_body(item));
            }
            w.message(6, list);
        }
        Value::Object(fields) => {
            let mut object = Writer::new();
            for (key, item) in fields {
                let mut entry = Writer::new();
                entry.string(1, key);
                entry.message(2, json_value_body(item));
                object.message(1, entry);
            }
            w.message(5, object);
        }
    }
}

fn json_value_body(value: &Value) -> Writer {
    let mut w = Writer::new();
    json_value(&mut w, value);
    w
}

pub fn encode_json_value(value: &Value) -> Vec<u8> {
    json_value_body(value).finish()
}

pub fn decode_json_value(bytes: &[u8]) -> Result<Value, PbError> {
    let mut reader = Reader::new(bytes);
    let mut out = Value::Null;
    while let Some((n, v)) = reader.next_field()? {
        out = match n {
            1 => Value::Null,
            2 => serde_json::Number::from_f64(v.as_f64()).map_or(Value::Null, Value::Number),
            3 => Value::String(v.text()),
            4 => Value::Bool(v.as_bool()),
            5 => {
                let mut fields = Map::new();
                let mut object = Reader::new(v.bytes());
                while let Some((m, entry)) = object.next_field()? {
                    if m != 1 {
                        continue;
                    }
                    let (mut key, mut val) = (String::new(), Value::Null);
                    let mut e = Reader::new(entry.bytes());
                    while let Some((k, ev)) = e.next_field()? {
                        match k {
                            1 => key = ev.text(),
                            2 => val = decode_json_value(ev.bytes())?,
                            _ => {}
                        }
                    }
                    fields.insert(key, val);
                }
                Value::Object(fields)
            }
            6 => {
                let mut items = Vec::new();
                let mut list = Reader::new(v.bytes());
                while let Some((m, item)) = list.next_field()? {
                    if m == 1 {
                        items.push(decode_json_value(item.bytes())?);
                    }
                }
                Value::Array(items)
            }
            _ => out,
        };
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Client messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct McpToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub provider_identifier: String,
}

impl McpToolDefinition {
    fn write(&self, w: &mut Writer) {
        w.string(1, &self.name);
        w.string(2, &self.description);
        w.bytes(3, &encode_json_value(&self.input_schema));
        w.string(4, &self.provider_identifier);
        w.string(5, &self.name);
        w.string(6, &self.input_schema.to_string());
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RequestContext {
    pub tools: Vec<McpToolDefinition>,
    /// `(server name, instructions)`.
    pub mcp_instructions: Vec<(String, String)>,
    pub cloud_rule: Option<String>,
}

impl RequestContext {
    fn body(&self) -> Writer {
        let mut w = Writer::new();
        for tool in &self.tools {
            let mut t = Writer::new();
            tool.write(&mut t);
            w.message(7, t);
        }
        for (server, instructions) in &self.mcp_instructions {
            let mut i = Writer::new();
            i.string(1, server);
            i.string(2, instructions);
            w.message(14, i);
        }
        if let Some(rule) = &self.cloud_rule {
            w.string(16, rule);
        }
        w
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct UserImage {
    pub uuid: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    UserMessage {
        text: String,
        message_id: String,
        images: Vec<UserImage>,
        context: RequestContext,
    },
    Resume {
        context: RequestContext,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunRequest {
    /// `ConversationStateStructure` bytes.
    pub conversation_state: Vec<u8>,
    pub action: Action,
    pub conversation_id: String,
    pub model_id: String,
    pub max_mode: bool,
    pub parameters: Vec<(String, String)>,
}

/// `ConversationStateStructure` carrying only the transcript blob ids.
pub fn conversation_state(root_prompt_blob_ids: &[Vec<u8>]) -> Vec<u8> {
    let mut w = Writer::new();
    for id in root_prompt_blob_ids {
        w.bytes(1, id);
    }
    w.finish()
}

impl RunRequest {
    /// An `AgentClientMessage` carrying the run request.
    pub fn encode(&self) -> Vec<u8> {
        let mut run = Writer::new();
        run.bytes(1, &self.conversation_state);
        let mut action = Writer::new();
        match &self.action {
            Action::UserMessage {
                text,
                message_id,
                images,
                context,
            } => {
                let mut user_message = Writer::new();
                user_message.string(1, text);
                user_message.string(2, message_id);
                let mut selected = Writer::new();
                for image in images {
                    let mut i = Writer::new();
                    i.string(2, &image.uuid);
                    i.string(7, &image.mime_type);
                    i.bytes(8, &image.data);
                    selected.message(1, i);
                }
                user_message.message(3, selected);
                let mut inner = Writer::new();
                inner.message(1, user_message);
                inner.message(2, context.body());
                action.message(1, inner);
            }
            Action::Resume { context } => {
                let mut inner = Writer::new();
                inner.message(2, context.body());
                action.message(2, inner);
            }
        }
        run.message(2, action);
        run.string(5, &self.conversation_id);
        let mut model = Writer::new();
        model.string(1, &self.model_id);
        model.varint(2, u64::from(self.max_mode));
        for (id, value) in &self.parameters {
            let mut p = Writer::new();
            p.string(1, id);
            p.string(2, value);
            model.message(3, p);
        }
        run.message(9, model);
        let mut message = Writer::new();
        message.message(1, run);
        message.finish()
    }
}

/// `AgentClientMessage{clientHeartbeat}`.
pub fn heartbeat_message() -> Vec<u8> {
    let mut w = Writer::new();
    w.message(7, Writer::new());
    w.finish()
}

/// The result of one exec, by the exec's result slot.
#[derive(Debug, Clone, PartialEq)]
pub enum ExecResult {
    RequestContext(RequestContext),
    McpError(String),
    /// A native exec the environment does not serve: the `rejected`/`error`
    /// payload of its result type.
    Unavailable(UnavailableKind, String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnavailableKind {
    /// `rejected { path, reason }`, result field number and path.
    Path { field: u32 },
    Shell { field: u32 },
    /// `error { error }` inside the result.
    Error { field: u32, error_field: u32 },
    /// `error { path, error }` inside the result (write and fetch).
    PathError { field: u32, error_field: u32 },
    Empty { field: u32 },
}

pub fn exec_client_message(id: u64, exec_id: &str, result: &ExecResult, detail: &ExecEcho) -> Vec<u8> {
    let mut m = Writer::new();
    m.varint(1, id);
    match result {
        ExecResult::RequestContext(context) => {
            let mut success = Writer::new();
            success.message(1, context.body());
            let mut result = Writer::new();
            result.message(1, success);
            m.message(10, result);
        }
        ExecResult::McpError(text) => {
            let mut error = Writer::new();
            error.string(1, text);
            let mut result = Writer::new();
            result.message(2, error);
            m.message(11, result);
        }
        ExecResult::Unavailable(kind, reason) => match *kind {
            UnavailableKind::Path { field } => {
                let mut rejected = Writer::new();
                rejected.string(1, &detail.path);
                rejected.string(2, reason);
                let mut result = Writer::new();
                // read/ls results hold `rejected` at 3; write at 6; delete at 6.
                result.message(rejected_field(field), rejected);
                m.message(field, result);
            }
            UnavailableKind::Shell { field } => {
                let mut rejected = Writer::new();
                rejected.string(1, &detail.command);
                rejected.string(2, &detail.working_directory);
                rejected.string(3, reason);
                let mut result = Writer::new();
                result.message(if field == 2 { 4 } else { 3 }, rejected);
                m.message(field, result);
            }
            UnavailableKind::Error { field, error_field } => {
                let mut error = Writer::new();
                error.string(1, reason);
                let mut result = Writer::new();
                result.message(error_field, error);
                m.message(field, result);
            }
            UnavailableKind::PathError { field, error_field } => {
                let mut error = Writer::new();
                error.string(1, &detail.path);
                error.string(2, reason);
                let mut result = Writer::new();
                result.message(error_field, error);
                m.message(field, result);
            }
            UnavailableKind::Empty { field } => m.message(field, Writer::new()),
        },
    }
    m.string(15, exec_id);
    let mut message = Writer::new();
    message.message(2, m);
    message.finish()
}

/// The result slot that holds `rejected` for a path-bearing result.
fn rejected_field(result_field: u32) -> u32 {
    match result_field {
        7 | 8 => 3,
        _ => 6,
    }
}

/// Request-echo values the unavailable results repeat.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecEcho {
    pub path: String,
    pub command: String,
    pub working_directory: String,
}

/// `AgentClientMessage{execClientControlMessage{throw}}`.
pub fn exec_throw(id: u64, error: &str) -> Vec<u8> {
    let mut t = Writer::new();
    t.varint(1, id);
    t.string(2, error);
    let mut control = Writer::new();
    control.message(2, t);
    let mut message = Writer::new();
    message.message(5, control);
    message.finish()
}

/// `AgentClientMessage{kvClientMessage}`: a blob read (`Some` data, or the
/// empty result when unknown) or a blob write acknowledgement.
pub fn kv_client_message(id: u64, get: Option<Option<&[u8]>>) -> Vec<u8> {
    let mut kv = Writer::new();
    kv.varint(1, id);
    match get {
        Some(data) => {
            let mut result = Writer::new();
            if let Some(data) = data {
                result.bytes(1, data);
            }
            kv.message(2, result);
        }
        None => kv.message(3, Writer::new()),
    }
    let mut message = Writer::new();
    message.message(3, kv);
    message.finish()
}

/// How a rejected interaction query answers: the response field and payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryReply {
    /// `approvalInteractionResponse{rejected{reason}}` at the field.
    Rejected { field: u32 },
    /// `askQuestionInteractionResponse{result{rejected{reason}}}`.
    AskQuestion,
    /// `createPlanRequestResponse{result{error{error}}}`.
    CreatePlan,
    /// `setupVmEnvironmentResult{success}`.
    SetupVmAck,
}

pub fn interaction_response(id: u64, reply: QueryReply, reason: &str) -> Vec<u8> {
    let rejected = || {
        let mut r = Writer::new();
        r.string(1, reason);
        r
    };
    let mut response = Writer::new();
    response.varint(1, id);
    match reply {
        QueryReply::Rejected { field } => {
            let mut approval = Writer::new();
            approval.message(2, rejected());
            response.message(field, approval);
        }
        QueryReply::AskQuestion => {
            let mut result = Writer::new();
            result.message(3, rejected());
            let mut ask = Writer::new();
            ask.message(1, result);
            response.message(3, ask);
        }
        QueryReply::CreatePlan => {
            let mut error = Writer::new();
            error.string(1, reason);
            let mut result = Writer::new();
            result.message(2, error);
            let mut plan = Writer::new();
            plan.message(1, result);
            response.message(7, plan);
        }
        QueryReply::SetupVmAck => {
            let mut success = Writer::new();
            success.message(1, Writer::new());
            response.message(8, success);
        }
    }
    let mut message = Writer::new();
    message.message(6, response);
    message.finish()
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct InteractionUpdate {
    pub text_delta: Option<String>,
    pub thinking_delta: Option<String>,
    pub token_delta: i64,
    pub turn_ended: bool,
    pub step_completed: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExecServer {
    pub id: u64,
    pub exec_id: String,
    pub request_context: bool,
    pub mcp: Option<McpArgs>,
    pub read: Option<ReadArgs>,
    pub write: Option<WriteArgs>,
    pub delete: Option<PathArgs>,
    pub grep: Option<GrepArgs>,
    pub ls: Option<PathArgs>,
    pub diagnostics: bool,
    pub shell: Option<ShellArgs>,
    pub shell_stream: Option<ShellArgs>,
    pub background_shell: Option<ShellArgs>,
    pub fetch: Option<FetchArgs>,
    pub write_shell_stdin: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct McpArgs {
    pub name: String,
    /// Argument name to its protobuf `Value` bytes.
    pub args: BTreeMap<String, Vec<u8>>,
    pub tool_call_id: String,
    pub tool_name: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReadArgs {
    pub path: String,
    pub tool_call_id: String,
    pub offset: i64,
    pub limit: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct WriteArgs {
    pub path: String,
    pub file_text: String,
    pub tool_call_id: String,
    pub file_bytes: Vec<u8>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PathArgs {
    pub path: String,
    pub tool_call_id: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct GrepArgs {
    pub pattern: String,
    pub path: String,
    pub glob: String,
    pub output_mode: String,
    pub head_limit: i64,
    pub tool_call_id: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShellArgs {
    pub command: String,
    pub working_directory: String,
    pub timeout: i64,
    pub tool_call_id: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchArgs {
    pub url: String,
    pub tool_call_id: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct KvServer {
    pub id: u64,
    pub get_blob: Option<Vec<u8>>,
    pub set_blob: Option<(Vec<u8>, Vec<u8>)>,
}

/// Which `InteractionQuery` field was set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryCase {
    WebSearch,
    ExaSearch,
    ExaFetch,
    SwitchMode,
    AskQuestion,
    CreatePlan,
    SetupVm,
    /// Field 9 (not described): the web fetch request.
    WebFetch,
    Unknown(u32),
}

#[derive(Debug, Clone, PartialEq)]
pub struct InteractionQuery {
    pub id: u64,
    pub case: QueryCase,
}

/// One decoded `AgentServerMessage`. Several fields may be set; the decoder
/// handles them in the order the product does.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ServerMessage {
    pub interaction: Option<InteractionUpdate>,
    pub exec: Option<ExecServer>,
    pub checkpoint: Option<Vec<u8>>,
    pub kv: Option<KvServer>,
    pub exec_abort: bool,
    pub query: Option<InteractionQuery>,
    /// Field numbers outside the described set.
    pub unknown: Vec<u32>,
}

fn decode_interaction(bytes: &[u8]) -> Result<InteractionUpdate, PbError> {
    let mut out = InteractionUpdate::default();
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        let first_text = |bytes: &[u8]| -> Result<String, PbError> {
            let mut inner = Reader::new(bytes);
            let mut text = String::new();
            while let Some((m, w)) = inner.next_field()? {
                if m == 1 {
                    text = w.text();
                }
            }
            Ok(text)
        };
        match n {
            1 => out.text_delta = Some(first_text(v.bytes())?),
            4 => out.thinking_delta = Some(first_text(v.bytes())?),
            8 => {
                let mut inner = Reader::new(v.bytes());
                while let Some((m, w)) = inner.next_field()? {
                    if m == 1 {
                        out.token_delta += w.as_u64() as i64;
                    }
                }
            }
            14 => out.turn_ended = true,
            17 => out.step_completed = true,
            _ => {}
        }
    }
    Ok(out)
}

fn string_fields(bytes: &[u8], wanted: &[(u32, usize)], strings: &mut [String]) -> Result<(), PbError> {
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        if let Some((_, at)) = wanted.iter().find(|(f, _)| *f == n) {
            strings[*at] = v.text();
        }
    }
    Ok(())
}

fn decode_mcp(bytes: &[u8]) -> Result<McpArgs, PbError> {
    let mut out = McpArgs::default();
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        match n {
            1 => out.name = v.text(),
            2 => {
                let (mut key, mut value) = (String::new(), Vec::new());
                let mut e = Reader::new(v.bytes());
                while let Some((k, ev)) = e.next_field()? {
                    match k {
                        1 => key = ev.text(),
                        2 => value = ev.bytes().to_vec(),
                        _ => {}
                    }
                }
                out.args.insert(key, value);
            }
            3 => out.tool_call_id = v.text(),
            5 => out.tool_name = v.text(),
            _ => {}
        }
    }
    Ok(out)
}

fn decode_exec(bytes: &[u8]) -> Result<ExecServer, PbError> {
    let mut out = ExecServer::default();
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        let b = v.bytes();
        match n {
            1 => out.id = v.as_u64(),
            15 => out.exec_id = v.text(),
            10 => out.request_context = true,
            11 => out.mcp = Some(decode_mcp(b)?),
            7 => {
                let mut a = ReadArgs::default();
                let mut f = Reader::new(b);
                while let Some((m, w)) = f.next_field()? {
                    match m {
                        1 => a.path = w.text(),
                        2 => a.tool_call_id = w.text(),
                        4 => a.offset = w.as_u64() as i64,
                        5 => a.limit = w.as_u64(),
                        _ => {}
                    }
                }
                out.read = Some(a);
            }
            3 => {
                let mut a = WriteArgs::default();
                let mut f = Reader::new(b);
                while let Some((m, w)) = f.next_field()? {
                    match m {
                        1 => a.path = w.text(),
                        2 => a.file_text = w.text(),
                        3 => a.tool_call_id = w.text(),
                        5 => a.file_bytes = w.bytes().to_vec(),
                        _ => {}
                    }
                }
                out.write = Some(a);
            }
            4 | 8 => {
                let (path_field, id_field) = if n == 4 { (1, 2) } else { (1, 3) };
                let mut a = PathArgs::default();
                let mut f = Reader::new(b);
                while let Some((m, w)) = f.next_field()? {
                    if m == path_field {
                        a.path = w.text();
                    } else if m == id_field {
                        a.tool_call_id = w.text();
                    }
                }
                if n == 4 {
                    out.delete = Some(a);
                } else {
                    out.ls = Some(a);
                }
            }
            5 => {
                let mut a = GrepArgs::default();
                let mut f = Reader::new(b);
                while let Some((m, w)) = f.next_field()? {
                    match m {
                        1 => a.pattern = w.text(),
                        2 => a.path = w.text(),
                        3 => a.glob = w.text(),
                        4 => a.output_mode = w.text(),
                        10 => a.head_limit = w.as_u64() as i64,
                        14 => a.tool_call_id = w.text(),
                        _ => {}
                    }
                }
                out.grep = Some(a);
            }
            9 => out.diagnostics = true,
            2 | 14 | 16 => {
                let mut a = ShellArgs::default();
                let id_field = if n == 16 { 3 } else { 4 };
                let mut f = Reader::new(b);
                while let Some((m, w)) = f.next_field()? {
                    match m {
                        1 => a.command = w.text(),
                        2 => a.working_directory = w.text(),
                        3 if n != 16 => a.timeout = w.as_u64() as i64,
                        m if m == id_field => a.tool_call_id = w.text(),
                        _ => {}
                    }
                }
                match n {
                    2 => out.shell = Some(a),
                    14 => out.shell_stream = Some(a),
                    _ => out.background_shell = Some(a),
                }
            }
            20 => {
                let mut a = FetchArgs::default();
                let mut s = [String::new(), String::new()];
                string_fields(b, &[(1, 0), (2, 1)], &mut s)?;
                [a.url, a.tool_call_id] = s;
                out.fetch = Some(a);
            }
            23 => out.write_shell_stdin = true,
            _ => {}
        }
    }
    Ok(out)
}

fn decode_kv(bytes: &[u8]) -> Result<KvServer, PbError> {
    let mut out = KvServer::default();
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        match n {
            1 => out.id = v.as_u64(),
            2 => {
                let mut f = Reader::new(v.bytes());
                let mut id = Vec::new();
                while let Some((m, w)) = f.next_field()? {
                    if m == 1 {
                        id = w.bytes().to_vec();
                    }
                }
                out.get_blob = Some(id);
            }
            3 => {
                let (mut id, mut data) = (Vec::new(), Vec::new());
                let mut f = Reader::new(v.bytes());
                while let Some((m, w)) = f.next_field()? {
                    match m {
                        1 => id = w.bytes().to_vec(),
                        2 => data = w.bytes().to_vec(),
                        _ => {}
                    }
                }
                out.set_blob = Some((id, data));
            }
            _ => {}
        }
    }
    Ok(out)
}

fn decode_query(bytes: &[u8]) -> Result<InteractionQuery, PbError> {
    let mut id = 0;
    let mut cases = Vec::new();
    let mut r = Reader::new(bytes);
    while let Some((n, v)) = r.next_field()? {
        match n {
            1 => id = v.as_u64(),
            2 => cases.push((2, QueryCase::WebSearch)),
            3 => cases.push((3, QueryCase::AskQuestion)),
            4 => cases.push((4, QueryCase::SwitchMode)),
            5 => cases.push((5, QueryCase::ExaSearch)),
            6 => cases.push((6, QueryCase::ExaFetch)),
            7 => cases.push((7, QueryCase::CreatePlan)),
            8 => cases.push((8, QueryCase::SetupVm)),
            9 => cases.push((9, QueryCase::WebFetch)),
            other => cases.push((other, QueryCase::Unknown(other))),
        }
    }
    // Answered in the product's priority order, not wire order.
    const PRIORITY: [QueryCase; 7] = [
        QueryCase::WebSearch,
        QueryCase::ExaSearch,
        QueryCase::ExaFetch,
        QueryCase::SwitchMode,
        QueryCase::AskQuestion,
        QueryCase::CreatePlan,
        QueryCase::SetupVm,
    ];
    let case = PRIORITY
        .iter()
        .find(|p| cases.iter().any(|(_, c)| c == *p))
        .copied()
        .or_else(|| cases.iter().map(|(_, c)| *c).find(|c| *c == QueryCase::WebFetch))
        .or_else(|| cases.first().map(|(_, c)| *c))
        .unwrap_or(QueryCase::Unknown(0));
    Ok(InteractionQuery { id, case })
}

impl ServerMessage {
    pub fn decode(bytes: &[u8]) -> Result<Self, PbError> {
        let mut out = Self::default();
        let mut r = Reader::new(bytes);
        while let Some((n, v)) = r.next_field()? {
            match n {
                1 => out.interaction = Some(decode_interaction(v.bytes())?),
                2 => out.exec = Some(decode_exec(v.bytes())?),
                3 => out.checkpoint = Some(v.bytes().to_vec()),
                4 => out.kv = Some(decode_kv(v.bytes())?),
                5 => {
                    let mut f = Reader::new(v.bytes());
                    while let Some((m, _)) = f.next_field()? {
                        if m == 1 {
                            out.exec_abort = true;
                        }
                    }
                }
                7 => out.query = Some(decode_query(v.bytes())?),
                other => out.unknown.push(other),
            }
        }
        Ok(out)
    }
}

/// `ConversationStateStructure.tokenDetails.usedTokens` of a checkpoint.
pub fn checkpoint_used_tokens(bytes: &[u8]) -> Option<u64> {
    let mut r = Reader::new(bytes);
    while let Ok(Some((n, v))) = r.next_field() {
        if n == 5 {
            let mut f = Reader::new(v.bytes());
            while let Ok(Some((m, w))) = f.next_field() {
                if m == 1 {
                    return Some(w.as_u64());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_value_round_trips() {
        let value = json!({"a": [1.5, "x", true, null], "b": {"c": false}});
        assert_eq!(decode_json_value(&encode_json_value(&value)).unwrap(), value);
    }

    #[test]
    fn server_message_with_only_noise_field_is_unknown() {
        let mut w = Writer::new();
        w.double(8, 1.0);
        let m = ServerMessage::decode(&w.finish()).unwrap();
        assert_eq!(m.unknown, vec![8]);
        assert!(m.interaction.is_none());
    }

    #[test]
    fn interaction_flags_are_presence() {
        let mut turn = Writer::new();
        turn.message(14, Writer::new());
        let mut w = Writer::new();
        w.message(1, turn);
        let m = ServerMessage::decode(&w.finish()).unwrap();
        assert!(m.interaction.unwrap().turn_ended);
    }
}
