//! `load_tool` and `call_tool`: the fixed tool bridge. On the bridge `load_tool` describes tools
//! by name (it never grants execution); off it the catalog loads them (`CatalogView::load_native`).
//! `call_tool` runs one deferred tool through the ordinary pipeline, so
//! a bridged call is judged exactly like a direct one. Continuation tokens carry only a
//! position and grant no authority.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::tool::CallProjection;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_js::token_estimate::estimate_tokens;
use mixdog_protocol::ThreadId;
use serde::Serialize;
use serde_json::Value;

use crate::orch::util::JsStr;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::util::spec_from_def;
use super::util::text;

pub const NAME_MAX_CHARS: usize = 256;
pub const CONTINUATION_MAX_CHARS: usize = 4096;
pub const DESCRIBE_MAX_NAMES: usize = 8;
/// A page's budget: bytes and estimated tokens.
pub const DESCRIBE_MAX_BYTES: usize = 16 * 1024;
pub const DESCRIBE_MAX_TOKENS: u64 = 4096;
pub const CONTINUATION_PREFIX: &str = "@continue:";
const SEARCH_MAX_MATCHES: usize = 20;
const SEARCH_DESCRIPTION_CHARS: usize = 100;
const DESCRIBE_NOTE: &str = "Run a deferred tool with call_tool {name, arguments}; call directly defined tools directly. When continueWith is set, call load_tool again with exactly those arguments for the rest.";
const META_NAMES: [&str; 3] = ["load_tool", "call_tool", "tool_search"];

fn is_meta_tool(name: &str) -> bool {
    META_NAMES.contains(&name.to_lowercase().as_str())
}

/// A bridge error: `Error: CODE: message` is the model text (`bridgeErrorText`).
fn bridge_error(code: &str, message: impl AsRef<str>) -> ToolError {
    let text = format!("Error: {code}: {}", message.as_ref());
    let tool_code = match code {
        "TOOL_NOT_FOUND" => ToolErrorCode::NotFound { target: String::new() },
        "TOOL_UNAVAILABLE" | "TOOL_EXCLUDED" => ToolErrorCode::Unavailable { capability: "tool".to_owned(), reason: text.clone() },
        "BRIDGE_RECURSION" | "USE_DIRECT_TOOL" => ToolErrorCode::DeniedByPolicy { rule: code.to_lowercase() },
        _ => ToolErrorCode::InvalidArgs { field: "names".to_owned(), reason: text.clone() },
    };
    ToolError::new(tool_code, text)
}

/// One tool's published definition.
#[derive(Clone, PartialEq, Debug)]
pub struct ToolDoc {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub annotations: Value,
}

/// The document a describe entry carries (key order is the wire order).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Document {
    name: String,
    description: String,
    input_schema: Value,
    annotations: Value,
}

impl From<&ToolDoc> for Document {
    fn from(t: &ToolDoc) -> Self {
        Self {
            name: t.name.clone(),
            description: t.description.clone(),
            input_schema: if t.input_schema.is_object() { t.input_schema.clone() } else { json!({"type":"object","properties":{}}) },
            annotations: if t.annotations.is_object() { t.annotations.clone() } else { json!({}) },
        }
    }
}

/// How `call_tool` finds its target in the session's catalog.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CallResolution {
    /// Directly defined in this session: call it directly.
    Direct(String),
    /// Directly defined but the route never sends it.
    Excluded(String),
    NotFound,
    /// In the catalog but unavailable now.
    Unavailable(String),
    Deferred(String),
}

/// The session's tool catalog: the eager surface plus the deferred catalog, within the
/// session's own allow/deny policy (a tool the policy excludes is unknown here).
#[async_trait]
pub trait CatalogView: Send + Sync {
    /// Every available tool, eager first, in the catalog's stable order.
    fn available(&self, thread: &ThreadId) -> Vec<ToolDoc>;
    fn is_eager(&self, thread: &ThreadId, name: &str) -> bool;
    /// Why a currently available tool cannot run here (denied, route-excluded, read-only).
    fn block_reason(&self, thread: &ThreadId, name: &str) -> Option<String>;
    /// Declared alias groups (`filesystem` → read, list, …), lower-case keys.
    fn alias_members(&self, key: &str) -> Vec<String>;
    /// The tools `mcp__<server>` stands for.
    fn mcp_server_members(&self, thread: &ThreadId, requested: &str) -> Vec<String>;
    /// MCP instruction text for the given tools, counted inside the page budget: the text of each
    /// server the session was not told yet (`pendingMcpInstructions`).
    fn instructions_for(&self, thread: &ThreadId, names: &[String]) -> String;
    /// Records that the session was told the MCP instructions of the servers of `names`
    /// (`announceMcpServers`), so the next page does not repeat them. Called with the entries of
    /// a page that carried instruction text.
    async fn announce(&self, thread: &ThreadId, names: &[String]);
    fn resolve_call(&self, thread: &ThreadId, name: &str) -> CallResolution;
    /// `refreshDeferredMcpToolCatalog(session)` before `load_tool` reads the catalog: the connected names and the
    /// late pool follow the live registry. A catalog that is not fed by one has nothing to refresh.
    async fn refresh(&self, _thread: &ThreadId) {}
    /// `renderToolSearch` on a session that is not on the bridge (native and fixed-surface
    /// providers): the call loads the named deferred tools into the session and answers with what
    /// it did. `None`: the session is on the bridge, and `load_tool` describes.
    /// `Err`: the session could not be read or updated.
    async fn load_native(&self, _thread: &ThreadId, _args: &Value) -> Option<Result<String, String>> {
        None
    }
    /// `catalogLacks`: whether a requested name is not in the deferred catalog.
    fn lacks(&self, _thread: &ThreadId, _names: &[String]) -> bool {
        false
    }
    /// `awaitMcpConnect`: returns once the thread's initial MCP connect settled or its startup budget passed.
    async fn await_connect(&self, _thread: &ThreadId) {}
}

/// The ordinary execution pipeline (policy, hooks, approval, deadline) for a named tool.
#[async_trait]
pub trait ToolDispatcher: Send + Sync {
    async fn dispatch(&self, ctx: &ToolContext, name: &str, arguments: Value) -> ToolOutcome;
}

fn hash16(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn encode_continuation(indexes: &[usize], revision: &str, offset: usize) -> String {
    let payload = json!({"v": 2, "t": indexes, "r": revision, "o": offset}).to_string();
    format!("{CONTINUATION_PREFIX}{}", URL_SAFE_NO_PAD.encode(payload))
}

struct Continuation {
    indexes: Vec<usize>,
    revision: String,
    offset: usize,
}

fn decode_continuation(token: &str) -> Option<Continuation> {
    if token.len() > CONTINUATION_MAX_CHARS {
        return None;
    }
    let body = token.strip_prefix(CONTINUATION_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(body).ok()?;
    // Only the canonical encoding this tool emits is accepted.
    if URL_SAFE_NO_PAD.encode(&bytes) != body {
        return None;
    }
    let payload: Value = serde_json::from_slice(&bytes).ok()?;
    let indexes: Vec<usize> = payload.get("t")?.as_array()?.iter().map(|v| v.as_u64().map(|n| n as usize)).collect::<Option<_>>()?;
    let distinct: HashSet<&usize> = indexes.iter().collect();
    if payload.get("v")?.as_u64()? != 2
        || indexes.is_empty()
        || indexes.len() > DESCRIBE_MAX_NAMES * 10
        || distinct.len() != indexes.len()
    {
        return None;
    }
    Some(Continuation { indexes, revision: payload.get("r")?.as_str()?.to_owned(), offset: payload.get("o")?.as_u64()? as usize })
}

/// `names` as exact tool names: a string or array of strings, split on commas and whitespace.
fn describe_names(raw: &Value) -> Option<Vec<String>> {
    let strings: Vec<&str> = match raw {
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().map(Value::as_str).collect::<Option<_>>()?,
        _ => return None,
    };
    let mut names: Vec<String> = Vec::new();
    for s in strings {
        let s = s.js_trim();
        let s = if s.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("select:")) { &s[7..] } else { s };
        for part in s.split(|c: char| c == ',' || mixdog_js::is_js_space(c)).filter(|p| !p.is_empty()) {
            if !names.iter().any(|n| n == part) {
                names.push(part.to_owned());
            }
        }
    }
    (!names.is_empty() && names.len() <= DESCRIBE_MAX_NAMES && names.iter().all(|n| n.js_len() <= NAME_MAX_CHARS)).then_some(names)
}

#[derive(Serialize, Clone)]
#[serde(untagged)]
enum Entry {
    Whole {
        name: String,
        #[serde(rename = "schemaRevision")]
        schema_revision: String,
        complete: bool,
        document: Document,
    },
    Chunk {
        name: String,
        #[serde(rename = "schemaRevision")]
        schema_revision: String,
        complete: bool,
        offset: usize,
        #[serde(rename = "jsonTextChunk")]
        json_text_chunk: String,
    },
}

#[derive(Serialize, Clone)]
struct Blocked {
    name: String,
    reason: String,
}

#[derive(Serialize, Clone)]
struct MatchTool {
    name: String,
    description: String,
}

#[derive(Serialize, Clone)]
struct Match {
    keyword: String,
    tools: Vec<MatchTool>,
}

#[derive(Serialize, Clone)]
struct ContinueWith {
    names: String,
}

#[derive(Serialize)]
struct Page<'a> {
    entries: &'a [Entry],
    missing: &'a [String],
    blocked: &'a [Blocked],
    #[serde(skip_serializing_if = "<[Match]>::is_empty")]
    matches: &'a [Match],
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    omitted: &'a [String],
    #[serde(rename = "mcpInstructions", skip_serializing_if = "str::is_empty")]
    mcp_instructions: &'a str,
    note: &'static str,
    #[serde(rename = "continueWith")]
    continue_with: Option<&'a ContinueWith>,
}

struct Doc {
    index: usize,
    name: String,
    revision: String,
    value: Document,
    text: String,
}

fn fits(page: &Page<'_>) -> bool {
    let text = serde_json::to_string(page).expect("page serializes");
    text.len() <= DESCRIBE_MAX_BYTES && estimate_tokens(&text) <= DESCRIBE_MAX_TOKENS
}

/// `load_tool` as the session runs it: off the bridge, the catalog's load; on it, the page, and
/// when the page carried MCP instruction text, the record that the session was told it (only the
/// servers of the entries that made the page).
pub async fn load(catalog: &dyn CatalogView, thread: &ThreadId, args: &Value) -> Result<String, ToolError> {
    catalog.refresh(thread).await;
    // A name the catalog does not hold yet may belong to a server still in its handshake: wait for that connect before
    // reporting it missing (`toolSearch`).
    if args.get("names").and_then(describe_names).is_some_and(|names| catalog.lacks(thread, &names)) {
        catalog.await_connect(thread).await;
        catalog.refresh(thread).await;
    }
    if let Some(loaded) = catalog.load_native(thread, args).await {
        return loaded.map_err(|reason| ToolError::new(ToolErrorCode::Unavailable { capability: "session".to_owned(), reason: reason.clone() }, reason));
    }
    let page = describe(catalog, thread, args)?;
    let parsed: Value = serde_json::from_str(&page).expect("a described page is JSON");
    if parsed.get("mcpInstructions").and_then(Value::as_str).is_some_and(|text| !text.is_empty()) {
        let names: Vec<String> = parsed["entries"].as_array().into_iter().flatten().filter_map(|e| e["name"].as_str()).map(|n| n.js_trim().to_owned()).filter(|n| !n.is_empty()).collect();
        catalog.announce(thread, &names).await;
    }
    Ok(page)
}

/// `load_tool`: describes tools by exact name (or keyword), paging long definitions.
pub fn describe(catalog: &dyn CatalogView, thread: &ThreadId, args: &Value) -> Result<String, ToolError> {
    const SYNTAX_HINT: &str = " Use load_tool {\"names\":[\"exact_tool_name\"]}; the required key is names, not name.";
    let Some(object) = args.as_object() else {
        return Err(bridge_error("INVALID_ARGUMENTS", format!("load_tool requires an arguments object.{SYNTAX_HINT}")));
    };
    let extra: Vec<&str> = object.keys().map(String::as_str).filter(|k| *k != "names").collect();
    if !extra.is_empty() {
        let hint = if object.contains_key("query") { " Pass exact names; the deferred tool list names them." } else { "" };
        return Err(bridge_error("INVALID_ARGUMENTS", format!("load_tool does not accept: {}.{hint}{SYNTAX_HINT}", extra.join(", "))));
    }
    let raw = object.get("names").cloned().unwrap_or(Value::Null);
    let strings: Vec<&str> = match &raw {
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    let available = catalog.available(thread);
    let lookup = |name: &str| {
        let key = name.js_trim();
        available.iter().position(|t| t.name == key).or_else(|| available.iter().position(|t| t.name.to_lowercase() == key.to_lowercase()))
    };
    let block = |name: &str| catalog.block_reason(thread, name);

    let continuation = if strings.iter().any(|s| s.contains(CONTINUATION_PREFIX)) {
        let alone = strings.len() == 1 && {
            let t = strings[0].js_trim();
            t.strip_prefix(CONTINUATION_PREFIX).is_some_and(|b| !b.is_empty() && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        };
        if !alone {
            return Err(bridge_error("INVALID_ARGUMENTS", "pass a continuation token alone in names."));
        }
        let invalid = || bridge_error("INVALID_CONTINUATION", "names holds a continuation token this tool did not return.");
        Some(decode_continuation(strings[0].js_trim()).ok_or_else(invalid)?)
    } else {
        None
    };
    let catalog_changed = || {
        bridge_error(
            "CATALOG_CHANGED",
            "the described tools or their schemas changed since this continuation was issued; describe them again by name.",
        )
    };

    let mut targets: Vec<usize> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut blocked: Vec<Blocked> = Vec::new();
    let mut matches: Vec<Match> = Vec::new();
    let mut omitted: Vec<String> = Vec::new();
    if let Some(c) = &continuation {
        for &i in &c.indexes {
            match available.get(i) {
                Some(t) if block(&t.name).is_none() => targets.push(i),
                _ => return Err(catalog_changed()),
            }
        }
    } else {
        let Some(names) = describe_names(&raw) else {
            return Err(bridge_error(
                "INVALID_ARGUMENTS",
                format!("names must be 1-{DESCRIBE_MAX_NAMES} exact tool names of at most {NAME_MAX_CHARS} characters.{SYNTAX_HINT}"),
            ));
        };
        let mut seen = HashSet::new();
        let mut add = |i: usize, targets: &mut Vec<usize>, blocked: &mut Vec<Blocked>| {
            let name = available[i].name.clone();
            if !seen.insert(name.clone()) {
                return;
            }
            match block(&name) {
                Some(reason) => blocked.push(Blocked { name, reason }),
                None => targets.push(i),
            }
        };
        for requested in &names {
            if let Some(i) = lookup(requested) {
                add(i, &mut targets, &mut blocked);
                continue;
            }
            let aliased: Vec<usize> = catalog.alias_members(&requested.to_lowercase()).iter().filter_map(|m| lookup(m)).collect();
            let members = if aliased.is_empty() {
                catalog.mcp_server_members(thread, requested).iter().filter_map(|m| lookup(m)).collect()
            } else {
                aliased
            };
            if members.is_empty() {
                missing.push(requested.clone());
            } else {
                members.into_iter().for_each(|i| add(i, &mut targets, &mut blocked));
            }
        }
        let cap = DESCRIBE_MAX_NAMES * 10;
        if targets.len() > cap {
            omitted = targets.split_off(cap).into_iter().map(|i| available[i].name.clone()).collect();
        }
        // A requested name that is no tool is a keyword: a case-insensitive substring search
        // over the deferred tools this session can run.
        let mut remaining = SEARCH_MAX_MATCHES;
        let keywords = std::mem::take(&mut missing);
        for keyword in keywords {
            let needle = keyword.to_lowercase();
            let tools: Vec<MatchTool> = available
                .iter()
                .filter(|t| {
                    !catalog.is_eager(thread, &t.name)
                        && !is_meta_tool(&t.name)
                        && format!("{} {}", t.name, t.description).to_lowercase().contains(&needle)
                        && block(&t.name).is_none()
                })
                .take(remaining)
                .map(|t| MatchTool { name: t.name.clone(), description: t.description.js_trim().chars().take(SEARCH_DESCRIPTION_CHARS).collect() })
                .collect();
            if tools.is_empty() {
                missing.push(keyword);
            } else {
                remaining -= tools.len();
                matches.push(Match { keyword, tools });
            }
        }
    }

    let docs: Vec<Doc> = targets
        .iter()
        .map(|&i| {
            let value = Document::from(&available[i]);
            let json = serde_json::to_string(&value).expect("document serializes");
            Doc { index: i, name: value.name.clone(), revision: hash16(&json), value, text: json }
        })
        .collect();
    let revision_of = |list: &[Doc]| hash16(&serde_json::to_string(&list.iter().map(|d| (&d.name, &d.revision)).collect::<Vec<_>>()).expect("serializes"));
    let mut offset = 0usize;
    if let Some(c) = &continuation {
        if docs.is_empty() || c.revision != revision_of(&docs) {
            return Err(catalog_changed());
        }
        if c.offset > docs[0].text.js_len() {
            return Err(bridge_error("INVALID_CONTINUATION", "names holds a continuation token this tool did not return."));
        }
        offset = c.offset;
    }

    let instructions_of = |entries: &[Entry]| -> String {
        let names: Vec<String> = entries.iter().map(|e| match e { Entry::Whole { name, .. } | Entry::Chunk { name, .. } => name.clone() }).collect();
        catalog.instructions_for(thread, &names)
    };
    let reserve = ContinueWith { names: encode_continuation(&vec![available.len(); docs.len()], &"f".repeat(16), 99_999_999) };
    let build = |entries: &[Entry], missing: &[String], blocked: &[Blocked], matches: &[Match], omitted: &[String], instructions: &str, cont: Option<&ContinueWith>| {
        serde_json::to_string(&Page { entries, missing, blocked, matches, omitted, mcp_instructions: instructions, note: DESCRIBE_NOTE, continue_with: cont }).expect("page serializes")
    };

    let mut entries: Vec<Entry> = Vec::new();
    let mut next_position: Option<(usize, usize)> = None;
    let mut entry_index = 0;
    while entry_index < docs.len() {
        let doc = &docs[entry_index];
        if offset == 0 {
            let whole = || Entry::Whole { name: doc.name.clone(), schema_revision: doc.revision.clone(), complete: true, document: doc.value.clone() };
            let mut trial = std::mem::take(&mut entries);
            trial.push(whole());
            let instr = instructions_of(&trial);
            let page = Page { entries: &trial, missing: &missing, blocked: &blocked, matches: &matches, omitted: &omitted, mcp_instructions: &instr, note: DESCRIBE_NOTE, continue_with: Some(&reserve) };
            if fits(&page) {
                entries = trial;
                entry_index += 1;
                continue;
            }
            trial.pop();
            entries = trial;
            // A document that fits on a page of its own starts the next page whole.
            let alone = vec![whole()];
            let instr = instructions_of(&alone);
            let page = Page { entries: &alone, missing: &missing, blocked: &blocked, matches: &matches, omitted: &omitted, mcp_instructions: &instr, note: DESCRIBE_NOTE, continue_with: Some(&reserve) };
            if !entries.is_empty() && fits(&page) {
                next_position = Some((entry_index, 0));
                break;
            }
        }
        let chars: Vec<char> = doc.text.chars().collect();
        let chunk_entry = |len: usize| Entry::Chunk {
            name: doc.name.clone(),
            schema_revision: doc.revision.clone(),
            complete: offset + len >= chars.len(),
            offset,
            json_text_chunk: chars[offset..offset + len].iter().collect(),
        };
        let try_len = |len: usize, entries: &[Entry]| -> bool {
            let mut trial = entries.to_vec();
            trial.push(chunk_entry(len));
            let instr = instructions_of(&trial);
            fits(&Page { entries: &trial, missing: &missing, blocked: &blocked, matches: &matches, omitted: &omitted, mcp_instructions: &instr, note: DESCRIBE_NOTE, continue_with: Some(&reserve) })
        };
        let (mut low, mut high) = (0usize, chars.len() - offset);
        while low < high {
            let middle = (low + high).div_ceil(2);
            if try_len(middle, &entries) { low = middle } else { high = middle - 1 }
        }
        if low == 0 {
            if entries.is_empty() {
                return Err(bridge_error("RESULT_TOO_LARGE", "the description cannot fit in one result."));
            }
            next_position = Some((entry_index, offset));
            break;
        }
        entries.push(chunk_entry(low));
        if offset + low < chars.len() {
            next_position = Some((entry_index, offset + low));
            break;
        }
        entry_index += 1;
        offset = 0;
    }
    let continue_with = match next_position {
        Some((at, off)) => {
            let rest = &docs[at..];
            let token = encode_continuation(&rest.iter().map(|d| d.index).collect::<Vec<_>>(), &revision_of(rest), off);
            if token.len() > CONTINUATION_MAX_CHARS {
                return Err(bridge_error("RESULT_TOO_LARGE", "the remaining definitions cannot be continued; describe fewer tools at once."));
            }
            Some(ContinueWith { names: token })
        }
        None => None,
    };
    let instr = instructions_of(&entries);
    Ok(build(&entries, &missing, &blocked, &matches, &omitted, &instr, continue_with.as_ref()))
}

pub struct LoadTool {
    spec: ToolSpec,
    catalog: Arc<dyn CatalogView>,
}

impl LoadTool {
    pub fn new(catalog: Arc<dyn CatalogView>) -> Self {
        // Loading mutates the active tool surface and must run on every explicit call so a
        // repeat can report what is already active: the loop never deduplicates it by name.
        let spec = spec_from_def(include_str!("defs/load_tool.json"), true, &[]);
        Self { spec, catalog }
    }
}

#[async_trait]
impl Tool for LoadTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        text(load(self.catalog.as_ref(), &ctx.thread_id, &args).await?)
    }
}

pub struct CallTool {
    spec: ToolSpec,
    catalog: Arc<dyn CatalogView>,
    dispatcher: Arc<dyn ToolDispatcher>,
}

impl CallTool {
    pub fn new(catalog: Arc<dyn CatalogView>, dispatcher: Arc<dyn ToolDispatcher>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/call_tool.json"), false, &[]), catalog, dispatcher }
    }
}

impl CallTool {
    /// `resolveExecutionToolCall`: the target a wire call stands for and its arguments. A
    /// malformed call, or one naming no tool of this session, is answered with the bridge error
    /// and never executed.
    fn project_call(&self, thread: &ThreadId, args: &JsonValue) -> Result<(String, JsonValue), ToolError> {
        let Some(object) = args.as_object() else {
            return Err(bridge_error("INVALID_ARGUMENTS", "call_tool requires {name, arguments}."));
        };
        let extra: Vec<&str> = object.keys().map(String::as_str).filter(|k| *k != "name" && *k != "arguments").collect();
        if !extra.is_empty() {
            return Err(bridge_error("INVALID_ARGUMENTS", format!("call_tool does not accept: {}.", extra.join(", "))));
        }
        if !object.get("arguments").is_some_and(Value::is_object) {
            return Err(bridge_error("INVALID_ARGUMENTS", "call_tool arguments must be an object of the target tool arguments."));
        }
        let name = args.get("name").and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or_default();
        if name.is_empty() || name.js_len() > NAME_MAX_CHARS {
            return Err(bridge_error("INVALID_ARGUMENTS", format!("name must be 1-{NAME_MAX_CHARS} characters.")));
        }
        if is_meta_tool(name) {
            return Err(bridge_error("BRIDGE_RECURSION", format!("call_tool cannot run the bridge tool \"{name}\"; call it directly.")));
        }
        let target = match self.catalog.resolve_call(thread, name) {
            CallResolution::Direct(direct) => {
                return Err(bridge_error("USE_DIRECT_TOOL", format!("\"{direct}\" is directly available; call {direct} directly instead of call_tool.")));
            }
            CallResolution::Excluded(reason) => return Err(bridge_error("TOOL_EXCLUDED", reason)),
            CallResolution::NotFound => {
                return Err(bridge_error(
                    "TOOL_NOT_FOUND",
                    format!("no tool named \"{name}\" is available in this session; find tools with load_tool {{names: keyword}}."),
                ));
            }
            CallResolution::Unavailable(canonical) => {
                return Err(bridge_error("TOOL_UNAVAILABLE", format!("tool \"{canonical}\" is unavailable in the current session catalog; no call was sent.")));
            }
            CallResolution::Deferred(canonical) => canonical,
        };
        Ok((target, args["arguments"].clone()))
    }
}

impl CallProjection for CallTool {
    fn project(&self, thread: &ThreadId, arguments: &JsonValue) -> Result<(String, JsonValue), String> {
        self.project_call(thread, arguments).map_err(|error| error.message_for_model)
    }
}

#[async_trait]
impl Tool for CallTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn projection(&self) -> Option<&dyn CallProjection> {
        Some(self)
    }

    /// Reached only by a caller that does not project (the loop does): the target runs through
    /// the dispatcher's pipeline.
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let (target, arguments) = self.project_call(&ctx.thread_id, &args)?;
        self.dispatcher.dispatch(ctx, &target, arguments).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Catalog(Vec<ToolDoc>);

    #[async_trait]
    impl CatalogView for Catalog {
        async fn announce(&self, _: &ThreadId, _: &[String]) {}
        fn available(&self, _: &ThreadId) -> Vec<ToolDoc> {
            self.0.clone()
        }
        fn is_eager(&self, _: &ThreadId, name: &str) -> bool {
            name == "read"
        }
        fn block_reason(&self, _: &ThreadId, name: &str) -> Option<String> {
            (name == "shell").then(|| "readonly mode".to_owned())
        }
        fn alias_members(&self, key: &str) -> Vec<String> {
            if key == "web" { vec!["web_fetch".into()] } else { Vec::new() }
        }
        fn mcp_server_members(&self, _: &ThreadId, _: &str) -> Vec<String> {
            Vec::new()
        }
        fn instructions_for(&self, _: &ThreadId, _: &[String]) -> String {
            String::new()
        }
        fn resolve_call(&self, _: &ThreadId, _: &str) -> CallResolution {
            CallResolution::NotFound
        }
    }

    fn doc(name: &str, description: &str, pad: usize) -> ToolDoc {
        ToolDoc {
            name: name.into(),
            description: description.into(),
            input_schema: json!({"type":"object","properties":{"p":{"description":"x".repeat(pad)}}}),
            annotations: json!({"title": name}),
        }
    }

    fn catalog() -> Catalog {
        Catalog(vec![doc("read", "reads", 0), doc("web_fetch", "fetch a page", 0), doc("shell", "runs", 0), doc("huge", "big schema", 40_000)])
    }

    fn thread() -> ThreadId {
        ThreadId("t".into())
    }

    /// `load_tool` is declared as Node declares it (read-only, idempotent); the loop leaves it out
    /// of the dedup by name (`dedup_eligible`).
    #[test]
    fn load_tool_carries_nodes_own_hints() {
        let tool = LoadTool::new(Arc::new(catalog()));
        assert_eq!(tool.spec().annotations.idempotent_hint, Some(true));
        assert_eq!(tool.spec().annotations.read_only_hint, Some(true));
    }

    #[test]
    fn exact_names_alias_blocked_and_keyword_are_resolved() {
        let out = describe(&catalog(), &thread(), &json!({"names": ["read", "web", "shell", "fetch", "nothing"]})).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let names: Vec<&str> = v["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["read", "web_fetch"]);
        assert_eq!(v["blocked"], json!([{"name":"shell","reason":"readonly mode"}]));
        assert_eq!(v["matches"][0]["keyword"], "fetch");
        assert_eq!(v["missing"], json!(["nothing"]));
        assert_eq!(v["continueWith"], Value::Null);
    }

    #[test]
    fn long_definitions_page_through_continuation_tokens() {
        let c = catalog();
        let mut args = json!({"names": ["huge"]});
        let mut text = String::new();
        for _ in 0..10 {
            let out = describe(&c, &thread(), &args).unwrap();
            assert!(out.len() <= DESCRIBE_MAX_BYTES);
            let v: Value = serde_json::from_str(&out).unwrap();
            for e in v["entries"].as_array().unwrap() {
                text.push_str(e["jsonTextChunk"].as_str().unwrap());
            }
            match v["continueWith"].get("names") {
                Some(n) => args = json!({"names": n}),
                None => break,
            }
        }
        let doc: Value = serde_json::from_str(&text).expect("chunks reassemble");
        assert_eq!(doc["name"], "huge");
    }

    /// A catalog whose MCP server is still connecting: the tool joins it when the wait for the connect ends.
    struct Connecting {
        tools: std::sync::Mutex<Vec<ToolDoc>>,
        waits: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl CatalogView for Connecting {
        async fn announce(&self, _: &ThreadId, _: &[String]) {}
        fn available(&self, _: &ThreadId) -> Vec<ToolDoc> {
            self.tools.lock().unwrap().clone()
        }
        fn is_eager(&self, _: &ThreadId, _: &str) -> bool {
            false
        }
        fn block_reason(&self, _: &ThreadId, _: &str) -> Option<String> {
            None
        }
        fn alias_members(&self, _: &str) -> Vec<String> {
            Vec::new()
        }
        fn mcp_server_members(&self, _: &ThreadId, _: &str) -> Vec<String> {
            Vec::new()
        }
        fn instructions_for(&self, _: &ThreadId, _: &[String]) -> String {
            String::new()
        }
        fn resolve_call(&self, _: &ThreadId, _: &str) -> CallResolution {
            CallResolution::NotFound
        }
        fn lacks(&self, _: &ThreadId, names: &[String]) -> bool {
            let tools = self.tools.lock().unwrap();
            names.iter().any(|name| !tools.iter().any(|t| &t.name == name))
        }
        async fn await_connect(&self, _: &ThreadId) {
            self.waits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.tools.lock().unwrap().push(doc("mcp__stub__echo", "echoes", 0));
        }
    }

    /// A name the catalog lacks waits for the connect in flight before it is reported missing (`toolSearch`); a name it holds never waits.
    #[tokio::test]
    async fn a_missing_name_waits_for_the_connect_in_flight() {
        let c = Connecting { tools: std::sync::Mutex::new(vec![doc("read", "reads", 0)]), waits: Default::default() };
        let page: Value = serde_json::from_str(&load(&c, &thread(), &json!({"names": ["mcp__stub__echo"]})).await.unwrap()).unwrap();
        assert_eq!(page["missing"], json!([]));
        assert_eq!(page["entries"][0]["name"], "mcp__stub__echo");
        load(&c, &thread(), &json!({"names": ["read", "mcp__stub__echo"]})).await.unwrap();
        assert_eq!(c.waits.load(std::sync::atomic::Ordering::SeqCst), 1, "a catalog that holds every name never waits");
    }

    #[tokio::test]
    async fn unprojectable_call_tool_answers_with_the_bridge_error() {
        struct Never;
        #[async_trait]
        impl ToolDispatcher for Never {
            async fn dispatch(&self, _: &ToolContext, _: &str, _: Value) -> ToolOutcome {
                panic!("never executed")
            }
        }
        let tool = CallTool::new(Arc::new(catalog()), Arc::new(Never));
        let ctx = super::super::tests::ctx();
        for (args, want) in [
            (json!("x"), "Error: INVALID_ARGUMENTS: call_tool requires {name, arguments}."),
            (json!({"name":"web_fetch","arguments":{},"extra":1}), "Error: INVALID_ARGUMENTS: call_tool does not accept: extra."),
            (json!({"name":"web_fetch"}), "Error: INVALID_ARGUMENTS: call_tool arguments must be an object of the target tool arguments."),
            (json!({"name":"load_tool","arguments":{}}), "Error: BRIDGE_RECURSION: call_tool cannot run the bridge tool \"load_tool\"; call it directly."),
            (json!({"name":"web_fetch","arguments":{}}), "Error: TOOL_NOT_FOUND: no tool named \"web_fetch\" is available in this session; find tools with load_tool {names: keyword}."),
        ] {
            assert_eq!(tool.call(&ctx, args).await.unwrap_err().message_for_model, want);
        }
    }

    #[test]
    fn bad_input_and_tampered_tokens_are_refused() {
        let c = catalog();
        let err = describe(&c, &thread(), &json!({"name":"read"})).unwrap_err();
        assert!(err.message_for_model.starts_with("Error: INVALID_ARGUMENTS: load_tool does not accept: name."));
        let err = describe(&c, &thread(), &json!({"names": "@continue:AAAA"})).unwrap_err();
        assert!(err.message_for_model.starts_with("Error: INVALID_CONTINUATION:"));
        let err = describe(&c, &thread(), &json!({"names": ["a", "@continue:AAAA"]})).unwrap_err();
        assert_eq!(err.message_for_model, "Error: INVALID_ARGUMENTS: pass a continuation token alone in names.");
    }
}
