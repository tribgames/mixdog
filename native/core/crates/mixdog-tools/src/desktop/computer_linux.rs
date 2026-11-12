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
use mixdog_rt::time::Instant;
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
const CACHE_LIFE: Duration = Duration::from_millis(3000);

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

/// The one probe of the process, as Node's module-level `cached`: every session reads it, whichever backend it runs on. It is taken
/// at most once per [`CACHE_LIFE`] of the runtime's clock and shared by concurrent calls (`getLinuxComputerReadiness`).
static CACHED: Mutex<Option<(Instant, Probe)>> = Mutex::new(None);

async fn shared_readiness(check: impl FnOnce() -> BoxFuture<'static, Readiness>) -> Arc<Readiness> {
    let probe = {
        let mut cached = CACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        match cached.as_ref() {
            Some((at, probe)) if now.saturating_duration_since(*at) <= CACHE_LIFE => probe.clone(),
            _ => {
                let probe: Probe = check().map(Arc::new).boxed().shared();
                *cached = Some((now, probe.clone()));
                probe
            }
        }
    };
    probe.await
}

/// `getLinuxComputerReadiness`: the process's one probe, asked afresh when it is older than [`CACHE_LIFE`].
pub(super) async fn probe(manager: Arc<dyn ProcessManager>, env: Env) -> Arc<Readiness> {
    shared_readiness(|| async move { check_readiness(&env, &SystemProbes::new(manager, env.clone())).await }.boxed()).await
}

/// `resetLinuxComputerPreflightCache`.
#[cfg(test)]
fn reset_probe() {
    *CACHED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// `linuxComputerPreflight`: `None` when the command can run; otherwise the refusal, whose text names every missing capability
/// and says nothing ran. The caller skips it on a platform that is not Linux.
pub async fn preflight(command: &Map<String, Value>, check: impl FnOnce() -> BoxFuture<'static, Readiness>) -> Option<Refusal> {
    let readiness = shared_readiness(check).await;
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
pub async fn capture_fallback(command: &Map<String, Value>, check: impl FnOnce() -> BoxFuture<'static, Readiness>) -> Option<Fallback> {
    if !is_foreground_window_capture(command) {
        return None;
    }
    let readiness = shared_readiness(check).await;
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
pub(super) async fn run_short(manager: &dyn ProcessManager, env: &Env, program: &str, args: &[&str], limit: Duration) -> Option<(bool, String)> {
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
    use std::sync::MutexGuard;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    use base64::Engine;
    use mixdog_core_api::domain::computer::ComputerBackend;
    use mixdog_core_api::domain::computer::ComputerError;
    use mixdog_core_api::domain::process::KillReason;
    use mixdog_core_api::domain::process::ProcessError;
    use mixdog_core_api::domain::process::ProcessExit;
    use mixdog_core_api::domain::process::ProcessInfo;
    use mixdog_core_api::domain::process::PtySize;
    use mixdog_core_api::domain::process::SpawnedProcess;
    use mixdog_core_api::domain::tool::ImageData;
    use mixdog_core_api::domain::tool::ToolPart;
    use tokio::sync::mpsc::UnboundedReceiver;
    use tokio::sync::mpsc::UnboundedSender;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::desktop::computer::failure_text;
    use crate::desktop::computer::request;
    use crate::desktop::computer_backend::ComputerConfig;
    use crate::desktop::computer_backend::ProcessComputerBackend;
    use crate::desktop::computer_backend::RESPONSE_MARKER;
    use crate::desktop::computer_gnome::Display;
    use crate::desktop::computer_gnome::ShotFiles;

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

    fn strings(value: &Value) -> Vec<String> {
        value.as_array().expect("a list").iter().map(|item| item.as_str().expect("a string").to_owned()).collect()
    }

    fn bytes_of(base64: &Value) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(base64.as_str().expect("base64")).expect("base64 bytes")
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

    // --- the stand-in machine: what the probes and the desktop host's calls read, answered at the process manager ---

    /// The recorded world: the environment, executables, paths, programs' answers, the scripted helper and the screenshot Node's recording ran on.
    struct World {
        env: Env,
        executables: Vec<String>,
        writable: Vec<String>,
        existing: Vec<String>,
        window_version: Option<u32>,
        a11y: bool,
        enabled: String,
        disabled: String,
        /// The helper's answer to each request action; any other action is answered as an error.
        helper: Map<String, Value>,
        /// How the extension's screenshot goes: `ok`, `fails`, `no-file` (exits 0, writes nothing) or `empty` (a 0x0 PNG).
        screenshot: String,
        png: Vec<u8>,
        empty_png: Vec<u8>,
        /// The one display the recording's Electron stand-in reports (id 1, scale 1, at the origin).
        display: (i64, i64),
        shot_id: String,
    }

    impl World {
        fn of(value: &Value) -> Self {
            Self {
                env: env_of(&value["env"]),
                executables: strings(&value["executables"]),
                writable: strings(&value["writable"]),
                existing: strings(&value["existing"]),
                window_version: value["windowVersion"].as_u64().map(|version| version as u32),
                a11y: value["a11y"].as_bool().expect("a11y"),
                enabled: value["gsettings"]["enabled"].as_str().expect("enabled").to_owned(),
                disabled: value["gsettings"]["disabled"].as_str().expect("disabled").to_owned(),
                helper: value["helperReplies"].as_object().expect("helper replies").clone(),
                screenshot: value["screenshot"]["how"].as_str().expect("how").to_owned(),
                png: bytes_of(&value["screenshot"]["png"]),
                empty_png: bytes_of(&value["screenshot"]["emptyPng"]),
                display: (value["display"]["width"].as_i64().expect("width"), value["display"]["height"].as_i64().expect("height")),
                shot_id: value["shotId"].as_str().expect("shot id").to_owned(),
            }
        }

        fn displays(&self) -> Vec<Display> {
            vec![Display { id: "1".into(), x: 0, y: 0, width: self.display.0, height: self.display.1, scale_factor: 1.0, primary: true }]
        }

        /// The shell checks the real probes run (`test -w`, `command -v`, `test -e`), against the world's files and the `PATH` they were given.
        fn shell(&self, env: &EnvSpec, script: &str, arg: &str) -> bool {
            match script {
                "test -w \"$1\"" => self.writable.iter().any(|file| file == arg),
                "command -v \"$1\" >/dev/null 2>&1" => {
                    let path = env.set.iter().find(|(key, _)| key == "PATH").map_or("", |(_, value)| value.as_str());
                    path.split(':').filter(|dir| !dir.is_empty()).any(|dir| self.executables.contains(&format!("{dir}/{arg}")))
                }
                "test -e \"$1/bus\"" => self.existing.contains(&format!("{arg}/bus")),
                "test -e \"$1/metadata.json\"" => self.existing.contains(&format!("{arg}/metadata.json")),
                other => panic!("the stand-in machine does not know the probe {other:?}"),
            }
        }

        /// What `gdbus` and `gsettings` answer: the exit code and stdout; the extension's screenshot is written to `files`.
        fn tool(&self, program: &str, args: &[String], files: &Files) -> (i32, String) {
            let has = |word: &str| args.iter().any(|arg| arg == word);
            match program {
                "gdbus" if has("Version") => match self.window_version {
                    Some(version) => (0, format!("(<uint32 {version}>,)\n")),
                    None => (1, String::new()),
                },
                "gdbus" if has("org.a11y.Bus.GetAddress") => {
                    if self.a11y { (0, "('unix:path=/run/user/1000/at-spi/bus',)\n".into()) } else { (1, String::new()) }
                }
                "gdbus" if args.iter().any(|arg| arg.ends_with(".Screenshot")) => {
                    if self.screenshot == "fails" {
                        return (1, String::new());
                    }
                    if self.screenshot != "no-file" {
                        let path = args.last().expect("the file argument").trim_matches('\'');
                        files.put(path, if self.screenshot == "empty" { self.empty_png.clone() } else { self.png.clone() });
                    }
                    (0, "()\n".into())
                }
                "gsettings" if args.get(1).map(String::as_str) == Some("org.gnome.shell") && args.get(2).map(String::as_str) == Some("enabled-extensions") => {
                    (0, self.enabled.clone())
                }
                "gsettings" if args.get(1).map(String::as_str) == Some("org.gnome.shell") && args.get(2).map(String::as_str) == Some("disable-user-extensions") => {
                    (0, self.disabled.clone())
                }
                _ => (1, String::new()),
            }
        }
    }

    /// The files of the virtual machine: what the extension wrote and the core has not yet removed.
    #[derive(Default)]
    struct Files(Mutex<HashMap<String, Vec<u8>>>);

    impl Files {
        fn put(&self, path: &str, bytes: Vec<u8>) {
            self.0.lock().unwrap().insert(path.to_owned(), bytes);
        }
    }

    impl ShotFiles for Files {
        fn read(&self, path: &str) -> std::io::Result<Vec<u8>> {
            self.0.lock().unwrap().get(path).cloned().ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
        }

        fn remove(&self, path: &str) {
            self.0.lock().unwrap().remove(path);
        }
    }

    /// Everything the machine was asked, in order: `{"tool": [program, args…]}` for a gdbus / gsettings process, `{"helper": request}` for a
    /// helper request, exactly as sent (the recording's `events`).
    #[derive(Default)]
    struct Log(Mutex<Vec<Value>>);

    impl Log {
        fn events(&self) -> Vec<Value> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }

    struct Feed(UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for Feed {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    /// A process manager that starts nothing: it answers the probes and the programs from the world, and a helper that answers as scripted.
    struct Machine {
        world: Arc<World>,
        log: Arc<Log>,
        files: Arc<Files>,
        senders: Mutex<HashMap<String, UnboundedSender<ProcessEvent>>>,
        receivers: Mutex<HashMap<String, UnboundedReceiver<ProcessEvent>>>,
        seq: AtomicU64,
    }

    impl Machine {
        fn new(world: &Arc<World>, log: &Arc<Log>, files: &Arc<Files>) -> Arc<Self> {
            Arc::new(Self {
                world: world.clone(),
                log: log.clone(),
                files: files.clone(),
                senders: Mutex::default(),
                receivers: Mutex::default(),
                seq: AtomicU64::new(0),
            })
        }

        fn emit(&self, handle: &ProcessHandle, event: impl FnOnce(u64) -> ProcessEvent) {
            let sender = self.senders.lock().unwrap().get(&handle.0).cloned();
            if let Some(sender) = sender {
                let _ = sender.send(event(self.seq.fetch_add(1, Ordering::SeqCst)));
            }
        }

        fn exited(seq: u64, code: i32, killed: Option<KillReason>) -> ProcessEvent {
            ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(code), killed } }
        }
    }

    #[async_trait]
    impl ProcessManager for Machine {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            let CommandSpec::Argv { program, args } = &request.command else { panic!("the stand-in machine starts argv commands") };
            let (send, receive) = tokio::sync::mpsc::unbounded_channel();
            self.senders.lock().unwrap().insert(request.handle.0.clone(), send);
            self.receivers.lock().unwrap().insert(request.handle.0.clone(), receive);
            let hangs = self.world.screenshot == "hangs" && args.iter().any(|arg| arg.ends_with(".Screenshot"));
            if !request.stdin_piped {
                let (code, out) = match program.as_str() {
                    "/bin/sh" => (i32::from(!self.world.shell(&request.env, &args[1], &args[3])), String::new()),
                    "gdbus" | "gsettings" => {
                        self.log.0.lock().unwrap().push(json!({ "tool": std::iter::once(program.clone()).chain(args.iter().cloned()).collect::<Vec<_>>() }));
                        self.world.tool(program, args, &self.files)
                    }
                    other => return Err(ProcessError::ProgramNotFound { program: other.to_owned() }),
                };
                if !out.is_empty() {
                    self.emit(&request.handle, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: out.into_bytes() });
                }
                if !hangs {
                    self.emit(&request.handle, |seq| Self::exited(seq, code, None));
                }
            }
            Ok(SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(&self, handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let receive = self.receivers.lock().unwrap().remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
            Ok(Box::new(Feed(receive)))
        }

        async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let request: Value = serde_json::from_slice(&bytes).expect("a request line");
            let action = request["action"].as_str().expect("an action");
            let reply = match self.world.helper.get(action) {
                Some(result) => json!({"id": request["id"], "ok": true, "result": result}),
                None => json!({"id": request["id"], "ok": false, "error": format!("unscripted helper action {action}")}),
            };
            self.log.0.lock().unwrap().push(json!({ "helper": request }));
            self.emit(handle, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: format!("{RESPONSE_MARKER}{reply}\n").into_bytes() });
            Ok(())
        }

        fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Err(ProcessError::StdinClosed)
        }

        fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
            Err(ProcessError::NotPty)
        }

        fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
            self.emit(handle, |seq| Self::exited(seq, 0, Some(KillReason::Requested)));
            Ok(())
        }

        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    /// The probe cache is the process's: tests that read it run one at a time.
    fn serial() -> MutexGuard<'static, ()> {
        static ONE: Mutex<()> = Mutex::new(());
        let held = ONE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_probe();
        held
    }

    /// What one recorded call is compared on.
    #[derive(Default)]
    struct Seen {
        refused: usize,
        diagnosed: usize,
        frames: usize,
        pixel_failures: usize,
        electron: usize,
        errors: usize,
    }

    /// The content blocks the core returned, in the recording's shape, minus the image's bytes and media type (see `node_blocks`).
    fn blocks_of(parts: &[ToolPart]) -> Vec<Value> {
        parts
            .iter()
            .map(|part| match part {
                ToolPart::Text(text) => json!({"type": "text", "text": text}),
                ToolPart::Image { width, height, .. } => json!({"type": "image", "width": width, "height": height}),
                other => panic!("unexpected part {other:?}"),
            })
            .collect()
    }

    /// The content blocks Node returned. NOT COMPARED: an image's bytes and media type. Node resamples and re-encodes the frame in
    /// Electron (Chromium's JPEG encoder), which the recorder replaces with a stand-in (`STANDIN-JPEG q<quality>` before the PNG it was
    /// given) and the core has no counterpart of yet (route undecided): neither side's bytes say anything about the other's, so they
    /// are not compared. What is compared is the block's `width` and `height`.
    fn node_blocks(content: &[Value]) -> Vec<Value> {
        content
            .iter()
            .map(|block| match block["type"].as_str().expect("a block type") {
                "text" => json!({"type": "text", "text": block["text"]}),
                "image" => json!({"type": "image", "width": block["width"], "height": block["height"]}),
                other => panic!("unexpected block {other}"),
            })
            .collect()
    }

    /// One recorded call through `ProcessComputerBackend::run` on a fresh backend and a fresh machine of the recorded world, compared whole
    /// with what Node's tool returned: the error flag, every content block, and the gdbus / gsettings invocations and helper requests in
    /// order. A capture Node could only take through Electron is `Unavailable`.
    async fn replay(world: World, session: &str, args: &Value, node: &Value, label: &str, seen: &mut Seen) {
        let world = Arc::new(world);
        let (log, files) = (Arc::new(Log::default()), Arc::new(Files::default()));
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", session), Machine::new(&world, &log, &files)).with_linux_session(
            world.env.clone(),
            world.displays(),
            files.clone(),
            world.shot_id.clone(),
        );
        let got = backend.run(request(args).expect("a recorded call"), CancellationToken::new()).await;
        if node["electron"] == true {
            assert!(matches!(got, Err(ComputerError::Unavailable { .. })), "{label}: Node takes this capture through Electron, got {got:?}");
            seen.electron += 1;
            return;
        }
        let result = &node["result"];
        let want = node_blocks(result["content"].as_array().expect("content"));
        let is_error = match got {
            Ok(parts) => {
                assert_eq!(blocks_of(&parts), want, "{label}: the content the tool returned");
                seen.frames += usize::from(want.iter().any(|block| block["type"] == "image"));
                false
            }
            Err(ComputerError::Failed { code, message }) => {
                if let Some(meta) = result.get("toolMeta") {
                    assert_eq!(code, meta["code"].as_str().expect("code"), "{label}: the refusal's code");
                    seen.refused += 1;
                }
                assert_eq!(vec![json!({"type": "text", "text": failure_text(&code, &message, args)})], want, "{label}: the error text the tool returns");
                seen.pixel_failures += usize::from(code == "computer_reported");
                true
            }
            Err(other) => panic!("{label}: Node ran it, got {other:?}"),
        };
        assert_eq!(is_error, result["isError"] == true, "{label}: the error flag");
        seen.errors += usize::from(is_error);
        seen.diagnosed += usize::from(args["action"] == "diagnose");
        assert_eq!(Value::Array(log.events()), node["events"], "{label}: the gdbus/gsettings invocations and helper requests, in order");
    }

    /// Every recorded session, every call it was asked, whole, through the backend's own entry on the Linux path.
    #[tokio::test(start_paused = true)]
    #[allow(clippy::await_holding_lock)]
    async fn every_recorded_session_replays_through_the_backend() {
        let _serial = serial();
        let mut seen = Seen::default();
        let mut sessions = 0;
        for recorded in cases().into_iter().filter(|case| case["case"].as_str().is_some_and(|name| name.starts_with("session ") && name != "session and desktop detection")) {
            let name = recorded["case"].as_str().expect("name");
            let observed = &recorded["observed"];
            for node in observed["calls"].as_array().expect("calls") {
                reset_probe();
                replay(World::of(&observed["world"]), "default", &node["args"], node, &format!("{name} / {}", node["args"]), &mut seen).await;
            }
            sessions += 1;
        }
        assert!(
            sessions >= 30 && seen.refused > 100 && seen.diagnosed >= 30 && seen.frames >= 3 && seen.pixel_failures >= 4 && seen.electron >= 10 && seen.errors > 100,
            "{sessions} sessions, {} refused, {} diagnosed, {} frames, {} pixel failures, {} electron, {} errors",
            seen.refused,
            seen.diagnosed,
            seen.frames,
            seen.pixel_failures,
            seen.electron,
            seen.errors
        );
    }

    /// Node ends a GNOME capture at 12 s (`GNOME_SHELL_CAPTURE_TIMEOUT_MS`), inside the 15 s the `gdbus` process gets: a `gdbus` that
    /// never answers fails the capture after 12 s of the runtime's (paused) clock.
    #[tokio::test(start_paused = true)]
    #[allow(clippy::await_holding_lock)]
    async fn a_gnome_capture_that_never_answers_ends_at_12_seconds() {
        let _serial = serial();
        let recorded = case("session gnome-everything")["observed"].clone();
        let mut world = World::of(&recorded["world"]);
        world.screenshot = "hangs".into();
        let world = Arc::new(world);
        let (log, files) = (Arc::new(Log::default()), Arc::new(Files::default()));
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "default"), Machine::new(&world, &log, &files)).with_linux_session(
            world.env.clone(),
            world.displays(),
            files.clone(),
            world.shot_id.clone(),
        );
        let call = json!({"action": "capture", "input": {"mode": "vision", "screen": 0}});
        // Nothing else is waiting on the clock, so a paused runtime moves it to the next deadline: the first one the capture armed.
        let started = tokio::time::Instant::now();
        let got = backend.run(request(&call).expect("a capture"), CancellationToken::new()).await;
        assert_eq!(started.elapsed(), Duration::from_secs(12), "the capture's bound");
        assert!(matches!(got, Err(ComputerError::Failed { ref code, .. }) if code == "computer_reported"), "{got:?}");
    }

    /// The probe is the process's, not a session's, and it lives 3 seconds of the runtime's clock: two sessions inside the window share it,
    /// and the first call after it asks again. The window passes by advancing that clock.
    #[tokio::test(start_paused = true)]
    #[allow(clippy::await_holding_lock)]
    async fn the_probe_is_shared_by_two_sessions_inside_3_seconds_and_asked_again_after() {
        let _serial = serial();
        let recorded = case("the probe is shared by two sessions inside 3 seconds and asked again after")["observed"].clone();
        let mut now = 0;
        let mut seen = Seen::default();
        for step in recorded["steps"].as_array().expect("steps") {
            let at = step["at"].as_u64().expect("at");
            tokio::time::advance(Duration::from_millis(at - now)).await;
            now = at;
            for node in step["calls"].as_array().expect("calls") {
                let mut world = World::of(&recorded["world"]);
                world.writable = if step["uinput"].as_bool().expect("uinput") { vec!["/dev/uinput".to_owned()] } else { Vec::new() };
                let session = node["sessionId"].as_str().expect("session");
                replay(world, session, &recorded["call"], node, &format!("at {at} / {session}"), &mut seen).await;
            }
        }
        assert_eq!(seen.diagnosed, 8);
    }
}
