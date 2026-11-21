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
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build")
    )]
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
            let turns =
                state.running.iter().map(|(_, turn)| turn).chain(state.guards.iter().map(|guard| &guard.turn)).chain(state.values.iter().map(|(turn, _)| turn));
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
fn as_saved_login_reply(response: Value) -> Value {
    with_result(response, |result| {
        result.shift_remove("saved_login_target");
    })
}

fn with_result(mut response: Value, edit: impl FnOnce(&mut Map<String, Value>)) -> Value {
    let mut result: Map<String, Value> = response.get("result").and_then(Value::as_object).cloned().unwrap_or_default();
    result.insert("action".to_owned(), json!("fill_saved_login"));
    edit(&mut result);
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
    let FillContext { registry, windows, assert_runnable, .. } = context;
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
    let available = assert_available(command, logins, *windows)?;
    let saved = logins
        .vault()
        .value(&origin, &account, available.field)
        .await
        .map_err(|message| format!("saved_login_unavailable: {}; no input was sent", error_text(&message)))?;
    // The worker's origin and the vault's (secureOrigin) must agree exactly.
    if saved.origin != origin {
        return Err("saved_login_refused: the page origin could not be matched exactly to the saved login; no input was sent".to_owned());
    }
    assert_runnable()?;
    assert_available(command, logins, *windows)?;
    if field == SavedLoginField::Password {
        protect_password(registry, &turn, &saved.value, &target)?;
    }
    let written = send_value(command, logins, worker, context, field, &saved, &target).await?;
    if written.get("result").and_then(|result| result.get("code")).and_then(Value::as_str).is_some_and(|code| !code.is_empty()) {
        return Ok(as_saved_login_reply(written));
    }
    Ok(filled_reply(written, &saved, field))
}

fn protect_password(registry: &SavedLoginRegistry, turn: &SavedLoginTurn, password: &str, target: &Value) -> Result<(), String> {
    let flat: String = password.chars().filter(|c| !matches!(c, '\r' | '\n')).collect();
    let mut spellings: Vec<String> = [password.to_owned(), flat]
        .into_iter()
        .flat_map(|value| {
            let escaped = serde_json::to_string(&value).map(|json| json[1..json.len() - 1].to_owned()).unwrap_or_default();
            [value, escaped]
        })
        .collect();
    let remembered = registry.remember(turn, &spellings);
    spellings.iter_mut().for_each(wipe);
    if !remembered {
        return Err("saved_login_refused: the password could not be registered for redaction; no input was sent".to_owned());
    }
    let guard = PixelGuard { turn: turn.clone(), window_id: js_string(target.get("window_id")), pid: js_string(target.get("pid")) };
    if !registry.arm_pixels(guard) {
        return Err("saved_login_refused: the browser window and process could not be identified to hold its captures back; no input was sent".to_owned());
    }
    Ok(())
}

async fn send_value(
    command: &Value,
    logins: &dyn SavedLogins,
    worker: &dyn SavedLoginWorker,
    context: &FillContext<'_>,
    field: SavedLoginField,
    saved: &SavedLoginValue,
    target: &Value,
) -> Result<Value, String> {
    let FillContext { windows, assert_runnable, redact, .. } = context;
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
        return Err(redact(
            &text_of(&written, "error")
                .unwrap_or_else(|| "saved_login_unconfirmed: the worker gave no answer; the value may have been written and is not retried".to_owned()),
        ));
    }
    Ok(written)
}

fn filled_reply(written: Value, saved: &SavedLoginValue, field: SavedLoginField) -> Value {
    let text = match field {
        SavedLoginField::Password => format!(
            "filled the saved password of {} into the focused field on {}; the site receives it and it stays out of your results, though a page that redisplays it can expose it; pixels of this browser are withheld until this turn ends",
            saved.label, saved.origin
        ),
        SavedLoginField::Username => format!(
            "filled the saved username of {} into the focused field on {}; a username is an identifier and is not hidden from you",
            saved.label, saved.origin
        ),
    };
    with_result(written, |result| {
        result.insert("text".to_owned(), json!(text));
        result.insert("saved_login".to_owned(), json!({ "account": saved.label, "origin": saved.origin, "field": field.as_str() }));
    })
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

/// The saved-login rules from the code's contract: what a fill sends and refuses, what stays out of the model's sight, and
/// when each protection ends.
#[cfg(test)]
mod rule_tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use super::*;

    const SESSION: &str = "s1";
    const LABEL: &str = "j•••e@example.com";
    const PASSWORD: &str = "Pa55-\"word\"\\x";

    fn turn(session: &str, number: u64) -> SavedLoginTurn {
        SavedLoginTurn { session: session.to_owned(), turn: number }
    }

    fn guard(session: &str, number: u64, window: &str, pid: &str) -> PixelGuard {
        PixelGuard { turn: turn(session, number), window_id: window.to_owned(), pid: pid.to_owned() }
    }

    fn page() -> Value {
        json!({ "window_id": "hwnd:0x1", "pid": "4242", "origin": "https://login.example.com", "field": "password" })
    }

    struct Vault {
        origin: String,
        fails: Option<String>,
        lookups: Mutex<Vec<(String, String, &'static str)>>,
    }

    #[async_trait]
    impl SavedLoginVault for Vault {
        async fn value(&self, url: &str, account: &str, field: SavedLoginField) -> Result<SavedLoginValue, String> {
            self.lookups.lock().unwrap().push((url.to_owned(), account.to_owned(), field.as_str()));
            if let Some(message) = &self.fails {
                return Err(message.clone());
            }
            let value = if field == SavedLoginField::Password { PASSWORD } else { "jane.doe@example.com" };
            Ok(SavedLoginValue { value: value.to_owned(), label: LABEL.to_owned(), origin: self.origin.clone() })
        }
    }

    struct Logins {
        enabled: bool,
        off_after: Option<usize>,
        reads: AtomicUsize,
        vault: Vault,
    }

    impl Logins {
        fn on() -> Self {
            Self {
                enabled: true,
                off_after: None,
                reads: AtomicUsize::new(0),
                vault: Vault { origin: "https://login.example.com".to_owned(), fails: None, lookups: Mutex::new(Vec::new()) },
            }
        }
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
        typed: Result<Value, String>,
        requests: Mutex<Vec<Value>>,
    }

    impl Worker {
        fn ok() -> Self {
            Self {
                check: json!({ "ok": true, "result": { "saved_login_target": page() } }),
                typed: Ok(json!({ "ok": true, "result": { "effect": "confirmed" } })),
                requests: Mutex::new(Vec::new()),
            }
        }
        fn actions(&self) -> Vec<String> {
            self.requests.lock().unwrap().iter().map(|request| request["action"].as_str().unwrap().to_owned()).collect()
        }
    }

    #[async_trait]
    impl SavedLoginWorker for Worker {
        async fn call(&self, request: &Value, before_send: Option<&mut (dyn FnMut() -> Result<(), String> + Send)>) -> Result<Value, String> {
            if let Some(before_send) = before_send {
                before_send()?;
            }
            self.requests.lock().unwrap().push(request.clone());
            if request["action"] == "saved_login_check" { Ok(self.check.clone()) } else { self.typed.clone() }
        }
    }

    fn command(field: &str) -> Value {
        json!({ "field": field, "saved_account": LABEL, "window_id": "hwnd:0x1", "runtime_id": "rt", "turn_id": 7, "session_id": SESSION })
    }

    async fn fill(registry: &Arc<SavedLoginRegistry>, command: &Value, logins: &Logins, worker: &Worker, windows: bool, admit: bool) -> Result<Value, String> {
        let _admitted = admit.then(|| registry.admit(&turn(SESSION, 7)).unwrap());
        let ok = || Ok(());
        let hide = |text: &str| registry.redact(text);
        fill_saved_login(command, logins, worker, &FillContext { registry, windows, assert_runnable: &ok, redact: &hide }).await
    }

    fn refused(outcome: Result<Value, String>) -> String {
        outcome.expect_err("the fill is refused")
    }

    /// A password reaches the page once, only for an admitted fill of a checked window on the origin the vault saved it for; the
    /// reply names the label and origin and never the value; every spelling of the value is hidden from then on, for every
    /// session; the window's pixels are held back.
    #[tokio::test]
    async fn a_password_fill_writes_once_and_leaves_the_value_hidden_and_the_pixels_held() {
        let registry = SavedLoginRegistry::new();
        let (logins, worker) = (Logins::on(), Worker::ok());
        let reply = fill(&registry, &command("password"), &logins, &worker, true, true).await.expect("filled");
        assert_eq!(worker.actions(), ["saved_login_check", "saved_login_type"]);
        assert_eq!(worker.requests.lock().unwrap()[1]["text"], PASSWORD, "the value goes to the worker only");
        assert_eq!(logins.vault.lookups.lock().unwrap().clone(), [("https://login.example.com".to_owned(), LABEL.to_owned(), "password")]);
        assert_eq!(reply["result"]["saved_login"], json!({ "account": LABEL, "origin": "https://login.example.com", "field": "password" }));
        assert!(!reply.to_string().contains("Pa55"), "the model never sees the value: {reply}");
        assert!(reply["result"]["text"].as_str().unwrap().contains("pixels of this browser are withheld until this turn ends"));
        assert_eq!(registry.redact(&format!("echo {PASSWORD} and {}", serde_json::to_string(PASSWORD).unwrap())), "echo [saved login] and \"[saved login]\"");
        assert_eq!(registry.pixel_guards(), [guard(SESSION, 7, "hwnd:0x1", "4242")]);
    }

    /// A username is an identifier: filled with no redaction and no pixel hold.
    #[tokio::test]
    async fn a_username_fill_hides_nothing_and_holds_no_pixels() {
        let registry = SavedLoginRegistry::new();
        let (logins, worker) = (Logins::on(), Worker::ok());
        let reply = fill(&registry, &command("username"), &logins, &worker, true, true).await.expect("filled");
        assert!(reply["result"]["text"].as_str().unwrap().contains("is not hidden from you"));
        assert_eq!(registry.redact("jane.doe@example.com"), "jane.doe@example.com");
        assert!(registry.pixel_guards().is_empty());
    }

    /// Each refusal sends no input at all: nothing is written, and the vault is not asked unless the refusal came after it.
    #[tokio::test]
    async fn each_refusal_before_the_write_sends_no_input() {
        let mut cases: Vec<(&str, Value, Logins, Worker, bool, bool, &str)> = Vec::new();
        cases.push((
            "not Windows",
            command("password"),
            Logins::on(),
            Worker::ok(),
            false,
            true,
            "saved_login_unavailable: saved logins are filled on Windows only for now; no input was sent",
        ));
        cases.push((
            "Auto login off",
            command("password"),
            Logins { enabled: false, ..Logins::on() },
            Worker::ok(),
            true,
            true,
            "saved_login_unavailable: Auto login is off in Settings (인증 관리); no input was sent",
        ));
        cases.push(("another field", command("otp"), Logins::on(), Worker::ok(), true, true, "invalid_input: field must be username or password; one-time codes, passkeys, security keys and app approvals are the user's step (handoff_user takeover)"));
        let mut no_account = command("password");
        no_account["saved_account"] = json!("  ");
        cases.push(("no account", no_account, Logins::on(), Worker::ok(), true, true, "invalid_input: saved_account must name a saved login"));
        let mut no_window = command("password");
        no_window["window_id"] = json!(" ");
        cases.push(("no window", no_window, Logins::on(), Worker::ok(), true, true, "fill_saved_login requires an exact window_id before dispatch"));
        let mut no_turn = command("password");
        no_turn["turn_id"] = json!(0);
        cases.push((
            "no turn",
            no_turn,
            Logins::on(),
            Worker::ok(),
            true,
            true,
            "saved_login_unavailable: the request names no runtime and agent turn to scope its protection to; no input was sent",
        ));
        cases.push((
            "not admitted",
            command("password"),
            Logins::on(),
            Worker::ok(),
            true,
            false,
            "saved_login_unavailable: the fill was not admitted by the bridge for its runtime and turn; no input was sent",
        ));
        for (name, command, logins, worker, windows, admit, want) in cases {
            let registry = SavedLoginRegistry::new();
            assert_eq!(refused(fill(&registry, &command, &logins, &worker, windows, admit).await), want, "{name}");
            assert!(worker.requests.lock().unwrap().is_empty(), "{name}: the worker was not asked");
            assert!(logins.vault.lookups.lock().unwrap().is_empty(), "{name}: the vault was not asked");
            assert!(registry.pixel_guards().is_empty() && registry.redact(PASSWORD) == PASSWORD, "{name}");
        }
    }

    /// A vault miss, a vault answer for another origin, and an Auto login that went off during the lookup all stop before the value
    /// is sent, and a window the worker would not check is the worker's own answer.
    #[tokio::test]
    async fn a_lookup_that_fails_or_disagrees_stops_before_the_value_is_sent() {
        let registry = SavedLoginRegistry::new();
        let mut logins = Logins::on();
        logins.vault.fails = Some("no saved login for j•••e@example.com.".to_owned());
        let worker = Worker::ok();
        assert_eq!(
            refused(fill(&registry, &command("password"), &logins, &worker, true, true).await),
            "saved_login_unavailable: no saved login for j•••e@example.com; no input was sent"
        );
        assert_eq!(worker.actions(), ["saved_login_check"]);

        let mut other_origin = Logins::on();
        other_origin.vault.origin = "https://evil.example.com".to_owned();
        let worker = Worker::ok();
        assert_eq!(
            refused(fill(&registry, &command("password"), &other_origin, &worker, true, true).await),
            "saved_login_refused: the page origin could not be matched exactly to the saved login; no input was sent"
        );
        assert_eq!(worker.actions(), ["saved_login_check"]);

        let off_during = Logins { off_after: Some(1), ..Logins::on() };
        let worker = Worker::ok();
        assert_eq!(
            refused(fill(&registry, &command("password"), &off_during, &worker, true, true).await),
            "saved_login_unavailable: Auto login is off in Settings (인증 관리); no input was sent"
        );
        assert_eq!(worker.actions(), ["saved_login_check"]);
        assert!(off_during.vault.lookups.lock().unwrap().is_empty(), "the vault was not asked");
        assert!(registry.pixel_guards().is_empty() && registry.redact(PASSWORD) == PASSWORD);

        let mut unchecked = Worker::ok();
        unchecked.check = json!({ "ok": false, "error": "the window is not a browser" });
        assert_eq!(refused(fill(&registry, &command("password"), &Logins::on(), &unchecked, true, true).await), "the window is not a browser");
    }

    /// A write that was sent and not clearly answered is "possibly written" and is not retried; the worker's error text never
    /// carries the value.
    #[tokio::test]
    async fn a_write_with_no_clear_answer_is_unconfirmed_and_hides_the_value() {
        let registry = SavedLoginRegistry::new();
        let mut worker = Worker::ok();
        worker.typed = Err(format!("the field said {PASSWORD}."));
        let message = refused(fill(&registry, &command("password"), &Logins::on(), &worker, true, true).await);
        assert_eq!(
            message,
            "saved_login_unconfirmed: the saved password was sent but no clear answer came back (the field said [saved login]); it may have been written and is not retried"
        );
        assert_eq!(worker.actions(), ["saved_login_check", "saved_login_type"], "one write, no retry");
    }

    /// The registry: a fill of a settled turn (or an older one) is refused; settling waits for the fills it covers and then retires
    /// their redaction and pixel guards; another session's entries stay; `forget` settles every turn of a session at once.
    #[tokio::test(start_paused = true)]
    async fn settling_waits_for_the_running_fills_then_retires_their_protection() {
        let registry = SavedLoginRegistry::new();
        assert!(registry.remember(&turn("a", 3), &["secret-a".to_owned()]));
        assert!(registry.remember(&turn("b", 1), &["secret-b".to_owned()]));
        assert!(registry.arm_pixels(guard("a", 3, "w1", "10")));
        let running = registry.admit(&turn("a", 3)).expect("admitted");
        assert!(registry.admitted(&turn("a", 3)));

        let settling = tokio::spawn({
            let registry = registry.clone();
            async move { registry.settle(&turn("a", 3)).await }
        });
        mixdog_rt::time::sleep(Duration::from_millis(5)).await;
        assert!(!settling.is_finished(), "the running fill is waited for");
        assert!(registry.admit(&turn("a", 3)).is_err(), "no new fill of the settled turn is admitted meanwhile");
        assert!(registry.admit(&turn("a", 2)).is_err(), "nor of an older one");
        assert_eq!(registry.redact("secret-a"), "[saved login]", "still hidden while the fill runs");
        drop(running);
        settling.await.unwrap();
        assert_eq!(registry.redact("secret-a secret-b"), "secret-a [saved login]", "a's entry retired, b's stays");
        assert!(registry.pixel_guards().is_empty());
        assert!(registry.admit(&turn("a", 4)).is_ok(), "a newer turn is admitted");

        registry.forget("b").await;
        assert_eq!(registry.redact("secret-b"), "secret-b");
        assert_eq!(registry.admit(&turn("b", 1)).err().unwrap(), "its agent turn has already ended");
    }

    /// What `remember` and `arm_pixels` take: a fill with no session or turn 0, no spelling, or no window or process registers
    /// nothing; an empty spelling is skipped; the longest value is replaced first; the same guard is armed once.
    #[test]
    fn the_registry_takes_only_complete_entries_and_replaces_the_longest_value_first() {
        let registry = SavedLoginRegistry::new();
        assert!(!registry.remember(&turn("", 1), &["x".to_owned()]));
        assert!(!registry.remember(&turn("a", 0), &["x".to_owned()]));
        assert!(!registry.remember(&turn("a", 1), &[]));
        assert!(registry.remember(&turn("a", 1), &[String::new(), "abc".to_owned(), "abcdef".to_owned(), "abc".to_owned()]));
        assert_eq!(registry.spellings(), ["abc", "abcdef"]);
        assert_eq!(registry.redact("abcdef abc"), "[saved login] [saved login]");
        assert!(!registry.arm_pixels(guard("a", 1, "", "10")));
        assert!(!registry.arm_pixels(guard("a", 1, "w", "")));
        assert!(!registry.arm_pixels(guard("a", 0, "w", "10")));
        assert!(registry.arm_pixels(guard("a", 1, "W1", "10")));
        assert!(registry.arm_pixels(guard("a", 1, "w1", "10")));
        assert_eq!(registry.pixel_guards().len(), 1, "a window id is the same in either case");
    }

    struct Pids {
        known: Vec<(&'static str, Result<Option<&'static str>, &'static str>)>,
        reads: AtomicUsize,
    }

    #[async_trait]
    impl WindowPids for Pids {
        async fn window_pid(&self, window_id: &str) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            match self.known.iter().find(|(id, _)| *id == window_id) {
                Some((_, Ok(pid))) => Ok(pid.map(str::to_owned)),
                Some((_, Err(message))) => Err((*message).to_owned()),
                None => Ok(None),
            }
        }
    }

    /// While a guard stands no pixels of the filled window or of any window of its process leave, and no full-screen pixels; an
    /// accessibility read carries none and passes; a window whose process cannot be read is refused.
    #[tokio::test]
    async fn pixels_are_withheld_for_the_filled_window_and_its_process_and_nothing_else() {
        const HELD: &str = "capture_withheld: pixels of a browser a saved-login password was filled into are withheld until the end of this agent turn; read it with mode \"ax\" or capture in a later turn";
        let registry = SavedLoginRegistry::new();
        let pids = |known| Pids { known, reads: AtomicUsize::new(0) };
        let none = pids(vec![]);
        assert_eq!(pixels_allowed(&registry, "capture", "w1", &none).await, Ok(()), "no guard: everything passes");
        assert!(registry.arm_pixels(guard("a", 1, "w1", "10")));
        assert_eq!(pixels_allowed(&registry, "capture", "W1", &none).await.unwrap_err(), HELD, "the filled window, whatever its case");
        assert_eq!(none.reads.load(Ordering::SeqCst), 0, "the process is not read when the window is the guard's");
        assert_eq!(pixels_allowed(&registry, "ax", "w1", &none).await, Ok(()), "an accessibility read carries no pixels");
        assert_eq!(pixels_allowed(&registry, "capture", "", &none).await.unwrap_err(), HELD, "a full screen");
        let same_process = pids(vec![("w2", Ok(Some("10")))]);
        assert_eq!(pixels_allowed(&registry, "capture", "w2", &same_process).await.unwrap_err(), HELD);
        let other_process = pids(vec![("w3", Ok(Some("99")))]);
        assert_eq!(pixels_allowed(&registry, "capture", "w3", &other_process).await, Ok(()));
        assert_eq!(other_process.reads.load(Ordering::SeqCst), 1);
        let unreadable = pids(vec![("w4", Err("unreadable"))]);
        assert_eq!(pixels_allowed(&registry, "capture", "w4", &unreadable).await.unwrap_err(), HELD, "fail closed");
        assert_eq!(pixels_allowed(&registry, "capture", "w5", &none).await.unwrap_err(), HELD, "a process nobody knows is fail closed too");
    }
}
