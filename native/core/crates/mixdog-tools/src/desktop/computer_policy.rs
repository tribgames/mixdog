//! Observation-only mode (`host/observation-policy.ts`): the live `desktop.computerObserveOnly` setting, checked when a call is
//! admitted and on every request the helper is sent. Also the execution policy (`host/execution-policy.ts`): the launch policy the
//! host names in `MIXDOG_COMPUTER_POLICY_FILE` (`computer_launch_policy`), which with no file refuses nothing and leaves every
//! request as it was.

use mixdog_core_api::domain::computer::ComputerError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use super::computer_backend::HelperFailure;
use super::computer_command::text;
use super::computer_env::RETAIN_REF_ACTIONS;
use super::computer_frames::FrameStore;
use super::computer_internal_windows;
use super::computer_launch_policy::AuthorizationSettings;
use super::computer_launch_policy::LaunchPolicy;
use super::computer_launch_policy::LIFECYCLE_ACTIONS;
use super::computer_launch_policy::STEP_ACTIONS;
use super::computer_launch_policy::WindowFacts;

/// `OBSERVE_ONLY_ALLOWED_ACTIONS` (`computerActionsWith('observeOnly')`, `computer-bridge/actions.mjs`): every read of the
/// helper and of the host, `diagnose`, and the lifecycle controls. Anything else could change the desktop.
const OBSERVE_ONLY_ALLOWED_ACTIONS: [&str; 31] = [
    "list_windows",
    "window_snapshot",
    "related_windows",
    "snapshot",
    "find",
    "clipboard_read",
    "wait",
    "window_bounds",
    "window_capture",
    "validate_background_input",
    "window_predicates",
    "accessibility_probe",
    "window_integrity",
    "input_recovery_state",
    "input_idle_state",
    "ocr_image",
    "ocr_status",
    "process_fate",
    "list_apps",
    "list_installed_apps",
    "list_history",
    "capture",
    "screenshot",
    "zoom",
    "verify",
    "diagnose",
    "wait_for_user",
    "execution_end",
    "session_release",
    "session_abort",
    "turn_settle",
];

/// The launch policy and the narrowing the harness sets on it, read once from the environment the core was started with. The harness
/// narrows it through `authorization()`; nothing a tool call carries can reach it.
pub fn authorization() -> &'static AuthorizationSettings {
    static SETTINGS: OnceLock<AuthorizationSettings> = OnceLock::new();
    SETTINGS.get_or_init(|| AuthorizationSettings::new(LaunchPolicy::load(&|name| std::env::var(name).ok())))
}

/// The wall clock the policy's expiry is read against, in milliseconds since the epoch.
pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// The host's admission of the helper command a call became, before anything is spawned or sent: `assertObservationInputAllowed`
/// first (while observation-only mode is on, a command that is not a read is refused in the desktop host's words), then the launch
/// policy (`assertPolicyAdmits`), which with no policy file admits everything.
pub(super) fn admit(command: &Map<String, Value>, observe_only: bool, frames: &FrameStore) -> Result<(), ComputerError> {
    let action = text(command, "action");
    if observe_only && !OBSERVE_ONLY_ALLOWED_ACTIONS.contains(&action) {
        let refusal = format!(
            "observation_only: Computer Use is observing only, so '{action}' input is blocked. Turn off \"Observation only\" in Settings to allow input."
        );
        return Err(HelperFailure { text: refusal, result: None }.into_error());
    }
    admit_launch(authorization(), command, frames, now_ms())
}

/// `assertAction` and `assertWindow` for the helper command a call became: refused when the launch policy (and its narrowing) does
/// not admit its action, its window or its launch target. A step of a sequence carries no window of its own: the sequence it
/// belongs to was admitted with its window. A zoom names a frame, not a window: it is judged on the window its frame was cut from
/// (`assertPolicyAdmits` reads it from `framesBySession`); a frame that is gone is the stale frame the zoom itself would report, and a
/// display frame has no window to name.
fn admit_launch(settings: &AuthorizationSettings, command: &Map<String, Value>, frames: &FrameStore, now_ms: f64) -> Result<(), ComputerError> {
    if !settings.restricted() {
        return Ok(());
    }
    let action = text(command, "action");
    let mut window_id = text(command, "window_id");
    let of_frame;
    if window_id.is_empty() && action == "zoom" && !text(command, "frame_id").is_empty() {
        of_frame = frames.lookup(Some(text(command, "frame_id")), std::time::Instant::now())?.and_then(|frame| frame.window_id).unwrap_or_default();
        window_id = &of_frame;
    }
    if window_id.is_empty() && STEP_ACTIONS.contains(&action) {
        return settings.admit_step(action, now_ms);
    }
    let window = (!window_id.is_empty()).then(|| WindowFacts { id: window_id.to_owned(), pid: None });
    settings.admit(action, window.as_ref(), (action == "launch").then(|| text(command, "app")), now_ms)
}

/// What the policy adds to a helper request. While observation-only mode is on it is marked read-only, so the helper refuses
/// any mutation in it; a request that hands input back (`release_held_input`, `release_session`, ...) goes as it is: the desktop
/// host sends those with `read_only: false` (`session-lifecycle.ts:100`, `lifecycle-abort.ts:185,297`, `worker-control.ts:26`),
/// so observing only never leaves a key or button down. Every request says whether its input may ask for elevation
/// (`assertElevated`, `execution-policy.ts:118-121`), which the helper checks before it opens a UAC prompt. Under a launch policy the
/// request also carries what the helper enforces at the moment of input: when the authorization ends, and the one window and process
/// the input may reach (`dispatchAuthority`).
pub(super) fn decorate(command: &mut Map<String, Value>, observe_only: bool, windows_helper: bool) {
    decorate_with(authorization(), command, observe_only, windows_helper);
}

fn decorate_with(settings: &AuthorizationSettings, command: &mut Map<String, Value>, observe_only: bool, windows_helper: bool) {
    let hands_back = command.get("action").and_then(Value::as_str).is_some_and(|action| RETAIN_REF_ACTIONS.contains(&action));
    if observe_only && !hands_back {
        command.insert("read_only".into(), json!(true));
    }
    if windows_helper {
        command.insert("allow_elevated_input".into(), json!(settings.allows_elevated_input()));
    }
    if settings.restricted() && !LIFECYCLE_ACTIONS.contains(&text(command, "action")) {
        let window_id = text(command, "window_id");
        let authority = settings.dispatch_authority((!window_id.is_empty()).then_some(window_id));
        command.extend(authority);
    }
}

/// The session whose replies carry every window (`CHROME_SETUP_SESSION_ID`): the setup of the browser's own Chrome.
const CHROME_SETUP_SESSION_ID: &str = "__mixdog_browser_chrome_setup__";

/// `visibleWindowRecords`: the window rows a restricted session may see, each judged as a capture of it (the launch policy and the
/// narrowing name its id and the process that owns it, and have not ended); the rest, titles included, never reach its replies.
/// An unrestricted session, and the browser's Chrome setup, see every row.
fn visible_rows(settings: &AuthorizationSettings, session_id: &str, rows: &mut Vec<Value>, now_ms: f64) {
    if !settings.restricted() || session_id == CHROME_SETUP_SESSION_ID {
        return;
    }
    rows.retain(|row| {
        let window = WindowFacts { id: text(row.as_object().unwrap_or(&Map::new()), "id").to_owned(), pid: row.get("pid").and_then(Value::as_u64) };
        settings.admit("capture", Some(&window), None, now_ms).is_ok()
    });
}

/// A `list_windows` or `window_snapshot` result narrowed to the windows its session may see; the list text keeps their lines.
pub(super) fn narrow_window_list(session_id: &str, result: &mut Map<String, Value>) {
    let Some(Value::Array(windows)) = result.get_mut("windows") else { return };
    let before = windows.len();
    visible_rows(authorization(), session_id, windows, now_ms());
    if windows.len() == before {
        return;
    }
    let visible: HashSet<String> = windows.iter().filter_map(|window| window.get("id").and_then(Value::as_str)).map(computer_internal_windows::normalized).collect();
    if let Some(Value::String(listed)) = result.get_mut("text") {
        *listed = computer_internal_windows::list_text(listed, &visible);
    }
}

/// `visibleWindowRecords` over window rows: those a restricted session may see.
pub(super) fn narrow_rows(session_id: &str, rows: &mut Vec<Value>) {
    visible_rows(authorization(), session_id, rows, now_ms());
}

/// A `window_transition` as a restricted session reads it: the windows it opened, closed or changed are only those the session may see
/// (the successor, `next_target`, is authorized on its own).
pub(super) fn narrow_transition(session_id: &str, mut transition: Value) -> Value {
    for key in ["opened_windows", "closed_windows", "changed_windows"] {
        if let Some(Value::Array(windows)) = transition.get_mut(key) {
            visible_rows(authorization(), session_id, windows, now_ms());
        }
    }
    transition
}

/// Input from the in-process screen half (`ComputerBackend::inject`) is denied while observation-only mode is on.
pub(super) fn admit_screen_input(observe_only: bool) -> Result<(), ComputerError> {
    if observe_only { Err(ComputerError::Denied) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_api::domain::computer::ComputerBackend;
    use mixdog_core_api::domain::computer::ComputerRequest;
    use tokio_util::sync::CancellationToken;

    use super::super::computer_backend::ComputerConfig;
    use super::super::computer_backend::ComputerShared;
    use super::super::computer_backend::ProcessComputerBackend;
    use super::super::computer_targets::testing::Scripted;
    use super::*;

    fn command(action: &str) -> Map<String, Value> {
        json!({ "action": action }).as_object().cloned().unwrap_or_default()
    }

    fn refusal(action: &str) -> ComputerError {
        ComputerError::Failed {
            code: "observation_only".into(),
            message: format!(
                "observation_only: Computer Use is observing only, so '{action}' input is blocked. Turn off \"Observation only\" in Settings to allow input."
            ),
        }
    }

    /// The commands a tool call becomes: the reads pass while observing only, and each one that could change the desktop is
    /// refused under the name the desktop host refuses it by. With the mode off nothing is refused.
    #[test]
    fn observing_only_admits_reads_and_refuses_every_input() {
        for read in ["list_windows", "list_apps", "list_history", "capture", "zoom", "verify", "diagnose", "wait_for_user", "clipboard_read"] {
            assert_eq!(admit(&command(read), true, &FrameStore::default()), Ok(()), "{read}");
        }
        let inputs = [
            "sequence",
            "focus_window",
            "move_window",
            "window_state",
            "close_window",
            "terminate_process",
            "invoke_menu",
            "clipboard_write",
            "launch",
            "fill_saved_login",
            "click",
            "type",
            "key",
        ];
        for input in inputs {
            assert_eq!(admit(&command(input), true, &FrameStore::default()), Err(refusal(input)), "{input}");
            assert_eq!(admit(&command(input), false, &FrameStore::default()), Ok(()), "{input}");
        }
    }

    /// Every request says elevation may be asked for; only a request that hands input back stays writable while observing only.
    #[test]
    fn requests_carry_the_policy() {
        let decorated = |action: &str, observe_only: bool| {
            let mut command = command(action);
            decorate(&mut command, observe_only, true);
            Value::Object(command)
        };
        assert_eq!(decorated("click", false), json!({"action":"click","allow_elevated_input":true}));
        assert_eq!(decorated("click", true), json!({"action":"click","read_only":true,"allow_elevated_input":true}));
        assert_eq!(decorated("release_held_input", true), json!({"action":"release_held_input","allow_elevated_input":true}));
    }

    fn restricted(extra: Value) -> AuthorizationSettings {
        let mut policy = json!({
            "version": 1,
            "actions": ["capture", "act"],
            "windows": [{"id": "hwnd:0x1", "pid": 42}],
            "expiresAt": "2100-01-01T00:00:00Z",
        });
        policy.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        AuthorizationSettings::new(Some(LaunchPolicy::parse(&policy).unwrap()))
    }

    fn on_window(action: &str, window_id: &str) -> Map<String, Value> {
        json!({"action": action, "window_id": window_id}).as_object().cloned().unwrap_or_default()
    }

    fn refused_with(result: Result<(), ComputerError>, code: &str) {
        assert!(matches!(&result, Err(ComputerError::Failed { code: got, .. }) if got == code), "{result:?}");
    }

    /// With no launch policy nothing is refused and a request carries nothing more; with one, only what it names is admitted.
    #[test]
    fn a_launch_policy_admits_what_it_names() {
        let open = AuthorizationSettings::new(None);
        assert_eq!(admit_launch(&open, &on_window("focus_window", "hwnd:0x9"), &FrameStore::default(), 0.0), Ok(()));
        let mut plain = command("click");
        decorate_with(&open, &mut plain, false, true);
        assert_eq!(Value::Object(plain), json!({"action":"click","allow_elevated_input":true}));

        let settings = restricted(json!({}));
        let now = 1.0;
        assert_eq!(admit_launch(&settings, &on_window("sequence", "hwnd:0x1"), &FrameStore::default(), now), Ok(()));
        assert_eq!(admit_launch(&settings, &on_window("zoom", "hwnd:0x1"), &FrameStore::default(), now), Ok(()));
        assert_eq!(admit_launch(&settings, &command("click"), &FrameStore::default(), now), Ok(()), "a step has no window of its own");
        assert_eq!(admit_launch(&settings, &command("execution_end"), &FrameStore::default(), now), Ok(()));
        refused_with(admit_launch(&settings, &on_window("sequence", "hwnd:0x2"), &FrameStore::default(), now), "computer_policy_denied");
        refused_with(admit_launch(&settings, &command("sequence"), &FrameStore::default(), now), "computer_policy_denied");
        refused_with(admit_launch(&settings, &command("list_windows"), &FrameStore::default(), now), "computer_policy_denied");
        refused_with(admit_launch(&settings, &command("launch"), &FrameStore::default(), now), "computer_policy_denied");
        refused_with(admit_launch(&settings, &on_window("sequence", "hwnd:0x1"), &FrameStore::default(), 5e12), "computer_policy_expired");
    }

    fn frame_of(window_id: Option<&str>) -> FrameStore {
        let frames = FrameStore::default();
        frames.remember(super::super::computer_frames::Frame {
            id: "frame-1".into(),
            window_id: window_id.map(str::to_owned),
            related_window_ids: None,
            origin_x: 0,
            origin_y: 0,
            physical_width: 100,
            physical_height: 100,
            capture_width: 100,
            capture_height: 100,
            idle: None,
        });
        frames
    }

    /// A zoom names a frame: it is judged on the window the frame was cut from, never refused for naming none.
    #[test]
    fn a_zoom_is_admitted_on_the_window_of_its_frame() {
        let settings = restricted(json!({}));
        let zoom = json!({"action": "zoom", "frame_id": "frame-1", "region": [0, 0, 10, 10]}).as_object().cloned().unwrap();
        assert_eq!(admit_launch(&settings, &zoom, &frame_of(Some("hwnd:0x1")), 1.0), Ok(()));
        refused_with(admit_launch(&settings, &zoom, &frame_of(Some("hwnd:0x2")), 1.0), "computer_policy_denied");
        refused_with(admit_launch(&settings, &zoom, &frame_of(None), 1.0), "computer_policy_denied");
        let other = json!({"action": "zoom", "frame_id": "frame-9"}).as_object().cloned().unwrap();
        assert!(matches!(admit_launch(&settings, &other, &frame_of(Some("hwnd:0x1")), 1.0), Err(ComputerError::Failed { message, .. }) if message.starts_with("stale_frame")));
    }

    /// A restricted session's window rows are those it may capture, by id and owning process; an open one sees every row.
    #[test]
    fn a_restricted_session_sees_only_its_windows() {
        let rows = || vec![json!({"id": "hwnd:0x1", "pid": 42}), json!({"id": "hwnd:0x1", "pid": 7}), json!({"id": "hwnd:0x2", "pid": 42})];
        let mut seen = rows();
        visible_rows(&restricted(json!({})), "s1", &mut seen, 1.0);
        assert_eq!(seen, vec![json!({"id": "hwnd:0x1", "pid": 42})]);
        let mut all = rows();
        visible_rows(&AuthorizationSettings::new(None), "s1", &mut all, 1.0);
        assert_eq!(all, rows());
        let mut setup = rows();
        visible_rows(&restricted(json!({})), CHROME_SETUP_SESSION_ID, &mut setup, 1.0);
        assert_eq!(setup, rows());
        let mut ended = rows();
        visible_rows(&restricted(json!({})), "s1", &mut ended, 5e12);
        assert!(ended.is_empty());
    }

    /// The request names the window and process the helper may reach, and says elevation is not authorized.
    #[test]
    fn a_launch_policy_decorates_the_request() {
        let settings = restricted(json!({}));
        let mut request = on_window("click", "hwnd:0x1");
        decorate_with(&settings, &mut request, false, true);
        let request = Value::Object(request);
        assert_eq!(request["allow_elevated_input"], json!(false));
        assert_eq!(request["authorization_window_id"], json!("hwnd:0x1"));
        assert_eq!(request["authorization_pid"], json!(42));
        assert!(request["authorization_expires_at"].is_i64());
        let mut lifecycle = command("session_release");
        decorate_with(&settings, &mut lifecycle, false, true);
        assert_eq!(Value::Object(lifecycle), json!({"action":"session_release","allow_elevated_input":false}));
    }

    #[test]
    fn screen_input_is_denied_while_observing_only() {
        assert_eq!(admit_screen_input(true), Err(ComputerError::Denied));
        assert_eq!(admit_screen_input(false), Ok(()));
    }

    /// A secret typed by a handoff goes through `execute`, which `run` does not: observing only refuses its `type` in the host's
    /// words and still admits its `find`.
    #[tokio::test]
    async fn observing_only_refuses_a_secret_type_but_admits_its_find() {
        use crate::state::secrets::ComputerSecretHost;

        let manager = Scripted::new(|_| Ok(json!({"text":"ok"})));
        let shared = ComputerShared { observe_only: Arc::new(|| true), ..ComputerShared::default() };
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()).with_shared(shared);
        let refused = ComputerSecretHost::execute(&backend, command("type")).await;
        assert_eq!(refused, Err("observation_only: Computer Use is observing only, so 'type' input is blocked. Turn off \"Observation only\" in Settings to allow input.".to_owned()));
        assert_eq!(manager.starts(), 0, "nothing was started");
        assert!(ComputerSecretHost::execute(&backend, command("find")).await.is_ok());
    }

    /// The live setting through the backend: while it is on an `act` is refused in the host's words before the helper is even
    /// started, and every request a read becomes goes read-only; turned off, the next `act` reaches the helper as input.
    #[tokio::test]
    async fn the_live_setting_blocks_input_before_anything_is_written() {
        let manager = Scripted::new(|_| Ok(json!({"text":"ok"})));
        let on = Arc::new(AtomicBool::new(true));
        let setting = on.clone();
        let shared = ComputerShared { observe_only: Arc::new(move || setting.load(Ordering::SeqCst)), ..ComputerShared::default() };
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager.clone()).with_shared(shared);
        let act = || ComputerRequest { action: ComputerAction::Act, input: json!({"window_id":"hwnd:0x2","actions":[{"type":"key","keys":"a"}]}) };
        let list = || ComputerRequest { action: ComputerAction::List, input: json!({"kind":"windows"}) };

        assert_eq!(backend.run(act(), CancellationToken::new()).await, Err(refusal("sequence")));
        assert_eq!((manager.starts(), manager.lines().len()), (0, 0), "nothing was started or written");

        backend.run(list(), CancellationToken::new()).await.unwrap();
        let reads = manager.lines();
        assert!(!reads.is_empty());
        assert!(reads.iter().all(|line| line["read_only"] == json!(true)), "{reads:?}");

        on.store(false, Ordering::SeqCst);
        backend.run(act(), CancellationToken::new()).await.unwrap();
        let sent = manager.lines();
        let writable: Vec<&Value> = sent[reads.len()..].iter().filter(|line| line.get("read_only").is_none()).collect();
        assert!(!writable.is_empty(), "the act's input is not a read-only run: {sent:?}");
        assert!(writable.iter().all(|line| line["allow_elevated_input"] == json!(true)), "{sent:?}");
    }
}
