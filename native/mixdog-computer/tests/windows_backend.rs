//! The Windows backend through the resident-helper protocol, against a window
//! this test creates and closes. Nothing here touches another window: the
//! fixture is topmost and never activated, and every input is delivered to it
//! as window messages or through accessibility.
#![cfg(windows)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Condvar, Mutex};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::*;

static CLICKS: AtomicUsize = AtomicUsize::new(0);
/// The fixture's own signal, raised after every click it counts and when its message pump ends
/// (the window is gone by then): what the test waits on instead of a timer.
static SIGNAL: Mutex<()> = Mutex::new(());
static CHANGED: Condvar = Condvar::new();

fn raise() {
    let _held = SIGNAL.lock().unwrap();
    CHANGED.notify_all();
}

/// Blocks until `ready` holds. The state is checked under the signal's lock and `raise` takes it
/// after changing the state, so a change between the check and the wait is not missed.
fn wait_until(ready: impl Fn() -> bool) {
    let mut held = SIGNAL.lock().unwrap();
    while !ready() {
        held = CHANGED.wait(held).unwrap();
    }
}
static EDIT: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

unsafe extern "system" fn fixture_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_COMMAND => {
            // BN_CLICKED from the button child.
            if (wparam.0 >> 16) as u32 == 0 {
                CLICKS.fetch_add(1, Ordering::SeqCst);
                raise();
                let _ = SetFocus(Some(HWND(EDIT.load(Ordering::SeqCst) as _)));
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
}

struct Fixture {
    window: isize,
    edit: isize,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Fixture {
    fn open(title: &str) -> Fixture {
        let title = title.to_string();
        let (ready, wait) = mpsc::channel();
        let thread = std::thread::spawn(move || unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let module = GetModuleHandleW(None).unwrap();
            let class = w!("MixdogComputerFixture");
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(fixture_proc),
                hInstance: module.into(),
                lpszClassName: class,
                hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(6 as _),
                ..Default::default()
            });
            let wide: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
            let window = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_NOACTIVATE,
                class,
                PCWSTR(wide.as_ptr()),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                140,
                140,
                460,
                260,
                None,
                None,
                Some(module.into()),
                None,
            )
            .unwrap();
            let edit = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("EDIT"),
                w!(""),
                WS_CHILD | WS_VISIBLE | WS_BORDER,
                10,
                10,
                300,
                28,
                Some(window),
                None,
                Some(module.into()),
                None,
            )
            .unwrap();
            let button = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("BUTTON"),
                w!("Press me"),
                WS_CHILD | WS_VISIBLE | WINDOW_STYLE(0),
                10,
                60,
                140,
                36,
                Some(window),
                None,
                Some(module.into()),
                None,
            )
            .unwrap();
            let _ = (button, ShowWindow(window, SW_SHOWNOACTIVATE));
            // Keyboard focus inside this window's own queue, as an app that was
            // used earlier keeps it while another window is in front.
            let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetActiveWindow(window);
            EDIT.store(edit.0 as isize, Ordering::SeqCst);
            let _ = SetFocus(Some(edit));
            ready.send((window.0 as isize, edit.0 as isize)).unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            raise();
        });
        let (window, edit) = wait.recv().unwrap();
        Fixture { window, edit, thread: Some(thread) }
    }

    fn edit_text(&self) -> String {
        let mut buffer = [0u16; 256];
        let length = unsafe { GetWindowTextW(HWND(self.edit as _), &mut buffer) };
        String::from_utf16_lossy(&buffer[..length as usize])
    }

    fn focused(&self) -> isize {
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        let thread = unsafe { GetWindowThreadProcessId(HWND(self.window as _), None) };
        unsafe { GetGUIThreadInfo(thread, &mut info) }.unwrap();
        info.hwndFocus.0 as isize
    }

    fn exists(&self) -> bool {
        unsafe { IsWindow(Some(HWND(self.window as _))) }.as_bool()
    }

    fn id(&self) -> String {
        format!("hwnd:0x{:X}", self.window)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.exists() {
            unsafe { PostMessageW(Some(HWND(self.window as _)), WM_CLOSE, WPARAM(0), LPARAM(0)).ok() };
            let _ = unsafe { DestroyWindow(HWND(self.window as _)) };
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Host {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: i64,
}

impl Host {
    fn start(marker: i64) -> Host {
        let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-computer"))
            .env("MIXDOG_COMPUTER_INPUT_MARKER", marker.to_string())
            .env("MIXDOG_COMPUTER_READ_ACTIONS", "list_windows,window_snapshot,snapshot,find,window_bounds,window_capture,window_integrity,ocr_status")
            .env("MIXDOG_COMPUTER_RETAIN_REF_ACTIONS", "snapshot,find,invoke,set_value,type,key,click")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Host { child, stdin, stdout, next: 1 }
    }

    fn call(&mut self, mut request: Value) -> Value {
        let id = self.next;
        self.next += 1;
        request["id"] = json!(id);
        writeln!(self.stdin, "{request}").unwrap();
        self.stdin.flush().unwrap();
        loop {
            let mut line = String::new();
            assert!(self.stdout.read_line(&mut line).unwrap() > 0, "host exited");
            if let Some(body) = line.strip_prefix("@@MIXCU@@") {
                let envelope: Value = serde_json::from_str(body.trim()).unwrap();
                assert_eq!(envelope["id"], json!(id));
                return envelope;
            }
        }
    }

    fn ok(&mut self, request: Value) -> Value {
        let envelope = self.call(request.clone());
        assert_eq!(envelope["ok"], json!(true), "{request} failed: {}", envelope["error"]);
        envelope["result"].clone()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn find_element(snapshot: &Value, role: &str) -> Value {
    snapshot["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|element| element["role"] == role)
        .unwrap_or_else(|| panic!("no {role} in {}", snapshot["text"]))
        .clone()
}

/// DS-COMP-1: the harness's observe/act/verify scenarios against a fixture
/// window, through the resident-helper protocol.
#[test]
fn windows_backend_serves_the_computer_protocol() {
    let title = format!("MixdogComputerFixture-{}", std::process::id());
    let fixture = Fixture::open(&title);
    let mut host = Host::start(4242);

    // Observation.
    let listing = host.ok(json!({ "action": "list_windows" }));
    let row = listing["windows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == json!(fixture.id()))
        .expect("fixture is listed");
    assert_eq!(row["title"], json!(title));
    assert_eq!(row["class_name"], json!("MixdogComputerFixture"));
    assert_eq!(row["pid"], json!(std::process::id()));

    let bounds = host.ok(json!({ "action": "window_bounds", "window_id": fixture.id() }));
    assert_eq!(bounds["width"], json!(460));
    assert!(bounds["client_width"].as_i64().unwrap() > 0);

    let integrity = host.ok(json!({ "action": "window_integrity", "window_id": fixture.id() }));
    assert_eq!(integrity["known"], json!(true));
    assert_eq!(integrity["higher"], json!(false));

    let capture = host.ok(json!({ "action": "window_capture", "window_id": fixture.id() }));
    assert_eq!(capture["capture_source"], json!("window_surface"));
    assert_eq!(capture["width"], json!(460));
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD
        .decode(capture["image_base64"].as_str().unwrap())
        .unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");

    let status = host.ok(json!({ "action": "ocr_status" }));
    assert!(status["available"].is_boolean());

    // Accessibility.
    let snapshot = host.ok(json!({ "action": "snapshot", "window_id": fixture.id() }));
    let edit = find_element(&snapshot, "Edit");
    let button = find_element(&snapshot, "Button");
    assert_eq!(edit["source"], json!("uia"));
    assert_eq!(button["name"], json!("Press me"));

    // Semantic actions.
    let set = host.ok(json!({ "action": "set_value", "ref": edit["ref"], "text": "semantic" }));
    assert_eq!(set["verified"], json!(true));
    assert_eq!(fixture.edit_text(), "semantic");
    let before = CLICKS.load(Ordering::SeqCst);
    let invoked = host.ok(json!({ "action": "invoke", "ref": button["ref"] }));
    assert_eq!(invoked["delivery_accepted"], json!(true));
    // Delivered by the fixture's own message pump, which raises its signal after counting it.
    wait_until(|| CLICKS.load(Ordering::SeqCst) > before);
    assert_eq!(CLICKS.load(Ordering::SeqCst), before + 1);

    // Background input, delivered as messages to the fixture alone.
    host.ok(json!({ "action": "set_value", "ref": edit["ref"], "text": "" }));
    assert_eq!(fixture.focused(), fixture.edit, "the fixture's own queue focuses its edit");
    let typed = host.ok(json!({ "action": "type", "window_id": fixture.id(), "text": "Hi 한글", "delivery": "background" }));
    assert_eq!(typed["delivery_accepted"], json!(true), "{typed}");
    assert_eq!(fixture.edit_text(), "Hi 한글");
    let keyed = host.ok(json!({ "action": "key", "window_id": fixture.id(), "keys": "{BACKSPACE 2}", "delivery": "background" }));
    assert_eq!(keyed["delivery_accepted"], json!(true), "{keyed}");
    assert_eq!(fixture.edit_text(), "Hi ");
    let rejected = host.call(json!({ "action": "key", "window_id": fixture.id(), "keys": "^a", "delivery": "background" }));
    assert_eq!(rejected["result"]["code"], json!("background_unsupported"), "{rejected}");
    assert_eq!(fixture.edit_text(), "Hi ", "a refused stream sends nothing");

    let before = CLICKS.load(Ordering::SeqCst);
    let clicked = host.ok(json!({
        "action": "click", "window_id": fixture.id(), "delivery": "background",
        "x": button["center_x"], "y": button["center_y"],
    }));
    assert_eq!(clicked["delivery_accepted"], json!(true), "{clicked}");
    // Delivered by the fixture's own message pump, which raises its signal after counting it.
    wait_until(|| CLICKS.load(Ordering::SeqCst) > before);
    assert_eq!(CLICKS.load(Ordering::SeqCst), before + 1);

    // Window operations.
    host.ok(json!({ "action": "move_window", "window_id": fixture.id(), "x": 160, "y": 160, "width": 480, "height": 280 }));
    let moved = host.ok(json!({ "action": "window_bounds", "window_id": fixture.id() }));
    assert_eq!((moved["x"].as_i64(), moved["width"].as_i64()), (Some(160), Some(480)));
    let minimized = host.ok(json!({ "action": "window_state", "window_id": fixture.id(), "state": "minimize" }));
    assert_eq!(minimized["verified"], json!(true));
    let restored = host.ok(json!({ "action": "window_state", "window_id": fixture.id(), "state": "restore" }));
    assert_eq!(restored["verified"], json!(true));
    host.ok(json!({ "action": "close_window", "window_id": fixture.id() }));
    // The pump ends (and raises) once the window is destroyed.
    wait_until(|| !fixture.exists());
    assert!(!fixture.exists(), "the fixture closed");
}

/// The one-shot cleanup from a fresh process succeeds with no host left, and
/// the probe reports a working desktop with an answering input observer.
#[test]
fn abort_cleanup_and_probe_run_from_a_fresh_process() {
    let status = Command::new(env!("CARGO_BIN_EXE_mixdog-computer"))
        .arg("--abort-cleanup")
        .env("MIXDOG_COMPUTER_INPUT_MARKER", "4343")
        .status()
        .unwrap();
    assert!(status.success());
    let probe = Command::new(env!("CARGO_BIN_EXE_mixdog-computer"))
        .arg("--probe")
        .output()
        .unwrap();
    let report: Value = serde_json::from_slice(&probe.stdout).unwrap();
    assert_eq!(report["platform"], json!("windows"));
    assert_eq!(report["observer_ready"], json!(true), "{report}");
    assert_eq!(report["accessibility"], json!("ready"));
    assert_eq!(report["background"], json!(true));
}