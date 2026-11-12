//! Linux Computer Use prerequisites, probed per capability before a task starts so a missing permission or helper gives one
//! actionable message naming what is missing instead of a failure or a hang mid-task (`computer-bridge/linux-readiness.mjs` and
//! `linux-action-capabilities.mjs`). Probes never prompt: they read the environment, test file access and PATH, and ask D-Bus
//! read-only questions. Only `needs_setup` and `unsupported` ever block an action; what cannot be probed is `unknown`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::future::FutureExt;
use futures::future::Shared;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_protocol::ProcessHandle;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const UINPUT_HINT: &str = "input_unavailable: Wayland input needs write access to /dev/uinput; add the udev rule `KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\", OPTIONS+=\"static_node=uinput\"`, add your user to the input group, then sign in again";
pub const INPUT_GROUP_SECURITY_NOTE: &str = "Security note: membership of the input group lets every program you run read and inject keyboard and mouse input system-wide. Grant it only on a machine and account you trust.";
pub const GNOME_EXTENSION_UUID: &str = "mixdog-windows@mixdog.io";
/// The oldest helper interface this app can use (2 added Screenshot and StopRequested, 3 the in-shell indicator).
pub const MIN_WINDOW_HELPER_VERSION: u32 = 3;
const WINDOW_HELPER_RELOGIN_HINT: &str = "wayland_window_control_unavailable: the Mixdog Windows GNOME extension is installed and enabled but GNOME Shell has not loaded it yet; the user must sign out and sign in again once";
const WINDOW_HELPER_ENABLE_HINT: &str = "wayland_window_control_unavailable: the Mixdog Windows GNOME extension is not enabled; it could not be enabled automatically (run gnome-extensions enable mixdog-windows@mixdog.io)";
const WINDOW_CONTROL_UNSUPPORTED_HINT: &str = "wayland_window_control_unavailable: this desktop offers no window control to other programs (supported: GNOME with the Mixdog Windows extension, sway, Hyprland, or an X11 session); screen, pointer, keyboard and clipboard still work";
const ACCESSIBILITY_HINT: &str = "accessibility_unavailable: the AT-SPI bus is not running; install at-spi2-core";
const TESSERACT_HINT: &str = "ocr_unavailable: install Tesseract (for example `sudo apt install tesseract-ocr tesseract-ocr-kor`) to read text from pixels";
const CLIPBOARD_HINT: &str = "clipboard_unavailable: install wl-clipboard (`wl-copy`/`wl-paste`) for clipboard access on Wayland";
const DISPLAY_HINT: &str = "display_unavailable: no graphical session to drive; run inside a desktop session with DISPLAY (X11) or WAYLAND_DISPLAY set";
/// Stable code of the whole refusal; the per-capability codes are the native ones.
pub const CAPABILITY_UNAVAILABLE_CODE: &str = "computer_capability_unavailable";
pub const CAPTURE_FALLBACK_NOTE: &str = "Note: window control is not available on this Linux session, so this is a full-screen capture of screen 0 instead of the foreground window.";
/// A probe is asked again once it is older than this, so a fix is noticed on the next call.
const CACHE_MS: f64 = 3000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Ready,
    NeedsSetup,
    Unsupported,
    Unknown,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::NeedsSetup => "needs_setup",
            Self::Unsupported => "unsupported",
            Self::Unknown => "unknown",
        }
    }

    /// The states that block an action.
    fn blocks(self) -> bool {
        matches!(self, Self::NeedsSetup | Self::Unsupported)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cap {
    pub state: State,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

impl Cap {
    fn of(state: State) -> Self {
        Self { state, fix: None, package: None, optional: false }
    }

    fn needs(fix: &str) -> Self {
        Self { fix: Some(fix.to_owned()), ..Self::of(State::NeedsSetup) }
    }

    fn needs_package(package: &str) -> Self {
        Self { package: Some(package.to_owned()), ..Self::needs("install_package") }
    }

    fn optional(self) -> Self {
        Self { optional: true, ..self }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub capture: Cap,
    pub windows: Cap,
    pub accessibility: Cap,
    #[serde(rename = "semanticActions")]
    pub semantic_actions: Cap,
    pub pointer: Cap,
    pub keyboard: Cap,
    pub clipboard: Cap,
    pub ocr: Cap,
}

impl Capabilities {
    fn get(&self, name: &str) -> Option<&Cap> {
        Some(match name {
            "capture" => &self.capture,
            "windows" => &self.windows,
            "accessibility" => &self.accessibility,
            "semanticActions" => &self.semantic_actions,
            "pointer" => &self.pointer,
            "keyboard" => &self.keyboard,
            "clipboard" => &self.clipboard,
            "ocr" => &self.ocr,
            _ => return None,
        })
    }
}

/// Per-capability readiness of one Linux session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Readiness {
    pub session: String,
    pub desktop: String,
    pub capabilities: Capabilities,
}

/// What the disk and the shell settings say of the GNOME extension (not whether the shell loaded it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HelperStatus {
    pub installed: bool,
    pub enabled: bool,
}

/// The session's environment variables.
pub type Env = HashMap<String, String>;

fn var<'a>(env: &'a Env, key: &str) -> &'a str {
    env.get(key).map_or("", String::as_str)
}

fn desktop_name_has(env: &Env, needle: &str) -> bool {
    var(env, "XDG_CURRENT_DESKTOP").to_lowercase().contains(needle)
}

/// Same rule as the native `platform::linux::wayland_session()`.
pub fn detect_session(env: &Env) -> &'static str {
    let wayland = env.contains_key("WAYLAND_DISPLAY") && env.get("XDG_SESSION_TYPE").is_none_or(|kind| kind == "wayland");
    if wayland { "wayland" } else { "x11" }
}

pub fn detect_desktop(env: &Env, session: &str) -> &'static str {
    if session == "wayland" {
        if env.contains_key("SWAYSOCK") {
            return "sway";
        }
        if env.contains_key("HYPRLAND_INSTANCE_SIGNATURE") {
            return "hyprland";
        }
    }
    for (needle, name) in [("gnome", "gnome"), ("kde", "kde"), ("plasma", "kde"), ("sway", "sway"), ("hyprland", "hyprland")] {
        if desktop_name_has(env, needle) {
            return name;
        }
    }
    "other"
}

/// What the session can be asked, read-only.
#[async_trait]
pub trait Probes: Send + Sync {
    async fn can_write(&self, file: &str) -> bool;
    async fn has_command(&self, name: &str) -> bool;
    async fn has_session_bus(&self) -> bool;
    /// The version of the window helper the shell loaded, or `None` when nothing answers.
    async fn window_helper_version(&self) -> Option<u32>;
    async fn window_helper_status(&self) -> HelperStatus;
    async fn accessibility_reachable(&self) -> bool;
}

async fn windows_capability(env: &Env, session: &str, probes: &dyn Probes) -> Cap {
    if session == "x11" {
        return Cap::of(State::Ready);
    }
    // Same order as the native `Compositor::detect()`.
    if env.contains_key("SWAYSOCK") {
        return if probes.has_command("swaymsg").await { Cap::of(State::Ready) } else { Cap::needs_package("sway") };
    }
    if env.contains_key("HYPRLAND_INSTANCE_SIGNATURE") {
        return if probes.has_command("hyprctl").await { Cap::of(State::Ready) } else { Cap::needs_package("hyprland") };
    }
    if desktop_name_has(env, "gnome") {
        // Without gdbus the extension cannot be probed (the native client talks to D-Bus itself): unknown, not missing.
        if !probes.has_command("gdbus").await {
            return Cap::of(State::Unknown);
        }
        // A shell that loaded an older copy keeps running it until the next sign-in.
        if let Some(loaded) = probes.window_helper_version().await {
            return if loaded >= MIN_WINDOW_HELPER_VERSION { Cap::of(State::Ready) } else { Cap::needs("relogin") };
        }
        // Not answering: either the shell has not loaded a freshly enabled extension yet (a sign-in fixes that) or it is not enabled.
        let status = probes.window_helper_status().await;
        return Cap::needs(if status.installed && status.enabled { "relogin" } else { "enable_window_helper" });
    }
    Cap::of(State::Unsupported)
}

async fn accessibility_capability(probes: &dyn Probes) -> Cap {
    if !probes.has_session_bus().await || !probes.has_command("gdbus").await {
        return Cap::of(State::Unknown);
    }
    if probes.accessibility_reachable().await { Cap::of(State::Ready) } else { Cap::needs_package("at-spi2-core") }
}

/// `checkLinuxComputerReadiness`.
pub async fn check_readiness(env: &Env, probes: &dyn Probes) -> Readiness {
    let session = detect_session(env);
    let desktop = detect_desktop(env, session);
    if session == "x11" && var(env, "DISPLAY").is_empty() {
        let none = Cap::of(State::Unsupported);
        return Readiness {
            session: session.into(),
            desktop: desktop.into(),
            capabilities: Capabilities {
                capture: none.clone(),
                windows: none.clone(),
                accessibility: none.clone(),
                semantic_actions: none.clone(),
                pointer: none.clone(),
                keyboard: none.clone(),
                clipboard: none.clone().optional(),
                ocr: none.optional(),
            },
        };
    }
    let wayland = session == "wayland";
    let windows = windows_capability(env, session, probes).await;
    let accessibility = accessibility_capability(probes).await;
    let input = if !wayland || probes.can_write("/dev/uinput").await { Cap::of(State::Ready) } else { Cap::needs("allow_input") };
    let clipboard = if !wayland || (probes.has_command("wl-copy").await && probes.has_command("wl-paste").await) {
        Cap::of(State::Ready)
    } else {
        Cap::needs_package("wl-clipboard")
    };
    let ocr = if probes.has_command("tesseract").await { Cap::of(State::Ready) } else { Cap::needs_package("tesseract-ocr") };
    Readiness {
        session: session.into(),
        desktop: desktop.into(),
        capabilities: Capabilities {
            // GNOME Wayland pixels come from our shell extension (no portal, never a prompt), so they are ready exactly when the
            // helper is. Other Wayland desktops use the desktop portal, which only prompts when used and so cannot be probed.
            capture: if wayland {
                if desktop == "gnome" { windows.clone() } else { Cap::of(State::Unknown) }
            } else {
                Cap::of(State::Ready)
            },
            // AT-SPI actions act on an accessible found through a window handle.
            semantic_actions: if windows.state == State::Ready { accessibility.clone() } else { windows.clone() },
            windows,
            accessibility,
            pointer: input.clone(),
            keyboard: input,
            clipboard: clipboard.optional(),
            ocr: ocr.optional(),
        },
    }
}

// --- which capability each host command needs (`linux-action-capabilities.mjs`) ---

const WINDOW_ACTIONS: [&str; 14] = [
    "list_windows",
    "window_snapshot",
    "related_windows",
    "window_bounds",
    "window_capture",
    "window_integrity",
    "validate_background_input",
    "list_apps",
    "verify",
    "focus_window",
    "move_window",
    "window_state",
    "close_window",
    "terminate_process",
];
const ACCESSIBILITY_ACTIONS: [&str; 4] = ["snapshot", "find", "window_predicates", "accessibility_probe"];
const SEMANTIC_ACTIONS: [&str; 4] = ["invoke", "set_value", "toggle", "invoke_menu"];
const POINTER_ACTIONS: [&str; 10] =
    ["click", "double_click", "right_click", "middle_click", "triple_click", "mouse_down", "mouse_up", "mouse_move", "drag", "scroll"];
const KEYBOARD_ACTIONS: [&str; 4] = ["type", "key", "key_down", "key_up"];

/// JavaScript truthiness of a command field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn text_of<'a>(command: &'a Map<String, Value>, key: &str) -> &'a str {
    command.get(key).and_then(Value::as_str).unwrap_or("")
}

fn names_window(command: &Map<String, Value>) -> bool {
    ["window_id", "app", "window"].iter().any(|key| truthy(command.get(*key)))
}

/// An insertion-ordered set of capability names.
#[derive(Default)]
struct Need(Vec<&'static str>);

impl Need {
    fn add(&mut self, name: &'static str) {
        if !self.0.contains(&name) {
            self.0.push(name);
        }
    }
}

fn add_step_needs(need: &mut Need, step: &Map<String, Value>, delivery: &str) {
    let action = text_of(step, "action");
    let foreground = delivery == "foreground";
    if truthy(step.get("ref")) || truthy(step.get("element")) {
        need.add("accessibility");
    }
    if SEMANTIC_ACTIONS.contains(&action) {
        // A foreground invoke is a real click; every other semantic action is AT-SPI.
        if action == "invoke" && foreground {
            need.add("pointer");
        } else {
            need.add("semanticActions");
        }
        if action == "invoke_menu" {
            need.add("windows");
        }
    } else if POINTER_ACTIONS.contains(&action) {
        need.add("pointer");
    } else if KEYBOARD_ACTIONS.contains(&action) {
        // Background typing into a settable element goes through its value.
        if action == "type" && truthy(step.get("ref")) && !foreground {
            need.add("semanticActions");
        } else {
            need.add("keyboard");
        }
    }
}

/// A capture that names no window or screen: it resolves the foreground window.
pub fn is_foreground_window_capture(command: &Map<String, Value>) -> bool {
    text_of(command, "action") == "capture" && !names_window(command) && !command.contains_key("screen")
}

fn delivery_of(command: &Map<String, Value>) -> &str {
    if truthy(command.get("delivery")) { text_of(command, "delivery") } else { "background" }
}

/// The capabilities a host command requires, in the order they are found.
pub fn required_capabilities(command: &Map<String, Value>) -> Vec<&'static str> {
    let mut need = Need::default();
    let action = text_of(command, "action");
    if WINDOW_ACTIONS.contains(&action) {
        need.add("windows");
    } else if ACCESSIBILITY_ACTIONS.contains(&action) {
        need.add("windows");
        need.add("accessibility");
    } else if action == "capture" {
        need.add("capture");
        let mode = if truthy(command.get("mode")) { text_of(command, "mode") } else { "state" };
        // Only a screen-index vision capture needs no window: every other mode resolves a named window or the foreground one.
        let screen_only = mode == "vision" && command.contains_key("screen") && !names_window(command);
        if !screen_only {
            need.add("windows");
        }
        if mode == "ax" {
            need.add("accessibility");
        }
    } else if action == "screenshot" || action == "zoom" {
        need.add("capture");
    } else if action == "clipboard_read" || action == "clipboard_write" {
        need.add("clipboard");
    } else if action == "sequence" {
        // An act always names its window (the schema requires it).
        need.add("windows");
        let delivery = delivery_of(command);
        if let Some(Value::Array(steps)) = command.get("steps") {
            for step in steps {
                // A step that is no object reads as an empty one.
                match step.as_object() {
                    Some(step) => add_step_needs(&mut need, step, delivery),
                    None => add_step_needs(&mut need, &Map::new(), delivery),
                }
            }
        }
    } else {
        add_step_needs(&mut need, command, delivery_of(command));
        if !need.0.is_empty() && names_window(command) {
            need.add("windows");
        }
    }
    need.0
}

// --- the refusal ---

fn capability_issue(name: &str, readiness: &Readiness) -> (String, String) {
    let caps = &readiness.capabilities;
    if caps.capture.state == State::Unsupported {
        return ("display_unavailable".into(), DISPLAY_HINT.into());
    }
    // Semantic actions fail on whichever of their two prerequisites is missing.
    let gnome_wayland = readiness.session == "wayland" && readiness.desktop == "gnome";
    let target = if name == "semanticActions" {
        if caps.windows.state == State::Ready { "accessibility" } else { "windows" }
    } else if name == "capture" && gnome_wayland {
        "windows"
    } else {
        name
    };
    let capability = caps.get(target);
    let (code, message) = match target {
        "windows" => {
            let fix = capability.and_then(|cap| cap.fix.as_deref());
            let message = match fix {
                Some("relogin") => WINDOW_HELPER_RELOGIN_HINT.to_owned(),
                Some("enable_window_helper") => WINDOW_HELPER_ENABLE_HINT.to_owned(),
                Some("install_package") => format!(
                    "wayland_window_control_unavailable: the {} window tool is missing from PATH; install {}",
                    readiness.desktop,
                    capability.and_then(|cap| cap.package.as_deref()).unwrap_or("undefined")
                ),
                _ => WINDOW_CONTROL_UNSUPPORTED_HINT.to_owned(),
            };
            ("wayland_window_control_unavailable".to_owned(), message)
        }
        "accessibility" => ("accessibility_unavailable".to_owned(), ACCESSIBILITY_HINT.to_owned()),
        "pointer" | "keyboard" => ("input_unavailable".to_owned(), format!("{UINPUT_HINT}. {INPUT_GROUP_SECURITY_NOTE}")),
        "clipboard" => ("clipboard_unavailable".to_owned(), CLIPBOARD_HINT.to_owned()),
        "ocr" => ("ocr_unavailable".to_owned(), TESSERACT_HINT.to_owned()),
        other => (format!("{other}_unavailable"), format!("{other}_unavailable: {other} is not available on this session")),
    };
    (code, message)
}

/// The required capabilities that are not usable, with their stable codes (`missingCapabilities`).
pub fn missing_capabilities(readiness: &Readiness, command: &Map<String, Value>) -> Vec<Value> {
    let mut missing = Vec::new();
    for name in required_capabilities(command) {
        let Some(capability) = readiness.capabilities.get(name) else { continue };
        if !capability.state.blocks() {
            continue;
        }
        let (code, message) = capability_issue(name, readiness);
        let mut item = Map::new();
        item.insert("capability".into(), json!(name));
        item.insert("state".into(), json!(capability.state.name()));
        if let Some(fix) = capability.fix.as_deref().filter(|fix| !fix.is_empty()) {
            item.insert("fix".into(), json!(fix));
        }
        if let Some(package) = capability.package.as_deref().filter(|package| !package.is_empty()) {
            item.insert("package".into(), json!(package));
        }
        item.insert("code".into(), json!(code));
        item.insert("message".into(), json!(message));
        missing.push(Value::Object(item));
    }
    missing
}

/// A refused action: nothing was executed.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub code: &'static str,
    pub missing: Vec<Value>,
    pub message: String,
}

impl Refusal {
    /// The capabilities that are missing, once each, in the order they were found (the structured twin of the text).
    pub fn capabilities(&self) -> Vec<&str> {
        let mut names: Vec<&str> = Vec::new();
        for item in &self.missing {
            let name = item["capability"].as_str().unwrap_or_default();
            if !names.contains(&name) {
                names.push(name);
            }
        }
        names
    }

    pub fn to_value(&self) -> Value {
        json!({ "code": self.code, "missing": self.missing, "message": self.message })
    }
}

/// A default capture without window control, rewritten as a full-screen capture of screen 0.
#[derive(Clone, Debug, PartialEq)]
pub struct Fallback {
    pub command: Map<String, Value>,
    pub note: &'static str,
}

type Probe = Shared<BoxFuture<'static, Arc<Readiness>>>;

/// The probe, taken at most once per few seconds and shared by concurrent calls (`getLinuxComputerReadiness`).
#[derive(Default)]
pub struct ReadinessCache {
    cached: Mutex<Option<(f64, Probe)>>,
}

impl ReadinessCache {
    async fn get(&self, now_ms: f64, check: impl FnOnce() -> BoxFuture<'static, Readiness>) -> Arc<Readiness> {
        let probe = {
            let mut cached = self.cached.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match cached.as_ref() {
                Some((at, probe)) if now_ms - at <= CACHE_MS => probe.clone(),
                _ => {
                    let probe: Probe = check().map(Arc::new).boxed().shared();
                    *cached = Some((now_ms, probe.clone()));
                    probe
                }
            }
        };
        probe.await
    }
}

/// `linuxComputerPreflight`: `None` when the command can run; otherwise the refusal, whose text names every missing capability
/// and says nothing ran. Other platforms are never blocked.
pub async fn preflight(
    cache: &ReadinessCache,
    command: &Map<String, Value>,
    linux: bool,
    now_ms: f64,
    check: impl FnOnce() -> BoxFuture<'static, Readiness>,
) -> Option<Refusal> {
    if !linux {
        return None;
    }
    let readiness = cache.get(now_ms, check).await;
    let missing = missing_capabilities(&readiness, command);
    if missing.is_empty() {
        return None;
    }
    // One line per distinct message, in the order first met, with the capabilities it covers.
    let mut details: Vec<(String, Vec<String>)> = Vec::new();
    for item in &missing {
        let message = item["message"].as_str().unwrap_or_default();
        let capability = item["capability"].as_str().unwrap_or_default().to_owned();
        match details.iter_mut().find(|(known, _)| known == message) {
            Some((_, capabilities)) => capabilities.push(capability),
            None => details.push((message.to_owned(), vec![capability])),
        }
    }
    let mut lines: Vec<String> = details.iter().map(|(message, capabilities)| format!("- {message} [{}]", capabilities.join(", "))).collect();
    let has = |name: &str| missing.iter().any(|item| item["capability"] == name);
    if text_of(command, "action") == "capture" && has("windows") && !has("capture") {
        lines.push("Screenshots that need no window still work: capture with mode=\"vision\" and a screen index (screen=0).".into());
    }
    let refusal = Refusal { code: CAPABILITY_UNAVAILABLE_CODE, missing, message: String::new() };
    let names = refusal.capabilities().join(", ");
    let message = format!(
        "{CAPABILITY_UNAVAILABLE_CODE}: Computer Use cannot run this action on this Linux session ({names}) — nothing was executed.\n{}",
        lines.join("\n")
    );
    Some(Refusal { message, ..refusal })
}

/// `linuxCaptureFallback`: a default capture resolves the foreground window; without window control it becomes a full-screen
/// capture instead of a refusal. `None` when no fallback applies.
pub async fn capture_fallback(
    cache: &ReadinessCache,
    command: &Map<String, Value>,
    linux: bool,
    now_ms: f64,
    check: impl FnOnce() -> BoxFuture<'static, Readiness>,
) -> Option<Fallback> {
    if !linux || !is_foreground_window_capture(command) {
        return None;
    }
    let readiness = cache.get(now_ms, check).await;
    if !readiness.capabilities.windows.state.blocks() {
        return None;
    }
    // A screen capture the session cannot take either is a refusal, not a fallback.
    if readiness.capabilities.capture.state.blocks() {
        return None;
    }
    let mut rewritten = Map::new();
    rewritten.insert("action".into(), command.get("action").cloned().unwrap_or(Value::Null));
    rewritten.insert("mode".into(), json!("vision"));
    rewritten.insert("screen".into(), json!(0));
    for key in ["session_id", "include_ocr"] {
        if truthy(command.get(key)) {
            rewritten.insert(key.into(), command[key].clone());
        }
    }
    Some(Fallback { command: rewritten, note: CAPTURE_FALLBACK_NOTE })
}

// --- the real probes ---

/// One short read-only process: whether it exited with code 0 and what it wrote to stdout; `None` when it could not be started
/// or did not end within `limit` (then it is killed).
async fn run_short(manager: &dyn ProcessManager, env: &Env, program: &str, args: &[&str], limit: Duration) -> Option<(bool, String)> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let cwd = std::env::current_dir().ok().and_then(AbsPath::new)?;
    let handle = ProcessHandle(format!("computer-probe-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let request = SpawnRequest {
        handle: handle.clone(),
        command: CommandSpec::Argv { program: program.to_owned(), args: args.iter().map(|arg| (*arg).to_owned()).collect() },
        cwd,
        env: EnvSpec { inherit: false, set: env.iter().map(|(key, value)| (key.clone(), value.clone())).collect(), remove: Vec::new() },
        pty: None,
        stdin_piped: false,
        output: OutputMode::Separate,
        owner: ProcessOwner::Internal,
        time_limit: None,
    };
    manager.spawn(request).await.ok()?;
    let mut events = manager.subscribe(&handle, Some(0)).ok()?;
    let read = async {
        let mut out = Vec::new();
        while let Some(event) = events.next().await {
            match event {
                ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } => out.extend_from_slice(&bytes),
                ProcessEvent::Output { .. } => {}
                ProcessEvent::Exited { exit, .. } => return Some((matches!(exit.status, ExitStatus::Code(0)), String::from_utf8_lossy(&out).into_owned())),
            }
        }
        None
    };
    match mixdog_rt::time::timeout(limit, read).await {
        Ok(done) => done,
        Err(_) => {
            let _ = manager.kill(&handle);
            None
        }
    }
}

/// The probes of the machine this process runs on.
pub struct SystemProbes {
    manager: Arc<dyn ProcessManager>,
    env: Env,
}

const PROBE_LIMIT: Duration = Duration::from_millis(2000);

impl SystemProbes {
    pub fn new(manager: Arc<dyn ProcessManager>, env: Env) -> Self {
        Self { manager, env }
    }

    async fn shell_test(&self, script: &str, arg: &str) -> bool {
        run_short(&*self.manager, &self.env, "/bin/sh", &["-c", script, "sh", arg], PROBE_LIMIT).await.is_some_and(|(ok, _)| ok)
    }

    async fn gdbus(&self, args: &[&str]) -> Option<String> {
        let mut full = vec!["call", "--session"];
        full.extend_from_slice(args);
        run_short(&*self.manager, &self.env, "gdbus", &full, PROBE_LIMIT).await.and_then(|(ok, out)| ok.then_some(out))
    }

    async fn gsettings(&self, args: &[&str]) -> String {
        run_short(&*self.manager, &self.env, "gsettings", args, PROBE_LIMIT).await.map_or_else(String::new, |(_, out)| out)
    }

    /// Where GNOME Shell looks for our extension: per user, then system-wide (the .deb).
    fn extension_dirs(&self) -> Vec<String> {
        let home = var(&self.env, "HOME");
        let data = match var(&self.env, "XDG_DATA_HOME") {
            "" if home.is_empty() => String::new(),
            "" => format!("{home}/.local/share"),
            data => data.to_owned(),
        };
        let mut dirs = Vec::new();
        if !data.is_empty() {
            dirs.push(format!("{data}/gnome-shell/extensions/{GNOME_EXTENSION_UUID}"));
        }
        dirs.push(format!("/usr/share/gnome-shell/extensions/{GNOME_EXTENSION_UUID}"));
        dirs
    }
}

#[async_trait]
impl Probes for SystemProbes {
    async fn can_write(&self, file: &str) -> bool {
        self.shell_test("test -w \"$1\"", file).await
    }

    async fn has_command(&self, name: &str) -> bool {
        self.shell_test("command -v \"$1\" >/dev/null 2>&1", name).await
    }

    // zbus (the native client) reaches the session bus through this address or the per-user socket; without either there is nothing to ask.
    async fn has_session_bus(&self) -> bool {
        if !var(&self.env, "DBUS_SESSION_BUS_ADDRESS").is_empty() {
            return true;
        }
        let runtime = var(&self.env, "XDG_RUNTIME_DIR");
        !runtime.is_empty() && self.shell_test("test -e \"$1/bus\"", runtime).await
    }

    async fn window_helper_version(&self) -> Option<u32> {
        let out = self
            .gdbus(&[
                "--dest",
                "org.gnome.Shell",
                "--object-path",
                "/io/mixdog/Windows",
                "--method",
                "org.freedesktop.DBus.Properties.Get",
                "io.mixdog.Windows",
                "Version",
            ])
            .await?;
        let digits = out.split("uint32 ").nth(1)?;
        let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
        digits[..end].parse().ok()
    }

    async fn window_helper_status(&self) -> HelperStatus {
        let mut installed = false;
        for dir in self.extension_dirs() {
            if self.shell_test("test -e \"$1/metadata.json\"", &dir).await {
                installed = true;
                break;
            }
        }
        if !installed {
            return HelperStatus { installed: false, enabled: false };
        }
        let list = self.gsettings(&["get", "org.gnome.shell", "enabled-extensions"]).await;
        let disabled_all = self.gsettings(&["get", "org.gnome.shell", "disable-user-extensions"]).await.contains("true");
        HelperStatus { installed, enabled: list.contains(&format!("'{GNOME_EXTENSION_UUID}'")) && !disabled_all }
    }

    async fn accessibility_reachable(&self) -> bool {
        self.gdbus(&["--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus", "--method", "org.a11y.Bus.GetAddress"]).await.is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use super::*;

    const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/computer-linux-readiness/golden.json");

    fn cases() -> Vec<Value> {
        let golden: Value = serde_json::from_str(&GOLDEN).expect("golden");
        golden["cases"].as_array().expect("cases").clone()
    }

    fn case(name: &str) -> Value {
        cases().into_iter().find(|case| case["case"] == name).unwrap_or_else(|| panic!("recording: no case {name:?}"))
    }

    fn command_of(value: &Value) -> Map<String, Value> {
        value.as_object().expect("a command is an object").clone()
    }

    fn env_of(value: &Value) -> Env {
        value.as_object().expect("env").iter().map(|(key, value)| (key.clone(), value.as_str().expect("env value").to_owned())).collect()
    }

    /// The test's injected probes, with the counters it reads.
    struct Injected {
        uinput: bool,
        window_version: Option<u32>,
        helper: HelperStatus,
        a11y: bool,
        bus: bool,
        tools: Vec<String>,
        window_calls: AtomicUsize,
        helper_calls: AtomicUsize,
        a11y_calls: AtomicUsize,
    }

    impl Injected {
        fn of(input: &Value) -> Self {
            Self {
                uinput: input["uinput"].as_bool().expect("uinput"),
                window_version: input["windowVersion"].as_u64().map(|version| version as u32),
                helper: HelperStatus { installed: input["helper"]["installed"].as_bool().expect("installed"), enabled: input["helper"]["enabled"].as_bool().expect("enabled") },
                a11y: input["a11y"].as_bool().expect("a11y"),
                bus: input["bus"].as_bool().expect("bus"),
                tools: input["tools"].as_array().expect("tools").iter().map(|tool| tool.as_str().expect("tool").to_owned()).collect(),
                window_calls: AtomicUsize::new(0),
                helper_calls: AtomicUsize::new(0),
                a11y_calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl Probes for Injected {
        async fn can_write(&self, file: &str) -> bool {
            file == "/dev/uinput" && self.uinput
        }
        async fn has_command(&self, name: &str) -> bool {
            self.tools.iter().any(|tool| tool == name)
        }
        async fn has_session_bus(&self) -> bool {
            self.bus
        }
        async fn window_helper_version(&self) -> Option<u32> {
            self.window_calls.fetch_add(1, Ordering::SeqCst);
            self.window_version
        }
        async fn window_helper_status(&self) -> HelperStatus {
            self.helper_calls.fetch_add(1, Ordering::SeqCst);
            self.helper
        }
        async fn accessibility_reachable(&self) -> bool {
            self.a11y_calls.fetch_add(1, Ordering::SeqCst);
            self.a11y
        }
    }

    fn ready_value(readiness: &Readiness) -> Value {
        serde_json::to_value(readiness).expect("readiness serialises")
    }

    fn check_of(readiness: Readiness) -> impl FnOnce() -> BoxFuture<'static, Readiness> {
        move || async move { readiness }.boxed()
    }

    /// The session and desktop of every recorded environment.
    #[test]
    fn session_and_desktop_detection_equal_the_recording() {
        for row in case("session and desktop detection")["observed"].as_array().expect("rows") {
            let env = env_of(&row["env"]);
            let session = detect_session(&env);
            assert_eq!(session, row["session"], "{:?}", row["env"]);
            assert_eq!(detect_desktop(&env, session), row["desktop"], "{:?}", row["env"]);
        }
    }

    #[test]
    fn what_each_command_requires_equals_the_recording() {
        let commands = case("the commands every session is asked about")["observed"].clone();
        let needs = case("what each command requires")["observed"].clone();
        let (commands, needs) = (commands.as_array().expect("commands"), needs.as_array().expect("needs"));
        assert_eq!(commands.len(), needs.len());
        for (command, need) in commands.iter().zip(needs) {
            assert_eq!(json!(required_capabilities(&command_of(command))), *need, "{command}");
        }
    }

    /// Every recorded session: its readiness and probe counts, what each command is missing, the refusal and the capture rewrite.
    #[tokio::test]
    async fn every_recorded_session_is_decided_as_node_decides_it() {
        let commands = case("the commands every session is asked about")["observed"].clone();
        let commands = commands.as_array().expect("commands").clone();
        let mut sessions = 0;
        for recorded in cases().into_iter().filter(|case| case["case"].as_str().is_some_and(|name| name.starts_with("session ") && name != "session and desktop detection")) {
            let name = recorded["case"].as_str().expect("name");
            let observed = &recorded["observed"];
            let input = &observed["input"];
            let injected = Injected::of(input);
            let env = env_of(&input["env"]);
            let readiness = check_readiness(&env, &injected).await;
            assert_eq!(ready_value(&readiness), observed["readiness"], "{name}: readiness");
            assert_eq!(
                json!({ "windowCalls": injected.window_calls.load(Ordering::SeqCst), "a11y": injected.a11y_calls.load(Ordering::SeqCst), "helper": injected.helper_calls.load(Ordering::SeqCst) }),
                observed["calls"],
                "{name}: probe counts"
            );
            for (at, command) in commands.iter().enumerate() {
                let command_map = command_of(command);
                let label = format!("{name} / {command}");
                assert_eq!(Value::Array(missing_capabilities(&readiness, &command_map)), observed["missing"][at], "{label}: missing");
                let refusal = preflight(&ReadinessCache::default(), &command_map, true, 0.0, check_of(readiness.clone())).await;
                assert_eq!(refusal.as_ref().map_or(Value::Null, Refusal::to_value), observed["preflight"][at], "{label}: preflight");
                let fallback = capture_fallback(&ReadinessCache::default(), &command_map, true, 0.0, check_of(readiness.clone())).await;
                let want = &observed["fallback"][at];
                match fallback {
                    None => assert!(want.is_null(), "{label}: fallback"),
                    Some(fallback) => assert_eq!(json!({ "command": fallback.command, "note": fallback.note }), *want, "{label}: fallback"),
                }
            }
            sessions += 1;
        }
        assert!(sessions >= 25, "{sessions}");
    }

    #[tokio::test]
    async fn other_platforms_are_never_blocked_and_never_rewritten() {
        let rows = case("other platforms are never blocked and never rewritten")["observed"].clone();
        let injected = Injected {
            uinput: false,
            window_version: None,
            helper: HelperStatus { installed: false, enabled: false },
            a11y: true,
            bus: true,
            tools: vec!["gdbus".into()],
            window_calls: AtomicUsize::new(0),
            helper_calls: AtomicUsize::new(0),
            a11y_calls: AtomicUsize::new(0),
        };
        let env = env_of(&json!({"WAYLAND_DISPLAY": "wayland-0", "XDG_SESSION_TYPE": "wayland", "XDG_CURRENT_DESKTOP": "ubuntu:GNOME", "PATH": ""}));
        let readiness = check_readiness(&env, &injected).await;
        for row in rows.as_array().expect("rows") {
            let command = command_of(&row["command"]);
            assert!(row["preflight"].is_null() && row["fallback"].is_null(), "recording: a platform that is not linux is never blocked");
            assert!(preflight(&ReadinessCache::default(), &command, false, 0.0, check_of(readiness.clone())).await.is_none());
            assert!(capture_fallback(&ReadinessCache::default(), &command, false, 0.0, check_of(readiness.clone())).await.is_none());
        }
    }

    /// The probe is cached for 3 seconds; concurrent calls share one probe; the fix is noticed once the window passes.
    #[tokio::test]
    async fn the_probe_is_cached_for_three_seconds_and_concurrent_calls_share_it() {
        let recorded = case("the probe is cached for 3 seconds and concurrent calls share one probe")["observed"].clone();
        let pointers: Vec<String> = recorded["pointers"].as_array().expect("pointers").iter().map(|p| p.as_str().expect("pointer").to_owned()).collect();
        let command = command_of(&json!({"action": "sequence", "steps": [{"action": "click", "x": 1, "y": 2}]}));
        let cache = ReadinessCache::default();
        let probes = Arc::new(AtomicUsize::new(0));
        for step in recorded["steps"].as_array().expect("steps") {
            let at = step["at"].as_f64().expect("at");
            let run = || {
                let (probes, pointers) = (probes.clone(), pointers.clone());
                preflight(&cache, &command, true, at, move || {
                    async move {
                        let index = probes.fetch_add(1, Ordering::SeqCst).min(pointers.len() - 1);
                        let ready = Cap::of(State::Ready);
                        Readiness {
                            session: "wayland".into(),
                            desktop: "gnome".into(),
                            capabilities: Capabilities {
                                capture: Cap::of(State::Unknown),
                                windows: ready.clone(),
                                accessibility: ready.clone(),
                                semantic_actions: ready.clone(),
                                pointer: if pointers[index] == "ready" { ready.clone() } else { Cap::needs("allow_input") },
                                keyboard: ready.clone(),
                                clipboard: ready.clone(),
                                ocr: ready,
                            },
                        }
                    }
                    .boxed()
                })
            };
            let mut results = Vec::new();
            for _ in 0..step["concurrent"].as_u64().expect("concurrent") {
                results.push(run());
            }
            let results: Vec<Value> = futures::future::join_all(results).await.iter().map(|r| r.as_ref().map_or(Value::Null, Refusal::to_value)).collect();
            assert_eq!(Value::Array(results), step["results"], "at {at}");
            assert_eq!(probes.load(Ordering::SeqCst), step["probes"].as_u64().expect("probes") as usize, "probes at {at}");
        }
    }
}
