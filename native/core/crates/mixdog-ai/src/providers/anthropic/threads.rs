//! Anthropic message threads (delta sending), `anthropic-message-threads.mjs` of Node. The request the codec
//! builds goes on the wire as one of:
//! - create: the full request plus `thread: {type: "create"}`;
//! - continue: only the messages after the server-held conversation, plus
//!   `thread: {type: "continue", previous_message_id}`, with `system` and `tools` left out (the thread keeps
//!   the create-time values);
//! - none: the unchanged full request.
//!
//! Per conversation (the session id, per provider) the store keeps only ids and digests: the latest stored
//! response id, a fingerprint of the create-only and fixed fields, the account, the digest of the exact wire
//! message prefix the server holds and the digest of the stored response's complete content. A send continues
//! only when its own full wire messages are that prefix followed by a message whose content is exactly the
//! stored response, nothing fixed changed and the thread is younger than [`CONTINUE_MAX_AGE_MS`]; everything
//! else creates. Compaction, rewind, edits, model/account/system/tool/cache-strategy changes therefore fall
//! back to a create by construction.
//!
//! A send that threads owns its conversation until the next send takes it: the stored state is consumed when
//! the send begins and written back only by that owner, only while the conversation was not torn down since
//! ([`Threads::forget`]), and only for a response that reached `message_stop` with a normal stop. Anything
//! else leaves "unknown" and the next turn creates. A second send on a conversation whose owner is still in
//! flight goes unthreaded.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::Instant;

use futures::future::Either;
use futures::future::select;
use mixdog_rt::TaskClass;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use crate::transport::http::BodyStream;

pub const MESSAGE_THREADS_BETA: &str = "message-threads-2026-08-12";

/// The API expires a thread 5 minutes after its latest stored response; a continue older than this margin is
/// skipped for a direct create.
pub const CONTINUE_MAX_AGE_MS: u64 = 270_000;

/// How long a threaded stream that ended on an early terminal frame (a `tool_use` `message_delta`) is read on
/// in the background for the `message_stop` that confirms storage. The turn itself is not held for it.
pub const MESSAGE_STOP_WAIT_MS: u64 = 5_000;

/// The request-wide limit on `cache_control` breakpoints with `thread` set.
const MAX_BREAKPOINTS: usize = 4;

/// Models the feature documents as supported (dated variants of a listed alias and the dated ids themselves
/// match).
const SUPPORTED_MODELS: [&str; 17] = [
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-mythos-preview",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-haiku-5-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929",
];

const NORMAL_STOPS: [&str; 5] = ["end_turn", "tool_use", "stop_sequence", "pause_turn", "max_tokens"];
const REPLAY_CODES: [&str; 4] = [
    "thread_not_found",
    "thread_already_continued",
    "thread_continue_in_flight",
    "thread_fingerprint_mismatch",
];
/// `thread_unsupported_request` values that are organization settings: no request of this account can be threaded.
const ACCOUNT_UNSUPPORTED: [&str; 2] = ["hipaa", "inference_hooks"];

/// An uncoded refusal that names the `thread` parameter or the beta itself.
static EXPLICIT_THREAD_REJECTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i){MESSAGE_THREADS_BETA}|(?:^|[^\w-])thread(?:[`'"]|\s*:|\.(?:type|previous_message_id)\b|\s+(?:parameter|field)\b)"#
    ))
    .expect("a valid pattern")
});

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_dated(long: &str, short: &str) -> bool {
    long.strip_prefix(short)
        .and_then(|rest| rest.strip_prefix('-'))
        .is_some_and(|date| date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()))
}

/// `threadsSupportModel`.
pub fn supports_model(model: &str) -> bool {
    let id = model.trim();
    !id.is_empty() && SUPPORTED_MODELS.iter().any(|listed| *listed == id || is_dated(id, listed) || is_dated(listed, id))
}

/// `threadAccountKey`: the account a thread belongs to, as an opaque hash.
pub fn account_key(provider: &str, parts: &[&str]) -> String {
    let mut all = vec![provider];
    all.extend_from_slice(parts);
    sha(&all.join("\u{0}"))
}

// ---------------------------------------------------------------------------
// What the server holds, as digests
// ---------------------------------------------------------------------------

fn without_block_marker(block: &Value) -> Value {
    match block {
        Value::Object(map) if map.contains_key("cache_control") => {
            let mut bare = map.clone();
            bare.shift_remove("cache_control");
            Value::Object(bare)
        }
        other => other.clone(),
    }
}

/// A message's content blocks without their breakpoints. A breakpoint is the `cache_control` property of a
/// content block itself, or of a block inside a `tool_result`'s content list; everything else is kept byte for
/// byte. A string content is one text block on the wire, so both compare equal.
fn blocks_without_breakpoints(content: &Value) -> Value {
    let blocks = match content {
        Value::String(text) if !text.is_empty() => json!([{ "type": "text", "text": text }]),
        other => other.clone(),
    };
    let Value::Array(items) = blocks else { return blocks };
    Value::Array(
        items
            .iter()
            .map(|block| {
                let mut bare = without_block_marker(block);
                if bare["type"] == "tool_result"
                    && let Some(Value::Array(inner)) = bare.get("content").cloned()
                {
                    bare["content"] = Value::Array(inner.iter().map(without_block_marker).collect());
                }
                bare
            })
            .collect(),
    )
}

/// One wire message as the server stores it, minus breakpoints.
fn message_key(message: &Value) -> String {
    let mut keyed = message.as_object().cloned().unwrap_or_default();
    if let Some(content) = message.get("content") {
        keyed.insert("content".into(), blocks_without_breakpoints(content));
    }
    Value::Object(keyed).to_string()
}

fn prefix_hash(messages: &[Value], count: usize) -> String {
    let mut hash = Sha256::new();
    for message in &messages[..count] {
        hash.update(message_key(message).as_bytes());
        hash.update(b"\n");
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A streamed `tool_use` names its caller; `{type: "direct"}` is what a request block without one means, so it
/// is dropped. Any other caller stays and cannot match a transcript block.
fn request_form(block: &Value) -> Value {
    let direct = block["type"] == "tool_use" && block["caller"]["type"] == "direct" && block["caller"].as_object().is_some_and(|c| c.len() == 1);
    if !direct {
        return block.clone();
    }
    let mut rest = block.as_object().cloned().unwrap_or_default();
    rest.shift_remove("caller");
    Value::Object(rest)
}

/// Digest of an assistant message's complete content: every block with every field, minus breakpoints. The
/// streamed response and the transcript's lowered copy of it digest equal only when the next request would
/// replay exactly what the API stored.
pub fn response_digest(content: &Value) -> String {
    match blocks_without_breakpoints(content) {
        Value::Array(blocks) => sha(&mixdog_js::json_stringify_sorted(&Value::Array(blocks.iter().map(request_form).collect()))),
        _ => String::new(),
    }
}

/// Count `cache_control` markers on a block / block list (incl. `tool_result` content).
fn count_controls(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.iter().map(count_controls).sum(),
        Value::Object(map) => {
            usize::from(map.get("cache_control").is_some_and(truthy)) + map.get("content").filter(|c| c.is_array()).map_or(0, count_controls)
        }
        _ => 0,
    }
}

fn truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false)) && value.as_str() != Some("") && value.as_f64() != Some(0.0)
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct State {
    account: String,
    fingerprint: String,
    prefix_count: usize,
    prefix_hash: String,
    response_id: String,
    response_digest: String,
    stop_reason: String,
    stored_at: u64,
    from_replay: bool,
}

struct Record {
    token: u64,
    in_flight: bool,
    state: Option<State>,
    disabled_account: Option<String>,
    /// The send (`send_group`) whose stream was cut mid-way: its next attempt is the same plan again.
    retry: Option<Retry>,
}

/// What Node's one `send` keeps across its mid-stream attempts: the plan is the same object each time. A dropped
/// continue is resent once as it was, after that it replays as a create; a replay stays a replay.
#[derive(Clone)]
struct Retry {
    group: String,
    /// The state the cut continue started from.
    prior: Option<State>,
    /// How many continues of this send were cut.
    resends: u32,
    replayed: bool,
}

/// Cut continues that are resent as they were before the next attempt replays (`attemptIndex >= 2`).
const RESENDS_BEFORE_REPLAY: u32 = 2;

#[derive(Default)]
struct Generation {
    id: u64,
    records: HashMap<String, Record>,
}

#[derive(Default)]
struct Account {
    confirmed: bool,
    disabled: bool,
    logged: bool,
}

#[derive(Default)]
struct Inner {
    next: u64,
    scopes: HashMap<String, Generation>,
    accounts: HashMap<String, Account>,
}

/// Every conversation's thread state of the process. The scope map's entry is the conversation's generation:
/// tearing it down drops it, so a send planned before the teardown can no longer write into the new one.
#[derive(Default)]
pub struct Threads {
    inner: Mutex<Inner>,
}

static PROCESS: LazyLock<Arc<Threads>> = LazyLock::new(Arc::default);

/// The process-wide store (Node's module-level maps).
pub fn process() -> &'static Arc<Threads> {
    &PROCESS
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    None,
    Create,
    Continue,
}

/// A resend directive after a rejected threaded request (`opts._anthropicThread`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Directive {
    pub force: Force,
    pub replay: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Force {
    Create,
    None,
}

/// What a plan needs to know about the send.
pub struct PlanInput<'a> {
    pub provider: &'a str,
    pub scope: &'a str,
    /// The full request body the codec built (a JSON object).
    pub body: &'a Value,
    /// The beta names it sends.
    pub betas: &'a [String],
    pub account: &'a str,
    /// The resolved per-layer cache TTLs, as the fingerprint takes them.
    pub cache_ttls: &'a str,
    pub now: u64,
    pub directive: Option<Directive>,
    /// The logical send this attempt belongs to (`RequestOptions.send_group`); the attempts of a send share a plan.
    pub send_group: Option<&'a str>,
}

/// Hash of every create-only and fixed field, the beta set and the per-layer cache TTLs.
fn fingerprint(body: &Value, betas: &[String], cache_ttls: &str) -> String {
    let field = |name: &str| body.get(name).cloned().unwrap_or(Value::Null);
    let mcp = match body.get("mcp_servers") {
        Some(Value::Array(servers)) => Value::Array(
            servers
                .iter()
                .map(|server| match server {
                    Value::Object(map) => {
                        let mut rest = map.clone();
                        rest.shift_remove("authorization_token");
                        Value::Object(rest)
                    }
                    other => other.clone(),
                })
                .collect(),
        ),
        Some(other) => other.clone(),
        None => Value::Null,
    };
    let mut names: Vec<&str> = betas.iter().map(String::as_str).collect();
    names.sort_unstable();
    names.dedup();
    sha(&json!({
        "model": field("model"),
        "system": field("system"),
        "tools": field("tools"),
        "tool_choice": field("tool_choice"),
        "thinking": field("thinking"),
        "mcp_servers": mcp,
        "context_management": field("context_management"),
        "output_config": field("output_config"),
        "container_skills": body.get("container").and_then(|c| c.get("skills")).cloned().unwrap_or(Value::Null),
        "cache_control": field("cache_control"),
        "fallbacks": body.get("fallbacks").is_some(),
        "betas": names,
        "cacheTtls": cache_ttls,
    })
    .to_string())
}

/// Why a continue is not possible for `messages` (`None` when it is).
fn continue_blocker(state: Option<&State>, account: &str, fingerprint: &str, messages: &[Value], now: u64) -> Option<&'static str> {
    let Some(state) = state.filter(|s| !s.response_id.is_empty()) else { return Some("no-thread") };
    if state.account != account {
        return Some("account");
    }
    if state.fingerprint != fingerprint {
        return Some("fingerprint");
    }
    if now.saturating_sub(state.stored_at) > CONTINUE_MAX_AGE_MS {
        return Some("expired");
    }
    let n = state.prefix_count;
    if messages.len() <= n {
        return Some("prefix");
    }
    if prefix_hash(messages, n) != state.prefix_hash {
        return Some("prefix");
    }
    let stored = &messages[n];
    if stored["role"] != "assistant" || response_digest(&stored["content"]) != state.response_digest {
        return Some("response");
    }
    let delta = messages.len() - n - 1;
    // A paused turn resumes with no messages and takes no new user turn; any other stop needs new messages.
    let bad = if state.stop_reason == "pause_turn" { delta != 0 } else { delta == 0 };
    bad.then_some("delta")
}

fn object(body: &Value) -> Map<String, Value> {
    body.as_object().cloned().unwrap_or_default()
}

fn create_body(body: &Value) -> Value {
    let mut wire = object(body);
    wire.insert("thread".into(), json!({ "type": "create" }));
    Value::Object(wire)
}

/// A cut continue replayed in place (`toCreate`): the wire keeps the continue's key order, `messages` and `thread`
/// are overwritten where they stand and `system` and `tools` come back after them.
fn replay_body(body: &Value, state: &State) -> Value {
    let Value::Object(mut wire) = continue_body(body, state) else { unreachable!("continue_body builds an object") };
    let full = object(body);
    for key in ["messages"] {
        if let Some(value) = full.get(key) {
            wire.insert(key.into(), value.clone());
        }
    }
    wire.insert("thread".into(), json!({ "type": "create" }));
    for key in ["system", "tools"] {
        if let Some(value) = full.get(key) {
            wire.insert(key.into(), value.clone());
        }
    }
    Value::Object(wire)
}

fn continue_body(body: &Value, state: &State) -> Value {
    let mut wire = object(body);
    let messages = wire.shift_remove("messages").unwrap_or(Value::Null);
    wire.shift_remove("system");
    wire.shift_remove("tools");
    let delta = messages.as_array().map(|all| all[state.prefix_count + 1..].to_vec()).unwrap_or_default();
    wire.insert("messages".into(), Value::Array(delta));
    wire.insert("thread".into(), json!({ "type": "continue", "previous_message_id": state.response_id }));
    Value::Object(wire)
}

/// Breakpoints a request with `thread` carries: on a continue the create-time system/tools breakpoints count
/// again; stored messages do not.
fn breakpoint_count(wire: &Value, create: &Value) -> usize {
    usize::from(wire.get("cache_control").is_some_and(truthy))
        + create.get("system").map_or(0, count_controls)
        + create.get("tools").map_or(0, count_controls)
        + wire.get("messages").map_or(0, count_controls)
}

/// The create form of `body` and its beta names, or `None` when that request carries more breakpoints than a
/// thread allows (it goes unthreaded). What a first send of the conversation puts on the wire.
pub fn create_form(body: &Value, betas: &[String]) -> Option<(Value, Vec<String>)> {
    let wire = create_body(body);
    (breakpoint_count(&wire, body) <= MAX_BREAKPOINTS).then(|| (wire, with_beta(betas)))
}

fn with_beta(betas: &[String]) -> Vec<String> {
    let mut all = betas.to_vec();
    if !all.iter().any(|b| b == MESSAGE_THREADS_BETA) {
        all.push(MESSAGE_THREADS_BETA.to_owned());
    }
    all
}

fn log_once(inner: &mut Inner, account: &str, line: &str) {
    let record = inner.accounts.entry(account.to_owned()).or_default();
    if record.logged {
        return;
    }
    record.logged = true;
    if std::env::var_os("MIXDOG_QUIET_PROVIDER_LOG").is_none() {
        mixdog_rt::node_stderr!("[anthropic-threads] {line}");
    }
}

/// The thread error fields of an Anthropic error body.
fn error_details(error_body: &str) -> (String, Vec<String>, String) {
    let parsed: Value = serde_json::from_str(error_body).unwrap_or(Value::Null);
    let error = if parsed.get("error").is_some_and(Value::is_object) { parsed["error"].clone() } else { parsed.clone() };
    let details = error.get("details").cloned().unwrap_or(Value::Null);
    let code = details["error_code"].as_str().unwrap_or_default().to_owned();
    let unsupported = details["unsupported"].as_array().map(|all| all.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).collect()).unwrap_or_default();
    let message = error["message"].as_str().filter(|m| !m.is_empty()).map_or_else(|| error_body.to_owned(), str::to_owned);
    (code, unsupported, message)
}

impl Threads {
    /// The wire plan for one send.
    pub fn plan(self: &Arc<Self>, input: PlanInput<'_>) -> Plan {
        let unthreaded = || Plan::unthreaded(input.body, input.betas);
        if input.directive.is_some_and(|d| d.force == Force::None) {
            return unthreaded();
        }
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if inner.accounts.entry(input.account.to_owned()).or_default().disabled {
            return unthreaded();
        }
        let record = inner.scopes.get(input.scope).and_then(|g| g.records.get(input.provider));
        if record.is_some_and(|r| r.disabled_account.as_deref() == Some(input.account) || r.in_flight) {
            return unthreaded();
        }
        let betas = with_beta(input.betas);
        let fingerprint = fingerprint(input.body, &betas, input.cache_ttls);
        let messages: Vec<Value> = input.body["messages"].as_array().cloned().unwrap_or_default();
        // The attempt after a cut stream of the same send continues that send's plan; any other send starts afresh
        // (the previous id was consumed by the cut one).
        let retry = record.and_then(|r| r.retry.clone()).filter(|r| input.send_group == Some(r.group.as_str()));
        let prior = match &retry {
            Some(retry) => retry.prior.clone(),
            None => record.and_then(|r| r.state.clone()),
        };

        let mut mode = Mode::Create;
        let mut wire = create_body(input.body);
        let mut replayed = retry.as_ref().is_some_and(|r| r.replayed);
        let resends = retry.as_ref().map_or(0, |r| r.resends);
        let blocker = if input.directive.is_some_and(|d| d.force == Force::Create) {
            Some("forced")
        } else if retry.as_ref().is_some_and(|r| r.prior.is_some()) {
            None
        } else {
            continue_blocker(prior.as_ref(), input.account, &fingerprint, &messages, input.now)
        };
        if let (None, Some(state)) = (blocker, prior.as_ref()) {
            let candidate = if resends >= RESENDS_BEFORE_REPLAY { replay_body(input.body, state) } else { continue_body(input.body, state) };
            if resends >= RESENDS_BEFORE_REPLAY {
                replayed = true;
                wire = candidate;
            } else if breakpoint_count(&candidate, input.body) <= MAX_BREAKPOINTS {
                mode = Mode::Continue;
                wire = candidate;
            }
        }
        if mode == Mode::Create && breakpoint_count(&wire, input.body) > MAX_BREAKPOINTS {
            return unthreaded();
        }

        // Take the conversation: the previous id is consumed (or abandoned) by this send either way, and only
        // this send may store the next one.
        inner.next += 1;
        let token = inner.next;
        let generation_id = inner.next;
        let generation = inner.scopes.entry(input.scope.to_owned()).or_insert_with(|| Generation { id: generation_id, records: HashMap::new() });
        let generation_id = generation.id;
        generation.records.insert(input.provider.to_owned(), Record { token, in_flight: true, state: None, disabled_account: None, retry: None });
        let replay = replayed || input.directive.is_some_and(|d| d.replay);
        let carried = if mode == Mode::Continue || retry.is_some() { prior.clone() } else { None };
        let after_replay = mode == Mode::Continue && prior.as_ref().is_some_and(|s| s.from_replay);
        let claim = Claim {
            threads: Arc::clone(self),
            scope: input.scope.to_owned(),
            provider: input.provider.to_owned(),
            generation: generation_id,
            token,
            account: input.account.to_owned(),
            fingerprint,
            prefix_count: messages.len(),
            prefix_hash: prefix_hash(&messages, messages.len()),
            replay,
            mode,
            carried,
            resends,
            group: input.send_group.map(str::to_owned),
        };
        Plan { mode, body: wire, betas, blocker, after_replay, directive: input.directive, session: Some(ThreadSession::new(claim)) }
    }

    /// Drops every thread record of a conversation scope (a new generation): the session closed, was deleted,
    /// or its transport scope was disposed of.
    pub fn forget(&self, scope: &str) {
        if scope.is_empty() {
            return;
        }
        self.inner.lock().unwrap_or_else(PoisonError::into_inner).scopes.remove(scope);
    }
}

/// One send's hold on its conversation.
#[derive(Clone)]
struct Claim {
    threads: Arc<Threads>,
    scope: String,
    provider: String,
    generation: u64,
    token: u64,
    account: String,
    fingerprint: String,
    prefix_count: usize,
    prefix_hash: String,
    replay: bool,
    mode: Mode,
    /// The state a cut attempt hands to the next one of the send (see [`Retry`]).
    carried: Option<State>,
    resends: u32,
    group: Option<String>,
}

impl Claim {
    /// The stream was cut after it began: the send's next attempt is this plan again.
    fn abandon(&self) {
        let mut inner = self.threads.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(group) = self.group.clone() else { return };
        let Some(record) = self.owned(&mut inner) else { return };
        if self.mode == Mode::Continue || self.replay {
            let resends = self.resends + u32::from(self.mode == Mode::Continue);
            record.retry = Some(Retry { group, prior: self.carried.clone(), resends, replayed: self.replay });
        }
    }

    /// The conversation's record while this send still owns it.
    fn owned<'a>(&self, inner: &'a mut Inner) -> Option<&'a mut Record> {
        let generation = inner.scopes.get_mut(&self.scope).filter(|g| g.id == self.generation)?;
        generation.records.get_mut(&self.provider).filter(|r| r.token == self.token)
    }

    fn settle(&self) {
        let mut inner = self.threads.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(record) = self.owned(&mut inner) {
            record.in_flight = false;
        }
    }

    /// Records the streamed response the API confirmed storing.
    fn commit(&self, receipt: &Receipt) {
        let Some(stop) = receipt.stored_stop() else { return };
        let mut inner = self.threads.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if self.owned(&mut inner).is_none() {
            return;
        }
        inner.accounts.entry(self.account.clone()).or_default().confirmed = true;
        let state = State {
            account: self.account.clone(),
            fingerprint: self.fingerprint.clone(),
            prefix_count: self.prefix_count,
            prefix_hash: self.prefix_hash.clone(),
            response_id: receipt.id.clone(),
            response_digest: response_digest(&Value::Array(receipt.blocks())),
            stop_reason: stop.to_owned(),
            stored_at: receipt.stopped_at,
            from_replay: self.replay,
        };
        if let Some(record) = self.owned(&mut inner) {
            record.state = Some(state);
        }
    }
}

/// The wire plan of one send: what goes out, the beta names it sends, and the hold on the conversation.
pub struct Plan {
    pub mode: Mode,
    pub body: Value,
    pub betas: Vec<String>,
    /// Why a continue was not possible (`None` for a continue and for an unthreaded send).
    pub blocker: Option<&'static str>,
    after_replay: bool,
    directive: Option<Directive>,
    session: Option<ThreadSession>,
}

impl Plan {
    fn unthreaded(body: &Value, betas: &[String]) -> Self {
        Self { mode: Mode::None, body: body.clone(), betas: betas.to_vec(), blocker: None, after_replay: false, directive: None, session: None }
    }

    /// The send's session: it feeds on the response stream, settles the conversation when dropped and records
    /// the stored response. `None` for an unthreaded send.
    pub fn take_session(&mut self) -> Option<ThreadSession> {
        self.session.take()
    }

    /// The resend directive for a rejected threaded request, or `None` when the rejection is not about threads.
    pub fn classify(&self, status: u16, error_body: &str) -> Option<Directive> {
        if self.mode == Mode::None {
            return None;
        }
        let claim = self.session.as_ref().map(|s| s.claim.clone())?;
        let (code, unsupported, message) = error_details(error_body);
        let force_none = Some(Directive { force: Force::None, replay: false });
        let mut inner = claim.threads.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let disable_conversation = |inner: &mut Inner| {
            if let Some(record) = claim.owned(inner) {
                record.disabled_account = Some(claim.account.clone());
            }
        };
        if code == "thread_unsupported_request" {
            if unsupported.iter().any(|value| ACCOUNT_UNSUPPORTED.contains(&value.as_str())) {
                inner.accounts.entry(claim.account.clone()).or_default().disabled = true;
                log_once(&mut inner, &claim.account, &format!("threads unavailable for this account ({}); sending unthreaded", unsupported.join(",")));
            } else {
                disable_conversation(&mut inner);
            }
            return force_none;
        }
        if REPLAY_CODES.contains(&code.as_str()) {
            // A continue that still cannot be served right after a replay: the API may be unable to store this
            // conversation.
            if code == "thread_not_found" && self.after_replay {
                disable_conversation(&mut inner);
                return force_none;
            }
            if self.mode != Mode::Continue || self.directive.is_some_and(|d| d.replay) {
                return force_none;
            }
            return Some(Directive { force: Force::Create, replay: true });
        }
        if code.starts_with("thread_") {
            return force_none;
        }
        // An uncoded refusal that names the thread parameter or the beta itself (a route that does not take
        // threads). The first one for an account turns threads off for it in this process. Any other error is
        // not about threads.
        if matches!(status, 400 | 403 | 422) && EXPLICIT_THREAD_REJECTION.is_match(&message) {
            if !inner.accounts.entry(claim.account.clone()).or_default().confirmed {
                inner.accounts.entry(claim.account.clone()).or_default().disabled = true;
                log_once(&mut inner, &claim.account, &format!("threads rejected for this account (HTTP {status}); sending unthreaded from now on"));
            }
            return force_none;
        }
        None
    }
}

// ---------------------------------------------------------------------------
// The streamed response as the API stores it
// ---------------------------------------------------------------------------

/// The response id, whether `message_stop` arrived (and when), and every content block exactly as the API
/// stored it. `opaque` marks anything the recording cannot reproduce exactly (an unknown delta, an unparsable
/// tool input, a block never closed); such a response is never continued.
#[derive(Default)]
pub struct Receipt {
    id: String,
    stopped_at: u64,
    stop: Option<String>,
    opaque: bool,
    fallback_iteration: bool,
    open: BTreeMap<u64, (Value, String)>,
    blocks: BTreeMap<u64, Value>,
    line: Vec<u8>,
}

impl Receipt {
    /// Folds a chunk of the SSE body in: every complete `data:` line is one event.
    pub fn feed(&mut self, chunk: &[u8], now: u64) {
        self.line.extend_from_slice(chunk);
        while let Some(end) = self.line.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.line.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line);
            if let Some(data) = text.trim_end().strip_prefix("data:")
                && let Ok(event) = serde_json::from_str::<Value>(data.trim())
            {
                self.note(&event, now);
            }
        }
    }

    fn note(&mut self, event: &Value, now: u64) {
        match event["type"].as_str() {
            Some("message_start") => {
                if let Some(id) = event["message"]["id"].as_str() {
                    self.id = id.to_owned();
                }
            }
            Some("message_delta") => {
                if let Some(stop) = event["delta"]["stop_reason"].as_str().filter(|s| !s.is_empty()) {
                    self.stop = Some(stop.to_owned());
                }
                if event["usage"]["iterations"].as_array().is_some_and(|all| all.iter().any(|it| it["type"] == "fallback_message")) {
                    self.fallback_iteration = true;
                }
            }
            Some("message_stop") => {
                if self.stopped_at == 0 {
                    self.stopped_at = now.max(1);
                }
                if !self.open.is_empty() {
                    self.opaque = true;
                }
            }
            Some("content_block_start") => match event.get("content_block").filter(|b| b.is_object()) {
                Some(block) => {
                    self.open.insert(event["index"].as_u64().unwrap_or(0), (block.clone(), String::new()));
                }
                None => self.opaque = true,
            },
            Some("content_block_delta") => {
                let delta = &event["delta"];
                let Some((block, json)) = self.open.get_mut(&event["index"].as_u64().unwrap_or(0)) else {
                    self.opaque = true;
                    return;
                };
                let append = |block: &mut Value, field: &str, piece: &Value| {
                    let joined = format!("{}{}", block[field].as_str().unwrap_or_default(), piece.as_str().unwrap_or_default());
                    block[field] = Value::String(joined);
                };
                match delta["type"].as_str() {
                    Some("text_delta") => append(block, "text", &delta["text"]),
                    Some("thinking_delta") => append(block, "thinking", &delta["thinking"]),
                    Some("signature_delta") => append(block, "signature", &delta["signature"]),
                    Some("input_json_delta") => json.push_str(delta["partial_json"].as_str().unwrap_or_default()),
                    Some("citations_delta") => {
                        if !block["citations"].is_array() {
                            block["citations"] = json!([]);
                        }
                        if let Some(citations) = block["citations"].as_array_mut() {
                            citations.push(delta["citation"].clone());
                        }
                    }
                    _ => self.opaque = true,
                }
            }
            Some("content_block_stop") => {
                let index = event["index"].as_u64().unwrap_or(0);
                let Some((mut block, json)) = self.open.remove(&index) else {
                    self.opaque = true;
                    return;
                };
                if !json.is_empty() {
                    match serde_json::from_str::<Value>(&json) {
                        Ok(input) => block["input"] = input,
                        Err(_) => self.opaque = true,
                    }
                }
                self.blocks.insert(index, block);
            }
            _ => {}
        }
    }

    fn blocks(&self) -> Vec<Value> {
        self.blocks.values().cloned().collect()
    }

    /// The stop reason when the API stored this response: `message_stop` arrived, the stop was a normal one, no
    /// tool call was cut by `max_tokens`, no fallback model wrote it, and every block was recorded completely.
    fn stored_stop(&self) -> Option<&str> {
        if self.id.is_empty() || self.stopped_at == 0 || self.opaque {
            return None;
        }
        let stop = self.stop.as_deref().filter(|s| NORMAL_STOPS.contains(s))?;
        let tool_call = self.blocks.values().any(|b| b["type"] == "tool_use" || b["type"] == "server_tool_use");
        if stop == "max_tokens" && tool_call {
            return None;
        }
        if self.blocks.values().any(|b| b["type"] == "fallback") || self.fallback_iteration {
            return None;
        }
        Some(stop)
    }
}

/// A threaded send, seen from its stream: feeds the receipt, records the stored response, and gives the
/// conversation back when it is dropped (the send is over; a later send may take it).
pub struct ThreadSession {
    claim: Claim,
    receipt: Receipt,
    /// The response began (a chunk arrived) and its end was never decoded: a cut stream.
    cut: bool,
}

impl ThreadSession {
    fn new(claim: Claim) -> Self {
        Self { claim, receipt: Receipt::default(), cut: false }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        self.cut = true;
        self.receipt.feed(chunk, super::oauth::now_ms());
    }

    /// The response ended (its terminal event was decoded). A confirmed `message_stop` is recorded now; when
    /// only an early terminal frame arrived, the rest of the body is read on in the background, for at most
    /// [`MESSAGE_STOP_WAIT_MS`], for the frame that confirms storage; the turn is not held for it.
    pub fn complete(mut self, body: Option<Box<dyn BodyStream>>) {
        self.cut = false;
        if self.receipt.stopped_at != 0 {
            self.claim.commit(&self.receipt);
            return;
        }
        let Some(mut body) = body else { return };
        // The send is over now; only the confirmation of storage is still awaited, so a send that starts before
        // it arrives finds no thread to continue and creates.
        self.claim.settle();
        let deadline = mixdog_rt::ticker().wait_until(Instant::now() + Duration::from_millis(MESSAGE_STOP_WAIT_MS));
        drop(mixdog_rt::spawn("anthropic.thread-message-stop", TaskClass::Work, async move {
            let mut deadline = Box::pin(deadline);
            while self.receipt.stopped_at == 0 {
                let read = Box::pin(body.next());
                match select(read, deadline).await {
                    Either::Left((Some(Ok(chunk)), pending)) => {
                        deadline = pending;
                        self.feed(&chunk);
                    }
                    _ => break,
                }
            }
            self.claim.commit(&self.receipt);
        }));
    }
}

impl Drop for ThreadSession {
    fn drop(&mut self) {
        if self.cut {
            self.claim.abandon();
        }
        self.claim.settle();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dated_ids_and_aliases_are_supported() {
        assert!(supports_model("claude-opus-5-5"));
        assert!(supports_model("claude-opus-5-5-20260101"));
        assert!(supports_model("claude-sonnet-4-5"));
        assert!(supports_model("claude-haiku-4-5-20251001"));
        assert!(!supports_model("claude-3-7-sonnet-20250219"));
        assert!(!supports_model(""));
    }
}
