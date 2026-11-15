//! `Close-SessionState` and the chart-data Excel cleanup, case by case from `office-cleanup.test.mjs` (the PowerShell cleanup
//! test), with behavioural probe objects in place of that test's C# probes: a document that counts its closes and takes
//! one off its application's collection, an application that counts its quits.

use std::any::Any;
use std::cell::Cell;
use std::path::Path;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Instant;

use mixdog_office_com::com::Call;
use mixdog_office_com::com::ComError;
use mixdog_office_com::com::ComObject;
use mixdog_office_com::com::ItemSource;
use mixdog_office_com::com::Kind;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::Value;
use mixdog_office_com::identity::Ownership;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::ScriptedApplications;
use mixdog_office_com::platform::ExclusiveStream;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::platform::FontSet;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::RunningObject;
use mixdog_office_com::ps::json::emit_json;
use mixdog_office_com::state::ChartExcel;
use mixdog_office_com::state::Mode;
use mixdog_office_com::state::SessionState;
use mixdog_office_com::state::close_session_state;

const PID: i32 = 4242;
const START_TICKS: i64 = 638_000_000_000_000_000;

#[derive(Default)]
struct Counters {
    count: Cell<i64>,
    closes: Cell<u32>,
    quits: Cell<u32>,
    fail_close: Cell<bool>,
    fail_quit: Cell<bool>,
    alerts_off: Cell<bool>,
    saves: Cell<u32>,
}

#[derive(Clone, Copy)]
enum Part {
    Application,
    Collection,
    Document(&'static str),
}

struct Probe {
    shared: Rc<Counters>,
    part: Part,
    id: u64,
}

fn failure(message: &str) -> ComError {
    ComError { hresult: -2_146_233_088, inner_hresult: -2_146_233_088, message: message.to_owned(), inner_message: message.to_owned(), unknown_member: false }
}

fn unknown() -> ComError {
    ComError { hresult: -2_147_352_570, inner_hresult: -2_147_352_570, message: String::new(), inner_message: String::new(), unknown_member: true }
}

fn probe(shared: &Rc<Counters>, part: Part, id: u64) -> Obj {
    Obj::new(Rc::new(Probe { shared: shared.clone(), part, id }))
}

struct NoItems;

impl ItemSource for NoItems {
    fn next_item(&mut self) -> Result<Option<Value>, ComError> {
        Ok(None)
    }
}

impl ComObject for Probe {
    fn invoke(&self, call: &Call<'_>) -> Result<Value, ComError> {
        let shared = &self.shared;
        match (self.part, call.kind, call.member) {
            (Part::Application, Kind::Get, "Documents" | "Workbooks" | "Presentations") => Ok(Value::Dispatch(probe(shared, Part::Collection, 2))),
            (Part::Application, Kind::Call, "Quit") => {
                if shared.fail_quit.get() {
                    return Err(failure("quit rejected"));
                }
                shared.quits.set(shared.quits.get() + 1);
                Ok(Value::Empty)
            }
            (Part::Application, Kind::Put, "DisplayAlerts") => {
                shared.alerts_off.set(call.value == Some(&Value::Bool(false)));
                Ok(Value::Empty)
            }
            (Part::Collection, Kind::Get, "Count") => Ok(Value::I4(shared.count.get() as i32)),
            (Part::Document(format), Kind::Call, "Close") => {
                let expected: &[Value] = match format {
                    "pptx" => &[],
                    "docx" => &[Value::I4(0)],
                    _ => &[Value::Bool(false)],
                };
                if call.args != expected {
                    return Err(failure("unexpected save"));
                }
                if shared.fail_close.get() {
                    return Err(failure("close rejected"));
                }
                shared.closes.set(shared.closes.get() + 1);
                shared.count.set(shared.count.get() - 1);
                Ok(Value::Empty)
            }
            (Part::Document(_), Kind::Call, "Save") => {
                shared.saves.set(shared.saves.get() + 1);
                Ok(Value::Empty)
            }
            _ => Err(unknown()),
        }
    }

    fn enum_open(&self) -> Result<Box<dyn ItemSource>, ComError> {
        Ok(Box::new(NoItems))
    }

    fn same_object(&self, other: &dyn ComObject) -> bool {
        other.as_any().downcast_ref::<Probe>().is_some_and(|other| other.id == self.id && Rc::ptr_eq(&other.shared, &self.shared))
    }

    fn identity_key(&self) -> String {
        format!("rcw:{}", self.id)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// A platform whose process ends a fixed time after the wait for it began (an Office that shuts down in its own time).
struct Timed {
    inner: FakePlatform,
    exits_after_ms: u32,
}

impl Platform for Timed {
    fn try_get_running_file(&self, path: &str) -> Option<RunningObject> {
        self.inner.try_get_running_file(path)
    }
    fn register_excel_instances(&self) {
        self.inner.register_excel_instances();
    }
    fn process_id_for_window(&self, hwnd: i64) -> i32 {
        self.inner.process_id_for_window(hwnd)
    }
    fn foreground_window(&self) -> i64 {
        self.inner.foreground_window()
    }
    fn hide_visible_windows_for_process(&self, process_id: i32) -> i32 {
        self.inner.hide_visible_windows_for_process(process_id)
    }
    fn visible_window_count_for_process(&self, process_id: i32) -> i32 {
        self.inner.visible_window_count_for_process(process_id)
    }
    fn visible_window_descriptions_for_process(&self, process_id: i32) -> Vec<String> {
        self.inner.visible_window_descriptions_for_process(process_id)
    }
    fn find_window_by_class_and_title(&self, class: &str, title_part: &str) -> i64 {
        self.inner.find_window_by_class_and_title(class, title_part)
    }
    fn activate_window(&self, hwnd: i64) -> bool {
        self.inner.activate_window(hwnd)
    }
    fn hide_window(&self, hwnd: i64) -> bool {
        self.inner.hide_window(hwnd)
    }
    fn window_visible(&self, hwnd: i64) -> bool {
        self.inner.window_visible(hwnd)
    }
    fn process_ids_by_name(&self, name: &str) -> Vec<i32> {
        self.inner.process_ids_by_name(name)
    }
    fn process_start_ticks(&self, process_id: i32) -> i64 {
        self.inner.process_start_ticks(process_id)
    }
    fn process_exists(&self, process_id: i32) -> bool {
        self.inner.process_exists(process_id)
    }
    fn wait_for_exit(&self, process_id: i32, timeout_ms: u32) -> bool {
        if !self.inner.process_exists(process_id) {
            return true;
        }
        if timeout_ms >= self.exits_after_ms {
            self.inner.sleep(self.exits_after_ms);
            self.inner.kill_process(process_id);
            return true;
        }
        self.inner.sleep(timeout_ms);
        false
    }
    fn kill_process(&self, process_id: i32) -> bool {
        self.inner.kill_process(process_id)
    }
    fn installed(&self, prog_id: &str) -> bool {
        self.inner.installed(prog_id)
    }
    fn installed_office_fonts(&self) -> FontSet {
        self.inner.installed_office_fonts()
    }
    fn open_exclusive(&self, path: &Path) -> std::io::Result<Box<dyn ExclusiveStream>> {
        self.inner.open_exclusive(path)
    }
    fn temp_dir(&self) -> PathBuf {
        self.inner.temp_dir()
    }
    fn new_guid_n(&self) -> String {
        self.inner.new_guid_n()
    }
    fn sleep(&self, milliseconds: u32) {
        self.inner.sleep(milliseconds);
    }
    fn now(&self) -> Instant {
        self.inner.now()
    }
}

struct Fixture {
    state: SessionState,
    shared: Rc<Counters>,
}

fn make(format: &str, ownership: Ownership, owns_application: bool, others: i64) -> Fixture {
    let shared = Rc::new(Counters::default());
    shared.count.set(1 + others);
    let part = Part::Document(match format {
        "pptx" => "pptx",
        "docx" => "docx",
        _ => "xlsx",
    });
    let state = SessionState {
        id: "test".to_owned(),
        format: format.to_owned(),
        path: "C:\\work\\doc".to_owned(),
        mode: Mode::Background,
        ownership,
        owns_application,
        app_start_ticks: 0,
        app: Some(probe(&shared, Part::Application, 1)),
        document: Some(probe(&shared, part, 3)),
        visible: false,
        app_pid: 0,
        window_hwnd: 0,
        foreground_activated: false,
        foreground_before_action: 0,
        isolated_process: true,
        background_isolation_checks: 0,
        background_hidden_windows: 0,
        background_focus_restorations: 0,
        excel_dpi_repairs: 0,
        pptx_exports: 0,
        document_id: format!("{format}:c:\\work\\doc"),
        chart_excel: ChartExcel::default(),
    };
    Fixture { state, shared }
}

fn close(state: &mut SessionState, platform: &dyn Platform) -> mixdog_office_com::state::Cleanup {
    let applications = ScriptedApplications::new();
    let env = Env { platform, applications: &applications };
    close_session_state(state, false, &env).expect("no save, no failure to report")
}

#[test]
fn each_format_closes_its_document_once_with_its_own_signature_and_quits_once() {
    let platform = FakePlatform::new();
    for format in ["pptx", "docx", "xlsx"] {
        let mut fixture = make(format, Ownership::Owned, true, 0);
        let result = close(&mut fixture.state, &platform);
        assert!(result.ok(), "{format}: {result:?}");
        assert_eq!((fixture.shared.closes.get(), fixture.shared.quits.get()), (1, 1), "{format}");
        assert!(fixture.state.document.is_none() && fixture.state.app.is_none(), "{format}: both references are released");
    }
}

#[test]
fn a_shared_application_is_not_quit_and_is_reported_retained() {
    let platform = FakePlatform::new();
    let mut fixture = make("pptx", Ownership::Owned, false, 0);
    let result = close(&mut fixture.state, &platform);
    assert!(result.ok());
    assert_eq!((fixture.shared.closes.get(), fixture.shared.quits.get()), (1, 0));
    assert!(result.application_retained && !result.application_quit);
    assert!(fixture.state.app.is_none(), "the handle is still given back");
}

#[test]
fn an_attached_document_is_neither_closed_nor_is_its_application_quit() {
    let platform = FakePlatform::new();
    let mut fixture = make("pptx", Ownership::Attached, false, 0);
    let result = close(&mut fixture.state, &platform);
    assert!(result.ok() && result.detached);
    assert_eq!((fixture.shared.closes.get(), fixture.shared.quits.get()), (0, 0));
    assert!(fixture.state.document.is_none());
}

#[test]
fn another_open_document_keeps_the_application() {
    let platform = FakePlatform::new();
    let mut fixture = make("pptx", Ownership::Owned, true, 1);
    let result = close(&mut fixture.state, &platform);
    assert!(result.ok());
    assert_eq!((fixture.shared.count.get(), fixture.shared.quits.get()), (1, 0));
    assert!(result.application_retained);
}

#[test]
fn a_close_failure_is_reported_with_the_reference_kept_and_an_explicit_retry_succeeds() {
    let platform = FakePlatform::new();
    let mut fixture = make("pptx", Ownership::Owned, true, 0);
    fixture.shared.fail_close.set(true);
    let result = close(&mut fixture.state, &platform);
    assert!(!result.ok());
    assert_eq!(result.errors, ["Document close failed: close rejected"]);
    assert!(fixture.state.document.is_some() && fixture.state.app.is_some(), "kept for the retry");
    fixture.shared.fail_close.set(false);
    let retried = close(&mut fixture.state, &platform);
    assert!(retried.ok(), "{retried:?}");
    assert_eq!((fixture.shared.closes.get(), fixture.shared.quits.get()), (1, 1));
}

#[test]
fn a_quit_failure_is_reported_with_the_application_kept_and_an_explicit_retry_succeeds() {
    let platform = FakePlatform::new();
    let mut fixture = make("pptx", Ownership::Owned, true, 0);
    fixture.shared.fail_quit.set(true);
    let result = close(&mut fixture.state, &platform);
    assert!(!result.ok());
    assert_eq!(result.errors, ["Application quit failed: quit rejected"]);
    assert!(fixture.state.app.is_some());
    fixture.shared.fail_quit.set(false);
    let retried = close(&mut fixture.state, &platform);
    assert!(retried.ok(), "{retried:?}");
    assert_eq!(fixture.shared.quits.get(), 1);
}

fn owned_with_process(format: &str, mode: Mode) -> Fixture {
    let mut fixture = make(format, Ownership::Owned, true, 0);
    fixture.state.mode = mode;
    fixture.state.app_pid = PID;
    fixture.state.app_start_ticks = START_TICKS;
    fixture
}

#[test]
fn an_application_that_exits_two_and_a_half_seconds_after_quit_is_waited_for_not_killed() {
    let inner = FakePlatform::new();
    inner.add_process(PID, "EXCEL", START_TICKS);
    let platform = Timed { inner, exits_after_ms: 2500 };
    let mut fixture = owned_with_process("xlsx", Mode::Background);
    let result = close(&mut fixture.state, &platform);
    assert_eq!(result.process_exited, Some(true));
    assert!(!result.forced_process_cleanup, "a quitting application was killed instead of allowed to exit");
    assert!(result.ok() && result.errors.is_empty(), "{result:?}");
    assert_eq!(fixture.state.app_pid, 0, "the pid is forgotten once the process is gone");
}

#[test]
fn a_process_that_is_already_gone_is_reported_exited() {
    let platform = FakePlatform::new();
    let mut fixture = owned_with_process("docx", Mode::Visible);
    let result = close(&mut fixture.state, &platform);
    assert_eq!(result.process_exited, Some(true));
    assert!(result.ok());
}

#[test]
fn a_process_whose_start_time_changed_is_never_waited_for_or_killed() {
    let platform = FakePlatform::new();
    platform.add_process(PID, "WINWORD", START_TICKS + 1);
    let mut fixture = owned_with_process("docx", Mode::Background);
    let result = close(&mut fixture.state, &platform);
    assert_eq!(result.errors, ["Application process identity changed; forced cleanup refused."]);
    assert_eq!(result.process_exited, None);
    assert!(!result.forced_process_cleanup && !result.ok());
    assert!(platform.process_exists(PID), "not killed");
    assert_eq!(platform.slept_ms(), 0, "not waited for");
    assert_eq!(fixture.state.app_pid, PID);
}

#[test]
fn a_background_application_that_accepted_quit_but_stays_is_killed_and_a_visible_one_never() {
    let platform = FakePlatform::new();
    platform.add_process(PID, "POWERPNT", START_TICKS);
    let mut background = owned_with_process("pptx", Mode::Background);
    let result = close(&mut background.state, &platform);
    assert!(result.forced_process_cleanup, "{result:?}");
    assert_eq!(result.process_exited, Some(true), "the wait after the kill sees the process gone");
    assert!(result.ok(), "{result:?}");
    assert!(!platform.process_exists(PID), "killed");
    assert_eq!(platform.slept_ms(), 8000, "the 8 s wait ran out before the kill");

    let platform = FakePlatform::new();
    platform.add_process(PID, "POWERPNT", START_TICKS);
    let mut visible = owned_with_process("pptx", Mode::Visible);
    let result = close(&mut visible.state, &platform);
    assert!(!result.forced_process_cleanup);
    assert_eq!(result.errors, ["Owned Office application is still running after cleanup."]);
    assert!(platform.process_exists(PID), "a visible application is never killed");
}

#[test]
fn a_background_application_that_refused_quit_is_not_killed() {
    let platform = FakePlatform::new();
    platform.add_process(PID, "EXCEL", START_TICKS);
    let mut fixture = owned_with_process("xlsx", Mode::Background);
    fixture.shared.fail_quit.set(true);
    let result = close(&mut fixture.state, &platform);
    assert!(!result.forced_process_cleanup);
    assert!(platform.process_exists(PID));
}

#[test]
fn the_record_has_the_keys_of_the_script_in_its_order() {
    let platform = FakePlatform::new();
    let mut fixture = make("docx", Ownership::Owned, true, 0);
    let result = close(&mut fixture.state, &platform);
    assert_eq!(
        emit_json(&result.to_value()),
        "{\"ok\":true,\"documentClosed\":true,\"detached\":false,\"applicationQuit\":true,\"applicationRetained\":false,\"processExited\":null,\"forcedProcessCleanup\":false,\"errors\":[]}\r\n"
    );
}

#[test]
fn a_save_before_the_close_goes_through_the_document_and_a_failed_save_closes_nothing() {
    let platform = FakePlatform::new();
    let applications = ScriptedApplications::new();
    let env = Env { platform: &platform, applications: &applications };
    let mut fixture = make("xlsx", Ownership::Owned, true, 0);
    let result = close_session_state(&mut fixture.state, true, &env).expect("saved");
    assert_eq!(fixture.shared.saves.get(), 1);
    assert!(result.ok());

    let mut empty = make("xlsx", Ownership::Owned, true, 0);
    empty.state.document = None;
    let error = close_session_state(&mut empty.state, true, &env).expect_err("a save of no document is the null call");
    assert_eq!(error, "You cannot call a method on a null-valued expression.");
}

fn chart_excel(platform: &FakePlatform) -> (ChartExcel, Rc<Counters>) {
    platform.add_process(PID, "EXCEL", START_TICKS);
    let shared = Rc::new(Counters::default());
    let mut registry = ChartExcel::default();
    registry.insert_application("hwnd:77", probe(&shared, Part::Application, 9));
    registry.insert_application("hwnd:77", probe(&shared, Part::Application, 10));
    registry.add_process(PID);
    registry.add_process(PID);
    (registry, shared)
}

#[test]
fn the_chart_excel_applications_are_quit_released_and_a_survivor_is_killed() {
    let platform = FakePlatform::new();
    let (mut registry, shared) = chart_excel(&platform);
    assert_eq!(registry.process_ids(), [PID], "a process id is tracked once");
    let applications = ScriptedApplications::new();
    let env = Env { platform: &platform, applications: &applications };
    assert_eq!(registry.close(true, &env), 1, "a key already tracked is not tracked twice");
    assert!(shared.alerts_off.get());
    assert_eq!(shared.quits.get(), 1);
    assert!(!platform.process_exists(PID), "an Excel that outlived 500 ms is killed");
    assert!(registry.is_empty());
}

#[test]
fn without_quit_the_chart_excel_applications_are_only_released() {
    let platform = FakePlatform::new();
    let (mut registry, shared) = chart_excel(&platform);
    let applications = ScriptedApplications::new();
    let env = Env { platform: &platform, applications: &applications };
    assert_eq!(registry.close(false, &env), 1);
    assert_eq!(shared.quits.get(), 0);
    assert!(platform.process_exists(PID));
    assert!(registry.is_empty(), "forgotten all the same");
}
