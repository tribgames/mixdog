//! The secret requests of a `handoff_user` secret handoff (desktop `main/secret-requests.ts`,
//! `session-secrets.ts`, `secret-markers.ts`, `secret-input.ts` `bindComputerSecret` /
//! `typeComputerSecret`): each request id's one-shot value slot and the exact window and field a
//! Computer Use request was bound to, the values filled for a session (redacted from its later
//! replies), and the one fill of a bound field. The value reaches the core by
//! `approval/provideSecret`; it never goes into a decision, an audit line or a log.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_js::JsRegex;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// How long the card's value stays in its slot (`SECRET_INPUT_TIMEOUT_MS`).
pub const SECRET_INPUT_TIMEOUT: Duration = Duration::from_secs(120);
/// A binding outlives the card's own wait (the runtime's 120 s) a little.
pub const BINDING_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_SECRET_LENGTH: usize = 4_096;
const USERNAME_SUFFIX: &str = "-username";
const SAVE_SUFFIX: &str = "-save";
/// What replaces a filled secret wherever it later appears in tool output.
pub const REDACTED_MARKER: &str = "[redacted]";
/// What replaces a Computer Use saved-login password wherever it later appears.
pub const SAVED_LOGIN_MARKER: &str = "[saved login]";
const SECRET_MARKERS: [&str; 2] = [REDACTED_MARKER, SAVED_LOGIN_MARKER];

fn request_id_ok(id: &str) -> bool {
    id.strip_prefix("secret_").is_some_and(|rest| (8..=80).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

/// A window id or field ref as the runtime validates it (`TARGET_TOKEN`), within `limit`.
fn target_token(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'#' | b'@' | b'-'))
}

/// The exact window and field a Computer Use secret request was bound to when it was made (the
/// agent's window id and ref; never a focused field).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ComputerBinding {
    pub session: String,
    pub window_id: String,
    pub reference: String,
}

struct Held<T> {
    value: T,
    until: Instant,
}

#[derive(Default)]
struct State {
    slots: HashMap<String, Held<String>>,
    bindings: HashMap<String, Held<ComputerBinding>>,
    /// Insertion order is kept: equal-length secrets are redacted in the order they were filled.
    sessions: HashMap<String, Vec<String>>,
}

impl State {
    /// An entry leaves memory when it expires, whether or not anything asks for it again.
    fn expire(&mut self) {
        let now = Instant::now();
        self.slots.retain(|_, held| held.until > now);
        self.bindings.retain(|_, held| held.until > now);
    }
}

pub struct SecretRequests {
    timeout: Duration,
    binding_timeout: Duration,
    state: Mutex<State>,
}

impl SecretRequests {
    pub fn new() -> Self {
        Self::with_timeouts(SECRET_INPUT_TIMEOUT, BINDING_TIMEOUT)
    }

    pub fn with_timeouts(timeout: Duration, binding_timeout: Duration) -> Self {
        Self { timeout, binding_timeout, state: Mutex::new(State::default()) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.expire();
        state
    }

    /// Binds a Computer Use request to the exact window and field the agent named; false
    /// (nothing bound) unless the id is a request id, there is a session and both targets are
    /// plain tokens.
    pub fn bind_computer(&self, request_id: &str, binding: ComputerBinding) -> bool {
        if !request_id_ok(request_id) || binding.session.is_empty() || !target_token(&binding.window_id, 128) || !target_token(&binding.reference, 64) {
            return false;
        }
        let until = Instant::now() + self.binding_timeout;
        self.state().bindings.insert(request_id.to_owned(), Held { value: binding, until });
        true
    }

    /// The window binding of `request_id`, left in place.
    pub fn computer_binding(&self, request_id: &str) -> Option<ComputerBinding> {
        self.state().bindings.get(request_id).map(|held| held.value.clone())
    }

    /// Whether the card handed a value for `request_id` (it is not taken).
    pub fn has(&self, request_id: &str) -> bool {
        self.state().slots.contains_key(request_id)
    }

    /// Drops every slot and the binding of `request_id` unused: the fill is over, or refused.
    pub fn discard(&self, request_id: &str) {
        let mut state = self.state();
        for id in [request_id.to_owned(), format!("{request_id}{USERNAME_SUFFIX}"), format!("{request_id}{SAVE_SUFFIX}")] {
            state.slots.remove(&id);
        }
        state.bindings.remove(request_id);
    }

    /// The card's value for `request_id`; false when the id or value is unusable.
    pub fn provide(&self, request_id: &str, value: &str) -> bool {
        if !request_id_ok(request_id) || value.is_empty() || utf16_len(value) > MAX_SECRET_LENGTH {
            return false;
        }
        let until = Instant::now() + self.timeout;
        self.state().slots.insert(request_id.to_owned(), Held { value: value.to_owned(), until });
        true
    }

    /// One-shot: the value is gone from the slot once taken.
    pub fn take(&self, request_id: &str) -> String {
        self.state().slots.remove(request_id).map(|held| held.value).unwrap_or_default()
    }

    /// Registers `value` for redaction in every later reply of `session`: every non-empty value,
    /// of any length, until [`Self::forget`]. A username is no secret and is never registered.
    pub fn remember(&self, session: &str, value: &str) {
        if session.is_empty() || value.is_empty() {
            return;
        }
        let mut state = self.state();
        let secrets = state.sessions.entry(session.to_owned()).or_default();
        if !secrets.iter().any(|known| known == value) {
            secrets.push(value.to_owned());
        }
    }

    /// `text` with every secret of `session` replaced by the marker: longest first, so a secret
    /// containing a shorter one is replaced whole.
    pub fn redact(&self, session: &str, text: &str) -> String {
        let mut secrets: Vec<String> = self.state().sessions.get(session).into_iter().flatten().cloned().collect();
        secrets.sort_by_key(|secret| std::cmp::Reverse(utf16_len(secret)));
        redact_secrets(text, &secrets, REDACTED_MARKER)
    }

    /// The session ended: its secrets leave memory.
    pub fn forget(&self, session: &str) {
        self.state().sessions.remove(session);
    }
}

impl Default for SecretRequests {
    fn default() -> Self {
        Self::new()
    }
}

/// [start, end) of every marker in `text`, in order.
fn marker_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    for marker in SECRET_MARKERS {
        let mut from = 0;
        while let Some(found) = text[from..].find(marker) {
            let at = from + found;
            spans.push((at, at + marker.len()));
            from = at + marker.len();
        }
    }
    spans.sort_by_key(|span| span.0);
    spans
}

fn find_from(text: &str, needle: &str, from: usize) -> Option<usize> {
    text.get(from..)?.find(needle).map(|at| from + at)
}

/// `text` with each occurrence of `secret` (non-empty) replaced by `marker`, except one lying
/// entirely inside markers. An occurrence that partly overlaps a marker replaces that marker
/// whole, so no marker is left broken.
fn redact_secret(text: &str, secret: &str, marker: &str) -> String {
    let spans = marker_spans(text);
    let mut next = String::new();
    let mut copied = 0;
    let mut found = text.find(secret);
    while let Some(at) = found {
        let end = at + secret.len();
        let touched: Vec<&(usize, usize)> = spans.iter().filter(|(from, to)| *from < end && at < *to).collect();
        let mut reach = at;
        for (from, to) in &touched {
            if *from > reach {
                break;
            }
            reach = reach.max(*to);
        }
        if reach >= end {
            let step = text[at..].chars().next().map_or(1, char::len_utf8);
            found = find_from(text, secret, at + step);
            continue;
        }
        let from = at.min(touched.first().map_or(at, |span| span.0));
        let to = end.max(touched.last().map_or(end, |span| span.1));
        if from > copied {
            next.push_str(&text[copied..from]);
        }
        next.push_str(marker);
        copied = to;
        found = find_from(text, secret, to);
    }
    next.push_str(&text[copied..]);
    next
}

/// `text` with every one of `secrets` (non-empty, longest first) replaced by `marker`, passes
/// repeated until no secret occurs outside the markers: a replacement can join a secret that
/// holds marker text to the text before it. Each replacement lowers the number of characters
/// outside the markers, so it ends.
pub fn redact_secrets(text: &str, secrets: &[String], marker: &str) -> String {
    let mut out = text.to_owned();
    loop {
        let before = out.clone();
        for secret in secrets {
            out = redact_secret(&out, secret, marker);
        }
        if out == before {
            return out;
        }
    }
}

/// The computer helper a secret is typed through (the bridge's `executeSerialized`).
#[async_trait]
pub trait ComputerSecretHost: Send + Sync {
    /// One helper command, run to its reply; `Err` is the helper's error text.
    async fn execute(&self, command: Map<String, Value>) -> Result<Map<String, Value>, String>;
    /// A secret field may now hold focus: captures are withheld until focus moves.
    fn arm_focus(&self);
}

fn stale_target() -> JsRegex {
    JsRegex::new_static(r"stale_target|\bis stale\b|stale or invalid", "i")
}

/// The bound field as a fresh read shows it after the background write.
struct BoundField {
    reference: String,
    value: String,
    is_password: bool,
}

/// Re-reads the window with the bound ref named: the host marks the element that ref pointed at
/// (`bound_ref`) and says whether it is a password field. Nothing from the read is returned or
/// stored. `None` when that element is not found.
async fn read_bound_field(host: &dyn ComputerSecretHost, session: &str, binding: &ComputerBinding) -> Result<Option<BoundField>, String> {
    let command = json!({
        "action": "find",
        "session_id": session,
        "window_id": binding.window_id,
        "ref": binding.reference,
        "max_elements": 1000,
    });
    let Value::Object(command) = command else { return Ok(None) };
    let reply = host.execute(command).await?;
    let field = reply.get("elements").and_then(Value::as_array).into_iter().flatten().find(|element| element.get("bound_ref") == Some(&Value::Bool(true)));
    let Some(field) = field else { return Ok(None) };
    let Some(reference) = field.get("ref").and_then(Value::as_str).filter(|r| !r.is_empty()) else { return Ok(None) };
    Ok(Some(BoundField {
        reference: reference.to_owned(),
        value: field.get("value").and_then(Value::as_str).unwrap_or_default().to_owned(),
        is_password: field.get("is_password") != Some(&Value::Bool(false)),
    }))
}

fn type_command(session: &str, binding: &ComputerBinding, reference: &str, value: &str, foreground: bool) -> Map<String, Value> {
    let mut command = Map::new();
    command.insert("action".into(), json!("type"));
    command.insert("text".into(), json!(value));
    command.insert("session_id".into(), json!(session));
    command.insert("ref".into(), json!(reference));
    command.insert("window_id".into(), json!(binding.window_id));
    if foreground {
        command.insert("delivery".into(), json!("foreground"));
    }
    command
}

/// Computer Use: types the request's value once into the window and field ref it was bound to at
/// request time, never the focused field, through the ordinary input path, discarding its reply
/// (the capture of a field holding the secret never leaves). A request never bound (`no_field`)
/// or a target other than its binding (`page_changed`) drops the value and binding unused.
/// Answers the outcome and nothing else.
pub async fn type_computer_secret(
    secrets: &SecretRequests,
    host: &dyn ComputerSecretHost,
    session: &str,
    request_id: &str,
    reference: &str,
    window_id: &str,
) -> &'static str {
    let binding = secrets.computer_binding(request_id);
    let refuse = |outcome: &'static str| {
        secrets.discard(request_id);
        outcome
    };
    if session.is_empty() || !secrets.has(request_id) {
        return refuse("expired");
    }
    let Some(binding) = binding else { return refuse("no_field") };
    if binding.session != session {
        return refuse("blocked");
    }
    if (!window_id.is_empty() && window_id != binding.window_id) || (!reference.is_empty() && reference != binding.reference) {
        return refuse("page_changed");
    }
    let value = secrets.take(request_id);
    secrets.discard(request_id);
    secrets.remember(session, &value);
    host.arm_focus();
    let failed = |message: &str| if stale_target().is_match(message) { "page_changed" } else { "blocked" };
    // Every secret first goes in by the background value write: a password is never sent as
    // keystrokes, which could land in another window.
    if let Err(message) = host.execute(type_command(session, &binding, &binding.reference, &value, false)).await {
        return failed(&message);
    }
    if value.chars().count() == 1 {
        return "entered";
    }
    // A background write sets one control's value, so a segmented code input (one digit per box)
    // keeps only the first digit. The field is read back and identified by the element the bound
    // ref pointed at, not by a ref. Best effort: a read that fails or finds nothing leaves the
    // result the write itself produced.
    let field = read_bound_field(host, session, &binding).await.ok().flatten();
    let first: String = value.chars().take(1).collect();
    // Real keystrokes (focus advancing box to box) only when the field is positively
    // re-identified, is not a password, and holds just the first character: a one-character box.
    let Some(field) = field.filter(|field| !field.is_password && field.value == first) else { return "entered" };
    match host.execute(type_command(session, &binding, &field.reference, &value, true)).await {
        Ok(_) => "entered",
        Err(message) => failed(&message),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/handoff-env/golden.json"))).expect("golden")
    }

    fn registry(golden: &Value) -> SecretRequests {
        let ms = |key: &str| Duration::from_millis(golden[key].as_u64().expect(key));
        SecretRequests::with_timeouts(ms("timeoutMs"), ms("bindingTimeoutMs"))
    }

    fn text<'a>(op: &'a Value, key: &str) -> &'a str {
        op[key].as_str().expect(key)
    }

    /// Every recorded case of `secret-requests.ts` / `secret-markers.ts`, op by op.
    #[tokio::test]
    async fn the_registry_answers_as_the_recorded_node_one_did() {
        let golden = golden();
        for case in golden["registry"].as_array().expect("cases") {
            let secrets = registry(&golden);
            let name = case["name"].as_str().expect("name");
            for (op, want) in case["ops"].as_array().expect("ops").iter().zip(case["results"].as_array().expect("results")) {
                let got = match text(op, "op") {
                    "bind" => json!(secrets.bind_computer(
                        text(op, "id"),
                        ComputerBinding { session: text(op, "session").into(), window_id: text(op, "window").into(), reference: text(op, "ref").into() }
                    )),
                    "binding" => secrets
                        .computer_binding(text(op, "id"))
                        .map_or(Value::Null, |b| json!({"sessionId": b.session, "windowId": b.window_id, "ref": b.reference})),
                    "provide" => json!(secrets.provide(text(op, "id"), text(op, "value"))),
                    "has" => json!(secrets.has(text(op, "id"))),
                    "take" => json!(secrets.take(text(op, "id"))),
                    "discard" => {
                        secrets.discard(text(op, "id"));
                        Value::Null
                    }
                    "remember" => {
                        secrets.remember(text(op, "session"), text(op, "value"));
                        Value::Null
                    }
                    "redact" => json!(secrets.redact(text(op, "session"), text(op, "text"))),
                    "forget" => {
                        secrets.forget(text(op, "session"));
                        Value::Null
                    }
                    "sleep" => {
                        tokio::time::sleep(Duration::from_millis(op["ms"].as_u64().expect("ms"))).await;
                        Value::Null
                    }
                    other => panic!("unknown op {other}"),
                };
                assert_eq!(&got, want, "{name}: {op}");
            }
        }
    }

    /// The helper `typeComputerSecret` drives: scripted replies, the commands it was sent, and
    /// whether the field was armed for the focus hold.
    struct Script {
        replies: Mutex<std::collections::VecDeque<Value>>,
        commands: Mutex<Vec<Value>>,
        focus: AtomicBool,
    }

    #[async_trait]
    impl ComputerSecretHost for Script {
        async fn execute(&self, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
            self.commands.lock().unwrap().push(Value::Object(command));
            let reply = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| json!({}));
            match reply.get("error").and_then(Value::as_str) {
                Some(message) => Err(message.to_owned()),
                None => Ok(reply.as_object().cloned().unwrap_or_default()),
            }
        }

        fn arm_focus(&self) {
            self.focus.store(true, Ordering::SeqCst);
        }
    }

    /// Every recorded fill of `typeComputerSecret`: the outcome, the helper commands and what the
    /// registry holds afterwards.
    #[tokio::test]
    async fn a_bound_field_is_filled_as_the_recorded_node_fill_did() {
        let golden = golden();
        for case in golden["fill"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            let secrets = registry(&golden);
            let request_id = "secret_fillfill1";
            if case["bind"] == json!(true) {
                secrets.bind_computer(request_id, ComputerBinding { session: "s1".into(), window_id: "w1".into(), reference: "e1".into() });
            }
            if let Some(value) = case.get("provide").and_then(Value::as_str) {
                secrets.provide(request_id, value);
            }
            let host = Script {
                replies: Mutex::new(case.get("replies").and_then(Value::as_array).cloned().unwrap_or_default().into()),
                commands: Mutex::new(Vec::new()),
                focus: AtomicBool::new(false),
            };
            let given = |key: &str| case["command"].get(key).and_then(Value::as_str).map(str::to_owned);
            let session = given("sessionId").unwrap_or_else(|| "s1".into());
            let outcome = type_computer_secret(
                &secrets,
                &host,
                &session,
                request_id,
                &given("ref").unwrap_or_default(),
                &given("windowId").unwrap_or_default(),
            )
            .await;
            assert_eq!(json!(outcome), case["outcome"], "{name}");
            assert_eq!(Value::Array(host.commands.lock().unwrap().clone()), case["commands"], "{name}");
            let after = &case["after"];
            assert_eq!(json!(secrets.has(request_id)), after["has"], "{name}");
            assert_eq!(secrets.computer_binding(request_id), None, "{name}");
            assert!(after["binding"].is_null(), "{name}");
            assert_eq!(host.focus.load(Ordering::SeqCst), after["focusArmed"] == json!(true), "{name}");
            let typed = format!("typed {} here", case.get("provide").and_then(Value::as_str).unwrap_or_default());
            assert_eq!(json!(secrets.redact("s1", &typed)), after["redacted"], "{name}");
        }
    }
}
