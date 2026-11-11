//! A member's pending approval as its room shows it, and the room's answer to it.
//!
//! Node's room reads the speaking member's `state.toolApproval` (`agent-room-turn.ts:278`): the
//! hook request the caller put to the session's approval queue, as the queue presents it
//! (`tool-approval-request.mjs` `normalizeToolApprovalRequest`, with `humanRequestFields`), and
//! shows it unchanged in the room view (`agent-room-views.ts` `decorateRoomSnapshot`). Here a
//! pending approval is the session's `ApprovalRequest` (the server request of the approval
//! book), so [`tool_approval`] rebuilds the hook request Node's caller would have sent from it
//! ([`hook_request`]) and presents it the same way. The room answers through the session's
//! one decision path ([`SessionDirectory::answer_member_approval`]): the server-request response
//! a client sends, so there is one approval mechanism.
//!
//! Recorded from Node per kind: `fixtures/room-approvals/golden.json`.

use mixdog_app_protocol::v2::thread::ThreadRoomView;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::domain::approval::ApprovalRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::thread::Decision;
use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_protocol::ConnectionKind;
use mixdog_tools::policy::action::GrantKey;
use mixdog_tools::state::handoff::login_page_url;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;

type Obj = Map<String, Value>;

const HUMAN_REQUEST_KINDS: [&str; 6] = ["approval", "outbound", "secret", "takeover", "permission", "connector"];
const CONNECTOR_WIDEN_LEVELS: [&str; 2] = ["needs_approval", "auto"];
const CONNECTOR_LEVELS: [&str; 3] = ["disabled", "needs_approval", "auto"];
const REMEMBER_SCOPES: [&str; 4] = ["once", "session", "agent", "always"];
const SECRET_FORMS: [&str; 4] = ["login", "password", "new-password", "otp"];
const DETAIL_FIELDS: [&str; 11] = ["to", "cc", "subject", "merchant", "amount", "currency", "recurrence", "count", "size", "messages", "more"];
const TEXT_LIMIT: usize = 200;
const PAYLOAD_LIMIT: usize = 40_000;

/// JavaScript truthiness of a stored value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn is_record(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

/// `text(value, limit)`: a string, trimmed, at most `limit` UTF-16 units; '' for anything else.
fn text(value: Option<&Value>, limit: usize) -> String {
    match value {
        Some(Value::String(s)) => slice_utf16(js_trim(s), limit),
        _ => String::new(),
    }
}

/// `/^[\w.:#@-]+$/.test(text(value, limit)) ? text(value, limit) : ''`.
fn token(value: Option<&Value>, limit: usize) -> String {
    let t = text(value, limit);
    let ok = !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '#' | '@' | '-'));
    if ok { t } else { String::new() }
}

/// `isRememberableAction(kind)`: an action kind other than a payment or permanent delete, or a
/// per-tool key whose tool may be remembered.
fn rememberable(action: &str) -> bool {
    GrantKey::parse(action).is_some_and(|key| key.rememberable())
}

/// `rememberScopes(value)`: `once` first, then the listed known scopes, each once.
fn remember_scopes(value: Option<&Value>) -> Vec<String> {
    let mut scopes = vec!["once".to_owned()];
    for scope in value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if REMEMBER_SCOPES.contains(&scope) && scope != "once" && !scopes.iter().any(|s| s == scope) {
            scopes.push(scope.to_owned());
        }
    }
    scopes
}

fn kind_of(input: &Obj) -> Option<&str> {
    input.get("kind").and_then(Value::as_str)
}

/// `grantActionOf(input)`.
fn grant_action_of(input: &Obj) -> String {
    match kind_of(input) {
        Some("outbound") => text(input.get("outbound").and_then(|o| o.get("category")), TEXT_LIMIT),
        Some("approval") => text(input.get("grantAction"), TEXT_LIMIT),
        _ => String::new(),
    }
}

/// `offeredScopes(input)`.
fn offered_scopes(input: &Obj) -> Vec<String> {
    let scopes = remember_scopes(input.get("remember"));
    let action = grant_action_of(input);
    if !action.is_empty() && !rememberable(&action) {
        return vec!["once".to_owned()];
    }
    if action.is_empty() { scopes.into_iter().filter(|s| s != "session" && s != "always").collect() } else { scopes }
}

/// `humanRequestFields(input)`: the kind-specific fields, whitelisted, plus the bound `account`.
fn human_request_fields(input: &Obj) -> Obj {
    let mut fields = Obj::new();
    let account = text(input.get("account"), TEXT_LIMIT);
    if !account.is_empty() {
        fields.insert("account".into(), json!(account));
    }
    let Some(kind) = kind_of(input).filter(|kind| HUMAN_REQUEST_KINDS.contains(kind)) else { return fields };
    fields.insert("remember".into(), json!(offered_scopes(input)));
    let agent = text(input.get("agentId"), TEXT_LIMIT);
    if !agent.is_empty() {
        fields.insert("agentId".into(), json!(agent));
    }
    if kind == "approval" {
        let grant = grant_action_of(input);
        if !grant.is_empty() && rememberable(&grant) {
            fields.insert("grantAction".into(), json!(grant));
        }
    }
    if kind == "outbound" && is_record(input.get("outbound")) {
        let outbound = &input["outbound"];
        let details = outbound.get("details").filter(|d| d.is_object());
        let mut shown = Obj::new();
        for name in DETAIL_FIELDS {
            let value = details.and_then(|d| d.get(name));
            if !text(value, TEXT_LIMIT).is_empty() {
                let limit = if name == "messages" { 1_000 } else { TEXT_LIMIT };
                shown.insert(name.into(), json!(text(value, limit)));
            }
        }
        let payload = match outbound.get("payload") {
            Some(Value::String(s)) => slice_utf16(s, PAYLOAD_LIMIT),
            _ => String::new(),
        };
        let editable: Vec<Value> = outbound.get("editable").and_then(Value::as_array).into_iter().flatten().filter(|v| v.is_string()).cloned().collect();
        fields.insert(
            "outbound".into(),
            json!({
                "category": text(outbound.get("category"), TEXT_LIMIT),
                "target": text(outbound.get("target"), TEXT_LIMIT),
                "account": text(outbound.get("account"), TEXT_LIMIT),
                "payload": payload,
                "editable": editable,
                "details": shown,
            }),
        );
    }
    if kind == "secret" {
        let secret = input.get("secret").filter(|s| s.is_object()).cloned().unwrap_or_else(|| json!({}));
        let origin = match secret.get("origin") {
            Some(Value::String(url)) => login_page_url(url).map(|page| page.origin).unwrap_or_default(),
            _ => String::new(),
        };
        let form = secret.get("form").and_then(Value::as_str).filter(|f| SECRET_FORMS.contains(f)).unwrap_or_default().to_owned();
        let length = secret.get("length").and_then(Value::as_u64).filter(|n| *n > 0);
        let surface = if secret.get("surface").and_then(Value::as_str) == Some("computer") { "computer" } else { "browser" };
        let (target, field) = (text(secret.get("target"), TEXT_LIMIT), text(secret.get("field"), TEXT_LIMIT));
        let mut shown = Obj::new();
        shown.insert("requestId".into(), json!(text(secret.get("requestId"), TEXT_LIMIT)));
        shown.insert("surface".into(), json!(surface));
        shown.insert("target".into(), json!(target));
        shown.insert("field".into(), json!(field));
        if !origin.is_empty() {
            shown.insert("origin".into(), json!(origin));
        }
        if !form.is_empty() {
            shown.insert("form".into(), json!(form));
        }
        if let (Some(length), true) = (length, form == "otp") {
            shown.insert("length".into(), json!(length));
        }
        fields.insert("secret".into(), Value::Object(shown));
        fields.insert("args".into(), json!({ "surface": surface, "target": target, "field": field }));
        fields.insert("remember".into(), json!(["once"]));
    }
    if kind == "takeover" {
        let takeover = input.get("takeover").filter(|t| t.is_object()).cloned().unwrap_or_else(|| json!({}));
        let surface = if takeover.get("surface").and_then(Value::as_str) == Some("computer") { "computer" } else { "browser" };
        let mut shown = Obj::new();
        shown.insert("surface".into(), json!(surface));
        shown.insert("instructions".into(), json!(text(takeover.get("instructions"), 2_000)));
        let target = text(takeover.get("target"), TEXT_LIMIT);
        if !target.is_empty() {
            shown.insert("target".into(), json!(target));
        }
        if surface == "browser" {
            let tab = token(takeover.get("tab"), 64);
            if !tab.is_empty() {
                shown.insert("tab".into(), json!(tab));
            }
        } else {
            let window = token(takeover.get("windowId"), 128);
            if !window.is_empty() {
                shown.insert("windowId".into(), json!(window));
            }
            let app = text(takeover.get("app"), 120);
            if !app.is_empty() {
                shown.insert("app".into(), json!(app));
            }
        }
        let login = match (surface, takeover.get("purpose").and_then(Value::as_str), takeover.get("url")) {
            ("browser", Some("login"), Some(Value::String(url))) => login_page_url(url),
            _ => None,
        };
        let accounts: Vec<Value> = match &login {
            Some(_) => takeover
                .get("accounts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|a| a.is_object() && !token(a.get("id"), 128).is_empty() && !text(a.get("label"), 120).is_empty())
                .map(|a| json!({ "id": token(a.get("id"), 128), "label": text(a.get("label"), 120) }))
                .collect(),
            None => Vec::new(),
        };
        let fill = text(takeover.get("fillId"), 100);
        let fill_ok = fill.strip_prefix("secret_").is_some_and(|rest| (8..=80).contains(&rest.len()) && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        if let Some(page) = login {
            shown.insert("purpose".into(), json!("login"));
            shown.insert("url".into(), json!(page.url));
            shown.insert("origin".into(), json!(page.origin));
        }
        if !accounts.is_empty() && fill_ok {
            shown.insert("accounts".into(), Value::Array(accounts));
            shown.insert("fillId".into(), json!(fill));
        }
        fields.insert("takeover".into(), Value::Object(shown));
        fields.insert("remember".into(), json!(["once"]));
    }
    if kind == "permission" {
        let scopes: Vec<Value> = input
            .get("permission")
            .and_then(|p| p.get("scopes"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|s| s.is_object() && !text(s.get("id"), TEXT_LIMIT).is_empty())
            .map(|s| {
                let id = text(s.get("id"), TEXT_LIMIT);
                let label = text(s.get("label"), TEXT_LIMIT);
                let mut scope = json!({ "id": id, "label": if label.is_empty() { id.clone() } else { label } });
                let kind = text(s.get("kind"), TEXT_LIMIT);
                if !kind.is_empty() {
                    scope["kind"] = json!(kind);
                }
                scope
            })
            .collect();
        fields.insert("permission".into(), json!({ "scopes": scopes }));
    }
    if kind == "connector" {
        let connector = input.get("connector").filter(|c| c.is_object()).cloned().unwrap_or_else(|| json!({}));
        let level = |key: &str| connector.get(key).and_then(Value::as_str).filter(|v| CONNECTOR_LEVELS.contains(v)).unwrap_or_default().to_owned();
        let choices: Vec<Value> = connector
            .get("choices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|c| c.as_str().is_some_and(|c| CONNECTOR_WIDEN_LEVELS.contains(&c)))
            .cloned()
            .collect();
        fields.insert(
            "connector".into(),
            json!({
                "server": text(connector.get("server"), TEXT_LIMIT),
                "tool": text(connector.get("tool"), TEXT_LIMIT),
                "from": level("from"),
                "requested": level("requested"),
                "choices": choices,
            }),
        );
        fields.insert("remember".into(), json!(["once"]));
    }
    fields
}

/// `normalizeToolApprovalRequest(input, id, null)` at `now` (the queue's default wait limit is
/// none unless the runtime configures one).
pub fn normalize_tool_approval_request(input: &Obj, id: &str, now: i64) -> Value {
    let first = |keys: &[&str]| keys.iter().map(|key| input.get(*key)).find(|value| truthy(*value)).flatten().cloned();
    let timeout = match input.get("timeoutMs") {
        Some(Value::Null) => None,
        Some(value) => Some(mixdog_js::to_number(value)).filter(|n| n.is_finite() && *n > 0.0),
        None => None,
    };
    let name = first(&["name", "tool_name"]).map_or_else(|| "tool".to_owned(), |v| mixdog_js::value_to_string(&v));
    let reason = first(&["reason", "message"]).map_or_else(|| "approval requested by hook".to_owned(), |v| mixdog_js::value_to_string(&v));
    let args = input.get("args").filter(|v| !v.is_null()).or_else(|| input.get("tool_input").filter(|v| !v.is_null())).cloned().unwrap_or(Value::Null);
    let mut out = json!({
        "id": id,
        "name": name,
        "kind": kind_of(input).unwrap_or_default(),
        "args": args,
        "cwd": first(&["cwd"]).unwrap_or(Value::Null),
        "sessionId": first(&["sessionId", "session_id"]).unwrap_or(Value::Null),
        "toolCallId": first(&["toolCallId", "tool_use_id"]).unwrap_or(Value::Null),
        "reason": js_trim(&reason),
        "requestedAt": now,
        "timeoutMs": timeout.map_or(Value::Null, mixdog_js::json_number),
        "expiresAt": timeout.map_or(Value::Null, |ms| mixdog_js::json_number(now as f64 + ms)),
    });
    if let Value::Object(map) = &mut out {
        map.extend(human_request_fields(input));
    }
    out
}

/// The hook request Node's caller puts to the queue for the request the approval book holds:
/// - `ask_user` (`ask-user-tool.mjs:248`): `{ name, kind: 'question', args: { questions }, reason: '', timeoutMs: null }`;
/// - `handoff_user` secret (`:137`): `{ name, kind: 'secret', secret, reason: '', timeoutMs }`, the
///   request's own expiry (`SECRET_REQUEST_TIMEOUT_MS`);
/// - `handoff_user` takeover (`:175`): `{ name, kind: 'takeover', takeover, args: { surface,
///   instructions }, reason: '', timeoutMs: null }`. Node's card has no wait limit; the expiry the
///   Rust takeover request carries is its own and is not shown;
/// - every gate kind (`tool-helpers.mjs:222`): the gate's request as the book holds it (`name`,
///   `args`, `cwd`, `reason`, `kind`, ...).
///
/// Each with the session and the tool call.
pub fn hook_request(request: &ApprovalRequest) -> Obj {
    let ask = &request.ask;
    let payload = ask.payload.as_object().cloned().unwrap_or_default();
    let tool = ask.tool.as_deref().unwrap_or_default();
    let mut input = match (ask.kind, tool, payload.get("kind").and_then(Value::as_str)) {
        (ApprovalKind::UserInput, "ask_user", _) => {
            json!({ "name": "ask_user", "kind": "question", "args": Value::Object(payload), "reason": "", "timeoutMs": null })
        }
        (_, "handoff_user", Some("secret")) => {
            let timeout = ask.expires_after.map_or(Value::Null, |after| json!(after.as_millis() as u64));
            json!({ "name": "handoff_user", "kind": "secret", "secret": payload.get("secret").cloned().unwrap_or(Value::Null), "reason": "", "timeoutMs": timeout })
        }
        (_, "handoff_user", Some("takeover")) => {
            let takeover = payload.get("takeover").cloned().unwrap_or(Value::Null);
            let args = json!({ "surface": takeover.get("surface").cloned().unwrap_or(Value::Null), "instructions": takeover.get("instructions").cloned().unwrap_or(Value::Null) });
            json!({ "name": "handoff_user", "kind": "takeover", "takeover": takeover, "args": args, "reason": "", "timeoutMs": null })
        }
        _ => Value::Object(payload),
    };
    if let Value::Object(map) = &mut input {
        map.insert("sessionId".into(), json!(request.thread_id.as_str()));
        map.insert("toolCallId".into(), ask.call_id.as_ref().map_or(Value::Null, |id| json!(id.as_str())));
        return std::mem::take(map);
    }
    Obj::new()
}

/// The id the phone's card and its result show for approval `aid` (the server request's id). Node's card took the session's next
/// row id (`requestToolApproval`: `const id = nextId()`, tool-approval.mjs:224), so its card's id is row-shaped and drawn before
/// the call's row; the core's is derived from the approval, so the card, its `toolApprovalResult` and an answer name the same one
/// without a table.
pub fn card_id(aid: &str) -> String {
    use std::hash::Hash;
    use std::hash::Hasher;
    let half = |salt: u8| {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        (salt, "approval-card", aid).hash(&mut hasher);
        hasher.finish()
    };
    format!("itm_{:016x}{:016x}", half(0), half(1))
}

/// Node's `state.toolApproval` for the request the session shows: [`hook_request`] presented
/// as the queue does, its id the server request's.
pub fn tool_approval(request: &ApprovalRequest) -> Value {
    let requested_at = request.requested_at.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    normalize_tool_approval_request(&hook_request(request), &request.id.0.to_string(), requested_at)
}

/// What the room runner keeps of an exchange for the view (`RunState`'s `speaking`,
/// `speakingName`, `typingId`, `approval`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoomViewState {
    pub speaking: String,
    pub speaking_name: String,
    pub typing_id: String,
    /// The speaking member's [`tool_approval`].
    pub approval: Option<Value>,
}

/// The `roomView` section of a room log (`thread/roomView/updated`): what
/// `decorateRoomSnapshot(state, snapshot, handoffQuestions)` lays over the log's own state. `None`
/// when there is nothing to lay (no exchange state, no handed-off questions).
pub fn room_view(state: Option<&RoomViewState>, handoff_questions: &[Value]) -> Option<ThreadRoomView> {
    let questions = (!handoff_questions.is_empty()).then(|| handoff_questions.to_vec());
    let Some(state) = state else { return questions.map(|q| ThreadRoomView { handoff_questions: Some(q), ..ThreadRoomView::default() }) };
    let typing = (!state.speaking.is_empty()).then(|| {
        json!({
            "kind": "notice",
            "id": state.typing_id,
            "tone": "info",
            "text": format!("{}…", state.speaking_name),
            "room": { "kind": "typing", "speaker": state.speaking, "name": state.speaking_name },
        })
    });
    Some(ThreadRoomView {
        busy: true,
        tool_approval: state.approval.clone().filter(|a| truthy(Some(a))),
        typing,
        handoff_questions: questions,
    })
}

/// A room log's state with its `roomView` laid over it, as the client fold does
/// (`packages/protocol-client` `desktopSessionState`): `busy` while the room has an exchange
/// state, its `toolApproval`, the questions, and the typing row after the transcript.
pub fn apply_room_view(snapshot: &Value, view: Option<&ThreadRoomView>) -> Value {
    let (Value::Object(base), Some(view)) = (snapshot, view) else { return snapshot.clone() };
    let mut out = base.clone();
    if view.busy {
        out.insert("busy".into(), json!(true));
    }
    if let Some(approval) = &view.tool_approval {
        out.insert("toolApproval".into(), approval.clone());
    }
    if let Some(questions) = &view.handoff_questions {
        out.insert("handoffQuestions".into(), Value::Array(questions.clone()));
    }
    if view.busy {
        let mut items = base.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        items.extend(view.typing.clone());
        out.insert("items".into(), Value::Array(items));
    }
    Value::Object(out)
}

/// `decorateRoomSnapshot(state, snapshot, handoffQuestions)`: the room log as its views see it,
/// busy while members speak, the speaking member's approval, a typing row naming who speaks,
/// and the questions of sessions its members handed work to.
pub fn decorate_room_view(state: Option<&RoomViewState>, snapshot: &Value, handoff_questions: &[Value]) -> Value {
    apply_room_view(snapshot, room_view(state, handoff_questions).as_ref())
}

impl SessionDirectory {
    /// The question copies `thread` holds now for the sessions it handed work to (its approvals
    /// section's `handoffQuestions`, the catalog row's `handoffQuestions` a room reads); none when
    /// it is not loaded (no runtime holds copies).
    pub fn member_handoff_questions(&self, thread: &ThreadId) -> Vec<Value> {
        let Some(handle) = self.handle(thread) else { return Vec::new() };
        handle.cell.view.load_full().state.approvals.as_ref().and_then(|approvals| approvals.handoff_questions.clone()).unwrap_or_default()
    }

    /// The approval `thread` shows now as its room reads it (`state.toolApproval`); `None` when
    /// it is not loaded or waits on nothing.
    pub fn member_approval(&self, thread: &ThreadId) -> Option<Value> {
        let handle = self.handle(thread)?;
        let shown = handle.cell.shown_approval.load_full()?;
        Some(tool_approval(&shown))
    }

    /// The room's answer to `approval_id` of `thread` (`scheduler.approve` → `deps.approve`):
    /// the server-request response a client sends, through the same decision path. `false` when
    /// `approval_id` is not the approval the thread shows (Node refuses then), or when another
    /// decision resolved it first (Node's `result.approved` of the serialized answer). `decision` is the
    /// response's result (`{ approved, reason?, answers?, reply?, remember?, ... }`).
    pub async fn answer_member_approval(
        &self,
        thread: &ThreadId,
        approval_id: &str,
        connection: ConnectionId,
        device: String,
        connection_kind: ConnectionKind,
        origin: mixdog_protocol::Origin,
        decision: Value,
    ) -> Result<bool, CoreError> {
        let Some(handle) = self.handle(thread) else { return Ok(false) };
        let shown = handle.cell.shown_approval.load_full();
        if shown.is_none_or(|request| request.id.0.to_string() != approval_id) {
            return Ok(false);
        }
        handle.decide_arbitrated(Decision { request: ServerRequestId(approval_id.to_owned()), connection, device, connection_kind, origin, result: decision }).await
    }
}

#[cfg(test)]
#[path = "room_approval_tests.rs"]
mod tests;
