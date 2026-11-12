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
    use std::sync::MutexGuard;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

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
    use base64::Engine;
    use tokio::sync::mpsc::UnboundedReceiver;
    use tokio::sync::mpsc::UnboundedSender;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::desktop::computer::request;
    use crate::desktop::computer_backend::ComputerConfig;
    use crate::desktop::computer_backend::ProcessComputerBackend;
    use crate::desktop::computer_backend::RESPONSE_MARKER;
    use crate::desktop::computer_recovery::format_tool_error;

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

    // --- the stand-in machine: what the preflight's probes read, answered at the process manager ---

    /// The recorded world: the same environment, executables, paths and answers Node's probing read through `fs` and `spawn`.
    struct World {
        env: Env,
        executables: Vec<String>,
        writable: Vec<String>,
        existing: Vec<String>,
        window_version: Option<u32>,
        a11y: bool,
        enabled: String,
        disabled: String,
        /// The screenshot the virtual desktop host answers with, as recorded.
        image: Value,
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
                image: value["image"].clone(),
            }
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

        /// What `gdbus` and `gsettings` answer: the exit code and stdout.
        fn tool(&self, program: &str, args: &[String]) -> (i32, String) {
            let has = |word: &str| args.iter().any(|arg| arg == word);
            match program {
                "gdbus" if has("Version") => match self.window_version {
                    Some(version) => (0, format!("(<uint32 {version}>,)\n")),
                    None => (1, String::new()),
                },
                "gdbus" if has("org.a11y.Bus.GetAddress") => {
                    if self.a11y { (0, "('unix:path=/run/user/1000/at-spi/bus',)\n".into()) } else { (1, String::new()) }
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

    /// What the machines of one test were asked.
    #[derive(Default)]
    struct Log {
        /// Every `gdbus` / `gsettings` process started, as program and arguments.
        spawned: Mutex<Vec<Vec<String>>>,
        /// Every request line the helper was sent.
        requests: Mutex<Vec<Value>>,
    }

    impl Log {
        fn spawned(&self) -> Value {
            json!(std::mem::take(&mut *self.spawned.lock().unwrap()))
        }

        /// The requests the helper was sent, without the transport's own fields (`id`, `session_id`).
        fn requests(&self) -> Vec<Value> {
            let mut sent = std::mem::take(&mut *self.requests.lock().unwrap());
            for request in &mut sent {
                let request = request.as_object_mut().expect("a request is an object");
                request.shift_remove("id");
                request.shift_remove("session_id");
                if let Some(step) = request.get_mut("step").and_then(Value::as_object_mut) {
                    step.shift_remove("session_id");
                }
            }
            sent
        }
    }

    struct Feed(UnboundedReceiver<ProcessEvent>);

    #[async_trait]
    impl EventSource<ProcessEvent> for Feed {
        async fn next(&mut self) -> Option<ProcessEvent> {
            self.0.recv().await
        }
    }

    /// A process manager that starts nothing: it answers the probes from the world, and a helper that answers every request `ok`.
    struct Machine {
        world: Arc<Mutex<World>>,
        log: Arc<Log>,
        senders: Mutex<HashMap<String, UnboundedSender<ProcessEvent>>>,
        receivers: Mutex<HashMap<String, UnboundedReceiver<ProcessEvent>>>,
        seq: AtomicU64,
    }

    impl Machine {
        fn new(world: &Arc<Mutex<World>>, log: &Arc<Log>) -> Arc<Self> {
            Arc::new(Self { world: world.clone(), log: log.clone(), senders: Mutex::default(), receivers: Mutex::default(), seq: AtomicU64::new(0) })
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
            if !request.stdin_piped {
                let (code, out) = {
                    let world = self.world.lock().unwrap();
                    match program.as_str() {
                        "/bin/sh" => (i32::from(!world.shell(&request.env, &args[1], &args[3])), String::new()),
                        "gdbus" | "gsettings" => {
                            self.log.spawned.lock().unwrap().push(std::iter::once(program.clone()).chain(args.iter().cloned()).collect());
                            world.tool(program, args)
                        }
                        other => return Err(ProcessError::ProgramNotFound { program: other.to_owned() }),
                    }
                };
                if !out.is_empty() {
                    self.emit(&request.handle, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: out.into_bytes() });
                }
                self.emit(&request.handle, |seq| Self::exited(seq, code, None));
            }
            Ok(SpawnedProcess { handle: request.handle, pid: 1 })
        }

        fn subscribe(&self, handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            let receive = self.receivers.lock().unwrap().remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
            Ok(Box::new(Feed(receive)))
        }

        async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let request: Value = serde_json::from_slice(&bytes).expect("a request line");
            let mut result = json!({"text": "ok"});
            if matches!(request["action"].as_str(), Some("window_capture" | "capture")) {
                result["image"] = self.world.lock().unwrap().image.clone();
            }
            let reply = format!("{}{}\n", RESPONSE_MARKER, json!({"id": request["id"], "ok": true, "result": result}));
            self.log.requests.lock().unwrap().push(request);
            self.emit(handle, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: reply.into_bytes() });
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

    /// A session of the `computer` tool on the stand-in machine; `linux` names the platform, whatever this test runs on.
    fn backend(world: &Arc<Mutex<World>>, log: &Arc<Log>, session: &str, linux: bool) -> ProcessComputerBackend {
        let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", session), Machine::new(world, log));
        if linux { backend.with_linux_session(world.lock().unwrap().env.clone()) } else { backend }
    }

    /// The requests the helper gets for the command Node dispatched to its desktop host: the host's own steps, one request each
    /// (a sequence is its steps, then the capture that observes the window; a capture is the snapshot, then the window's pixels).
    fn helper_requests(dispatched: &Value) -> Vec<Value> {
        let command = command_of(dispatched);
        let renamed = |name: &str| {
            let mut renamed = command.clone();
            renamed.insert("action".into(), json!(name));
            vec![Value::Object(renamed)]
        };
        match text_of(&command, "action") {
            "sequence" => {
                let target: Map<String, Value> = ["window_id", "app"].iter().filter_map(|key| command.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect();
                let delivery = command["delivery"].clone();
                let mut out: Vec<Value> = command["steps"]
                    .as_array()
                    .expect("steps")
                    .iter()
                    .map(|step| {
                        let mut step = step.as_object().expect("a step").clone();
                        for (key, value) in &target {
                            step.entry(key.clone()).or_insert_with(|| value.clone());
                        }
                        step.insert("delivery".into(), delivery.clone());
                        if delivery == "background" && step.contains_key("window_id") {
                            json!({"action": "sequence_step", "delivery": "background", "step": step})
                        } else {
                            Value::Object(step)
                        }
                    })
                    .collect();
                if !target.is_empty() {
                    let mut observe = target;
                    observe.insert("action".into(), json!("capture"));
                    if let Some(mode) = command.get("capture_after_mode") {
                        observe.insert("mode".into(), mode.clone());
                    }
                    out.extend(capture_requests(&observe));
                }
                out
            }
            "capture" => capture_requests(&command),
            "diagnose" => vec![json!({"action": "accessibility_probe"}), json!({"action": "ocr_status"})],
            "list_apps" => renamed("list_installed_apps"),
            "verify" => renamed("window_predicates"),
            _ => vec![dispatched.clone()],
        }
    }

    fn capture_requests(command: &Map<String, Value>) -> Vec<Value> {
        if command.contains_key("screen") {
            return vec![Value::Object(command.clone())];
        }
        let mut rest = command.clone();
        let mode = rest.shift_remove("mode").and_then(|mode| mode.as_str().map(str::to_owned)).unwrap_or_else(|| "state".into());
        let with = |name: &str| {
            let mut request = rest.clone();
            request.insert("action".into(), json!(name));
            Value::Object(request)
        };
        let mut out = Vec::new();
        if mode != "vision" {
            out.push(with("snapshot"));
        }
        if mode != "ax" {
            out.push(with("window_capture"));
        }
        out
    }

    /// The content blocks a call returned, in Node's shape. The text of an `act` is composed by the desktop host in Node and by the client in
    /// Rust (from the stand-in's answers), and `diagnose` is answered once per probe in Rust: those two are compared as the manifest declares.
    fn assert_content(action: &str, parts: &[ToolPart], node: &[Value], label: &str) {
        let mut got: Vec<Value> = parts
            .iter()
            .map(|part| match part {
                ToolPart::Text(text) => json!({"type": "text", "text": text}),
                ToolPart::Image { mime, data: ImageData::Bytes(bytes) } => {
                    json!({"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes)}})
                }
                other => panic!("{label}: unexpected part {other:?}"),
            })
            .collect();
        let mut want = node.to_vec();
        match action {
            "act" => {
                got.retain(|block| block["type"] == "image");
                want.remove(0);
            }
            "diagnose" => got.dedup(),
            _ => {}
        }
        assert_eq!(got, want, "{label}: the content the tool returned");
    }

    /// One recorded call through `ProcessComputerBackend::run`, compared with what Node's tool did with it: refused (the tool's error text, no
    /// request to the helper) or run (the requests the helper got and the content returned, whole; a rewritten capture returns the screenshot
    /// and the fallback note); and the gdbus/gsettings processes started are Node's.
    async fn replay(backend: &ProcessComputerBackend, log: &Log, args: &Value, node: &Value, label: &str) {
        let got = backend.run(request(args).expect("a recorded call"), CancellationToken::new()).await;
        let result = &node["result"];
        let text = result["content"][0]["text"].as_str().expect("text");
        let dispatched = node["dispatched"].as_array().expect("dispatched");
        if let Some(meta) = result.get("toolMeta") {
            assert!(dispatched.is_empty(), "{label}: recording: a refused call dispatches nothing");
            let Err(ComputerError::Failed { code, message }) = &got else { panic!("{label}: refused by Node, got {got:?}") };
            assert_eq!(code, meta["code"].as_str().expect("code"), "{label}: code");
            assert_eq!(format_tool_error(message, args), text, "{label}: the error text the tool returns");
            assert_eq!(log.requests(), Vec::<Value>::new(), "{label}: a refused action reached the helper");
            assert_eq!(result["isError"], true, "{label}: the error flag");
        } else {
            assert_eq!(dispatched.len(), 1, "{label}: recording: one command to the bridge");
            assert!(result.get("isError").is_none(), "{label}: recording: Node's call succeeded");
            let parts = got.unwrap_or_else(|error| panic!("{label}: Node ran it, got {error:?}"));
            assert_eq!(log.requests(), dispatched.iter().flat_map(helper_requests).collect::<Vec<_>>(), "{label}: the requests that reached the helper");
            assert_content(args["action"].as_str().expect("action"), &parts, result["content"].as_array().expect("content"), label);
        }
        assert_eq!(log.spawned(), node["spawns"], "{label}: the gdbus/gsettings processes started");
    }

    /// Every recorded session, every tool call, whole, through the backend's own entry on the Linux path.
    #[tokio::test(start_paused = true)]
    #[allow(clippy::await_holding_lock)]
    async fn every_recorded_session_replays_through_the_backend() {
        let _serial = serial();
        let tool_calls = case("the tool calls every session is asked")["observed"].clone();
        let tool_calls = tool_calls.as_array().expect("tool calls");
        let (mut sessions, mut refused, mut rewritten) = (0, 0, 0);
        for recorded in cases().into_iter().filter(|case| case["case"].as_str().is_some_and(|name| name.starts_with("session ") && name != "session and desktop detection")) {
            let name = recorded["case"].as_str().expect("name");
            let observed = &recorded["observed"];
            let world = Arc::new(Mutex::new(World::of(&observed["world"])));
            let log = Arc::new(Log::default());
            let backend = backend(&world, &log, "s1", true);
            let calls = observed["calls"].as_array().expect("calls");
            assert_eq!(calls.len(), tool_calls.len(), "{name}");
            for (args, node) in tool_calls.iter().zip(calls) {
                reset_probe();
                refused += usize::from(node["result"].get("toolMeta").is_some());
                rewritten += usize::from(node["dispatched"][0].get("screen").is_some() && args["input"].get("screen").is_none());
                replay(&backend, &log, args, node, &format!("{name} / {args}")).await;
            }
            sessions += 1;
        }
        assert!(sessions >= 30 && refused > 500 && rewritten >= 3, "{sessions} sessions, {refused} refused, {rewritten} rewritten");
    }

    /// Another platform is never blocked and never rewritten: the preflight does not run, nothing is probed.
    #[tokio::test(start_paused = true)]
    #[allow(clippy::await_holding_lock)]
    async fn a_platform_that_is_not_linux_is_never_blocked_and_never_rewritten() {
        let _serial = serial();
        let recorded = case("a platform that is not linux is never blocked and never rewritten")["observed"].clone();
        let world = Arc::new(Mutex::new(World::of(&recorded["world"])));
        let log = Arc::new(Log::default());
        let backend = backend(&world, &log, "s1", false);
        for node in recorded["calls"].as_array().expect("calls") {
            replay(&backend, &log, &node["args"], node, &format!("{} / {}", node["platform"], node["args"])).await;
        }
    }

    /// The probe is the process's, not a session's, and it lives 3 seconds of the runtime's clock: two sessions inside the window share it
    /// (the concurrent calls of one instant too), and the first call after it asks again. The window passes by advancing that clock.
    #[tokio::test(start_paused = true)]
    #[allow(clippy::await_holding_lock)]
    async fn the_probe_is_shared_by_two_sessions_inside_3_seconds_and_asked_again_after() {
        let _serial = serial();
        let recorded = case("the probe is shared by two sessions inside 3 seconds and asked again after")["observed"].clone();
        let world = Arc::new(Mutex::new(World::of(&recorded["world"])));
        let log = Arc::new(Log::default());
        let (first, second) = (backend(&world, &log, "s1", true), backend(&world, &log, "s2", true));
        let mut now = 0;
        for step in recorded["steps"].as_array().expect("steps") {
            let at = step["at"].as_u64().expect("at");
            tokio::time::advance(Duration::from_millis(at - now)).await;
            now = at;
            world.lock().unwrap().writable = if step["uinput"].as_bool().expect("uinput") { vec!["/dev/uinput".to_owned()] } else { Vec::new() };
            let args = &recorded["call"];
            let runs = step["sessions"].as_array().expect("sessions").iter().map(|session| {
                let backend = if session == "s1" { &first } else { &second };
                backend.run(request(args).expect("a recorded call"), CancellationToken::new())
            });
            let got = futures::future::join_all(runs).await;
            let results = step["results"].as_array().expect("results");
            assert_eq!(got.len(), results.len(), "at {at}");
            for (got, node) in got.iter().zip(results) {
                match node.get("toolMeta") {
                    Some(_) => {
                        let Err(ComputerError::Failed { message, .. }) = got else { panic!("at {at}: refused by Node, got {got:?}") };
                        assert_eq!(format_tool_error(message, args), node["content"][0]["text"], "at {at}");
                    }
                    None => {
                        let parts = got.as_ref().unwrap_or_else(|error| panic!("at {at}: Node ran it, got {error:?}"));
                        assert_content("act", parts, node["content"].as_array().expect("content"), &format!("at {at}"));
                    }
                }
            }
            assert_eq!(got.iter().filter(|got| got.is_ok()).count() as u64, step["dispatches"].as_u64().expect("dispatches"), "dispatches at {at}");
            assert_eq!(log.spawned(), step["spawns"], "the probe's processes at {at}");
            log.requests();
        }
    }
}
