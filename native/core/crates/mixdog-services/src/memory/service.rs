//! The `memory/` namespace: `memory/memoryControl` (the `memory` tool for the
//! host acting for the user) and `memory/recall`. Recall answers from, in
//! order: the configured profile (a "who am I" query), the current session's
//! own messages, the session's stored rows (after the live transcript is
//! ingested), and last the general memory recall.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::AtomicU64;

use async_trait::async_trait;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::Admit;
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use mixdog_js::{JsRegex, js_trim, js_words, json_stringify, slice_utf16, to_number, value_to_string};
use serde_json::{Map, Value, json};

use crate::memory::core::action::{CoreContext, run};
use crate::memory::ingest::SessionIngest;
use crate::memory::pg::db::Db;
use crate::memory::recall::Recall;

/// The session a call belongs to, as the memory domain reads it.
#[derive(Debug, Clone)]
pub struct SessionData {
    pub id: String,
    pub messages: Vec<Value>,
}

/// What the memory domain needs from the session runtime.
#[async_trait]
pub trait SessionSource: Send + Sync {
    /// The thread's active session; None when there is none.
    async fn session(&self, thread_id: Option<&str>) -> Option<SessionData>;
    /// The working directory of the thread, if it has one.
    async fn current_cwd(&self, thread_id: Option<&str>) -> Option<String>;
    /// The configured profile title (the user's name or identity), or empty.
    async fn profile_title(&self) -> String;
}

/// The memory runtime's tool entry: `handleToolCall(name, args)` as text.
#[async_trait]
pub trait MemoryModule: Send + Sync {
    /// The `memory` tool, including `ingest_session`.
    async fn memory(&self, args: Value) -> String;
    /// The `recall` tool.
    async fn recall(&self, args: Value) -> String;
}

/// The memory runtime over the local Postgres. `memory` serves the curated
/// core-memory actions; `ingest_session` stores a live transcript as recall
/// entries through the session ingest it is built with.
pub struct LocalMemory {
    db: Db,
    data_dir: PathBuf,
    revision: AtomicU64,
    recall: Recall,
    ingest: SessionIngest,
    /// The lane project markers and the snapshot file are read and written on.
    lane: mixdog_rt::DurabilityIo,
}

impl LocalMemory {
    pub fn new(db: Db, data_dir: PathBuf, recall: Recall, ingest: SessionIngest, lane: mixdog_rt::DurabilityIo) -> Self {
        Self { db, data_dir, revision: AtomicU64::new(0), recall, ingest, lane }
    }
}

#[async_trait]
impl MemoryModule for LocalMemory {
    async fn memory(&self, args: Value) -> String {
        if args.get("action").and_then(Value::as_str) == Some("ingest_session") {
            return self.ingest.ingest_session(&args).await.unwrap_or_else(|error| error.message());
        }
        let ctx = CoreContext { db: &self.db, data_dir: &self.data_dir, session_cwd: None, snapshot_revision: &self.revision, lane: self.lane };
        run(&ctx, &args).await.text
    }

    async fn recall(&self, args: Value) -> String {
        self.recall.recall(&args).await.text
    }
}

pub struct MemoryService {
    memory: Arc<dyn MemoryModule>,
    sessions: Arc<dyn SessionSource>,
}

static IDENTITY_A: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"(?:내가|나는|나|사용자|유저|user|my|me).*(?:누구|누군|정체|이름|name|identity)|who(?:am)?i", "")
});
static IDENTITY_B: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:나누구냐|나는누구냐|내가누구냐|내이름뭐|내이름뭐야|whoami)$", "i"));
static EMPTY_RESULT: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^\(?no results\)?$|^\(?empty memory result\)?$", "i"));
static TERM: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[\p{L}\p{N}_./:-]{2,}", "gu"));

/// `isIdentityRecallQuery`.
pub fn is_identity_query(query: &str) -> bool {
    let compact: String = js_words(&js_trim(query).to_lowercase()).collect();
    !compact.is_empty() && (IDENTITY_A.is_match(&compact) || IDENTITY_B.is_match(&compact))
}

/// `isEmptyRecallText`.
pub fn is_empty_recall_text(value: &str) -> bool {
    let text = js_trim(value);
    text.is_empty() || EMPTY_RESULT.is_match(text)
}

fn session_message_text(content: Option<&Value>) -> String {
    match content {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => message_parts_text(parts),
        Some(Value::Object(map)) if map.get("content").is_some_and(Value::is_array) => {
            message_parts_text(map["content"].as_array().map_or(&[][..], Vec::as_slice))
        }
        Some(Value::Object(map)) if map.get("text").is_some_and(Value::is_string) => value_to_string(&map["text"]),
        Some(other) => json_stringify(other),
    }
}

fn message_parts_text(parts: &[Value]) -> String {
    parts
        .iter()
        .map(|part| match part {
            Value::String(text) => text.clone(),
            other => match other.get("text") {
                None | Some(Value::Null) => String::new(),
                Some(text) => value_to_string(text),
            },
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// JS truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn message_context_text(message: &Value) -> String {
    let mut text = session_message_text(message.get("content"));
    let role = message.get("role").and_then(Value::as_str);
    if role == Some("assistant")
        && let Some(calls) = message.get("toolCalls").and_then(Value::as_array).filter(|calls| !calls.is_empty())
    {
        text.push('\n');
        text.push_str(&json_stringify(&Value::Array(calls.clone())));
    }
    if role == Some("tool")
        && let Some(id) = message.get("toolCallId").filter(|id| truthy(id))
    {
        text.push('\n');
        text.push_str(&value_to_string(id));
    }
    text
}

/// `currentSessionRecallRows`: the session's own recent messages that match
/// the query, newest first.
pub fn current_session_recall_rows(messages: &[Value], query: &str, limit: Option<&Value>) -> String {
    if messages.is_empty() {
        return "(no results)".into();
    }
    let lowered = query.to_lowercase();
    let mut terms: Vec<&str> = Vec::new();
    for range in TERM.find_iter(&lowered) {
        let term = &lowered[range];
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms.truncate(16);
    let wanted = limit.map_or(f64::NAN, to_number);
    let max = (if wanted.is_nan() || wanted == 0.0 { 10.0 } else { wanted }).clamp(1.0, 100.0);
    let mut rows = Vec::new();
    for (index, message) in messages.iter().enumerate().rev() {
        if rows.len() as f64 >= max {
            break;
        }
        let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
        if !matches!(role, "user" | "assistant" | "tool") {
            continue;
        }
        let text = js_words(&message_context_text(message)).collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }
        let haystack = text.to_lowercase();
        if !terms.is_empty() && !terms.iter().any(|term| haystack.contains(term)) {
            continue;
        }
        rows.push(format!("[session:{}] {role}: {}", index + 1, slice_utf16(&text, 1000)));
    }
    if rows.is_empty() { "(no results)".into() } else { rows.join("\n") }
}

impl MemoryService {
    pub fn new(memory: Arc<dyn MemoryModule>, sessions: Arc<dyn SessionSource>) -> Self {
        Self { memory, sessions }
    }

    async fn memory_control(&self, params: &Value) -> Value {
        let args = params.get("args").filter(|args| truthy(args)).cloned().unwrap_or_else(|| json!({}));
        Value::String(self.memory.memory(args).await)
    }

    /// `recall(query, args)` of the session runtime.
    async fn recall(&self, params: &Value) -> Value {
        let thread = params.get("threadId").and_then(Value::as_str);
        let args = params.get("args").filter(|args| args.is_object()).cloned().unwrap_or_else(|| json!({}));
        let base_query = params
            .get("query")
            .filter(|query| truthy(query))
            .or_else(|| args.get("query").filter(|query| truthy(query)))
            .cloned()
            .unwrap_or_else(|| Value::String(String::new()));
        let query_text = value_to_string(&base_query);
        if is_identity_query(&query_text) {
            let title = self.sessions.profile_title().await;
            let title = js_trim(&title);
            if !title.is_empty() {
                return Value::String(format!(
                    "[profile] Current configured user name/identity: {title}. This profile value is authoritative; ignore stale memory rows that say the user's identity is unknown."
                ));
            }
        }
        let session = self.sessions.session(thread).await.filter(|session| !session.id.is_empty());
        let current_cwd = self.sessions.current_cwd(thread).await;
        let current_session_on = args.get("currentSession") != Some(&Value::Bool(false));
        if let (true, Some(session)) = (current_session_on, &session) {
            let own = current_session_recall_rows(&session.messages, &query_text, args.get("limit"));
            if !is_empty_recall_text(&own) {
                return Value::String(own);
            }
        }
        let mut base_args: Map<String, Value> = args.as_object().cloned().unwrap_or_default();
        base_args.insert("query".into(), base_query);
        let cwd = args.get("cwd").filter(|cwd| truthy(cwd)).cloned().or_else(|| current_cwd.clone().map(Value::String));
        match cwd {
            Some(cwd) => base_args.insert("cwd".into(), cwd),
            None => base_args.shift_remove("cwd"),
        };
        if let Some(session) = &session {
            base_args.insert("currentSessionId".into(), Value::String(session.id.clone()));
        }
        let mut result = String::from("(no results)");
        if let (true, Some(session)) = (current_session_on && args.get("forceCycleOnEmpty") != Some(&Value::Bool(false)), &session)
            && !session.messages.is_empty()
        {
            let mut ingest = Map::new();
            ingest.insert("action".into(), json!("ingest_session"));
            ingest.insert("sessionId".into(), json!(session.id));
            if let Some(cwd) = &current_cwd {
                ingest.insert("cwd".into(), json!(cwd));
            }
            ingest.insert("messages".into(), Value::Array(session.messages.clone()));
            self.memory.memory(Value::Object(ingest)).await;
            let mut scoped = base_args.clone();
            scoped.insert("sessionId".into(), json!(session.id));
            scoped.insert("currentSession".into(), json!(true));
            if !base_args.get("projectScope").is_some_and(truthy) {
                scoped.insert("projectScope".into(), json!("all"));
            }
            scoped.insert("includeRaw".into(), json!(base_args.get("includeRaw") != Some(&Value::Bool(false))));
            scoped.insert("includeArchived".into(), json!(base_args.get("includeArchived") != Some(&Value::Bool(false))));
            result = self.memory.recall(Value::Object(scoped)).await;
        }
        if is_empty_recall_text(&result) {
            result = self.memory.recall(Value::Object(base_args)).await;
        }
        Value::String(result)
    }
}

#[async_trait]
impl DomainService for MemoryService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "memory/memoryControl" => Ok(Reply::Value(self.memory_control(&req.params).await)),
            "memory/recall" => Ok(Reply::Value(self.recall(&req.params).await)),
            _ => Err(CoreError::InvalidParams { path: "method".into(), expected: "memory/*".into() }),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &["memory/memoryControl", "memory/recall"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_queries_are_recognised_after_removing_spaces() {
        assert!(is_identity_query("내가 누구야"));
        assert!(is_identity_query("Who am I"));
        assert!(is_identity_query("whoami"));
        assert!(is_identity_query("what is my name"));
        assert!(!is_identity_query("deploy the cluster"));
        assert!(!is_identity_query(""));
    }

    #[test]
    fn the_session_rows_are_newest_first_filtered_by_terms_and_limited() {
        let messages = vec![
            json!({ "role": "user", "content": "deploy the staging cluster" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "Deploying now" }], "toolCalls": [{ "id": "c1" }] }),
            json!({ "role": "system", "content": "deploy hidden" }),
            json!({ "role": "tool", "toolCallId": "c1", "content": "ok" }),
            json!({ "role": "user", "content": "thanks" }),
        ];
        let rows = current_session_recall_rows(&messages, "deploy", None);
        assert_eq!(
            rows,
            "[session:2] assistant: Deploying now [{\"id\":\"c1\"}]\n[session:1] user: deploy the staging cluster"
        );
        assert_eq!(current_session_recall_rows(&messages, "", Some(&json!(2))).lines().count(), 2);
        assert_eq!(current_session_recall_rows(&messages, "zzz", None), "(no results)");
        assert_eq!(current_session_recall_rows(&[], "x", None), "(no results)");
    }
}
