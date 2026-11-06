//! The real `ComputerBackend`: the `computer` tool served by the resident `mixdog-computer`
//! helper (one process per backend, one JSON request per stdin line, one `@@MIXCU@@`-prefixed
//! reply line per request, the protocol the Node desktop speaks), plus the in-process screen
//! half in `computer_screen`.
//!
//! The action contract is Node's (`computer-bridge/action-schema.mjs`): the same cross-field
//! rules, the same translation of a tool call into host commands, the same limits and the same
//! recovery on a timeout or cancellation (the helper is killed and `--abort-cleanup` releases any
//! input it held). What the Node desktop host adds on top of the helper (the permission prompt,
//! overlay, history ledger, saved-login secrets, zoom frame store, display capture) is not here;
//! those actions report `Unavailable`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::computer::ComputerStatus;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::computer::InputOutcome;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::js_trim_start;
use mixdog_js::utf16_len;
use mixdog_protocol::ProcessHandle;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::computer_screen::Screen;

const RESPONSE_MARKER: &str = "@@MIXCU@@";
/// Per-command ceiling for one helper round trip (Node `COMMAND_TIMEOUT_MS`).
const COMMAND_TIMEOUT: Duration = Duration::from_millis(45_000);
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 1_000_000;
const MAX_IMAGE_CHARS: usize = 24 * 1024 * 1024;
const DEFAULT_DELIVERY: &str = "background";
/// Process handles are unique per manager, and one manager can serve several backends.
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

/// Helper actions that only read (`computerActionsWith('nativeRead')`).
const READ_ACTIONS: [&str; 19] = [
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
    "list_installed_apps",
];
/// Helper actions that keep the session's element refs (`retainNativeRefs`): the reads plus
/// the ones that hand input back.
const RETAIN_REF_ACTIONS: [&str; 5] =
    ["release_session", "release_cursor_theme", "release_held_input", "release_sequence_holds", "restore_input_state"];

/// How the helper is run.
#[derive(Clone, Debug)]
pub struct ComputerConfig {
    /// The `mixdog-computer` executable.
    pub binary: PathBuf,
    /// Names the helper's per-session state (held input, element refs).
    pub session_id: String,
    /// Tags input this process injects so the helper's observer can tell it from the user's.
    pub input_marker: Option<String>,
    /// Refuse every mutation (the helper's `read_only` run).
    pub observe_only: bool,
    /// Pause after a background sequence step, in milliseconds.
    pub sequence_settle_ms: u64,
    /// Longest literal foreground text one call may type.
    pub max_foreground_text: usize,
}

impl ComputerConfig {
    pub fn new(binary: impl Into<PathBuf>, session_id: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
            session_id: session_id.into(),
            input_marker: None,
            observe_only: false,
            sequence_settle_ms: 350,
            max_foreground_text: 4_000,
        }
    }
}

type Waiter = Box<dyn FnOnce(Result<Map<String, Value>, String>) + Send>;
type Pending = Arc<Mutex<HashMap<i64, Waiter>>>;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Host {
    handle: ProcessHandle,
    pending: Pending,
    alive: Arc<AtomicBool>,
    /// Turns true once the process has exited and `pump` has failed its waiters.
    exited: watch::Receiver<bool>,
}

impl Host {
    /// Kills the helper and waits for its exit, so a cleanup run that follows starts after it.
    async fn stop(mut self, manager: &dyn ProcessManager) {
        let _ = manager.kill(&self.handle);
        let _ = self.exited.wait_for(|exited| *exited).await.is_ok();
    }
}

/// Splits the helper's stdout into lines the way `BufRead::lines` does.
#[derive(Default)]
struct LineSplitter {
    partial: Vec<u8>,
}

impl LineSplitter {
    /// The lines `bytes` completes, and whether one of them was not UTF-8 (`lines()` fails
    /// there, which ends the host's output).
    fn push(&mut self, bytes: &[u8]) -> (Vec<String>, bool) {
        let mut lines = Vec::new();
        let mut rest = bytes;
        while let Some(at) = rest.iter().position(|byte| *byte == b'\n') {
            self.partial.extend_from_slice(&rest[..at]);
            rest = &rest[at + 1..];
            if self.partial.last() == Some(&b'\r') {
                self.partial.pop();
            }
            match String::from_utf8(std::mem::take(&mut self.partial)) {
                Ok(line) => lines.push(line),
                Err(_) => return (lines, true),
            }
        }
        self.partial.extend_from_slice(rest);
        (lines, false)
    }

    /// The unterminated last line, at the end of the output.
    fn finish(&mut self) -> Option<String> {
        if self.partial.is_empty() {
            return None;
        }
        String::from_utf8(std::mem::take(&mut self.partial)).ok()
    }
}

/// Hands one output line to the request it answers.
fn deliver(pending: &Pending, line: &str) {
    let Some(body) = line.strip_prefix(RESPONSE_MARKER) else { return };
    let (id, outcome) = if body.len() > MAX_RESPONSE_BYTES {
        // Too large to trust or parse; the id is still the number after `"id":`.
        (leading_id(body), Err("computer_response_too_large: worker output exceeded byte limit".into()))
    } else {
        match serde_json::from_str::<Value>(body) {
            Ok(value) => (value.get("id").and_then(Value::as_i64), envelope(value)),
            Err(_) => return,
        }
    };
    let waiter = id.and_then(|id| locked(pending).remove(&id));
    if let Some(waiter) = waiter {
        waiter(outcome);
    }
}

/// Marks the host gone and fails every request still waiting on it.
fn fail_waiters(pending: &Pending, alive: &AtomicBool) {
    alive.store(false, Ordering::SeqCst);
    let orphans: Vec<Waiter> = locked(pending).drain().map(|(_, waiter)| waiter).collect();
    for waiter in orphans {
        waiter(Err("computer_host_exited: the computer host stopped".into()));
    }
}

/// Reads the helper's output events until it exits.
async fn pump(
    mut events: Box<dyn EventSource<ProcessEvent>>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    exited: watch::Sender<bool>,
) {
    let mut lines = LineSplitter::default();
    let mut reading = true;
    while let Some(event) = events.next().await {
        match event {
            ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } if reading => {
                let (complete, broken) = lines.push(&bytes);
                for line in complete {
                    deliver(&pending, &line);
                }
                if broken {
                    // Past a line that is not text the output is not trusted; keep draining the
                    // pipe until the process is gone.
                    reading = false;
                    fail_waiters(&pending, &alive);
                }
            }
            ProcessEvent::Output { .. } => {}
            ProcessEvent::Exited { .. } => {
                if let Some(line) = reading.then(|| lines.finish()).flatten() {
                    deliver(&pending, &line);
                }
                break;
            }
        }
    }
    fail_waiters(&pending, &alive);
    let _ = exited.send(true);
}

/// Runs a process to its exit.
async fn run_to_exit(manager: &dyn ProcessManager, request: SpawnRequest) {
    let handle = request.handle.clone();
    if manager.spawn(request).await.is_err() {
        return;
    }
    let Ok(mut events) = manager.subscribe(&handle, Some(0)) else { return };
    while let Some(event) = events.next().await {
        if matches!(event, ProcessEvent::Exited { .. }) {
            break;
        }
    }
}

#[allow(
    clippy::disallowed_types,
    reason = "`turn` is held across the helper start and the stdin write on purpose, so one request starts and is written at a time"
)]
pub struct ProcessComputerBackend {
    config: ComputerConfig,
    manager: Arc<dyn ProcessManager>,
    host: Mutex<Option<Host>>,
    turn: tokio::sync::Mutex<()>,
    next_id: AtomicI64,
    screen: Screen,
}

impl ProcessComputerBackend {
    /// The helper runs under `manager`; it starts on the first action and restarts after a
    /// timeout or cancellation.
    #[allow(clippy::disallowed_types, reason = "builds the `turn` lock; see the struct")]
    pub fn new(config: ComputerConfig, manager: Arc<dyn ProcessManager>) -> Self {
        Self {
            config,
            manager,
            host: Mutex::new(None),
            turn: tokio::sync::Mutex::new(()),
            next_id: AtomicI64::new(1),
            screen: Screen::default(),
        }
    }

    /// A run of the helper with `args`; it reads requests from stdin when `stdin_piped`.
    fn request(&self, args: Vec<String>, stdin_piped: bool) -> Result<SpawnRequest, ComputerError> {
        let cwd = std::env::current_dir().ok().and_then(AbsPath::new).ok_or_else(|| ComputerError::Unavailable {
            reason: "computer_backend_unavailable: the working directory is unreadable".into(),
        })?;
        let mut set = vec![
            ("MIXDOG_COMPUTER_READ_ACTIONS".to_owned(), READ_ACTIONS.join(",")),
            (
                "MIXDOG_COMPUTER_RETAIN_REF_ACTIONS".to_owned(),
                READ_ACTIONS.iter().chain(RETAIN_REF_ACTIONS.iter()).copied().collect::<Vec<_>>().join(","),
            ),
            ("MIXDOG_COMPUTER_SEQUENCE_SETTLE_MS".to_owned(), self.config.sequence_settle_ms.to_string()),
            ("MIXDOG_COMPUTER_MAX_FOREGROUND_TEXT".to_owned(), self.config.max_foreground_text.to_string()),
        ];
        if let Some(marker) = &self.config.input_marker {
            set.push(("MIXDOG_COMPUTER_INPUT_MARKER".to_owned(), marker.clone()));
        }
        Ok(SpawnRequest {
            handle: ProcessHandle(format!("computer-{}-{}", std::process::id(), NEXT_HANDLE.fetch_add(1, Ordering::SeqCst))),
            command: CommandSpec::Argv { program: self.config.binary.to_string_lossy().into_owned(), args },
            cwd,
            env: EnvSpec { inherit: true, set, remove: Vec::new() },
            pty: None,
            stdin_piped,
            output: OutputMode::Separate,
            owner: ProcessOwner::Internal,
            time_limit: None,
        })
    }

    async fn spawn(&self) -> Result<Host, ComputerError> {
        let unavailable = |error: String| ComputerError::Unavailable {
            reason: format!("computer_backend_unavailable: cannot start {}: {error}", self.config.binary.display()),
        };
        let request = self.request(Vec::new(), true)?;
        let handle = request.handle.clone();
        self.manager.spawn(request).await.map_err(|error| unavailable(format!("{error:?}")))?;
        let events = match self.manager.subscribe(&handle, Some(0)) {
            Ok(events) => events,
            Err(error) => {
                let _ = self.manager.kill(&handle);
                return Err(unavailable(format!("{error:?}")));
            }
        };
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (done, exited) = watch::channel(false);
        tokio::spawn(pump(events, pending.clone(), alive.clone(), done));
        Ok(Host { handle, pending, alive, exited })
    }

    /// Writes one request and returns the channel its reply arrives on.
    async fn send(&self, mut command: Map<String, Value>) -> Result<oneshot::Receiver<Result<Map<String, Value>, String>>, ComputerError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        command.insert("id".into(), json!(id));
        command.insert("session_id".into(), json!(self.config.session_id));
        if self.config.observe_only {
            command.insert("read_only".into(), json!(true));
        }
        let line = Value::Object(command).to_string();
        if line.len() > MAX_REQUEST_BYTES {
            return Err(ComputerError::InvalidInput {
                reason: "computer request exceeds byte limit; no input was dispatched".into(),
            });
        }
        let (reply, receive) = oneshot::channel();
        let _turn = self.turn.lock().await;
        let live = locked(&self.host)
            .as_ref()
            .filter(|host| host.alive.load(Ordering::SeqCst))
            .map(|host| (host.handle.clone(), host.pending.clone()));
        let (handle, pending) = match live {
            Some(live) => live,
            None => {
                let dead = locked(&self.host).take();
                if let Some(dead) = dead {
                    dead.stop(&*self.manager).await;
                }
                let host = self.spawn().await?;
                let live = (host.handle.clone(), host.pending.clone());
                *locked(&self.host) = Some(host);
                live
            }
        };
        locked(&pending).insert(id, Box::new(move |outcome| drop(reply.send(outcome))));
        let mut bytes = line.into_bytes();
        bytes.push(b'\n');
        if let Err(error) = self.manager.write_stdin(&handle, bytes).await {
            locked(&pending).remove(&id);
            let broken = locked(&self.host).take();
            if let Some(broken) = broken {
                broken.stop(&*self.manager).await;
            }
            return Err(ComputerError::Failed {
                code: "computer_host_write_failed".into(),
                message: format!("the computer host did not take the request: {error:?}"),
            });
        }
        Ok(receive)
    }

    /// Stops the helper and releases whatever input it held, from a fresh process.
    async fn retire(&self) {
        let host = locked(&self.host).take();
        if let Some(host) = host {
            host.stop(&*self.manager).await;
        }
        if let Ok(request) = self.request(vec!["--abort-cleanup".to_owned()], false) {
            run_to_exit(&*self.manager, request).await;
        }
    }

    async fn call(&self, command: Map<String, Value>, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
        if cancel.is_cancelled() {
            return Err(ComputerError::Cancelled);
        }
        let receive = self.send(command).await?;
        tokio::select! {
            outcome = tokio::time::timeout(COMMAND_TIMEOUT, receive) => match outcome {
                Err(_) => {
                    self.retire().await;
                    Err(ComputerError::Failed {
                        code: "computer_command_timeout".into(),
                        message: format!(
                            "command exceeded {}ms; the input host was restarted",
                            COMMAND_TIMEOUT.as_millis()
                        ),
                    })
                }
                Ok(Err(_)) => Err(host_exited()),
                Ok(Ok(Err(message))) => Err(host_error(&message)),
                Ok(Ok(Ok(result))) => Ok(result),
            },
            () = cancel.cancelled() => {
                self.retire().await;
                Err(ComputerError::Cancelled)
            }
        }
    }

    async fn act(&self, mut command: Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let steps = match command.shift_remove("steps") {
            Some(Value::Array(steps)) => steps,
            _ => Vec::new(),
        };
        let delivery = command.get("delivery").and_then(Value::as_str).unwrap_or(DEFAULT_DELIVERY).to_string();
        let observe = command.shift_remove("capture_after_mode");
        let target: Map<String, Value> =
            ["window_id", "app"].iter().filter_map(|key| command.get(*key).map(|v| ((*key).to_string(), v.clone()))).collect();
        let mut messages = Vec::new();
        for step in steps {
            let Value::Object(mut step) = step else { continue };
            for (key, value) in &target {
                step.entry(key.clone()).or_insert_with(|| value.clone());
            }
            step.insert("delivery".into(), json!(delivery));
            step.insert("session_id".into(), json!(self.config.session_id));
            // A background step on an exact window goes through the helper's sequence step,
            // which reports the windows it opened or closed; everything else is the action itself.
            let request = if delivery == "background" && step.contains_key("window_id") {
                let mut request = Map::new();
                request.insert("action".into(), json!("sequence_step"));
                request.insert("delivery".into(), json!("background"));
                request.insert("step".into(), Value::Object(step));
                request
            } else {
                step
            };
            let result = self.call(request, cancel).await?;
            let inner = result.get("step_result").and_then(Value::as_object).unwrap_or(&result);
            messages.push(text_of(inner));
        }
        let mut payload = json!({
            "ok": true,
            "action": "act",
            "message": messages.join("; "),
            "goal_verified": false,
            "verdict": { "decision": "verify_fresh_state" },
        });
        let mut parts = Vec::new();
        if target.contains_key("window_id") || target.contains_key("app") {
            let mut capture = Map::new();
            capture.insert("action".into(), json!("capture"));
            capture.extend(target);
            if let Some(mode) = observe {
                capture.insert("mode".into(), mode);
            }
            payload["capture_after"] = json!({ "ok": true, "action": "capture" });
            let observed = self.capture(capture, cancel).await?;
            parts.push(ToolPart::Text(payload.to_string()));
            parts.extend(observed);
            return Ok(parts);
        }
        parts.push(ToolPart::Text(payload.to_string()));
        Ok(parts)
    }

    /// `capture`: the accessibility snapshot, plus the window's pixels unless the mode is `ax`.
    async fn capture(&self, mut command: Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        if command.contains_key("screen") {
            return Err(unsupported("capture of a whole screen needs the desktop host's display capture"));
        }
        let mode = command.shift_remove("mode").and_then(|mode| mode.as_str().map(str::to_string)).unwrap_or_else(|| "state".into());
        let mut parts = Vec::new();
        let mut window = command.get("window_id").cloned();
        if mode != "vision" {
            command.insert("action".into(), json!("snapshot"));
            let snapshot = self.call(command.clone(), cancel).await?;
            window = snapshot.get("window_id").cloned().or(window);
            parts.extend(parts_of(&snapshot)?);
        }
        if mode != "ax" {
            command.insert("action".into(), json!("window_capture"));
            if let Some(window) = window {
                command.insert("window_id".into(), window);
                command.shift_remove("app");
            }
            let image = self.call(command, cancel).await?;
            let mut image_parts = parts_of(&image)?;
            if mode != "vision" {
                image_parts.retain(|part| matches!(part, ToolPart::Image { .. }));
            }
            parts.extend(image_parts);
        }
        Ok(parts)
    }
}

impl Drop for ProcessComputerBackend {
    fn drop(&mut self) {
        let held = locked(&self.host).take();
        let Some(host) = held else { return };
        let manager = self.manager.clone();
        let cleanup = self.request(vec!["--abort-cleanup".to_owned()], false).ok();
        // A drop cannot await: the stop and the cleanup run on the runtime, if there is one.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    host.stop(&*manager).await;
                    if let Some(request) = cleanup {
                        run_to_exit(&*manager, request).await;
                    }
                });
            }
            Err(_) => {
                let _ = manager.kill(&host.handle);
            }
        }
    }
}

fn leading_id(body: &str) -> Option<i64> {
    let rest = body.split("\"id\":").nth(1)?;
    js_trim_start(rest).split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// A reply envelope: its `result` object, or its `error` text.
fn envelope(value: Value) -> Result<Map<String, Value>, String> {
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(value.get("error").and_then(Value::as_str).unwrap_or("computer host request failed").to_string());
    }
    match value {
        Value::Object(mut object) => match object.shift_remove("result") {
            Some(Value::Object(result)) => Ok(result),
            _ => Ok(Map::new()),
        },
        _ => Ok(Map::new()),
    }
}

fn host_exited() -> ComputerError {
    ComputerError::Failed { code: "computer_host_exited".into(), message: "the computer host stopped".into() }
}

fn unsupported(reason: &str) -> ComputerError {
    ComputerError::Unavailable { reason: reason.into() }
}

/// The leading code token of an error text (`computerErrorCode`).
fn error_code(text: &str) -> String {
    let text = js_trim(text);
    let text = text.strip_prefix("Error:").map_or(text, js_trim_start);
    let end = text.find([':', '|']).unwrap_or(0);
    let head = &text[..end];
    let valid = !head.is_empty()
        && head.len() <= 80
        && head.starts_with(|c: char| c.is_ascii_alphabetic())
        && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if valid { head.to_ascii_lowercase() } else { String::new() }
}

fn host_error(message: &str) -> ComputerError {
    let code = error_code(message);
    ComputerError::Failed { code: if code.is_empty() { "computer_failed".into() } else { code }, message: message.to_string() }
}

fn text_of(result: &Map<String, Value>) -> String {
    match result.get("text") {
        Some(Value::String(text)) => text.clone(),
        _ => "OK".into(),
    }
}

/// Tool parts of one helper result: its text, and its image when it carries one
/// (`validateComputerReply` bounds both).
fn parts_of(result: &Map<String, Value>) -> Result<Vec<ToolPart>, ComputerError> {
    let invalid = |reason: &str| ComputerError::Failed { code: "computer_invalid_reply".into(), message: reason.into() };
    let text = text_of(result);
    if utf16_len(&text) > MAX_TEXT_CHARS {
        return Err(invalid("computer bridge returned invalid or oversized text"));
    }
    let mut parts = vec![ToolPart::Text(text)];
    let image = match (result.get("image_base64"), result.get("image")) {
        (Some(Value::String(data)), _) => Some(("image/png", data.as_str())),
        (_, Some(Value::Object(image))) => match (image.get("mimeType").and_then(Value::as_str), image.get("data").and_then(Value::as_str)) {
            (Some(mime @ ("image/png" | "image/jpeg")), Some(data)) => Some((mime, data)),
            _ => return Err(invalid("computer bridge returned an invalid or oversized image")),
        },
        _ => None,
    };
    if let Some((mime, data)) = image {
        if data.len() > MAX_IMAGE_CHARS {
            return Err(invalid("computer bridge returned an invalid or oversized image"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| invalid("computer bridge returned an invalid or oversized image"))?;
        parts.push(ToolPart::Image { mime: mime.into(), data: ImageData::Bytes(bytes) });
    }
    Ok(parts)
}

// --- the tool contract (`computer-bridge/action-schema.mjs`) --------------------------------

fn has(input: &Map<String, Value>, key: &str) -> bool {
    input.contains_key(key)
}

fn text<'a>(input: &'a Map<String, Value>, key: &str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The rules beyond the tool's JSON schema (`validateComputerToolArgs`, minus the schema
/// itself and the per-step rules of `act.actions`, which the helper enforces on each step).
fn validate(action: ComputerAction, input: &Map<String, Value>) -> Result<(), String> {
    let name = action.wire_name();
    for field in ["window_id", "app", "frame_id"] {
        if let Some(Value::String(value)) = input.get(field)
            && js_trim(value).is_empty()
        {
            return Err(format!("Computer Use {name} {field} must not be empty"));
        }
    }
    if matches!(action, ComputerAction::Act | ComputerAction::Window | ComputerAction::Menu | ComputerAction::Verify | ComputerAction::SavedLogin)
        && ["window_id", "app"].iter().filter(|key| has(input, key)).count() != 1
    {
        return Err(format!("Computer Use {name} requires exactly one of window_id or app"));
    }
    match action {
        ComputerAction::Capture => capture_error(input),
        ComputerAction::List => list_error(input),
        ComputerAction::Menu => menu_error(input),
        ComputerAction::Verify => verify_error(input),
        ComputerAction::Act => {
            if input.get("actions").and_then(Value::as_array).is_none_or(Vec::is_empty) {
                Err("Computer Use action \"act\" requires input field(s): actions".into())
            } else {
                Ok(())
            }
        }
        ComputerAction::Window => window_error(input),
        ComputerAction::Clipboard => clipboard_error(input),
        ComputerAction::Launch => launch_error(input),
        ComputerAction::SavedLogin => saved_login_error(input),
        ComputerAction::Diagnose | ComputerAction::WaitForUser => Ok(()),
    }
}

fn capture_error(input: &Map<String, Value>) -> Result<(), String> {
    let mode = input.get("mode").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("state");
    let targets = ["window_id", "app", "screen"].iter().filter(|key| has(input, key)).count();
    let include_ocr = input.get("include_ocr") == Some(&Value::Bool(true));
    let err = |message: &str| Err(format!("Computer Use {message}"));
    if targets > 1 {
        return err("capture accepts at most one of window_id, app, or screen");
    }
    if mode == "zoom" && (!has(input, "frame_id") || !has(input, "region")) {
        return err("capture mode=\"zoom\" requires input field(s): frame_id, region");
    }
    if mode == "zoom" && targets > 0 {
        return err("capture mode=\"zoom\" accepts frame_id and region instead of a window, app, or screen target");
    }
    if mode != "zoom" && (has(input, "frame_id") || has(input, "region")) {
        return err("capture frame_id/region requires mode=\"zoom\"");
    }
    if mode == "ax" && include_ocr {
        return err("capture include_ocr is unavailable with mode=\"ax\"");
    }
    if mode == "zoom" && has(input, "ocr_language") && !include_ocr {
        return err("capture mode=\"zoom\" reads text only with include_ocr");
    }
    if mode == "ax" && has(input, "image_output") {
        return err("capture image_output requires a mode that returns pixels");
    }
    if has(input, "screen") && mode != "vision" {
        return err("capture screen requires mode=\"vision\"");
    }
    Ok(())
}

fn list_error(input: &Map<String, Value>) -> Result<(), String> {
    let history = text(input, "kind") == "history";
    if has(input, "limit") && !history {
        return Err("Computer Use list limit applies to kind=\"history\"".into());
    }
    if has(input, "query") && history {
        return Err("Computer Use list query applies to kind=\"windows\" or kind=\"apps\"".into());
    }
    Ok(())
}

fn menu_error(input: &Map<String, Value>) -> Result<(), String> {
    let bad = input
        .get("path")
        .and_then(Value::as_array)
        .is_some_and(|path| path.iter().any(|segment| segment.as_str().is_none_or(|s| js_trim(s).is_empty())));
    if bad { Err("Computer Use menu path segments must be non-empty labels".into()) } else { Ok(()) }
}

fn verify_error(input: &Map<String, Value>) -> Result<(), String> {
    const ALLOWED: [&str; 4] = ["present", "absent", "title_contains", "window_exists"];
    for (index, predicate) in input.get("expect").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let n = index + 1;
        let Some(predicate) = predicate.as_object() else {
            return Err(format!("Computer Use verify predicate {n} must be an object"));
        };
        let extras: Vec<&str> = predicate.keys().map(String::as_str).filter(|k| !ALLOWED.contains(k)).collect();
        if !extras.is_empty() {
            return Err(format!("Computer Use verify predicate {n} does not accept field(s): {}", extras.join(", ")));
        }
        if predicate.len() != 1 {
            return Err(format!("Computer Use verify predicate {n} takes exactly one condition"));
        }
        let (key, value) = predicate.iter().next().ok_or_else(|| format!("Computer Use verify predicate {n} takes exactly one condition"))?;
        if key == "window_exists" {
            if !value.is_boolean() {
                return Err(format!("Computer Use verify predicate {n} window_exists must be a boolean"));
            }
        } else {
            let Some(value) = value.as_str() else {
                return Err(format!("Computer Use verify predicate {n} text must be a string"));
            };
            if js_trim(value).is_empty() {
                return Err(format!("Computer Use verify predicate {n} text must not be empty"));
            }
        }
    }
    Ok(())
}

fn window_error(input: &Map<String, Value>) -> Result<(), String> {
    if text(input, "operation") == "move" && !["x", "y", "width", "height"].iter().any(|key| has(input, key)) {
        return Err("Computer Use window operation=\"move\" requires x, y, width, or height".into());
    }
    Ok(())
}

fn clipboard_error(input: &Map<String, Value>) -> Result<(), String> {
    match text(input, "operation") {
        "write" if !has(input, "text") => Err("Computer Use clipboard operation=\"write\" requires input field: text".into()),
        "read" if has(input, "text") => Err("Computer Use clipboard operation=\"read\" does not accept input field: text".into()),
        _ => Ok(()),
    }
}

fn launch_error(input: &Map<String, Value>) -> Result<(), String> {
    let app = match input.get("app") {
        Some(Value::String(app)) => js_trim(app).to_string(),
        _ => String::new(),
    };
    if app.is_empty() {
        return Err("Computer Use launch app must not be empty".into());
    }
    let compile = |pattern: &str, flags: &str| JsRegex::new(pattern, flags);
    let http = compile(r"^https?://", "i")?.is_match(&app);
    if compile(r"[\r\n\0]|javascript:", "i")?.is_match(&app) || (!http && compile(r"&&|\|\|", "")?.is_match(&app)) {
        return Err("Computer Use launch app must be one executable, file, or URL without command syntax".into());
    }
    if !http
        && (compile(r#"(?:^|[\\/"'])\s*(?:cmd|powershell|pwsh|wt|wsl|bash|sh|zsh|fish|nu|wscript|cscript|mshta|rundll32|regsvr32)(?:\.exe)?(?:["'\s]|$)"#, "i")?
            .is_match(&app)
            || compile(r#"\.(?:bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|appref-ms)(?:["']?\s*)$"#, "i")?.is_match(&app))
    {
        return Err("Computer Use launch blocks shells, script hosts, and shortcut files; use an exact non-shell executable, document, or URL".into());
    }
    Ok(())
}

fn saved_login_error(input: &Map<String, Value>) -> Result<(), String> {
    if js_trim(&text(input, "savedAccount")).is_empty() {
        return Err("Computer Use saved_login savedAccount must not be empty".into());
    }
    Ok(())
}

/// One `act.actions` entry as the host sequence step it becomes (`toHostSequenceStep`).
fn host_step(step: &Value, frame_id: Option<&Value>) -> Value {
    let Some(step) = step.as_object() else { return step.clone() };
    let mut out = step.clone();
    let kind = out.shift_remove("type").unwrap_or(Value::Null);
    let mut action = kind.clone();
    match kind.as_str() {
        Some("click") => {
            action = match text(step, "button") {
                "right" => json!("right_click"),
                "middle" => json!("middle_click"),
                _ => json!("click"),
            };
            out.shift_remove("button");
        }
        Some("move") => action = json!("mouse_move"),
        Some("set_value") => {
            if let Some(value) = out.shift_remove("value") {
                out.insert("text".into(), value);
            }
        }
        _ => {}
    }
    out.insert("action".into(), action);
    if let Some(frame) = frame_id
        && ["x", "y", "to_x", "to_y", "waypoints"].iter().any(|key| has(step, key))
    {
        out.insert("frame_id".into(), frame.clone());
    }
    Value::Object(out)
}

/// The helper command a tool call becomes (`toComputerHostCommand`).
fn host_command(action: ComputerAction, input: &Map<String, Value>) -> Map<String, Value> {
    let mut command = input.clone();
    let set = |command: &mut Map<String, Value>, name: &str| {
        command.insert("action".into(), json!(name));
    };
    match action {
        ComputerAction::List => {
            let name = match text(input, "kind") {
                "apps" => "list_apps",
                "history" => "list_history",
                _ => "list_windows",
            };
            set(&mut command, name);
            command.shift_remove("kind");
        }
        ComputerAction::Capture => {
            if text(input, "mode") == "zoom" {
                set(&mut command, "zoom");
                command.shift_remove("mode");
            } else {
                set(&mut command, "capture");
            }
        }
        ComputerAction::Menu => set(&mut command, "invoke_menu"),
        ComputerAction::Act => {
            set(&mut command, "sequence");
            let delivery = input.get("delivery").cloned().unwrap_or_else(|| json!(DEFAULT_DELIVERY));
            command.insert("delivery".into(), delivery);
            let frame = input.get("frame_id").filter(|frame| frame.as_str().is_none_or(|f| !f.is_empty()));
            let steps: Vec<Value> = input.get("actions").and_then(Value::as_array).into_iter().flatten().map(|step| host_step(step, frame)).collect();
            command.insert("steps".into(), Value::Array(steps));
            if let Some(mode) = input.get("observe").filter(|m| m.as_str().is_none_or(|m| !m.is_empty())) {
                command.insert("capture_after_mode".into(), mode.clone());
            }
            for key in ["observe", "actions", "frame_id"] {
                command.shift_remove(key);
            }
        }
        ComputerAction::Window => {
            let operation = text(input, "operation");
            let name = match operation {
                "focus" => "focus_window",
                "move" => "move_window",
                "close" => "close_window",
                "terminate" => "terminate_process",
                _ => {
                    command.insert("state".into(), json!(operation));
                    "window_state"
                }
            };
            set(&mut command, name);
            command.shift_remove("operation");
        }
        ComputerAction::Clipboard => {
            set(&mut command, if text(input, "operation") == "write" { "clipboard_write" } else { "clipboard_read" });
            command.shift_remove("operation");
        }
        ComputerAction::SavedLogin => {
            set(&mut command, "fill_saved_login");
            if let Some(account) = command.shift_remove("savedAccount") {
                command.insert("saved_account".into(), account);
            }
            command.insert("delivery".into(), json!("foreground"));
        }
        other => set(&mut command, other.wire_name()),
    }
    command
}

#[async_trait]
impl ComputerBackend for ProcessComputerBackend {
    async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let Some(input) = request.input.as_object() else {
            return Err(ComputerError::InvalidInput {
                reason: format!("Computer Use action \"{}\" input must be an object", request.action.wire_name()),
            });
        };
        validate(request.action, input).map_err(|reason| ComputerError::InvalidInput { reason })?;
        let mut command = host_command(request.action, input);
        let name = text(&command, "action").to_string();
        match name.as_str() {
            "sequence" => self.act(command, &cancel).await,
            "capture" => self.capture(command, &cancel).await,
            "zoom" => Err(unsupported("capture mode=\"zoom\" needs the desktop host's frame store")),
            "list_history" => Err(unsupported("list kind=\"history\" needs the desktop host's action ledger")),
            "wait_for_user" => Err(unsupported("wait_for_user needs the desktop host's user-wait service")),
            "fill_saved_login" => Err(unsupported("saved_login needs the desktop host's secret store")),
            "verify" => {
                command.insert("action".into(), json!("window_predicates"));
                parts_of(&self.call(command, &cancel).await?)
            }
            "diagnose" => {
                let mut parts = Vec::new();
                for probe in ["accessibility_probe", "ocr_status"] {
                    let mut probe_command = Map::new();
                    probe_command.insert("action".into(), json!(probe));
                    parts.extend(parts_of(&self.call(probe_command, &cancel).await?)?);
                }
                Ok(parts)
            }
            "list_apps" => {
                command.insert("action".into(), json!("list_installed_apps"));
                parts_of(&self.call(command, &cancel).await?)
            }
            _ => parts_of(&self.call(command, &cancel).await?),
        }
    }

    fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
        if self.config.observe_only {
            return Err(ComputerError::Denied);
        }
        self.screen.inject(input)
    }

    fn release_input(&self) -> Result<u32, ComputerError> {
        self.screen.release()
    }

    fn input_desktop(&self) -> Option<DesktopIdentity> {
        self.screen.input_desktop()
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
        self.screen.displays()
    }

    fn screen_source(&self, display: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        self.screen.source(display)
    }

    fn status(&self) -> ComputerStatus {
        let active = locked(&self.host).as_ref().is_some_and(|host| host.alive.load(Ordering::SeqCst));
        ComputerStatus { active, observe_only: self.config.observe_only, controller: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn tool_calls_become_the_host_commands_node_sends() {
        let list = host_command(ComputerAction::List, &input(json!({"kind":"apps","query":"x"})));
        assert_eq!(Value::Object(list), json!({"action":"list_apps","query":"x"}));
        let window = host_command(ComputerAction::Window, &input(json!({"operation":"minimize","window_id":"w"})));
        assert_eq!(Value::Object(window), json!({"action":"window_state","state":"minimize","window_id":"w"}));
        let act = host_command(
            ComputerAction::Act,
            &input(json!({"window_id":"w","observe":"ax","frame_id":"f","actions":[
                {"type":"click","button":"right","x":1,"y":2},
                {"type":"set_value","value":"v","ref":"e1"},
                {"type":"move","x":3,"y":4}]})),
        );
        assert_eq!(
            Value::Object(act),
            json!({"action":"sequence","window_id":"w","delivery":"background","capture_after_mode":"ax","steps":[
                {"action":"right_click","x":1,"y":2,"frame_id":"f"},
                {"action":"set_value","text":"v","ref":"e1"},
                {"action":"mouse_move","x":3,"y":4,"frame_id":"f"}]})
        );
        let login = host_command(ComputerAction::SavedLogin, &input(json!({"savedAccount":"a","app":"b"})));
        assert_eq!(Value::Object(login), json!({"action":"fill_saved_login","saved_account":"a","app":"b","delivery":"foreground"}));
    }

    #[test]
    fn cross_field_rules_match_the_node_messages() {
        let err = |action, value: Value| validate(action, &input(value)).unwrap_err();
        assert_eq!(err(ComputerAction::Window, json!({"operation":"focus"})), "Computer Use window requires exactly one of window_id or app");
        assert_eq!(
            err(ComputerAction::Capture, json!({"mode":"zoom"})),
            "Computer Use capture mode=\"zoom\" requires input field(s): frame_id, region"
        );
        assert_eq!(err(ComputerAction::List, json!({"limit":3})), "Computer Use list limit applies to kind=\"history\"");
        assert!(err(ComputerAction::Launch, json!({"app":"powershell.exe"})).starts_with("Computer Use launch blocks shells"));
        assert!(err(ComputerAction::Launch, json!({"app":"a && b"})).ends_with("without command syntax"));
        assert!(validate(ComputerAction::Launch, &input(json!({"app":"https://example.com/a&&b"}))).is_ok());
        assert!(validate(ComputerAction::Capture, &input(json!({"window_id":"w"}))).is_ok());
    }

    #[test]
    fn error_codes_and_replies() {
        assert_eq!(error_code("Error: Stale_Target: gone"), "stale_target");
        assert_eq!(error_code("no code here"), "");
        assert_eq!(error_code("capture_source_unavailable|x"), "capture_source_unavailable");
        let result = input(json!({"text":"hi","image_base64":"aGk="}));
        let parts = parts_of(&result).unwrap();
        assert_eq!(parts[0], ToolPart::Text("hi".into()));
        assert_eq!(parts[1], ToolPart::Image { mime: "image/png".into(), data: ImageData::Bytes(b"hi".to_vec()) });
        assert!(parts_of(&input(json!({"image":{"data":"aGk=","mimeType":"image/gif"}}))).is_err());
        assert_eq!(envelope(json!({"id":1,"ok":false,"error":"x"})), Err("x".into()));
        assert_eq!(leading_id("{\"id\": 42,\"ok\":true"), Some(42));
    }

    #[test]
    fn output_is_split_into_lines_like_buf_read_lines() {
        let mut lines = LineSplitter::default();
        assert_eq!(lines.push(b"one\r\ntw"), (vec!["one".to_owned()], false));
        assert_eq!(lines.push(b"o\n\nthr"), (vec!["two".to_owned(), String::new()], false));
        assert_eq!(lines.push(b"ee"), (Vec::<String>::new(), false));
        assert_eq!(lines.finish(), Some("three".to_owned()));
        assert_eq!(lines.finish(), None);
        let (done, broken) = lines.push(b"ok\n\xff\nlater\n");
        assert_eq!((done, broken), (vec!["ok".to_owned()], true));
    }

    struct Script(std::collections::VecDeque<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for Script {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.pop_front()
        }
    }

    #[tokio::test]
    async fn replies_are_delivered_before_the_waiters_of_an_exited_host_are_failed() {
        use mixdog_core_api::domain::process::ExitStatus;
        use mixdog_core_api::domain::process::ProcessExit;

        let pending: Pending = Arc::default();
        let outcomes = Arc::new(Mutex::new(Vec::new()));
        for id in [1, 2] {
            let outcomes = outcomes.clone();
            locked(&pending).insert(id, Box::new(move |outcome| locked(&outcomes).push((id, outcome))));
        }
        let output = |seq, stream, text: &str| ProcessEvent::Output { seq, stream, bytes: text.as_bytes().to_vec() };
        let events = Script(
            [
                output(0, OutputStream::Stdout, "noise\n@@MIXCU@@{\"id\":1,\"ok\":tr"),
                output(1, OutputStream::Stderr, "ignored\n"),
                output(2, OutputStream::Stdout, "ue,\"result\":{\"text\":\"a\"}}\r\n"),
                ProcessEvent::Exited { seq: 3, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } },
            ]
            .into(),
        );
        let alive = Arc::new(AtomicBool::new(true));
        let (done, exited) = watch::channel(false);
        pump(Box::new(events), pending, alive.clone(), done).await;
        assert!(!alive.load(Ordering::SeqCst));
        assert!(*exited.borrow());
        let outcomes = locked(&outcomes);
        assert_eq!(outcomes[0].0, 1);
        assert_eq!(outcomes[0].1.as_ref().unwrap().get("text"), Some(&json!("a")));
        assert_eq!(outcomes[1].0, 2);
        assert!(outcomes[1].1.as_ref().unwrap_err().starts_with("computer_host_exited"));
    }

    #[cfg(unix)]
    mod host {
        use super::*;

        /// A stand-in helper: answers each request with its id and echoes the action.
        fn fake_host(dir: &std::path::Path) -> PathBuf {
            let path = dir.join("fake-host.sh");
            let script = r#"#!/bin/sh
if [ "$1" = "--abort-cleanup" ]; then echo cleaned > "$(dirname "$0")/cleanup"; exit 0; fi
while read -r line; do
  id=$(echo "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *hang*) sleep 30;;
    *) echo "@@MIXCU@@{\"id\":$id,\"ok\":true,\"result\":{\"text\":\"ok $line\"}}";;
  esac
done
"#;
            std::fs::write(&path, script).unwrap();
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
            std::fs::set_permissions(&path, perms).unwrap();
            path
        }

        #[tokio::test]
        async fn runs_an_action_through_the_resident_host_and_cleans_up_on_cancel() {
            let dir = tempfile::tempdir().unwrap();
            let tokens = mixdog_rt::testing::tokens();
            let manager = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
            let backend = ProcessComputerBackend::new(ComputerConfig::new(fake_host(dir.path()), "s1"), manager);
            let parts = backend
                .run(ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"read"}) }, CancellationToken::new())
                .await
                .unwrap();
            let ToolPart::Text(text) = &parts[0] else { panic!("text part") };
            assert!(text.contains("clipboard_read") && text.contains("\"session_id\":\"s1\""), "{text}");
            assert!(backend.status().active);

            let cancel = CancellationToken::new();
            let trip = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                trip.cancel();
            });
            let hung = backend
                .run(ComputerRequest { action: ComputerAction::Clipboard, input: json!({"operation":"write","text":"hang"}) }, cancel)
                .await;
            assert_eq!(hung, Err(ComputerError::Cancelled));
            assert!(dir.path().join("cleanup").exists());
            assert!(!backend.status().active);
        }
    }
}
