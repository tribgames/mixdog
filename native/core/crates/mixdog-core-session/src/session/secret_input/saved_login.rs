//! Saved-login sign-in for Computer Use (Node `computer/host/saved-login.ts` over the turn-scoped half
//! of `saved-login-registry.ts`): the login Browser Use signs in with, written into a username or
//! password field of the user's own browser window with no prompt and no value ever reaching the
//! model.
//!
//! - [`SavedLoginRegistry`]: the saved-login passwords (redacted for every session as
//!   `[saved login]`) and the pixel guards of the filled browser windows, each kept until the filling
//!   agent turn settles, and the admission of fills (a fill of a settled turn is refused). The
//!   owner/process protocol of the Node registry binds the separate runtime process to the desktop
//!   process; the core is that runtime, so it is not ported.
//! - [`fill_saved_login`]: the check of the browser window, the vault lookup for the origin it shows,
//!   the registration of every spelling of the password and the pixel guard, and the one write, in
//!   Node's order, with its refusals worded as Node words them. The worker (the Windows UIA process
//!   that checks and writes the field) and the vault stay behind [`SavedLoginWorker`] and
//!   [`SavedLoginVault`].
//! - [`pixels_allowed`]: the capture gate after a password fill.
//! - [`FullRedactor`]: `secretInputs.redact`, the saved-login passwords and the session's filled
//!   secrets together.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::Redact;
use super::SecretFill;
use super::redact::SAVED_LOGIN_MARKER;
use super::redact::redact_secrets;

/// One fill's scope: the session and its agent turn number.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SavedLoginTurn {
    pub session: String,
    pub turn: u64,
}

/// Held back until the turn settles: pixels of this window and of every window of this process, for
/// every session.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PixelGuard {
    pub turn: SavedLoginTurn,
    pub window_id: String,
    pub pid: String,
}

fn valid_fill(turn: &SavedLoginTurn) -> bool {
    !turn.session.is_empty() && turn.turn >= 1
}

#[derive(Default)]
struct State {
    values: Vec<(SavedLoginTurn, String)>,
    guards: Vec<PixelGuard>,
    /// Per session, the newest settled turn: no fill of it or an older one is admitted again.
    settled: std::collections::HashMap<String, u64>,
    /// Fills admitted and not yet finished: a retirement first waits for the ones it covers, since a
    /// running fill may still arm a guard.
    running: Vec<(u64, SavedLoginTurn)>,
    next_id: u64,
}

#[derive(Default)]
pub struct SavedLoginRegistry {
    state: Mutex<State>,
    changed: Notify,
}

/// A fill admitted by [`SavedLoginRegistry::admit`]; dropping it ends the fill, however it ended.
pub struct FillGuard {
    registry: Arc<SavedLoginRegistry>,
    id: u64,
}

impl Drop for FillGuard {
    fn drop(&mut self) {
        self.registry.held().running.retain(|(id, _)| *id != self.id);
        self.registry.changed.notify_waiters();
    }
}

impl SavedLoginRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn held(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `text` with every saved-login password replaced by `[saved login]`: longest first, so a value
    /// containing another is replaced whole; for every session, never silent removal.
    pub fn redact(&self, text: &str) -> String {
        let mut saved: Vec<String> = Vec::new();
        for (_, value) in &self.held().values {
            if !saved.contains(value) {
                saved.push(value.clone());
            }
        }
        saved.sort_by_key(|value| std::cmp::Reverse(mixdog_js::utf16_len(value)));
        redact_secrets(text, &saved, SAVED_LOGIN_MARKER)
    }

    /// Registers every spelling of a saved-login password for redaction until `turn` settles,
    /// whatever its length. All or nothing: false (nothing registered) when `turn` is no valid fill
    /// or names no spelling. An empty spelling hides nothing and is skipped.
    pub fn remember(&self, turn: &SavedLoginTurn, spellings: &[String]) -> bool {
        if !valid_fill(turn) || spellings.is_empty() {
            return false;
        }
        let mut state = self.held();
        for value in spellings {
            if value.is_empty() || state.values.iter().any(|(held, known)| known == value && held == turn) {
                continue;
            }
            state.values.push((turn.clone(), value.clone()));
        }
        true
    }

    /// Holds back pixels of `guard.window_id` and of every window of process `guard.pid` until the
    /// guard's turn settles. False (nothing armed) when `guard` names no valid fill, window or process.
    pub fn arm_pixels(&self, guard: PixelGuard) -> bool {
        if !valid_fill(&guard.turn) || guard.window_id.is_empty() || guard.pid.is_empty() {
            return false;
        }
        let mut state = self.held();
        let window = guard.window_id.to_lowercase();
        let present = state.guards.iter().any(|held| held.turn == guard.turn && held.window_id.to_lowercase() == window && held.pid == guard.pid);
        if !present {
            state.guards.push(guard);
        }
        true
    }

    /// The spellings held, in registration order.
    #[cfg(test)]
    pub(super) fn spellings(&self) -> Vec<String> {
        self.held().values.iter().map(|(_, spelling)| spelling.clone()).collect()
    }

    /// Every armed pixel guard, of every session.
    pub fn pixel_guards(&self) -> Vec<PixelGuard> {
        self.held().guards.clone()
    }

    /// Admits one fill the moment it is accepted, before any target preparation: the guard to drop
    /// when the fill has ended, however it ended, or why it is refused (its turn already settled).
    pub fn admit(self: &Arc<Self>, fill: &SavedLoginTurn) -> Result<FillGuard, String> {
        if !valid_fill(fill) {
            return Err("the request names no runtime owner and agent turn to scope its protection to".to_owned());
        }
        let mut state = self.held();
        if fill.turn <= state.settled.get(&fill.session).copied().unwrap_or(0) {
            return Err("its agent turn has already ended".to_owned());
        }
        let id = state.next_id;
        state.next_id += 1;
        state.running.push((id, fill.clone()));
        Ok(FillGuard { registry: self.clone(), id })
    }

    /// Whether `fill` was admitted and has not finished.
    pub fn admitted(&self, fill: &SavedLoginTurn) -> bool {
        self.held().running.iter().any(|(_, running)| running == fill)
    }

    fn mark_settled(&self, session: &str, turn: u64) -> u64 {
        let mut state = self.held();
        let through = state.settled.entry(session.to_owned()).or_insert(0);
        *through = (*through).max(turn);
        *through
    }

    /// Retires every entry `covered` selects, once the running fills it selects have finished.
    /// Callers first make sure no new fill it covers can be admitted (a settled turn).
    async fn drain_then_retire(&self, covered: &(dyn Fn(&SavedLoginTurn) -> bool + Sync)) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.held().running.iter().any(|(_, running)| covered(running)) {
                break;
            }
            notified.await;
        }
        let mut state = self.held();
        state.guards.retain(|guard| !covered(&guard.turn));
        state.values.retain(|(turn, _)| !covered(turn));
    }

    /// The authoritative settlement of `turn`: from this moment no fill of that turn (or an older
    /// one of the session) is admitted, and once those still running have finished, their pixel
    /// guards and password redaction retire.
    pub async fn settle(&self, turn: &SavedLoginTurn) {
        if !valid_fill(turn) {
            return;
        }
        let through = self.mark_settled(&turn.session, turn.turn);
        let session = turn.session.clone();
        self.drain_then_retire(&move |entry| entry.session == session && entry.turn <= through).await;
    }

    /// The session ended: every turn of it a fill was admitted for is settled at once.
    pub async fn forget(&self, session: &str) {
        let newest = {
            let state = self.held();
            let turns = state.running.iter().map(|(_, turn)| turn).chain(state.guards.iter().map(|guard| &guard.turn)).chain(state.values.iter().map(|(turn, _)| turn));
            turns.filter(|turn| turn.session == session).map(|turn| turn.turn).max()
        };
        let Some(newest) = newest else { return };
        let through = self.mark_settled(session, newest);
        let session = session.to_owned();
        self.drain_then_retire(&move |entry| entry.session == session && entry.turn <= through).await;
    }
}

/// `secretInputs.redact(sessionId, text)`: the saved-login passwords first (for every session), then
/// the session's own secrets, repeated until neither changes the text: one redactor's marker could
/// complete a marker-containing secret of the other.
pub struct FullRedactor {
    pub saved: Arc<SavedLoginRegistry>,
    pub sessions: Arc<SecretFill>,
}

impl Redact for FullRedactor {
    fn redact(&self, thread: &ThreadId, text: &str) -> String {
        let mut out = text.to_owned();
        loop {
            let next = self.sessions.redact(thread, &self.saved.redact(&out));
            if next == out {
                return out;
            }
            out = next;
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SavedLoginField {
    Username,
    Password,
}

impl SavedLoginField {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Username => "username",
            Self::Password => "password",
        }
    }
}

/// One saved value for a checked page, with the only names the agent sees. The value is the core's for
/// one fill only: it is zeroed when this is dropped (after the write, or whenever the fill ends). It has
/// no `Clone` and no `Debug`.
pub struct SavedLoginValue {
    pub value: String,
    /// The login's masked label.
    pub label: String,
    pub origin: String,
}

impl Drop for SavedLoginValue {
    fn drop(&mut self) {
        wipe(&mut self.value);
    }
}

/// `text` as zeroed bytes, the string left empty.
pub(super) fn zeroed(text: &mut String) -> Vec<u8> {
    let mut bytes = std::mem::take(text).into_bytes();
    bytes.iter_mut().for_each(|byte| *byte = 0);
    bytes
}

/// Overwrites `text` with zeros before its buffer is freed.
pub(super) fn wipe(text: &mut String) {
    std::hint::black_box(zeroed(text));
}

/// `wipe` for every string a request holds.
pub(super) fn wipe_json(value: &mut Value) {
    match value {
        Value::String(text) => wipe(text),
        Value::Array(items) => items.iter_mut().for_each(wipe_json),
        Value::Object(fields) => fields.values_mut().for_each(wipe_json),
        _ => {}
    }
}

#[async_trait]
pub trait SavedLoginVault: Send + Sync {
    /// The `field` value of `account` (username or masked label) saved for the HTTPS origin of
    /// `url`; a miss is an `Err` naming only masked labels.
    async fn value(&self, url: &str, account: &str, field: SavedLoginField) -> Result<SavedLoginValue, String>;
}

pub trait SavedLogins: Send + Sync {
    /// The Auto login setting (`browserAutoSignIn`).
    fn enabled(&self) -> bool;
    fn vault(&self) -> &dyn SavedLoginVault;
}

/// The worker of the Windows host: `saved_login_check` proves the target and `saved_login_type`
/// writes the value. `before_send` runs after the dispatch was authorized and right before the
/// request is written (the last host check): an `Err` stops the request unsent and is the call's
/// error. A write the worker already executed cannot be recalled. A reply is the worker's
/// `PowerShellResponse` (`{ok, error?, result?}`).
#[async_trait]
pub trait SavedLoginWorker: Send + Sync {
    async fn call(&self, request: &Value, before_send: Option<&mut (dyn FnMut() -> Result<(), String> + Send)>) -> Result<Value, String>;
}

fn error_text(message: &str) -> String {
    message.strip_suffix('.').unwrap_or(message).to_owned()
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

/// `Number(value)` as a safe integer of at least 1.
fn turn_number(value: Option<&Value>) -> Option<u64> {
    let number = match value? {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => mixdog_js::string_to_number(text),
        _ => return None,
    };
    (number.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&number)).then_some(number as u64)
}

struct Available {
    field: SavedLoginField,
    account: String,
    turn: SavedLoginTurn,
}

/// The request's login and field, or the refusal that sends nothing: off Windows, with Auto login
/// off, or without a saved account to use.
fn assert_available(command: &Value, logins: &dyn SavedLogins, windows: bool) -> Result<Available, String> {
    if !windows {
        return Err("saved_login_unavailable: saved logins are filled on Windows only for now; no input was sent".to_owned());
    }
    if !logins.enabled() {
        return Err("saved_login_unavailable: Auto login is off in Settings (인증 관리); no input was sent".to_owned());
    }
    let field = match js_string(command.get("field")).as_str() {
        "username" => SavedLoginField::Username,
        "password" => SavedLoginField::Password,
        _ => {
            return Err("invalid_input: field must be username or password; one-time codes, passkeys, security keys and app approvals are the user's step (handoff_user takeover)".to_owned());
        }
    };
    let account = match command.get("saved_account") {
        Some(Value::String(text)) => mixdog_js::js_trim(text).to_owned(),
        _ => String::new(),
    };
    if account.is_empty() {
        return Err("invalid_input: saved_account must name a saved login".to_owned());
    }
    if mixdog_js::js_trim(&js_string(command.get("window_id"))).is_empty() {
        return Err("fill_saved_login requires an exact window_id before dispatch".to_owned());
    }
    // The runtime names itself and the agent turn; the fill's protection lives until that turn
    // settles, so a fill it cannot scope is not made.
    let turn = turn_number(command.get("turn_id"));
    let runtime = matches!(command.get("runtime_id"), Some(Value::String(text)) if !text.is_empty());
    let Some(turn) = turn.filter(|_| runtime) else {
        return Err("saved_login_unavailable: the request names no runtime and agent turn to scope its protection to; no input was sent".to_owned());
    };
    Ok(Available { field, account, turn: SavedLoginTurn { session: js_string(command.get("session_id")), turn } })
}

/// A worker answer that wrote nothing, as this action's reply.
fn as_saved_login_reply(mut response: Value) -> Value {
    let mut result: Map<String, Value> = response.get("result").and_then(Value::as_object).cloned().unwrap_or_default();
    result.insert("action".to_owned(), json!("fill_saved_login"));
    result.remove("saved_login_target");
    if let Some(object) = response.as_object_mut() {
        object.insert("result".to_owned(), Value::Object(result));
    }
    response
}

/// What a fill needs besides its command, the logins and the worker.
pub struct FillContext<'a> {
    pub registry: &'a Arc<SavedLoginRegistry>,
    pub windows: bool,
    /// The dispatch's authorization, checked before the vault is asked, after it, and right before
    /// the request is written.
    pub assert_runnable: &'a (dyn Fn() -> Result<(), String> + Sync),
    /// `registry.redact(sessionId, text)` for this session.
    pub redact: &'a (dyn Fn(&str) -> String + Sync),
}

fn ok_of(response: &Value) -> bool {
    response.get("ok").and_then(Value::as_bool).unwrap_or(false)
}

fn text_of(response: &Value, key: &str) -> Option<String> {
    response.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned)
}

/// Checks the browser window, looks the login up for the origin it shows, and has the worker write
/// it into the checked field. Before a password is sent: Auto login is re-proven after the vault
/// await, every spelling of it is registered for redaction and the pixel guard is armed, both scoped
/// to this agent turn and refused (nothing written) when either cannot be. Once the value was sent, a
/// failure is "possibly written" and never retried. The fill must have been admitted when it was
/// accepted ([`SavedLoginRegistry::admit`]), so its turn's settlement waits for it.
pub async fn fill_saved_login(command: &Value, logins: &dyn SavedLogins, worker: &dyn SavedLoginWorker, context: &FillContext<'_>) -> Result<Value, String> {
    let FillContext { registry, windows, assert_runnable, redact } = context;
    let Available { field, account, turn } = assert_available(command, logins, *windows)?;
    if !registry.admitted(&turn) {
        return Err("saved_login_unavailable: the fill was not admitted by the bridge for its runtime and turn; no input was sent".to_owned());
    }
    let checked = worker.call(&json!({ "action": "saved_login_check", "field": field.as_str(), "text": Value::Null }), None).await?;
    if !ok_of(&checked) {
        return Err(text_of(&checked, "error").unwrap_or_else(|| "saved_login_refused: the browser window could not be checked; no input was sent".to_owned()));
    }
    let target = checked.get("result").and_then(|result| result.get("saved_login_target")).cloned();
    // Activation was refused or the foreground moved: the answer says so.
    let Some(target) = target.filter(|target| target.get("origin").is_some_and(Value::is_string)) else {
        return Ok(as_saved_login_reply(checked));
    };
    assert_runnable()?;
    let origin = js_string(target.get("origin"));
    let lookup = match assert_available(command, logins, *windows) {
        Ok(available) => logins.vault().value(&origin, &account, available.field).await,
        Err(message) => Err(message),
    };
    let saved = lookup.map_err(|message| format!("saved_login_unavailable: {}; no input was sent", error_text(&message)))?;
    // The worker's origin and the vault's (secureOrigin) must agree exactly.
    if saved.origin != origin {
        return Err("saved_login_refused: the page origin could not be matched exactly to the saved login; no input was sent".to_owned());
    }
    assert_runnable()?;
    assert_available(command, logins, *windows)?;
    if field == SavedLoginField::Password {
        // The exact password, without line breaks, and as a JSON reply would spell either: all must
        // be registered, or nothing is written.
        let plain = saved.value.clone();
        let flat: String = saved.value.chars().filter(|c| !matches!(c, '\r' | '\n')).collect();
        let mut spellings: Vec<String> = [plain, flat]
            .into_iter()
            .flat_map(|value| {
                let escaped = serde_json::to_string(&value).map(|json| json[1..json.len() - 1].to_owned()).unwrap_or_default();
                [value, escaped]
            })
            .collect();
        let remembered = registry.remember(&turn, &spellings);
        // The registry holds its own copies; these are the core's to give up.
        spellings.iter_mut().for_each(wipe);
        if !remembered {
            return Err("saved_login_refused: the password could not be registered for redaction; no input was sent".to_owned());
        }
        let guard = PixelGuard { turn: turn.clone(), window_id: js_string(target.get("window_id")), pid: js_string(target.get("pid")) };
        if !registry.arm_pixels(guard) {
            return Err("saved_login_refused: the browser window and process could not be identified to hold its captures back; no input was sent".to_owned());
        }
    }
    let sent = AtomicBool::new(false);
    let mut before_send = || -> Result<(), String> {
        assert_runnable()?;
        assert_available(command, logins, *windows)?;
        sent.store(true, Ordering::SeqCst);
        Ok(())
    };
    let mut request = json!({ "action": "saved_login_type", "field": field.as_str(), "text": saved.value, "expected": target });
    let answer = worker.call(&request, Some(&mut before_send)).await;
    // The write is over: the copy of the value in the request goes the way of the vault's.
    wipe_json(&mut request);
    let written = match answer {
        Ok(written) => written,
        Err(message) if !sent.load(Ordering::SeqCst) => return Err(redact(&error_text(&message))),
        Err(message) => {
            return Err(format!(
                "saved_login_unconfirmed: the saved {} was sent but no clear answer came back ({}); it may have been written and is not retried",
                field.as_str(),
                redact(&error_text(&message))
            ));
        }
    };
    if !ok_of(&written) {
        return Err(redact(&text_of(&written, "error").unwrap_or_else(|| "saved_login_unconfirmed: the worker gave no answer; the value may have been written and is not retried".to_owned())));
    }
    if written.get("result").and_then(|result| result.get("code")).and_then(Value::as_str).is_some_and(|code| !code.is_empty()) {
        return Ok(as_saved_login_reply(written));
    }
    let text = match field {
        SavedLoginField::Password => format!(
            "filled the saved password of {} into the focused field on {}; the site receives it and it stays out of your results, though a page that redisplays it can expose it; pixels of this browser are withheld until this turn ends",
            saved.label, saved.origin
        ),
        SavedLoginField::Username => format!("filled the saved username of {} into the focused field on {}; a username is an identifier and is not hidden from you", saved.label, saved.origin),
    };
    let mut result: Map<String, Value> = written.get("result").and_then(Value::as_object).cloned().unwrap_or_default();
    result.insert("action".to_owned(), json!("fill_saved_login"));
    result.insert("text".to_owned(), json!(text));
    result.insert("saved_login".to_owned(), json!({ "account": saved.label, "origin": saved.origin, "field": field.as_str() }));
    let mut reply = written;
    if let Some(object) = reply.as_object_mut() {
        object.insert("result".to_owned(), Value::Object(result));
    }
    Ok(reply)
}

/// The process id of a window as the host reads it; `Err` or `None` when it cannot be read.
#[async_trait]
pub trait WindowPids: Send + Sync {
    async fn window_pid(&self, window_id: &str) -> Result<Option<String>, String>;
}

/// The capture gate after a saved-login password fill: while any session's turn holds a guard, no
/// pixels (capture, capture-after, zoom; any session) of the filled window or of any window of the
/// same browser process leave the host, and no full-screen pixels at all. A window whose process
/// cannot be read is refused too (fail closed). Accessibility reads (`ax`) carry no pixels.
pub async fn pixels_allowed(registry: &SavedLoginRegistry, mode: &str, window_id: &str, pids: &dyn WindowPids) -> Result<(), String> {
    let guards = registry.pixel_guards();
    if mode == "ax" || guards.is_empty() {
        return Ok(());
    }
    let target = window_id.to_lowercase();
    let same_window = |guard: &PixelGuard| guard.window_id.to_lowercase() == target;
    let held: Vec<PixelGuard> = if target.is_empty() || guards.iter().all(same_window) {
        guards
    } else {
        match pids.window_pid(window_id).await.ok().flatten().filter(|pid| !pid.is_empty()) {
            Some(pid) => guards.into_iter().filter(|guard| same_window(guard) || guard.pid == pid).collect(),
            None => guards,
        }
    };
    if held.is_empty() {
        return Ok(());
    }
    Err("capture_withheld: pixels of a browser a saved-login password was filled into are withheld until the end of this agent turn; read it with mode \"ax\" or capture in a later turn".to_owned())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use super::*;

    /// Recorded from the real desktop code (`benchmarks/rust-core/recorders/record-saved-login.mjs`).
    fn golden(name: &str) -> Value {
        let text = match name {
            "registry.json" => include_str!("../../../../../fixtures/saved-login/registry.json"),
            "fill.json" => include_str!("../../../../../fixtures/saved-login/fill.json"),
            "pixels.json" => include_str!("../../../../../fixtures/saved-login/pixels.json"),
            other => panic!("{other}"),
        };
        serde_json::from_str(text).unwrap()
    }

    fn turn_of(value: &Value) -> SavedLoginTurn {
        SavedLoginTurn { session: value["session"].as_str().unwrap().to_owned(), turn: value["turn"].as_u64().unwrap_or(0) }
    }

    fn guard_json(guard: &PixelGuard) -> Value {
        json!({ "session": guard.turn.session, "turn": guard.turn.turn, "windowId": guard.window_id, "pid": guard.pid })
    }

    #[tokio::test]
    async fn the_registry_follows_the_recorded_scenarios() {
        for case in golden("registry.json")["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let registry = SavedLoginRegistry::new();
            let mut fills: Vec<(String, FillGuard)> = Vec::new();
            let mut settles: Vec<tokio::task::JoinHandle<()>> = Vec::new();
            for (at, (step, want)) in case["steps"].as_array().unwrap().iter().zip(case["results"].as_array().unwrap()).enumerate() {
                let got = match step["op"].as_str().unwrap() {
                    "remember" => {
                        let spellings: Vec<String> = step["spellings"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect();
                        json!(registry.remember(&turn_of(&step["turn"]), &spellings))
                    }
                    "redact" => json!(registry.redact(step["text"].as_str().unwrap())),
                    "arm" => {
                        let guard = &step["guard"];
                        json!(registry.arm_pixels(PixelGuard { turn: turn_of(guard), window_id: guard["windowId"].as_str().unwrap().to_owned(), pid: guard["pid"].as_str().unwrap().to_owned() }))
                    }
                    "guards" => json!(registry.pixel_guards().iter().map(guard_json).collect::<Vec<_>>()),
                    "admit" => match registry.admit(&turn_of(&step["fill"])) {
                        Ok(guard) => {
                            fills.push((step["name"].as_str().unwrap().to_owned(), guard));
                            json!("admitted")
                        }
                        Err(reason) => json!(reason),
                    },
                    "admitted" => json!(registry.admitted(&turn_of(&step["fill"]))),
                    "finish" => {
                        let at = fills.iter().position(|(held, _)| held == step["name"].as_str().unwrap()).unwrap();
                        drop(fills.swap_remove(at));
                        Value::Null
                    }
                    "settle" => {
                        let (registry, turn) = (registry.clone(), turn_of(&step["turn"]));
                        let handle = tokio::spawn(async move { registry.settle(&turn).await });
                        tokio::time::sleep(Duration::from_millis(5)).await;
                        let at_once = handle.is_finished();
                        settles.push(handle);
                        json!({ "settledAtOnce": at_once })
                    }
                    "awaitSettle" => {
                        settles.pop().unwrap().await.unwrap();
                        Value::Null
                    }
                    "forget" => {
                        registry.forget(step["session"].as_str().unwrap()).await;
                        Value::Null
                    }
                    other => panic!("{other}"),
                };
                assert_eq!(&got, want, "{name} step {at}");
            }
        }
    }

    const SESSION: &str = "saved-login-session";
    const LABEL: &str = "j•••e@example.com";

    fn target() -> Value {
        json!({ "window_id": "hwnd:0x1", "pid": "4242", "start_time": "133700000000000001", "origin": "https://login.example.com", "document_id": "42.1.4.5.1.20", "runtime_id": "42.1.4.5.1.77", "field": "password", "value_length": 0 })
    }

    struct Vault {
        values: Value,
        origin: String,
        fails: Option<String>,
        lookups: Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl SavedLoginVault for Vault {
        async fn value(&self, url: &str, account: &str, field: SavedLoginField) -> Result<SavedLoginValue, String> {
            self.lookups.lock().unwrap().push(json!({ "url": url, "account": account, "field": field.as_str() }));
            if let Some(message) = &self.fails {
                return Err(message.clone());
            }
            Ok(SavedLoginValue { value: self.values[field.as_str()].as_str().unwrap().to_owned(), label: LABEL.to_owned(), origin: self.origin.clone() })
        }
    }

    struct Logins {
        enabled: bool,
        /// Auto login reads after which the setting reads off.
        off_after: Option<usize>,
        reads: AtomicUsize,
        vault: Vault,
    }

    impl SavedLogins for Logins {
        fn enabled(&self) -> bool {
            let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
            !matches!(self.off_after, Some(after) if read > after) && self.enabled
        }
        fn vault(&self) -> &dyn SavedLoginVault {
            &self.vault
        }
    }

    struct Worker {
        check: Value,
        typed: Value,
        requests: Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl SavedLoginWorker for Worker {
        async fn call(&self, request: &Value, before_send: Option<&mut (dyn FnMut() -> Result<(), String> + Send)>) -> Result<Value, String> {
            if let Some(before_send) = before_send {
                before_send()?;
            }
            let seen = |key: &str| request.get(key).cloned().unwrap_or(Value::Null);
            self.requests.lock().unwrap().push(json!({ "action": seen("action"), "field": seen("field"), "text": seen("text"), "expected": seen("expected") }));
            let answer = if request["action"] == "saved_login_check" { &self.check } else { &self.typed };
            match answer.get("throw").and_then(Value::as_str) {
                Some(message) => Err(message.to_owned()),
                None => Ok(answer.clone()),
            }
        }
    }

    #[tokio::test]
    async fn a_fill_goes_as_the_recorded_desktop_fill_went() {
        let doc = golden("fill.json");
        let sample = doc["sampleText"].as_str().unwrap();
        for case in doc["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let spec = &case["spec"];
            let registry = SavedLoginRegistry::new();
            let admitted = (spec["admit"] != json!(false)).then(|| registry.admit(&SavedLoginTurn { session: SESSION.to_owned(), turn: 7 }).unwrap());
            let logins = Logins {
                enabled: spec["enabled"] != json!(false),
                off_after: spec["enabledAfter"].as_u64().map(|n| n as usize),
                reads: AtomicUsize::new(0),
                vault: Vault {
                    values: spec.get("values").cloned().unwrap_or_else(|| json!({ "password": "Pa55-\"word\"\\x", "username": "jane.doe@example.com" })),
                    origin: spec["vaultOrigin"].as_str().unwrap_or("https://login.example.com").to_owned(),
                    fails: spec["vaultThrow"].as_str().map(str::to_owned),
                    lookups: Mutex::new(Vec::new()),
                },
            };
            let worker = Worker {
                check: spec.get("check").cloned().unwrap_or_else(|| json!({ "ok": true, "result": { "saved_login_target": target() } })),
                typed: spec.get("typed").cloned().unwrap_or_else(|| json!({ "ok": true, "result": { "action": "fill_saved_login", "path": "uia_setvalue", "effect": "confirmed" } })),
                requests: Mutex::new(Vec::new()),
            };
            let calls = AtomicUsize::new(0);
            let fails_at = spec["runnableFailsAt"].as_u64().unwrap_or(0) as usize;
            let counted = || {
                let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                if fails_at != 0 && n == fails_at { Err("runnable refused".to_owned()) } else { Ok(()) }
            };
            let hide = |text: &str| registry.redact(text);
            let context = FillContext { registry: &registry, windows: spec["platform"] != json!("linux"), assert_runnable: &counted, redact: &hide };
            let outcome = fill_saved_login(&case["command"], &logins, &worker, &context).await;
            drop(admitted);
            match (&outcome, &case["outcome"]) {
                (Ok(value), want) => assert_eq!((want["ok"].clone(), &want["value"]), (json!(true), value), "{name}"),
                (Err(message), want) => assert_eq!((want["ok"].clone(), &want["error"]), (json!(false), &json!(message)), "{name}"),
            }
            assert_eq!(json!(worker.requests.lock().unwrap().clone()), case["requests"], "{name}: what the worker was sent");
            assert_eq!(json!(logins.vault.lookups.lock().unwrap().clone()), case["lookups"], "{name}: what the vault was asked");
            assert_eq!(json!(calls.load(Ordering::SeqCst)), case["runnableCalls"], "{name}: dispatch checks");
            let after = &case["after"];
            assert_eq!(json!(registry.redact(sample)), after["redacted"], "{name}");
            assert_eq!(json!(registry.redact(sample)), after["otherSession"], "{name}: for every session");
            assert_eq!(json!(registry.pixel_guards().iter().map(guard_json).collect::<Vec<_>>()), after["guards"], "{name}");
        }
    }

    struct Pids {
        known: Value,
        reads: AtomicUsize,
    }

    #[async_trait]
    impl WindowPids for Pids {
        async fn window_pid(&self, window_id: &str) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            match self.known.get(window_id).and_then(Value::as_str) {
                Some("throw") => Err("unreadable".to_owned()),
                other => Ok(other.map(str::to_owned)),
            }
        }
    }

    #[tokio::test]
    async fn the_capture_gate_follows_the_recorded_scenarios() {
        for case in golden("pixels.json")["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let registry = SavedLoginRegistry::new();
            for guard in case["guards"].as_array().unwrap() {
                let armed = registry.arm_pixels(PixelGuard { turn: turn_of(guard), window_id: guard["windowId"].as_str().unwrap().to_owned(), pid: guard["pid"].as_str().unwrap().to_owned() });
                assert!(armed, "{name}");
            }
            let pids = Pids { known: case["pids"].clone(), reads: AtomicUsize::new(0) };
            let outcome = pixels_allowed(&registry, case["command"]["mode"].as_str().unwrap_or_default(), case["windowId"].as_str().unwrap(), &pids).await;
            let got = match outcome {
                Ok(()) => "allowed".to_owned(),
                Err(message) => message,
            };
            assert_eq!(json!(got), case["outcome"], "{name}");
            assert_eq!(json!(pids.reads.load(Ordering::SeqCst)), case["pidReads"], "{name}: the process is read at most once, and only when needed");
        }
    }
}