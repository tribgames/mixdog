//! The Linux readiness rules, written from the rules themselves: which session and desktop an environment is, what is probed and in what
//! order, what each missing piece reports, which capabilities a command needs, the capture fallback, the probe cache, the real probes
//! over a scripted process runner, and the backend refusing before it dispatches.

use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessInfo;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnedProcess;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::desktop::computer_backend::ComputerConfig;
use crate::desktop::computer_backend::ProcessComputerBackend;

fn env(pairs: &[(&str, &str)]) -> Env {
    pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
}

fn command(value: Value) -> Map<String, Value> {
    value.as_object().expect("a command is an object").clone()
}

fn cap(state: State) -> Cap {
    Cap { state, fix: None, package: None, optional: false }
}

fn needs(fix: &str, package: Option<&str>, optional: bool) -> Cap {
    Cap { state: State::NeedsSetup, fix: Some(fix.to_owned()), package: package.map(str::to_owned), optional }
}

/// The probe cache is the process's: tests that read it run one at a time, each from a cleared cache.
async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let held = ONE.lock().await;
    reset_probe();
    held
}

/// A session whose answers are fixed and whose questions are written down in the order they were asked.
#[derive(Default)]
struct Stub {
    commands: Vec<&'static str>,
    writable: bool,
    bus: bool,
    helper_version: Option<u32>,
    installed: bool,
    enabled: bool,
    a11y: bool,
    asked: Mutex<Vec<String>>,
}

impl Stub {
    fn note(&self, question: impl Into<String>) {
        self.asked.lock().unwrap().push(question.into());
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

#[async_trait]
impl Probes for Stub {
    async fn can_write(&self, file: &str) -> bool {
        self.note(format!("write:{file}"));
        self.writable
    }
    async fn has_command(&self, name: &str) -> bool {
        self.note(format!("command:{name}"));
        self.commands.contains(&name)
    }
    async fn has_session_bus(&self) -> bool {
        self.note("bus");
        self.bus
    }
    async fn window_helper_version(&self) -> Option<u32> {
        self.note("helper-version");
        self.helper_version
    }
    async fn window_helper_status(&self) -> HelperStatus {
        self.note("helper-status");
        HelperStatus { installed: self.installed, enabled: self.enabled }
    }
    async fn accessibility_reachable(&self) -> bool {
        self.note("a11y");
        self.a11y
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

// --- the session and the desktop an environment is ---

#[test]
fn a_session_is_wayland_only_when_a_wayland_display_is_set_and_the_session_type_does_not_say_otherwise() {
    for (pairs, want) in [
        (vec![("WAYLAND_DISPLAY", "wayland-0")], "wayland"),
        (vec![("WAYLAND_DISPLAY", "wayland-0"), ("XDG_SESSION_TYPE", "wayland")], "wayland"),
        (vec![("WAYLAND_DISPLAY", "wayland-0"), ("XDG_SESSION_TYPE", "x11")], "x11"),
        (vec![("XDG_SESSION_TYPE", "wayland")], "x11"),
        (vec![("DISPLAY", ":0")], "x11"),
        (vec![], "x11"),
    ] {
        assert_eq!(detect_session(&env(&pairs)), want, "{pairs:?}");
    }
}

#[test]
fn a_desktop_is_named_by_its_compositor_socket_on_wayland_and_otherwise_by_the_desktop_name() {
    for (pairs, session, want) in [
        (vec![("SWAYSOCK", "/s"), ("XDG_CURRENT_DESKTOP", "GNOME")], "wayland", "sway"),
        (vec![("HYPRLAND_INSTANCE_SIGNATURE", "x"), ("XDG_CURRENT_DESKTOP", "GNOME")], "wayland", "hyprland"),
        (vec![("SWAYSOCK", "/s"), ("XDG_CURRENT_DESKTOP", "GNOME")], "x11", "gnome"),
        (vec![("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")], "x11", "gnome"),
        (vec![("XDG_CURRENT_DESKTOP", "KDE")], "wayland", "kde"),
        (vec![("XDG_CURRENT_DESKTOP", "Plasma")], "x11", "kde"),
        (vec![("XDG_CURRENT_DESKTOP", "sway")], "wayland", "sway"),
        (vec![("XDG_CURRENT_DESKTOP", "Hyprland")], "wayland", "hyprland"),
        (vec![("XDG_CURRENT_DESKTOP", "XFCE")], "x11", "other"),
        (vec![], "x11", "other"),
    ] {
        assert_eq!(detect_desktop(&env(&pairs), session), want, "{pairs:?} {session}");
    }
}

// --- what is probed, and what it makes of each capability ---

#[tokio::test(start_paused = true)]
async fn an_x11_session_without_a_display_has_nothing_to_drive_and_asks_nothing() {
    let stub = Stub::default();
    let ready = check_readiness(&env(&[("XDG_SESSION_TYPE", "x11")]), &stub).await;
    assert_eq!((ready.session.as_str(), ready.desktop.as_str()), ("x11", "other"));
    let caps = &ready.capabilities;
    for required in [&caps.capture, &caps.windows, &caps.accessibility, &caps.semantic_actions, &caps.pointer, &caps.keyboard] {
        assert_eq!(*required, cap(State::Unsupported));
    }
    assert_eq!((&caps.clipboard, &caps.ocr), (&Cap { optional: true, ..cap(State::Unsupported) }, &Cap { optional: true, ..cap(State::Unsupported) }));
    assert!(stub.asked().is_empty());
}

#[tokio::test(start_paused = true)]
async fn an_x11_display_needs_no_window_or_input_probe_and_asks_the_bus_then_tesseract() {
    let stub = Stub::default();
    let ready = check_readiness(&env(&[("DISPLAY", ":0")]), &stub).await;
    assert_eq!(stub.asked(), strings(&["bus", "command:tesseract"]));
    let caps = &ready.capabilities;
    assert_eq!((&caps.capture, &caps.windows, &caps.pointer, &caps.keyboard), (&cap(State::Ready), &cap(State::Ready), &cap(State::Ready), &cap(State::Ready)));
    // What cannot be probed is unknown, and semantic actions are exactly as ready as accessibility once windows are.
    assert_eq!((&caps.accessibility, &caps.semantic_actions), (&cap(State::Unknown), &cap(State::Unknown)));
    assert_eq!(caps.clipboard, Cap { optional: true, ..cap(State::Ready) });
    assert_eq!(caps.ocr, needs("install_package", Some("tesseract-ocr"), true));
}

#[tokio::test(start_paused = true)]
async fn accessibility_is_asked_only_once_the_bus_and_gdbus_are_there_and_is_missing_when_the_bus_does_not_answer() {
    let stub = Stub { commands: vec!["gdbus", "tesseract"], bus: true, a11y: true, ..Stub::default() };
    let ready = check_readiness(&env(&[("DISPLAY", ":0")]), &stub).await;
    assert_eq!(stub.asked(), strings(&["bus", "command:gdbus", "a11y", "command:tesseract"]));
    assert_eq!((&ready.capabilities.accessibility, &ready.capabilities.semantic_actions), (&cap(State::Ready), &cap(State::Ready)));
    assert_eq!(ready.capabilities.ocr, Cap { optional: true, ..cap(State::Ready) });

    let stub = Stub { commands: vec!["gdbus"], bus: true, ..Stub::default() };
    let ready = check_readiness(&env(&[("DISPLAY", ":0")]), &stub).await;
    assert_eq!(ready.capabilities.accessibility, needs("install_package", Some("at-spi2-core"), false));
    assert_eq!(ready.capabilities.semantic_actions, needs("install_package", Some("at-spi2-core"), false));

    let stub = Stub { bus: true, ..Stub::default() };
    check_readiness(&env(&[("DISPLAY", ":0")]), &stub).await;
    assert_eq!(stub.asked(), strings(&["bus", "command:gdbus", "command:tesseract"]), "without gdbus the bus is not asked");
}

#[tokio::test(start_paused = true)]
async fn a_sway_session_without_its_tools_is_asked_for_each_and_reports_what_to_install_or_allow() {
    let stub = Stub::default();
    let sway = env(&[("WAYLAND_DISPLAY", "wayland-0"), ("SWAYSOCK", "/s")]);
    let ready = check_readiness(&sway, &stub).await;
    assert_eq!(ready.desktop, "sway");
    assert_eq!(stub.asked(), strings(&["command:swaymsg", "bus", "write:/dev/uinput", "command:wl-copy", "command:tesseract"]));
    let caps = &ready.capabilities;
    assert_eq!(caps.windows, needs("install_package", Some("sway"), false));
    // Pixels on a desktop other than GNOME come through the portal, which cannot be probed without prompting.
    assert_eq!(caps.capture, cap(State::Unknown));
    assert_eq!(caps.semantic_actions, caps.windows, "semantic actions wait for window control first");
    assert_eq!((&caps.pointer, &caps.keyboard), (&needs("allow_input", None, false), &needs("allow_input", None, false)));
    assert_eq!(caps.clipboard, needs("install_package", Some("wl-clipboard"), true));
    assert_eq!(caps.ocr, needs("install_package", Some("tesseract-ocr"), true));

    let stub = Stub { commands: vec!["swaymsg", "wl-copy", "wl-paste", "tesseract"], writable: true, ..Stub::default() };
    let ready = check_readiness(&sway, &stub).await;
    assert_eq!(stub.asked(), strings(&["command:swaymsg", "bus", "write:/dev/uinput", "command:wl-copy", "command:wl-paste", "command:tesseract"]));
    let caps = &ready.capabilities;
    assert_eq!((&caps.windows, &caps.pointer, &caps.keyboard), (&cap(State::Ready), &cap(State::Ready), &cap(State::Ready)));
    assert_eq!((&caps.accessibility, &caps.semantic_actions), (&cap(State::Unknown), &cap(State::Unknown)));
    assert_eq!(caps.clipboard, Cap { optional: true, ..cap(State::Ready) });
}

#[tokio::test(start_paused = true)]
async fn a_hyprland_session_is_asked_for_hyprctl_and_names_hyprland_when_it_is_missing() {
    let hypr = env(&[("WAYLAND_DISPLAY", "wayland-0"), ("HYPRLAND_INSTANCE_SIGNATURE", "sig")]);
    let stub = Stub::default();
    let ready = check_readiness(&hypr, &stub).await;
    assert_eq!(stub.asked().first().map(String::as_str), Some("command:hyprctl"));
    assert_eq!(ready.capabilities.windows, needs("install_package", Some("hyprland"), false));
    let stub = Stub { commands: vec!["hyprctl"], ..Stub::default() };
    assert_eq!(check_readiness(&hypr, &stub).await.capabilities.windows, cap(State::Ready));
}

#[tokio::test(start_paused = true)]
async fn gnome_on_wayland_is_ready_only_when_the_shell_runs_a_new_enough_window_helper() {
    let gnome = env(&[("WAYLAND_DISPLAY", "wayland-0"), ("XDG_CURRENT_DESKTOP", "GNOME")]);
    let windows = |stub: Stub| {
        let gnome = gnome.clone();
        async move {
            let ready = check_readiness(&gnome, &stub).await;
            // Pixels come from the same extension, so capture is ready exactly when the helper is.
            assert_eq!(ready.capabilities.capture, ready.capabilities.windows);
            (ready.capabilities.windows, stub.asked().into_iter().take_while(|q| q != "bus").collect::<Vec<_>>())
        }
    };
    // Without gdbus nothing can be asked: unknown, not missing.
    assert_eq!(windows(Stub::default()).await, (cap(State::Unknown), strings(&["command:gdbus"])));
    let with_gdbus = |version, installed, enabled| Stub { commands: vec!["gdbus"], helper_version: version, installed, enabled, ..Stub::default() };
    assert_eq!(windows(with_gdbus(Some(2), true, true)).await, (needs("relogin", None, false), strings(&["command:gdbus", "helper-version"])));
    assert_eq!(windows(with_gdbus(Some(MIN_WINDOW_HELPER_VERSION), false, false)).await, (cap(State::Ready), strings(&["command:gdbus", "helper-version"])));
    assert_eq!(windows(with_gdbus(Some(MIN_WINDOW_HELPER_VERSION + 1), false, false)).await.0, cap(State::Ready));
    // The shell does not answer: a sign-in fixes an extension that is installed and enabled; otherwise it has to be enabled first.
    assert_eq!(windows(with_gdbus(None, true, true)).await, (needs("relogin", None, false), strings(&["command:gdbus", "helper-version", "helper-status"])));
    assert_eq!(windows(with_gdbus(None, true, false)).await.0, needs("enable_window_helper", None, false));
    assert_eq!(windows(with_gdbus(None, false, true)).await.0, needs("enable_window_helper", None, false));
}

#[tokio::test(start_paused = true)]
async fn a_desktop_with_no_window_control_on_wayland_is_unsupported_and_semantic_actions_follow_accessibility_once_windows_are_ready() {
    let kde = env(&[("WAYLAND_DISPLAY", "wayland-0"), ("XDG_CURRENT_DESKTOP", "KDE")]);
    let ready = check_readiness(&kde, &Stub::default()).await;
    assert_eq!(ready.capabilities.windows, cap(State::Unsupported));
    assert_eq!(ready.capabilities.semantic_actions, cap(State::Unsupported));
}

// --- which capabilities a command needs ---

#[test]
fn what_a_command_needs_follows_its_action_its_delivery_and_whether_it_names_a_window() {
    for (input, want) in [
        (json!({"action": "list_windows"}), vec!["windows"]),
        (json!({"action": "snapshot"}), vec!["windows", "accessibility"]),
        (json!({"action": "capture"}), vec!["capture", "windows"]),
        (json!({"action": "capture", "mode": "vision", "screen": 0}), vec!["capture"]),
        (json!({"action": "capture", "mode": "vision", "screen": 0, "app": "term"}), vec!["capture", "windows"]),
        (json!({"action": "capture", "mode": "ax"}), vec!["capture", "windows", "accessibility"]),
        (json!({"action": "screenshot"}), vec!["capture"]),
        (json!({"action": "zoom"}), vec!["capture"]),
        (json!({"action": "clipboard_read"}), vec!["clipboard"]),
        (json!({"action": "click"}), vec!["pointer"]),
        (json!({"action": "click", "window_id": "w"}), vec!["pointer", "windows"]),
        (json!({"action": "click", "window_id": ""}), vec!["pointer"]),
        (json!({"action": "type", "ref": "e1"}), vec!["accessibility", "semanticActions"]),
        (json!({"action": "type", "ref": "e1", "delivery": "foreground"}), vec!["accessibility", "keyboard"]),
        (json!({"action": "type"}), vec!["keyboard"]),
        (json!({"action": "invoke", "delivery": "foreground"}), vec!["pointer"]),
        (json!({"action": "invoke"}), vec!["semanticActions"]),
        (json!({"action": "invoke_menu"}), vec!["semanticActions", "windows"]),
        (json!({"action": "wait"}), vec![]),
        (json!({"action": "sequence", "window_id": "w", "steps": [{"action": "click"}, {"action": "type"}, "not a step", {"action": "click"}]}), vec!["windows", "pointer", "keyboard"]),
    ] {
        assert_eq!(required_capabilities(&command(input.clone())), want, "{input}");
    }
}

#[test]
fn a_capture_that_names_no_window_or_screen_is_the_foreground_one() {
    for (input, want) in [
        (json!({"action": "capture"}), true),
        (json!({"action": "capture", "screen": 0}), false),
        (json!({"action": "capture", "window": "x"}), false),
        (json!({"action": "capture", "app": "x"}), false),
        (json!({"action": "capture", "window_id": "w"}), false),
        (json!({"action": "screenshot"}), false),
    ] {
        assert_eq!(is_foreground_window_capture(&command(input.clone())), want, "{input}");
    }
}

// --- what a missing piece reports to the user ---

async fn refusal(session: &Env, stub: Stub, input: Value) -> Option<Refusal> {
    let (session, stub) = (session.clone(), Arc::new(stub));
    preflight(&command(input), move || async move { check_readiness(&session, &*stub).await }.boxed()).await
}

fn sway() -> Env {
    env(&[("WAYLAND_DISPLAY", "wayland-0"), ("SWAYSOCK", "/s")])
}

#[tokio::test(start_paused = true)]
async fn a_missing_window_tool_is_refused_with_what_to_install_before_anything_runs() {
    let _one = serial().await;
    let refused = refusal(&sway(), Stub::default(), json!({"action": "list_windows"})).await.expect("refused");
    assert_eq!(refused.code, "computer_capability_unavailable");
    assert_eq!(refused.capabilities(), vec!["windows"]);
    assert_eq!(
        refused.missing,
        vec![json!({
            "capability": "windows",
            "state": "needs_setup",
            "fix": "install_package",
            "package": "sway",
            "code": "wayland_window_control_unavailable",
            "message": "wayland_window_control_unavailable: the sway window tool is missing from PATH; install sway",
        })]
    );
    assert_eq!(
        refused.message,
        "computer_capability_unavailable: Computer Use cannot run this action on this Linux session (windows) — nothing was executed.\n- wayland_window_control_unavailable: the sway window tool is missing from PATH; install sway [windows]"
    );
}

#[tokio::test(start_paused = true)]
async fn input_that_cannot_be_written_is_refused_once_for_every_device_with_the_group_security_note() {
    let _one = serial().await;
    let ready_windows = || Stub { commands: vec!["swaymsg"], ..Stub::default() };
    let refused = refusal(&sway(), ready_windows(), json!({"action": "click"})).await.expect("refused");
    assert_eq!(
        refused.missing,
        vec![json!({
            "capability": "pointer",
            "state": "needs_setup",
            "fix": "allow_input",
            "code": "input_unavailable",
            "message": format!("{UINPUT_HINT}. {INPUT_GROUP_SECURITY_NOTE}"),
        })]
    );
    reset_probe();
    let sequence = json!({"action": "sequence", "window_id": "w", "steps": [{"action": "click"}, {"action": "type", "text": "x"}]});
    let refused = refusal(&sway(), ready_windows(), sequence).await.expect("refused");
    assert_eq!(refused.capabilities(), vec!["pointer", "keyboard"]);
    assert_eq!(
        refused.message,
        format!(
            "computer_capability_unavailable: Computer Use cannot run this action on this Linux session (pointer, keyboard) — nothing was executed.\n- {UINPUT_HINT}. {INPUT_GROUP_SECURITY_NOTE} [pointer, keyboard]"
        )
    );
}

#[tokio::test(start_paused = true)]
async fn only_what_needs_setup_or_is_unsupported_blocks_an_action() {
    let _one = serial().await;
    // Accessibility cannot be probed without a bus: unknown, so a snapshot is let through.
    let stub = Stub { commands: vec!["swaymsg"], writable: true, ..Stub::default() };
    assert_eq!(refusal(&sway(), stub, json!({"action": "snapshot"})).await, None);
}

#[tokio::test(start_paused = true)]
async fn a_capture_refused_for_its_window_says_a_screen_capture_still_works() {
    let _one = serial().await;
    let refused = refusal(&sway(), Stub::default(), json!({"action": "capture"})).await.expect("refused");
    assert_eq!(refused.capabilities(), vec!["windows"], "the portal capture is unknown, not missing");
    assert!(
        refused.message.ends_with("\nScreenshots that need no window still work: capture with mode=\"vision\" and a screen index (screen=0)."),
        "{}",
        refused.message
    );
}

#[tokio::test(start_paused = true)]
async fn a_session_with_no_display_refuses_everything_as_one_display_problem() {
    let _one = serial().await;
    let none = env(&[("XDG_SESSION_TYPE", "x11")]);
    let refused = refusal(&none, Stub::default(), json!({"action": "list_windows"})).await.expect("refused");
    assert_eq!(
        refused.missing,
        vec![json!({"capability": "windows", "state": "unsupported", "code": "display_unavailable", "message": DISPLAY_HINT})]
    );
    reset_probe();
    let refused = refusal(&none, Stub::default(), json!({"action": "capture"})).await.expect("refused");
    assert_eq!(
        refused.message,
        format!("computer_capability_unavailable: Computer Use cannot run this action on this Linux session (capture, windows) — nothing was executed.\n- {DISPLAY_HINT} [capture, windows]")
    );
}

#[tokio::test(start_paused = true)]
async fn a_semantic_action_is_refused_for_whichever_of_window_control_and_accessibility_is_missing() {
    let _one = serial().await;
    let gnome = env(&[("WAYLAND_DISPLAY", "wayland-0"), ("XDG_CURRENT_DESKTOP", "GNOME")]);
    let input = json!({"action": "invoke", "ref": "e1", "window_id": "w"});
    assert_eq!(required_capabilities(&command(input.clone())), vec!["accessibility", "semanticActions", "windows"]);
    // The window helper is loaded, the accessibility bus is not answering.
    let stub = Stub { commands: vec!["gdbus"], bus: true, helper_version: Some(MIN_WINDOW_HELPER_VERSION), writable: true, ..Stub::default() };
    let refused = refusal(&gnome, stub, input.clone()).await.expect("refused");
    assert_eq!(refused.capabilities(), vec!["accessibility", "semanticActions"]);
    assert_eq!(
        refused.message,
        format!("computer_capability_unavailable: Computer Use cannot run this action on this Linux session (accessibility, semanticActions) — nothing was executed.\n- {ACCESSIBILITY_HINT} [accessibility, semanticActions]")
    );
    // The window helper has not been loaded by the shell yet: the sign-in hint names the windows.
    reset_probe();
    let stub = Stub { commands: vec!["gdbus"], bus: true, a11y: true, installed: true, enabled: true, ..Stub::default() };
    let refused = refusal(&gnome, stub, input).await.expect("refused");
    assert_eq!(refused.capabilities(), vec!["semanticActions", "windows"]);
    assert!(refused.message.contains(&format!("- {WINDOW_HELPER_RELOGIN_HINT} [semanticActions, windows]")), "{}", refused.message);
}

// --- the capture fallback and the probe cache ---

async fn fallback(session: &Env, stub: Stub, input: Value) -> Option<Fallback> {
    let (session, stub) = (session.clone(), Arc::new(stub));
    capture_fallback(&command(input), move || async move { check_readiness(&session, &*stub).await }.boxed()).await
}

#[tokio::test(start_paused = true)]
async fn a_default_capture_without_window_control_becomes_a_screen_zero_capture_keeping_its_session_and_ocr() {
    let _one = serial().await;
    let got = fallback(&sway(), Stub::default(), json!({"action": "capture", "session_id": "s1", "include_ocr": true, "mode": "ax", "other": 1})).await;
    let got = got.expect("a fallback");
    assert_eq!(got.note, CAPTURE_FALLBACK_NOTE);
    assert_eq!(Value::Object(got.command), json!({"action": "capture", "mode": "vision", "screen": 0, "session_id": "s1", "include_ocr": true}));
    reset_probe();
    let got = fallback(&sway(), Stub::default(), json!({"action": "capture", "include_ocr": false})).await.expect("a fallback");
    assert_eq!(Value::Object(got.command), json!({"action": "capture", "mode": "vision", "screen": 0}));
}

#[tokio::test(start_paused = true)]
async fn a_capture_names_nothing_to_fall_back_from_when_it_names_a_window_when_windows_work_or_when_no_screen_can_be_taken() {
    let _one = serial().await;
    assert_eq!(fallback(&sway(), Stub::default(), json!({"action": "capture", "window": "x"})).await, None);
    reset_probe();
    assert_eq!(fallback(&sway(), Stub::default(), json!({"action": "capture", "screen": 0})).await, None);
    reset_probe();
    assert_eq!(fallback(&sway(), Stub { commands: vec!["swaymsg"], ..Stub::default() }, json!({"action": "capture"})).await, None);
    reset_probe();
    assert_eq!(fallback(&env(&[("XDG_SESSION_TYPE", "x11")]), Stub::default(), json!({"action": "capture"})).await, None);
}

#[tokio::test(start_paused = true)]
async fn one_probe_serves_every_call_within_its_life_and_a_cleared_cache_asks_again() {
    let _one = serial().await;
    let probes = Arc::new(AtomicUsize::new(0));
    let ask = |probes: Arc<AtomicUsize>| {
        move || {
            probes.fetch_add(1, Ordering::SeqCst);
            async { check_readiness(&sway(), &Stub::default()).await }.boxed()
        }
    };
    let list = command(json!({"action": "list_windows"}));
    assert!(preflight(&list, ask(probes.clone())).await.is_some());
    assert!(preflight(&list, ask(probes.clone())).await.is_some());
    assert!(capture_fallback(&command(json!({"action": "capture"})), ask(probes.clone())).await.is_some());
    assert_eq!(probes.load(Ordering::SeqCst), 1);
    reset_probe();
    assert!(preflight(&list, ask(probes.clone())).await.is_some());
    assert_eq!(probes.load(Ordering::SeqCst), 2);
}

// --- the real probes, over a scripted process runner ---

struct Feed(UnboundedReceiver<ProcessEvent>);

#[async_trait]
impl EventSource<ProcessEvent> for Feed {
    async fn next(&mut self) -> Option<ProcessEvent> {
        self.0.recv().await
    }
}

type Answer = Box<dyn Fn(&str, &[String]) -> (i32, String) + Send + Sync>;

/// Runs nothing: each program is answered with an exit code and stdout by `answer`, and written down as `[program, args…]`.
struct Script {
    answer: Answer,
    calls: Mutex<Vec<Vec<String>>>,
    feeds: Mutex<HashMap<String, UnboundedReceiver<ProcessEvent>>>,
}

impl Script {
    fn new(answer: impl Fn(&str, &[String]) -> (i32, String) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { answer: Box::new(answer), calls: Mutex::default(), feeds: Mutex::default() })
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl ProcessManager for Script {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Argv { program, args } = &request.command else { panic!("the probes start argv commands") };
        self.calls.lock().unwrap().push(std::iter::once(program.clone()).chain(args.iter().cloned()).collect());
        let (code, out) = (self.answer)(program, args);
        let (send, receive) = tokio::sync::mpsc::unbounded_channel();
        if !out.is_empty() {
            let _ = send.send(ProcessEvent::Output { seq: 0, stream: OutputStream::Stdout, bytes: out.into_bytes() });
        }
        let _ = send.send(ProcessEvent::Exited { seq: 1, exit: ProcessExit { status: ExitStatus::Code(code), killed: None } });
        self.feeds.lock().unwrap().insert(request.handle.0.clone(), receive);
        Ok(SpawnedProcess { handle: request.handle, pid: 1 })
    }

    fn subscribe(&self, handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let receive = self.feeds.lock().unwrap().remove(&handle.0).ok_or(ProcessError::UnknownHandle)?;
        Ok(Box::new(Feed(receive)))
    }

    async fn write_stdin(&self, _: &ProcessHandle, _: Vec<u8>) -> Result<(), ProcessError> {
        Err(ProcessError::StdinClosed)
    }

    fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Err(ProcessError::StdinClosed)
    }

    fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::NotPty)
    }

    fn kill(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Ok(())
    }

    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

const SH: &str = "/bin/sh";
const COMMAND_V: &str = "command -v \"$1\" >/dev/null 2>&1";
const TEST_W: &str = "test -w \"$1\"";
const TEST_BUS: &str = "test -e \"$1/bus\"";
const TEST_META: &str = "test -e \"$1/metadata.json\"";

fn call(items: &[&str]) -> Vec<String> {
    strings(items)
}

#[tokio::test(start_paused = true)]
async fn a_command_and_a_writable_file_are_asked_of_the_shell_and_answered_by_its_exit_code() {
    let manager = Script::new(|_, args| (i32::from(args[3] != "gdbus" && args[3] != "/dev/uinput"), String::new()));
    let probes = SystemProbes::new(manager.clone(), env(&[("PATH", "/usr/bin")]));
    assert!(probes.has_command("gdbus").await);
    assert!(!probes.has_command("tesseract").await);
    assert!(probes.can_write("/dev/uinput").await);
    assert!(!probes.can_write("/dev/other").await);
    assert_eq!(
        manager.calls(),
        vec![
            call(&[SH, "-c", COMMAND_V, "sh", "gdbus"]),
            call(&[SH, "-c", COMMAND_V, "sh", "tesseract"]),
            call(&[SH, "-c", TEST_W, "sh", "/dev/uinput"]),
            call(&[SH, "-c", TEST_W, "sh", "/dev/other"]),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn the_session_bus_is_there_when_its_address_is_set_or_its_socket_exists_and_is_not_asked_for_otherwise() {
    let manager = Script::new(|_, _| (0, String::new()));
    assert!(SystemProbes::new(manager.clone(), env(&[("DBUS_SESSION_BUS_ADDRESS", "unix:path=/x")])).has_session_bus().await);
    assert!(manager.calls().is_empty(), "the address needs no process");
    assert!(!SystemProbes::new(manager.clone(), env(&[])).has_session_bus().await);
    assert!(manager.calls().is_empty(), "with neither there is nothing to ask");
    assert!(SystemProbes::new(manager.clone(), env(&[("XDG_RUNTIME_DIR", "/run/user/1000")])).has_session_bus().await);
    assert_eq!(manager.calls(), vec![call(&[SH, "-c", TEST_BUS, "sh", "/run/user/1000"])]);
}

#[tokio::test(start_paused = true)]
async fn the_window_helper_version_is_read_from_the_shells_answer_and_nothing_else_is_a_version() {
    let ask = ["gdbus", "call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/io/mixdog/Windows", "--method", "org.freedesktop.DBus.Properties.Get", "io.mixdog.Windows", "Version"];
    for (answer, want) in [((0, "(<uint32 3>,)\n"), Some(3)), ((0, "(<uint32 12>,)"), Some(12)), ((1, ""), None), ((0, "(<'x'>,)"), None), ((0, ""), None)] {
        let manager = Script::new(move |_, _| (answer.0, answer.1.to_owned()));
        assert_eq!(SystemProbes::new(manager.clone(), env(&[])).window_helper_version().await, want, "{answer:?}");
        assert_eq!(manager.calls(), vec![call(&ask)]);
    }
}

#[tokio::test(start_paused = true)]
async fn the_extension_is_installed_when_its_metadata_is_in_the_users_or_the_systems_folder_and_enabled_when_the_shell_lists_it() {
    let user = "/home/u/.local/share/gnome-shell/extensions/mixdog-windows@mixdog.io";
    let system = "/usr/share/gnome-shell/extensions/mixdog-windows@mixdog.io";
    let answer = move |disabled: &'static str, present: &'static str| {
        move |program: &str, args: &[String]| match program {
            SH => (i32::from(args[3] != present), String::new()),
            "gsettings" if args[2] == "enabled-extensions" => (0, "['other@x', 'mixdog-windows@mixdog.io']".to_owned()),
            "gsettings" => (0, disabled.to_owned()),
            _ => (1, String::new()),
        }
    };
    let manager = Script::new(answer("false", system));
    let status = SystemProbes::new(manager.clone(), env(&[("HOME", "/home/u")])).window_helper_status().await;
    assert_eq!(status, HelperStatus { installed: true, enabled: true });
    assert_eq!(
        manager.calls(),
        vec![
            call(&[SH, "-c", TEST_META, "sh", user]),
            call(&[SH, "-c", TEST_META, "sh", system]),
            call(&["gsettings", "get", "org.gnome.shell", "enabled-extensions"]),
            call(&["gsettings", "get", "org.gnome.shell", "disable-user-extensions"]),
        ]
    );
    // User extensions switched off in the shell leave an installed extension disabled.
    let data = "/data/gnome-shell/extensions/mixdog-windows@mixdog.io";
    let manager = Script::new(answer("true", data));
    let status = SystemProbes::new(manager.clone(), env(&[("XDG_DATA_HOME", "/data"), ("HOME", "/home/u")])).window_helper_status().await;
    assert_eq!(status, HelperStatus { installed: true, enabled: false }, "XDG_DATA_HOME takes the place of ~/.local/share");
    assert_eq!(manager.calls()[0], call(&[SH, "-c", TEST_META, "sh", data]));
    // Nothing on disk: not installed, and the shell's settings are not read.
    let manager = Script::new(answer("false", "/nowhere"));
    let status = SystemProbes::new(manager.clone(), env(&[("HOME", "/home/u")])).window_helper_status().await;
    assert_eq!(status, HelperStatus { installed: false, enabled: false });
    assert!(manager.calls().iter().all(|call| call[0] == SH));
}

#[tokio::test(start_paused = true)]
async fn accessibility_is_reachable_when_the_a11y_bus_answers_its_address_call() {
    let manager = Script::new(|_, _| (0, "('unix:path=/run/user/1000/at-spi/bus',)\n".to_owned()));
    assert!(SystemProbes::new(manager.clone(), env(&[])).accessibility_reachable().await);
    assert_eq!(
        manager.calls(),
        vec![call(&["gdbus", "call", "--session", "--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus", "--method", "org.a11y.Bus.GetAddress"])]
    );
    let manager = Script::new(|_, _| (1, String::new()));
    assert!(!SystemProbes::new(manager, env(&[])).accessibility_reachable().await);
}

// --- the backend refuses on a Linux session before it dispatches anything ---

async fn run_on(manager: Arc<Script>, session: Env, input: Value) -> Result<Vec<mixdog_core_api::domain::tool::ToolPart>, ComputerError> {
    let backend = ProcessComputerBackend::new(ComputerConfig::new("helper", "s1"), manager).with_linux_session(session);
    backend.run(ComputerRequest { action: ComputerAction::List, input }, CancellationToken::new()).await
}

#[tokio::test(start_paused = true)]
async fn the_backend_refuses_a_command_on_a_session_with_no_display_without_asking_the_machine_anything() {
    let _one = serial().await;
    let manager = Script::new(|_, _| (0, String::new()));
    let Err(ComputerError::Failed { code, message }) = run_on(manager.clone(), env(&[("XDG_SESSION_TYPE", "x11")]), json!({"kind": "windows"})).await else {
        panic!("the call is refused")
    };
    assert_eq!(code, "computer_capability_unavailable");
    assert!(message.contains(&format!("- {DISPLAY_HINT} [windows]")), "{message}");
    assert!(manager.calls().is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_backend_probes_the_window_tool_of_the_compositor_and_refuses_when_it_is_missing() {
    let _one = serial().await;
    let manager = Script::new(|_, _| (1, String::new()));
    let Err(ComputerError::Failed { code, message }) = run_on(manager.clone(), sway(), json!({"kind": "windows"})).await else { panic!("the call is refused") };
    assert_eq!(code, "computer_capability_unavailable");
    assert!(message.contains("install sway [windows]"), "{message}");
    assert_eq!(manager.calls().first(), Some(&call(&[SH, "-c", COMMAND_V, "sh", "swaymsg"])), "the first thing asked is the window tool");
}
