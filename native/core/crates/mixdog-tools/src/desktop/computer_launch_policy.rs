//! The launch policy of Computer Use: what the host that starts the core allows a session to do, and the in-process narrowing the
//! embedding host or the reliability harness may add on top of it (`host/execution-policy.ts`, `host/authorization-settings.ts`).
//!
//! Only trusted launch configuration selects a policy: the file named by `MIXDOG_COMPUTER_POLICY_FILE`, never a tool argument. With
//! no file there is no policy and nothing is refused. A policy file that cannot be loaded does not open anything: every command
//! but a lifecycle control is refused with `computer_policy_invalid`, the nearest to "Computer Use was not started".

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::computer::ComputerError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The environment variable the host names the policy file by.
pub(super) const POLICY_FILE_ENV: &str = "MIXDOG_COMPUTER_POLICY_FILE";

/// `COMPUTER_POLICY_ACTIONS` (`computer-bridge/actions.mjs`): the public actions a policy can name.
const POLICY_ACTIONS: [&str; 10] = ["list", "capture", "diagnose", "act", "window", "menu", "verify", "launch", "clipboard_read", "clipboard_write"];
/// The public actions that act on one window, which a policy must have named by its exact id.
const WINDOW_BOUND: [&str; 5] = ["act", "capture", "window", "menu", "verify"];
/// `computerActionHas(name, 'lifecycle')`: the controls that end or settle work; never refused.
pub(super) const LIFECYCLE_ACTIONS: [&str; 4] = ["execution_end", "session_release", "session_abort", "turn_settle"];
/// The input actions of a sequence's steps (policy `act`): a step is judged on its action alone, the sequence it belongs to having
/// been judged with its window.
pub(super) const STEP_ACTIONS: [&str; 17] = [
    "invoke",
    "set_value",
    "toggle",
    "click",
    "double_click",
    "right_click",
    "middle_click",
    "triple_click",
    "mouse_down",
    "mouse_up",
    "mouse_move",
    "drag",
    "type",
    "key",
    "key_down",
    "key_up",
    "scroll",
];
const FIELDS: [&str; 6] = ["version", "actions", "windows", "launchTargets", "allowElevatedInput", "expiresAt"];
const MAX_POLICY_BYTES: usize = 64 * 1024;
const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;

const INVALID: &str = "computer_policy_invalid: expected a version 1 policy with exact actions, windows and launch targets";
const NOT_LOADED: &str = "computer_policy_invalid: the configured policy could not be loaded; Computer Use was not started";
const IDENTITY: &str = "computer_policy_denied: target process identity no longer matches the authorization";

fn failed(message: &str) -> ComputerError {
    let code = message.split(':').next().unwrap_or_default();
    ComputerError::Failed { code: code.to_owned(), message: message.to_owned() }
}

/// The public action a helper action is judged as (`computerActionPolicy`): its own name where the catalogue gives none.
fn public_action(action: &str) -> &str {
    match action {
        "list_windows" | "list_apps" | "list_installed_apps" | "list_history" => "list",
        "snapshot" | "find" | "window_bounds" | "screenshot" | "zoom" => "capture",
        "wait" | "fill_saved_login" | "sequence" => "act",
        "focus_window" | "move_window" | "window_state" | "close_window" | "terminate_process" => "window",
        "invoke_menu" => "menu",
        other if STEP_ACTIONS.contains(&other) => "act",
        other => other,
    }
}

/// A window the command names: its id, and the process that owns it when that has been read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowFacts {
    pub id: String,
    pub pid: Option<u64>,
}

/// A window as the narrowing layer offers it: its id and the process that owns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowIdentity {
    pub id: String,
    pub pid: u64,
}

/// JavaScript's `String.prototype.trim` white space.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// A window id a policy may name: `hwnd:0x` and hex digits, in either case.
fn window_id_shape(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    lower.strip_prefix("hwnd:0x").is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_hexdigit()))
}

/// `Date.parse` of the forms a policy writes: RFC 3339, or a date with an optional time and no zone (read as UTC).
fn parse_instant(text: &str) -> Option<f64> {
    if let Ok(at) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(at.timestamp_millis() as f64);
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(at) = chrono::NaiveDateTime::parse_from_str(text, format) {
            return Some(at.and_utc().timestamp_millis() as f64);
        }
    }
    let day = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
    Some(day.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64)
}

/// A version 1 policy: the exact public actions, windows (by id and owning process) and launch targets a session may use, and when it
/// ends.
#[derive(Clone, Debug)]
pub struct LaunchPolicy {
    actions: BTreeSet<String>,
    windows: HashMap<String, u64>,
    launches: HashSet<String>,
    elevated: bool,
    expires_at: f64,
    /// The policy could not be loaded: nothing but a lifecycle control is admitted.
    unloadable: bool,
}

impl LaunchPolicy {
    /// The policy the environment names: none when it names none, and one that admits nothing when what it names cannot be loaded
    /// (a launch that asked to be restricted is never opened by a broken file).
    pub fn load(env: &dyn Fn(&str) -> Option<String>) -> Option<Self> {
        let path = env(POLICY_FILE_ENV)?;
        let loaded = Self::read(&path);
        if loaded.is_none() {
            tracing::error!("{NOT_LOADED}");
        }
        Some(loaded.unwrap_or(Self {
            actions: BTreeSet::new(),
            windows: HashMap::new(),
            launches: HashSet::new(),
            elevated: false,
            expires_at: f64::INFINITY,
            unloadable: true,
        }))
    }

    fn read(path: &str) -> Option<Self> {
        if path.trim().is_empty() {
            return None;
        }
        let source = mixdog_statefile::read_content(Path::new(path)).ok()??;
        if source.len() > MAX_POLICY_BYTES {
            return None;
        }
        Self::parse(&serde_json::from_slice(&source).ok()?).ok()
    }

    /// `createComputerExecutionPolicy(raw)`: the policy a value states, or `computer_policy_invalid`.
    pub fn parse(raw: &Value) -> Result<Self, ComputerError> {
        let invalid = || failed(INVALID);
        let value = raw.as_object().ok_or_else(invalid)?;
        if value.keys().any(|key| !FIELDS.contains(&key.as_str())) || value.get("version").and_then(Value::as_f64) != Some(1.0) {
            return Err(invalid());
        }
        let strings = |field: &str| -> Result<Vec<String>, ComputerError> {
            let list = match value.get(field) {
                None | Some(Value::Null) => return Ok(Vec::new()),
                Some(Value::Array(list)) if list.len() <= 128 => list,
                Some(_) => return Err(invalid()),
            };
            let mut out = Vec::with_capacity(list.len());
            for entry in list {
                match entry.as_str() {
                    Some(text) if !text.trim_matches(js_space).is_empty() && text.trim_matches(js_space) == text && text.encode_utf16().count() <= 4096 => {
                        out.push(text.to_owned());
                    }
                    _ => return Err(invalid()),
                }
            }
            Ok(out)
        };
        let actions: BTreeSet<String> = strings("actions")?.into_iter().collect();
        if actions.iter().any(|action| !POLICY_ACTIONS.contains(&action.as_str())) {
            return Err(invalid());
        }
        let launches: HashSet<String> = strings("launchTargets")?.into_iter().collect();
        let none = Vec::new();
        let targets = match value.get("windows") {
            None | Some(Value::Null) => &none,
            Some(Value::Array(list)) if list.len() <= 128 => list,
            Some(_) => return Err(invalid()),
        };
        let mut windows = HashMap::new();
        for target in targets {
            let target = target.as_object().ok_or_else(invalid)?;
            let id = target.get("id").and_then(Value::as_str).filter(|id| window_id_shape(id)).ok_or_else(invalid)?;
            let pid = target.get("pid").and_then(Value::as_f64).filter(|pid| pid.fract() == 0.0 && *pid >= 1.0 && *pid <= 9_007_199_254_740_991.0);
            if target.keys().any(|key| key != "id" && key != "pid") || windows.contains_key(id) {
                return Err(invalid());
            }
            windows.insert(id.to_owned(), pid.ok_or_else(invalid)? as u64);
        }
        let elevated = match value.get("allowElevatedInput") {
            None => false,
            Some(Value::Bool(allowed)) => *allowed,
            Some(_) => return Err(invalid()),
        };
        let expires_at = value.get("expiresAt").and_then(Value::as_str).and_then(parse_instant).ok_or_else(invalid)?;
        Ok(Self { actions, windows, launches, elevated, expires_at, unloadable: false })
    }

    /// When the authorization ends, in milliseconds since the epoch; `None` for a policy that does not end.
    pub fn expires_at(&self) -> Option<f64> {
        self.expires_at.is_finite().then_some(self.expires_at)
    }

    /// Whether input to a window of higher integrity may ask for elevation.
    pub fn allows_elevated_input(&self) -> bool {
        self.elevated
    }

    fn assert_current(&self, now_ms: f64) -> Result<(), ComputerError> {
        if now_ms >= self.expires_at {
            return Err(failed("computer_policy_expired: the configured authorization has expired"));
        }
        Ok(())
    }

    /// The public action `action` is judged as, when the policy names it and has not ended.
    fn check<'a>(&self, action: &'a str, now_ms: f64) -> Result<&'a str, ComputerError> {
        if self.unloadable {
            return Err(failed(NOT_LOADED));
        }
        self.assert_current(now_ms)?;
        let public = public_action(action);
        if !self.actions.contains(public) {
            return Err(failed("computer_policy_denied: this action is outside the configured authorization"));
        }
        Ok(public)
    }

    /// `assertAction` and `assertWindow`: whether `action` may run on `window` (the window the command names, with its owning process
    /// when that has been read) and, for `launch`, on `launch_target`. A lifecycle control is always admitted. A window whose
    /// process is not given is judged by its id alone; the helper checks the process when the input is sent.
    pub fn admit(&self, action: &str, window: Option<&WindowFacts>, launch_target: Option<&str>, now_ms: f64) -> Result<(), ComputerError> {
        if LIFECYCLE_ACTIONS.contains(&action) {
            return Ok(());
        }
        let public = self.check(action, now_ms)?;
        if action == "launch" && !self.launches.contains(launch_target.unwrap_or_default()) {
            return Err(failed("computer_policy_denied: launch target is not explicitly authorized"));
        }
        if WINDOW_BOUND.contains(&public) && window.is_none_or(|window| !self.windows.contains_key(&window.id)) {
            return Err(failed("computer_policy_denied: an explicitly authorized exact window_id is required"));
        }
        if let Some(window) = window {
            let expected = self.windows.get(&window.id).ok_or_else(|| failed(IDENTITY))?;
            if window.pid.is_some_and(|pid| pid != *expected) {
                return Err(failed(IDENTITY));
            }
        }
        Ok(())
    }

    /// One step of a sequence: judged on its action alone; the sequence was admitted with its window.
    pub fn admit_step(&self, action: &str, now_ms: f64) -> Result<(), ComputerError> {
        if LIFECYCLE_ACTIONS.contains(&action) {
            return Ok(());
        }
        self.check(action, now_ms).map(|_| ())
    }

    /// `assertElevated`: input that asks for elevation.
    pub fn admit_elevated(&self, now_ms: f64) -> Result<(), ComputerError> {
        self.assert_current(now_ms)?;
        if self.elevated { Ok(()) } else { Err(failed("computer_policy_denied: elevated input is not authorized")) }
    }

    /// `dispatchAuthority`: what a request carries for the helper to enforce at the moment of input.
    fn authority(&self, window_id: Option<&str>) -> Map<String, Value> {
        let mut out = Map::new();
        if let Some(expires) = self.expires_at() {
            out.insert("authorization_expires_at".into(), json!(expires as i64));
        }
        if let Some(window_id) = window_id.filter(|_| !self.unloadable) {
            out.insert("authorization_window_id".into(), json!(window_id));
            if let Some(pid) = self.windows.get(window_id) {
                out.insert("authorization_pid".into(), json!(pid));
            }
        }
        out
    }
}

/// What `read` reports of the narrowing layer.
#[derive(Clone, Debug, PartialEq)]
pub struct AuthorizationStatus {
    /// The narrowing in force (never the launch policy), or `None`.
    pub policy: Option<Value>,
    pub externally_restricted: bool,
    pub updating: bool,
}

#[derive(Default)]
struct Narrowing {
    raw: Option<Value>,
    current: Option<LaunchPolicy>,
}

/// The launch policy together with the in-process narrowing the harness or an embedding host sets: it can tighten, never replace,
/// the launch policy, and nothing is persisted, so a fresh start is the launch policy alone (a saved file could only expire into a
/// lock-out).
pub struct AuthorizationSettings {
    base: Option<LaunchPolicy>,
    narrowing: Mutex<Narrowing>,
    updating: AtomicBool,
}

impl AuthorizationSettings {
    pub fn new(base: Option<LaunchPolicy>) -> Self {
        Self { base, narrowing: Mutex::new(Narrowing::default()), updating: AtomicBool::new(false) }
    }

    fn narrowing(&self) -> MutexGuard<'_, Narrowing> {
        self.narrowing.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The policies in force: the launch policy, then the narrowing.
    fn policies(&self) -> Vec<LaunchPolicy> {
        self.base.iter().cloned().chain(self.narrowing().current.clone()).collect()
    }

    fn assert_ready(&self) -> Result<(), ComputerError> {
        if self.updating.load(Ordering::SeqCst) { Err(failed("computer_policy_updating: authorization is being replaced")) } else { Ok(()) }
    }

    /// Whether any policy restricts, or one is being replaced.
    pub fn restricted(&self) -> bool {
        self.updating.load(Ordering::SeqCst) || self.base.is_some() || self.narrowing().current.is_some()
    }

    /// The earliest end of the policies in force.
    pub fn authorization_expiry(&self) -> Option<f64> {
        self.policies().iter().filter_map(LaunchPolicy::expires_at).min_by(f64::total_cmp)
    }

    /// Whether elevation may be asked for: every policy in force allows it, and none is being replaced.
    pub fn allows_elevated_input(&self) -> bool {
        self.assert_ready().is_ok() && self.policies().iter().all(LaunchPolicy::allows_elevated_input)
    }

    /// `assertElevated` of every policy in force.
    pub fn admit_elevated(&self, now_ms: f64) -> Result<(), ComputerError> {
        self.assert_ready()?;
        self.policies().iter().try_for_each(|policy| policy.admit_elevated(now_ms))
    }

    /// The fields a request carries for the helper to enforce (`dispatchAuthority`): the narrowing's window and process win over the
    /// launch policy's, the expiry is the earliest of both.
    pub fn dispatch_authority(&self, window_id: Option<&str>) -> Map<String, Value> {
        let mut out = Map::new();
        for policy in self.policies() {
            out.extend(policy.authority(window_id));
        }
        match self.authorization_expiry() {
            Some(expires) => out.insert("authorization_expires_at".into(), json!(expires as i64)),
            None => out.remove("authorization_expires_at"),
        };
        out
    }

    /// `assertAction` and `assertWindow` of every policy in force, the launch policy first.
    pub fn admit(&self, action: &str, window: Option<&WindowFacts>, launch_target: Option<&str>, now_ms: f64) -> Result<(), ComputerError> {
        self.assert_ready()?;
        self.policies().iter().try_for_each(|policy| policy.admit(action, window, launch_target, now_ms))
    }

    /// One step of a sequence, of every policy in force.
    pub fn admit_step(&self, action: &str, now_ms: f64) -> Result<(), ComputerError> {
        self.assert_ready()?;
        self.policies().iter().try_for_each(|policy| policy.admit_step(action, now_ms))
    }

    pub fn read(&self) -> AuthorizationStatus {
        AuthorizationStatus {
            policy: self.narrowing().raw.clone(),
            externally_restricted: self.base.is_some(),
            updating: self.updating.load(Ordering::SeqCst),
        }
    }

    /// Replaces the narrowing. The value must be a valid policy that ends within 24 hours; running work is stopped first, and every
    /// window it names must still be there with the process it names. A refused update leaves the narrowing as it was.
    pub async fn update<S, SF, W, WF>(&self, value: &Value, now: impl Fn() -> f64, stop: S, windows: W) -> Result<AuthorizationStatus, ComputerError>
    where
        S: FnOnce() -> SF,
        SF: Future<Output = ()>,
        W: FnOnce() -> WF,
        WF: Future<Output = Result<Vec<WindowIdentity>, ComputerError>>,
    {
        let busy = || failed("computer_policy_updating: another authorization write is in progress");
        if self.updating.load(Ordering::SeqCst) {
            return Err(busy());
        }
        let candidate = normalize(value)?;
        let next = LaunchPolicy::parse(&candidate)?;
        let expiry = next.expires_at().unwrap_or(f64::NAN);
        if !(expiry > now() && expiry <= now() + DAY_MS) {
            return Err(failed("computer_policy_invalid: authorization must expire within 24 hours"));
        }
        if self.updating.swap(true, Ordering::SeqCst) {
            return Err(busy());
        }
        let checked = async {
            stop().await;
            let live = windows().await?;
            for (id, pid) in &next.windows {
                if !live.iter().any(|window| &window.id == id && window.pid == *pid) {
                    return Err(failed("computer_policy_denied: selected window is no longer available; refresh the list"));
                }
            }
            if expiry <= now() {
                return Err(failed("computer_policy_expired: authorization expired while saving"));
            }
            Ok(())
        }
        .await;
        if checked.is_ok() {
            let mut narrowing = self.narrowing();
            narrowing.raw = Some(candidate);
            narrowing.current = Some(next);
        }
        self.updating.store(false, Ordering::SeqCst);
        checked?;
        Ok(self.read())
    }
}

/// `normalizeAuthorization`: the candidate with every field present, within the storage limit.
fn normalize(value: &Value) -> Result<Value, ComputerError> {
    LaunchPolicy::parse(value)?;
    let raw = value.as_object().ok_or_else(|| failed("computer_policy_invalid: an authorization object is required"))?;
    let field = |name: &str| raw.get(name).filter(|entry| !entry.is_null()).cloned().unwrap_or_else(|| json!([]));
    let normalized = json!({
        "version": 1,
        "actions": field("actions"),
        "windows": field("windows"),
        "launchTargets": field("launchTargets"),
        "allowElevatedInput": raw.get("allowElevatedInput") == Some(&Value::Bool(true)),
        "expiresAt": raw.get("expiresAt").cloned().unwrap_or(Value::Null),
    });
    if normalized.to_string().len() > MAX_POLICY_BYTES {
        return Err(failed("computer_policy_invalid: authorization exceeds the storage limit"));
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    const NOW: f64 = 1_800_000_000_000.0;

    fn expires(offset_ms: f64) -> String {
        chrono::DateTime::from_timestamp_millis((NOW + offset_ms) as i64).unwrap().to_rfc3339()
    }

    fn policy(extra: Value) -> Value {
        let mut base = json!({
            "version": 1,
            "actions": ["capture", "act", "launch"],
            "windows": [{"id": "hwnd:0x1", "pid": 42}],
            "launchTargets": ["notepad"],
            "allowElevatedInput": false,
            "expiresAt": expires(60_000.0),
        });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        base
    }

    fn denied(result: Result<(), ComputerError>, code: &str) {
        match result {
            Err(ComputerError::Failed { code: got, .. }) => assert_eq!(got, code),
            other => panic!("expected {code}, got {other:?}"),
        }
    }

    fn on(id: &str, pid: Option<u64>) -> WindowFacts {
        WindowFacts { id: id.into(), pid }
    }

    fn written(body: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        std::fs::write(&path, body).unwrap();
        let path = path.to_string_lossy().into_owned();
        (dir, path)
    }

    fn env_of(path: &str) -> impl Fn(&str) -> Option<String> + '_ {
        move |key| (key == POLICY_FILE_ENV).then(|| path.to_owned())
    }

    #[test]
    fn no_policy_file_is_no_policy() {
        assert!(LaunchPolicy::load(&|_| None).is_none());
        let settings = AuthorizationSettings::new(None);
        assert!(!settings.restricted());
        assert_eq!(settings.admit("click", None, None, NOW), Ok(()));
        assert!(settings.allows_elevated_input());
        assert!(settings.dispatch_authority(Some("hwnd:0x9")).is_empty());
    }

    #[test]
    fn a_policy_file_is_read_and_a_broken_one_admits_nothing() {
        let (_dir, path) = written(&policy(json!({})).to_string());
        let loaded = LaunchPolicy::load(&env_of(&path)).unwrap();
        assert!(!loaded.unloadable);
        assert_eq!(loaded.admit("capture", Some(&on("hwnd:0x1", None)), None, NOW), Ok(()));
        let wrong_action = policy(json!({"actions": ["anything"]})).to_string();
        for broken in ["not json", "{}", "", wrong_action.as_str()] {
            let (_dir, path) = written(broken);
            let loaded = LaunchPolicy::load(&env_of(&path)).unwrap();
            denied(loaded.admit("capture", Some(&on("hwnd:0x1", None)), None, NOW), "computer_policy_invalid");
            assert_eq!(loaded.admit("session_release", None, None, NOW), Ok(()));
        }
        denied(LaunchPolicy::load(&env_of("   ")).unwrap().admit("list_windows", None, None, NOW), "computer_policy_invalid");
        let missing = std::env::temp_dir().join("no-such-policy-file.json").to_string_lossy().into_owned();
        denied(LaunchPolicy::load(&env_of(&missing)).unwrap().admit("list_windows", None, None, NOW), "computer_policy_invalid");
        let (_dir, huge) = written(&format!("{{\"version\":1,\"pad\":\"{}\"}}", "x".repeat(70_000)));
        denied(LaunchPolicy::load(&env_of(&huge)).unwrap().admit("list_windows", None, None, NOW), "computer_policy_invalid");
    }

    #[test]
    fn the_format_is_exact() {
        for bad in [
            json!(null),
            json!([]),
            policy(json!({"version": 2})),
            policy(json!({"extra": 1})),
            policy(json!({"actions": "capture"})),
            policy(json!({"actions": ["capture "]})),
            policy(json!({"actions": [""]})),
            policy(json!({"actions": ["list_windows"]})),
            policy(json!({"launchTargets": [3]})),
            policy(json!({"launchTargets": ["x".repeat(4097)]})),
            policy(json!({"launchTargets": vec!["x"; 129]})),
            policy(json!({"windows": [{"id": "hwnd:1", "pid": 1}]})),
            policy(json!({"windows": [{"id": "hwnd:0x", "pid": 1}]})),
            policy(json!({"windows": [{"id": "hwnd:0x1", "pid": 0}]})),
            policy(json!({"windows": [{"id": "hwnd:0x1", "pid": 1.5}]})),
            policy(json!({"windows": [{"id": "hwnd:0x1", "pid": 1, "title": "t"}]})),
            policy(json!({"windows": [{"id": "hwnd:0x1", "pid": 1}, {"id": "hwnd:0x1", "pid": 2}]})),
            policy(json!({"allowElevatedInput": null})),
            policy(json!({"allowElevatedInput": "yes"})),
            policy(json!({"expiresAt": 5})),
            policy(json!({"expiresAt": "tomorrow"})),
        ] {
            assert!(LaunchPolicy::parse(&bad).is_err(), "{bad}");
        }
        let mut missing_expiry = policy(json!({}));
        missing_expiry.as_object_mut().unwrap().remove("expiresAt");
        assert!(LaunchPolicy::parse(&missing_expiry).is_err());
        let minimal = LaunchPolicy::parse(&json!({"version": 1, "expiresAt": expires(1.0)})).unwrap();
        denied(minimal.admit("capture", Some(&on("hwnd:0x1", None)), None, NOW), "computer_policy_denied");
        assert!(LaunchPolicy::parse(&policy(json!({"windows": [{"id": "HWND:0xAB", "pid": 7}]}))).is_ok());
        for date in ["2030-01-01", "2030-01-01T10:00", "2030-01-01T10:00:00.5", "2030-01-01T10:00:00Z", "2030-01-01T10:00:00+09:00"] {
            assert!(parse_instant(date).is_some(), "{date}");
        }
    }

    #[test]
    fn actions_windows_and_launch_targets_are_admitted_exactly() {
        let policy = LaunchPolicy::parse(&policy(json!({}))).unwrap();
        let window = on("hwnd:0x1", None);
        assert_eq!(policy.admit("capture", Some(&window), None, NOW), Ok(()));
        assert_eq!(policy.admit("zoom", Some(&window), None, NOW), Ok(()));
        assert_eq!(policy.admit("sequence", Some(&window), None, NOW), Ok(()));
        denied(policy.admit("list_windows", None, None, NOW), "computer_policy_denied");
        denied(policy.admit("focus_window", Some(&window), None, NOW), "computer_policy_denied");
        denied(policy.admit("window_snapshot", Some(&window), None, NOW), "computer_policy_denied");
        denied(policy.admit("capture", Some(&on("hwnd:0x2", None)), None, NOW), "computer_policy_denied");
        denied(policy.admit("capture", None, None, NOW), "computer_policy_denied");
        assert_eq!(policy.admit("launch", None, Some("notepad"), NOW), Ok(()));
        denied(policy.admit("launch", None, Some("calc"), NOW), "computer_policy_denied");
        denied(policy.admit("launch", None, None, NOW), "computer_policy_denied");
        for lifecycle in LIFECYCLE_ACTIONS {
            assert_eq!(policy.admit(lifecycle, None, None, NOW + 1e12), Ok(()));
        }
        assert_eq!(policy.admit_step("click", NOW), Ok(()));
        denied(policy.admit_step("focus_window", NOW), "computer_policy_denied");
    }

    #[test]
    fn the_owning_process_must_still_match() {
        let policy = LaunchPolicy::parse(&policy(json!({"actions": ["capture", "verify"]}))).unwrap();
        assert_eq!(policy.admit("capture", Some(&on("hwnd:0x1", Some(42))), None, NOW), Ok(()));
        denied(policy.admit("capture", Some(&on("hwnd:0x1", Some(43))), None, NOW), "computer_policy_denied");
    }

    #[test]
    fn the_authorization_expires() {
        let policy = LaunchPolicy::parse(&policy(json!({}))).unwrap();
        let window = on("hwnd:0x1", None);
        assert_eq!(policy.admit("capture", Some(&window), None, NOW + 59_999.0), Ok(()));
        denied(policy.admit("capture", Some(&window), None, NOW + 60_000.0), "computer_policy_expired");
        denied(policy.admit_elevated(NOW + 60_000.0), "computer_policy_expired");
        assert_eq!(policy.expires_at(), Some(NOW + 60_000.0));
    }

    #[test]
    fn elevated_input_needs_the_policy_to_allow_it() {
        let closed = LaunchPolicy::parse(&policy(json!({}))).unwrap();
        denied(closed.admit_elevated(NOW), "computer_policy_denied");
        let open = LaunchPolicy::parse(&policy(json!({"allowElevatedInput": true}))).unwrap();
        assert_eq!(open.admit_elevated(NOW), Ok(()));
    }

    #[test]
    fn a_request_carries_the_authority_for_the_helper() {
        let settings = AuthorizationSettings::new(Some(LaunchPolicy::parse(&policy(json!({}))).unwrap()));
        let carried = settings.dispatch_authority(Some("hwnd:0x1"));
        assert_eq!(carried["authorization_pid"], json!(42));
        assert_eq!(carried["authorization_window_id"], json!("hwnd:0x1"));
        assert_eq!(carried["authorization_expires_at"], json!((NOW + 60_000.0) as i64));
        assert!(!settings.dispatch_authority(None).contains_key("authorization_pid"));
    }

    fn target() -> WindowIdentity {
        WindowIdentity { id: "hwnd:0x1".into(), pid: 42 }
    }

    #[tokio::test]
    async fn a_narrowing_gates_dispatch_keeps_the_launch_policy_and_is_never_persisted() {
        let base = LaunchPolicy::parse(&policy(json!({"actions": ["capture", "list"]}))).unwrap();
        let settings = AuthorizationSettings::new(Some(base.clone()));
        assert_eq!(settings.read().policy, None);
        assert!(settings.read().externally_restricted);
        let candidate = policy(json!({"actions": ["capture"]}));
        let (release, wait) = tokio::sync::oneshot::channel::<()>();
        let saving = settings.update(&candidate, || NOW, || async move { wait.await.unwrap() }, || async { Ok(vec![target()]) });
        let during = async {
            assert!(settings.read().updating);
            denied(settings.admit("capture", Some(&on("hwnd:0x1", None)), None, NOW), "computer_policy_updating");
            let second = settings.update(&candidate, || NOW, || async {}, || async { Ok(vec![target()]) }).await;
            denied(second.map(|_| ()), "computer_policy_updating");
            release.send(()).unwrap();
        };
        let (saved, ()) = tokio::join!(saving, during);
        saved.unwrap();
        assert!(!settings.read().updating);
        assert_eq!(settings.admit("capture", Some(&on("hwnd:0x1", None)), None, NOW), Ok(()));
        denied(settings.admit("list_windows", None, None, NOW), "computer_policy_denied");
        assert_eq!(AuthorizationSettings::new(Some(base)).read().policy, None);
        let before = settings.read();
        let broader = policy(json!({"actions": ["act"], "windows": [{"id": "hwnd:0x2", "pid": 90}]}));
        let refused = settings.update(&broader, || NOW, || async {}, || async { Ok(vec![target()]) }).await;
        assert!(matches!(refused, Err(ComputerError::Failed { message, .. }) if message.contains("no longer available")));
        assert_eq!(settings.read(), before);
        settings.update(&policy(json!({"actions": ["act"]})), || NOW, || async {}, || async { Ok(vec![target()]) }).await.unwrap();
        denied(settings.admit("click", Some(&on("hwnd:0x1", None)), None, NOW), "computer_policy_denied");
        assert_eq!(settings.read().policy.unwrap()["actions"], json!(["act"]));
    }

    #[tokio::test]
    async fn a_candidate_that_is_invalid_or_too_long_lived_fails_without_stopping_work() {
        let stops = AtomicUsize::new(0);
        let settings = AuthorizationSettings::new(None);
        assert!(!settings.restricted());
        for bad in [
            Value::Null,
            json!({}),
            policy(json!({"actions": ["anything"]})),
            policy(json!({"expiresAt": expires(-NOW)})),
            policy(json!({"expiresAt": expires(48.0 * 3600_000.0)})),
            policy(json!({"launchTargets": (0..128).map(|i| format!("C:\\{i}{}", "x".repeat(1000))).collect::<Vec<_>>()})),
        ] {
            let result = settings
                .update(&bad, || NOW, || async { stops.fetch_add(1, Ordering::SeqCst); }, || async { Ok(vec![target()]) })
                .await;
            denied(result.map(|_| ()), "computer_policy_invalid");
        }
        assert_eq!(stops.load(Ordering::SeqCst), 0);
        let saved = settings
            .update(&json!({"version": 1, "expiresAt": expires(60_000.0)}), || NOW, || async { stops.fetch_add(1, Ordering::SeqCst); }, || async { Ok(Vec::new()) })
            .await
            .unwrap();
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        let shown = saved.policy.unwrap();
        assert_eq!(shown["actions"], json!([]));
        assert_eq!(shown["windows"], json!([]));
        assert!(settings.restricted());
        denied(settings.admit("capture", Some(&on("hwnd:0x1", None)), None, NOW), "computer_policy_denied");
    }
}
