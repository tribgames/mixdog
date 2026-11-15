//! The session lifecycle against the replaying fake dispatch object and the scripted platform: open and create per format,
//! visible and background, attach, the refusals, the answers, and the close. Every call the port makes is compared with the
//! call log of its scenario, in order, and every line the host writes is compared with the line the script writes.
//!
//! The logs here are written by hand from `office-com-session-host.ps1`; the logs recorded from the PowerShell host against
//! Office (`recorder/scenarios/session.json`, run on a PC with Microsoft Office) are held to the same ports once they exist.

use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_fsio::Unlaned;
use mixdog_office_com::com::fake::Fake;
use mixdog_office_com::host::Emitter;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::ScriptedApplications;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::platform::FakeWindow;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::json::emit_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::SessionState;
use mixdog_office_com::state::close_session;
use mixdog_office_com::state::open_session_response;
use mixdog_office_com::state::open_session_state;
use serde_json::Value as Json;
use serde_json::json;

const START_TICKS: i64 = 638_000_000_000_000_000;

// ---------------------------------------------------------------------------------------------------------------------
// The call log of a scenario.

fn s(text: &str) -> Json {
    json!({"t": "str", "v": text})
}

fn i4(number: i32) -> Json {
    json!({"t": "i4", "v": number})
}

fn r4(number: f32) -> Json {
    json!({"t": "r4", "v": f64::from(number)})
}

fn b(flag: bool) -> Json {
    json!({"t": "bool", "v": flag})
}

fn obj(id: u64) -> Json {
    json!({"t": "obj", "v": id})
}

fn null() -> Json {
    json!({"t": "null"})
}

fn empty() -> Json {
    json!({"t": "empty"})
}

#[derive(Default)]
struct Log {
    lines: Vec<Json>,
}

impl Log {
    fn push(&mut self, mut line: Json) {
        line["seq"] = json!(self.lines.len() + 1);
        self.lines.push(line);
    }

    fn get(&mut self, id: u64, member: &str, result: Json) {
        self.push(json!({"obj": id, "kind": "get", "member": member, "flags": 2, "args": [], "result": result}));
    }

    fn get_with(&mut self, id: u64, member: &str, args: Vec<Json>, result: Json) {
        self.push(json!({"obj": id, "kind": "get", "member": member, "flags": 3, "args": args, "result": result}));
    }

    fn call(&mut self, id: u64, member: &str, args: Vec<Json>, result: Json) {
        self.push(json!({"obj": id, "kind": "call", "member": member, "flags": 3, "args": args, "result": result}));
    }

    fn call_error(&mut self, id: u64, member: &str, args: Vec<Json>, hresult: i32, message: &str) {
        let error = json!({"hresult": hresult, "inner_hresult": hresult, "message": message, "inner_message": message, "unknown_member": false});
        self.push(json!({"obj": id, "kind": "call", "member": member, "flags": 3, "args": args, "error": error}));
    }

    fn get_error(&mut self, id: u64, member: &str, hresult: i32, message: &str) {
        let error = json!({"hresult": hresult, "inner_hresult": hresult, "message": message, "inner_message": message, "unknown_member": false});
        self.push(json!({"obj": id, "kind": "get", "member": member, "flags": 2, "args": [], "error": error}));
    }

    fn put(&mut self, id: u64, member: &str, value: Json) {
        self.push(json!({"obj": id, "kind": "put", "member": member, "flags": 4, "args": [], "value": value, "result": empty()}));
    }

    fn put_with(&mut self, id: u64, member: &str, args: Vec<Json>, value: Json) {
        self.push(json!({"obj": id, "kind": "put", "member": member, "flags": 4, "args": args, "value": value, "result": empty()}));
    }

    fn end_of_enumeration(&mut self, id: u64) {
        self.push(json!({"obj": id, "kind": "enum-next", "member": "", "flags": 0, "args": [], "result": null}));
    }

    fn fake(&self) -> Fake {
        Fake::from_lines(&self.lines.iter().map(Json::to_string).collect::<Vec<_>>().join("\n"))
    }

    /// The calls of `Initialize-OwnedOfficeApplication` and of `New-HiddenApplication`.
    fn initialize(&mut self, app: u64, format: &str, visible: bool) {
        self.put(app, "DisplayAlerts", i4(0));
        self.put(app, "AutomationSecurity", i4(3));
        if format != "pptx" {
            self.put(app, "Visible", b(visible));
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The world a scenario runs in.

#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);

impl Write for Shared {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Shared {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()).expect("utf-8")
    }
}

struct World {
    platform: Rc<FakePlatform>,
    apps: ScriptedApplications,
    dir: PathBuf,
    stdout: Shared,
    stderr: Shared,
    out: Emitter,
}

impl World {
    fn new(name: &str) -> World {
        let dir = std::env::temp_dir().join(format!("mixdog-office-session-{}-{name}", std::process::id()));
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
        mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
        let (stdout, stderr) = (Shared::default(), Shared::default());
        let out = Emitter::new(Box::new(stdout.clone()), Box::new(stderr.clone()));
        World { platform: Rc::new(FakePlatform::new()), apps: ScriptedApplications::new(), dir, stdout, stderr, out }
    }

    /// An existing document of the scratch directory; its full path.
    fn file(&self, name: &str) -> String {
        let path = self.dir.join(name);
        mixdog_fsio::write(&Unlaned, &path, b"document").expect("a document");
        path.to_string_lossy().into_owned()
    }

    fn path(&self, name: &str) -> String {
        self.dir.join(name).to_string_lossy().into_owned()
    }

    fn open(&mut self, request: Json) -> Result<SessionState, String> {
        let env = Env { platform: &*self.platform, applications: &self.apps };
        open_session_state(&Unlaned, &env, &mut self.out, &payload::parse_payload(&request.to_string()).expect("a request"))
    }

    fn answer(&self, state: &mut SessionState) -> String {
        let env = Env { platform: &*self.platform, applications: &self.apps };
        let value = open_session_response(state, &env).expect("an answer");
        emit_json(&value).trim_end().to_owned()
    }

    fn close(&self, state: &mut SessionState, request: Json) -> (Value, bool) {
        let env = Env { platform: &*self.platform, applications: &self.apps };
        let closed = close_session(state, &env, &payload::parse_payload(&request.to_string()).expect("a request")).expect("an answer");
        (closed.result, closed.closed)
    }

    /// The application that appears with its first request for it: a new process and its (hidden) window.
    fn new_process(&self, process_id: i32, name: &'static str, hwnd: i64, class: &'static str, visible: bool) -> impl FnOnce() + 'static {
        let platform = self.platform.clone();
        move || {
            platform.add_process(process_id, name, START_TICKS);
            let mut window = FakeWindow::new(hwnd, process_id, class, "document");
            window.visible = visible;
            platform.add_window(window);
        }
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, &self.dir);
    }
}

fn quoted(text: &str) -> String {
    serde_json::to_string(text).expect("text")
}

fn isolation_report(checks: u32) -> String {
    format!(
        "{{\"strict\":true,\"isolatedProcess\":true,\"checks\":{checks},\"hiddenWindows\":0,\"focusRestorations\":0,\"observedVisibleWindows\":[],\"foregroundBefore\":0,\"foregroundAfter\":0,\"visibleOwnedWindows\":0,\"ownedForeground\":false}}"
    )
}

fn identity_line(pid: i32) -> String {
    format!("{{\"ok\":true,\"session\":\"s1\",\"ownership\":\"owned\",\"ownsApplication\":true,\"appPid\":{pid},\"lifecycle\":\"initializing\"}}\r\n")
}

// ---------------------------------------------------------------------------------------------------------------------
// Open.

/// The calls of opening an existing Word document in a new background application (process 500, window 9001).
fn word_background_open(log: &mut Log, path: &str) {
    log.get(1, "Hwnd", null());
    log.get(1, "HWND", null());
    log.initialize(1, "docx", false);
    log.get(1, "Documents", obj(2));
    log.call(2, "Open", vec![s(path)], obj(3));
    log.get(3, "ActiveWindow", obj(4));
    log.get(4, "Hwnd", i4(9001));
}

fn word_world(name: &str, file: &str) -> (World, String) {
    let world = World::new(name);
    let path = world.file(file);
    (world, path)
}

#[test]
fn a_background_word_document_opens_in_a_new_application_of_its_own_and_the_answer_says_so() {
    let (mut world, path) = word_world("word-open", "a.docx");
    let mut log = Log::default();
    word_background_open(&mut log, &path);
    let fake = log.fake();
    world.apps.queue_create_then("Word.Application", Ok(fake.object(1)), world.new_process(500, "WINWORD", 9001, "OpusApp", false));
    let mut state = world.open(json!({"action": "open_session", "session": "s1", "format": "docx", "path": path, "mode": "background"})).expect("opened");
    fake.finish();
    assert_eq!(world.stdout.text(), identity_line(500), "the identity line is written before the document is opened");
    assert_eq!((state.app_pid, state.window_hwnd, state.owns_application, state.app_start_ticks), (500, 9001, true, START_TICKS));
    let document_id = format!("docx:{}", path.to_lowercase());
    assert_eq!(state.document_id, document_id);
    let expected = format!(
        "{{\"ok\":true,\"session\":\"s1\",\"mode\":\"background\",\"backend\":\"microsoft-office-com\",\"ownership\":\"owned\",\"ownsApplication\":true,\"appPid\":500,\"windowHwnd\":9001,\"documentId\":{id},\"backgroundIsolation\":{report},\"opened\":true,\"visible\":false,\"foregroundActivated\":false,\"path\":{path}}}",
        id = quoted(&document_id),
        report = isolation_report(1),
        path = quoted(&path)
    );
    assert_eq!(world.answer(&mut state), expected);
    assert_eq!(world.stderr.text(), "");
}

#[test]
fn a_background_session_hides_what_an_owned_window_shows_and_counts_it() {
    let (mut world, path) = word_world("word-hide", "a.docx");
    let mut log = Log::default();
    word_background_open(&mut log, &path);
    let fake = log.fake();
    world.apps.queue_create_then("Word.Application", Ok(fake.object(1)), world.new_process(500, "WINWORD", 9001, "OpusApp", true));
    let mut state = world.open(json!({"action": "open_session", "session": "s1", "format": "docx", "path": path, "mode": "background"})).expect("opened");
    let answer = world.answer(&mut state);
    assert!(answer.contains("\"observedVisibleWindows\":[\"OpusApp|document\"]"), "{answer}");
    assert!(answer.contains("\"hiddenWindows\":1"), "{answer}");
    assert!(!world.platform.windows()[0].visible);
}

#[test]
fn a_window_that_stays_visible_fails_the_action_with_the_script_text() {
    let (mut world, path) = word_world("word-stuck", "a.docx");
    let mut log = Log::default();
    word_background_open(&mut log, &path);
    let fake = log.fake();
    world.apps.queue_create_then("Word.Application", Ok(fake.object(1)), world.new_process(500, "WINWORD", 9001, "OpusApp", true));
    let mut state = world.open(json!({"action": "open_session", "session": "s1", "format": "docx", "path": path, "mode": "background"})).expect("opened");
    // The owned process owns the foreground and the user's window is not the one that has it.
    world.platform.set_foreground(9001);
    state.foreground_before_action = 1234;
    let env = Env { platform: &*world.platform, applications: &world.apps };
    let error = open_session_response(&mut state, &env).expect_err("the owned window kept the foreground");
    assert_eq!(error, "Background Office isolation failed: 0 owned window(s) remain visible and ownedForeground=True.");
    assert_eq!((state.background_isolation_checks, state.background_hidden_windows, state.background_focus_restorations), (1, 1, 0));
}

#[test]
fn a_new_excel_workbook_is_created_saved_and_its_folder_made() {
    let mut world = World::new("excel-create");
    let path = world.path("new\\deeper\\b.xlsx");
    let mut log = Log::default();
    log.get(1, "Hwnd", i4(8001));
    log.initialize(1, "xlsx", false);
    log.get(1, "Workbooks", obj(2));
    log.call(2, "Add", vec![], obj(3));
    log.call(3, "SaveAs", vec![s(&path), i4(51)], empty());
    log.get(1, "Hwnd", i4(8001));
    let fake = log.fake();
    world.apps.queue_create_then("Excel.Application", Ok(fake.object(1)), world.new_process(600, "EXCEL", 8001, "XLMAIN", false));
    let mut state = world
        .open(json!({"action": "open_session", "session": "s1", "format": "xlsx", "path": path, "mode": "background", "create": true}))
        .expect("created");
    fake.finish();
    assert_eq!(state.app_pid, 600);
    assert!(mixdog_fsio::is_dir(&Unlaned, world.dir.join("new").join("deeper")));
    assert!(world.answer(&mut state).contains("\"documentId\":"));
}

#[test]
fn an_existing_create_target_is_refused_before_anything_starts_unless_overwrite_is_set() {
    let (mut world, path) = word_world("create-exists", "a.docx");
    let error = world
        .open(json!({"action": "open_session", "session": "s1", "format": "docx", "path": path, "mode": "background", "create": true}))
        .err()
        .expect("refused");
    assert_eq!(error, format!("Office create target already exists: {path}"));
    assert_eq!(world.apps.creations_left(), 0);
    assert_eq!(world.stdout.text(), "");
}

/// The calls of the portable template's defaults of a new Word document `doc`.
fn word_defaults(log: &mut Log, doc: u64) {
    let normal_format = |log: &mut Log| {
        log.get(doc, "Styles", obj(4));
        log.get_with(4, "Item", vec![i4(-1)], obj(5));
        log.get(5, "ParagraphFormat", obj(6));
    };
    normal_format(log);
    log.put(6, "WordWrap", b(true));
    normal_format(log);
    log.put(6, "LineSpacingRule", i4(5));
    log.put(6, "LineSpacing", r4((12.0_f64 * 259.0 / 240.0) as f32));
    log.put(6, "WidowControl", b(true));
    for (style, id, format) in [(-63, 7, 8), (-75, 9, 10)] {
        log.get(doc, "Styles", obj(4));
        log.get_with(4, "Item", vec![i4(style)], obj(id));
        log.get(id, "ParagraphFormat", obj(format));
        log.put(format, "Alignment", i4(0));
    }
    log.get(doc, "PageSetup", obj(11));
    for name in ["TopMargin", "BottomMargin", "LeftMargin", "RightMargin"] {
        log.put(11, name, r4(70.9));
    }
    log.put(11, "HeaderDistance", r4(35.45));
    log.put(11, "FooterDistance", r4(35.45));
    log.get(doc, "Styles", obj(4));
    log.get_with(4, "Item", vec![i4(-1)], obj(5));
    log.get(5, "Font", obj(12));
    for (k, (style, size, before)) in [(-2, 16, 12), (-3, 14, 10), (-4, 13, 8), (-5, 12, 8)].into_iter().enumerate() {
        let (heading, font, format) = (20 + k as u64, 30 + k as u64, 40 + k as u64);
        log.get(doc, "Styles", obj(4));
        log.get_with(4, "Item", vec![i4(style)], obj(heading));
        for name in ["Name", "NameFarEast"] {
            log.get(heading, "Font", obj(font));
            log.get(12, name, s("Malgun Gothic"));
            log.put(font, name, s("Malgun Gothic"));
        }
        log.get(heading, "Font", obj(font));
        log.put(font, "Bold", b(true));
        log.get(heading, "Font", obj(font));
        log.put(font, "Size", i4(size));
        log.get(heading, "ParagraphFormat", obj(format));
        log.put(format, "SpaceBefore", i4(before));
        log.get(heading, "ParagraphFormat", obj(format));
        log.put(format, "SpaceAfter", i4(6));
    }
    log.put_with(doc, "Compatibility", vec![i4(16)], b(true));
}

#[test]
fn a_new_word_document_gets_the_portable_templates_defaults_in_order_and_is_saved_with_saveas2() {
    let mut world = World::new("word-create");
    let path = world.path("c.docx");
    let mut log = Log::default();
    log.get(1, "Hwnd", null());
    log.get(1, "HWND", null());
    log.initialize(1, "docx", false);
    log.get(1, "Documents", obj(2));
    log.call(2, "Add", vec![], obj(3));
    word_defaults(&mut log, 3);
    log.call(3, "SaveAs2", vec![s(&path), i4(16)], empty());
    log.get(3, "ActiveWindow", obj(4));
    log.get(4, "Hwnd", i4(9001));
    let fake = log.fake();
    world.apps.queue_create_then("Word.Application", Ok(fake.object(1)), world.new_process(500, "WINWORD", 9001, "OpusApp", false));
    world
        .open(json!({"action": "open_session", "session": "s1", "format": "docx", "path": path, "mode": "background", "create": true}))
        .expect("created");
    fake.finish();
}

#[test]
fn saveas2_failing_falls_back_to_saveas_and_a_failing_save_closes_the_new_document() {
    let mut world = World::new("word-saveas");
    let path = world.path("d.docx");
    let mut log = Log::default();
    log.get(1, "Hwnd", null());
    log.get(1, "HWND", null());
    log.initialize(1, "docx", false);
    log.get(1, "Documents", obj(2));
    log.call(2, "Add", vec![], obj(3));
    word_defaults(&mut log, 3);
    log.call_error(3, "SaveAs2", vec![s(&path), i4(16)], -2_146_233_088, "no SaveAs2");
    log.call_error(3, "SaveAs", vec![s(&path), i4(16)], -2_146_233_088, "disk full");
    // The half-made document is closed (Close(0)), then the cleanup of the failed open: the application is empty and quits.
    log.call(3, "Close", vec![i4(0)], empty());
    log.get(1, "Documents", obj(2));
    log.get(2, "Count", i4(0));
    log.call(1, "Quit", vec![], empty());
    let fake = log.fake();
    world.apps.queue_create_then("Word.Application", Ok(fake.object(1)), world.new_process(500, "WINWORD", 9001, "OpusApp", false));
    let error = world
        .open(json!({"action": "open_session", "session": "s1", "format": "docx", "path": path, "mode": "background", "create": true}))
        .err()
        .expect("failed");
    fake.finish();
    assert_eq!(error, "disk full", "the cleanup was complete: nothing is appended");
    assert!(!world.platform.process_exists(500), "an isolated empty application that accepted Quit is ended");
    assert_eq!(world.stderr.text(), "");
}

#[test]
fn a_visible_deck_opens_with_its_window_found_and_the_foreground_taken() {
    let (mut world, path) = word_world("deck-visible", "e.pptx");
    world.platform.put_file(&path, b"deck");
    let mut log = Log::default();
    log.get(1, "Hwnd", i4(0));
    log.get(1, "HWND", i4(0));
    log.initialize(1, "pptx", true);
    log.get(1, "Presentations", obj(2));
    log.call(2, "Open", vec![s(&path), b(false), b(false), b(true)], obj(3));
    log.put(1, "Visible", b(true));
    log.get(3, "Windows", obj(4));
    log.get_with(4, "Item", vec![i4(1)], obj(5));
    log.get(5, "HWND", i4(7001));
    let fake = log.fake();
    world.apps.queue_create_then("PowerPoint.Application", Ok(fake.object(1)), world.new_process(700, "POWERPNT", 7001, "PPTFrameClass", true));
    let mut state = world.open(json!({"action": "open_session", "session": "s1", "format": "pptx", "path": path, "mode": "visible"})).expect("opened");
    fake.finish();
    assert!(state.foreground_activated && state.visible);
    assert_eq!((state.app_pid, state.window_hwnd), (700, 7001));
    assert_eq!(world.platform.foreground_window(), 7001);
    let answer = world.answer(&mut state);
    assert!(!answer.contains("backgroundIsolation") && answer.contains("\"mode\":\"visible\""), "{answer}");
    assert!(answer.contains("\"foregroundActivated\":true"), "{answer}");
}

// ---------------------------------------------------------------------------------------------------------------------
// Attach and the refusals.

fn xlsx_attach_world(name: &str) -> (World, String, Fake) {
    let (world, path) = word_world(name, "f.xlsx");
    world.platform.add_running_file(&path, "book");
    world.platform.add_process(800, "EXCEL", START_TICKS);
    world.platform.add_window(FakeWindow::new(5001, 800, "XLMAIN", "Book - Excel"));
    let mut log = Log::default();
    log.get(3, "FullName", s(&path));
    log.get(3, "Application", obj(1));
    log.get(1, "Hwnd", i4(5001));
    let fake = log.fake();
    world.apps.add_running("book", fake.object(3));
    (world, path, fake)
}

#[test]
fn attach_takes_the_exact_document_a_visible_application_holds_and_the_close_leaves_it_open() {
    let (mut world, path, fake) = xlsx_attach_world("attach");
    let mut state = world.open(json!({"action": "open_session", "session": "s1", "format": "xlsx", "path": path, "mode": "live"})).expect("attached");
    fake.finish();
    assert_eq!(world.platform.excel_registrations(), 1, "Excel is asked to register its workbooks first");
    assert_eq!(world.stdout.text(), "", "an attached session has no identity line: nothing is owned");
    assert_eq!((state.app_pid, state.owns_application, state.mode.as_str()), (800, false, "attach"));
    let answer = world.answer(&mut state);
    assert!(answer.contains("\"ownership\":\"attached\",\"ownsApplication\":false,\"appPid\":800"), "{answer}");

    let (closed, ok) = world.close(&mut state, json!({"action": "close_session", "session": "s1"}));
    assert!(ok);
    let text = emit_json(&closed);
    assert!(
        text.contains("\"cleanup\":{\"ok\":true,\"documentClosed\":false,\"detached\":true,\"applicationQuit\":false,\"applicationRetained\":true,\"processExited\":null,\"forcedProcessCleanup\":false,\"errors\":[]}"),
        "{text}"
    );
    assert!(text.contains("\"closed\":true"), "{text}");
    assert!(world.platform.process_exists(800), "the user's Excel is still running");
}

#[test]
fn attach_to_a_document_that_is_not_open_is_refused_after_ten_tries_a_tenth_of_a_second_apart() {
    let (mut world, path) = word_world("attach-refused", "g.xlsx");
    let error = world.open(json!({"action": "open_session", "session": "s1", "format": "xlsx", "path": path, "mode": "attach"})).err().expect("refused");
    assert_eq!(error, format!("The exact document is not registered as open in Microsoft Office: {path}"));
    assert_eq!(world.platform.slept_ms(), 1000);
    assert_eq!(world.stderr.text(), "");
}

#[test]
fn visible_refuses_to_open_a_duplicate_of_a_file_that_appears_open() {
    let (mut world, path) = word_world("duplicate", "h.docx");
    world.platform.set_locked(&path, true);
    let error = world.open(json!({"action": "open_session", "session": "s1", "format": "docx", "path": path, "mode": "visible"})).err().expect("refused");
    assert_eq!(error, format!("The document appears open but its exact COM object is unavailable; refusing to open a duplicate: {path}"));
}

#[test]
fn background_refuses_a_shared_application_before_opening_anything() {
    let (mut world, path) = word_world("shared", "i.docx");
    // The user's own Word is the only instance: COM hands out that one and no new process appears.
    world.platform.add_process(300, "WINWORD", START_TICKS);
    let mut log = Log::default();
    log.get(1, "Hwnd", null());
    log.get(1, "HWND", null());
    let fake = log.fake();
    world.apps.queue_create("Word.Application", Ok(fake.object(1)));
    let error = world.open(json!({"action": "open_session", "session": "s1", "format": "docx", "path": path, "mode": "background"})).err().expect("refused");
    fake.finish();
    assert_eq!(
        error,
        "Background Office refused a shared or unidentified application before opening the document (pid 0). Existing documents were not opened, hidden, or closed."
    );
    assert!(world.platform.process_exists(300), "the user's Word is untouched");
    assert_eq!(world.stdout.text(), "", "nothing was owned, so no identity line");
}

#[test]
fn the_requests_own_refusals_have_the_script_texts() {
    let mut world = World::new("requests");
    let path = world.path("missing.docx");
    let cases = [
        (json!({"session": " ", "format": "docx", "path": path, "mode": "background"}), "open_session requires session"),
        (json!({"session": "s", "format": "txt", "path": path, "mode": "background"}), "Unsupported Office session format: txt"),
        (json!({"session": "s", "format": "docx", "path": path, "mode": "hidden"}), "Unsupported Office session mode: hidden"),
        (json!({"session": "s", "format": "docx", "path": path, "mode": "attach", "create": true}), "create does not support attach mode"),
    ];
    for (request, expected) in cases {
        assert_eq!(world.open(request).err().expect("refused"), expected);
    }
    let missing = world.open(json!({"session": "s", "format": "docx", "path": path, "mode": "background"})).err().expect("refused");
    assert_eq!(missing, format!("Office document not found: {path}"));
    let empty = world.open(json!({"session": "s", "format": "docx", "path": "", "mode": "background"})).err().expect("refused");
    assert_eq!(empty, "Exception calling \"GetFullPath\" with \"1\" argument(s): \"The path is not of a legal form.\"");
}

#[test]
fn a_failed_open_is_cleaned_up_and_the_error_is_the_opens() {
    let (mut world, path) = word_world("open-fails", "j.docx");
    let mut log = Log::default();
    log.get(1, "Hwnd", null());
    log.get(1, "HWND", null());
    log.initialize(1, "docx", false);
    log.get(1, "Documents", obj(2));
    log.call_error(2, "Open", vec![s(&path)], -2_146_233_088, "Word cannot open it");
    log.get(1, "Documents", obj(2));
    log.get(2, "Count", i4(0));
    log.call(1, "Quit", vec![], empty());
    let fake = log.fake();
    world.apps.queue_create_then("Word.Application", Ok(fake.object(1)), world.new_process(500, "WINWORD", 9001, "OpusApp", false));
    let error = world.open(json!({"session": "s1", "format": "docx", "path": path, "mode": "background"})).err().expect("failed");
    fake.finish();
    assert_eq!(error, "Word cannot open it");
    assert_eq!(world.stdout.text(), identity_line(500));
    assert!(!world.platform.process_exists(500), "the application the host started is gone with the failed open");
}

// ---------------------------------------------------------------------------------------------------------------------
// Close.

/// An opened background Word session whose log goes on with `after`.
fn word_session(name: &str, after: impl FnOnce(&mut Log)) -> (World, SessionState, Fake, String) {
    let (mut world, path) = word_world(name, "k.docx");
    let mut log = Log::default();
    word_background_open(&mut log, &path);
    after(&mut log);
    let fake = log.fake();
    world.apps.queue_create_then("Word.Application", Ok(fake.object(1)), world.new_process(500, "WINWORD", 9001, "OpusApp", false));
    let state = world.open(json!({"session": "s1", "format": "docx", "path": path, "mode": "background"})).expect("opened");
    (world, state, fake, path)
}

fn close_log(log: &mut Log, save: bool) {
    if save {
        log.get(3, "TablesOfContents", obj(5));
        log.end_of_enumeration(5);
        log.call(3, "Save", vec![], empty());
    }
    log.call(3, "Close", vec![i4(0)], empty());
    log.get(1, "Documents", obj(2));
    log.get(2, "Count", i4(0));
    log.call(1, "Quit", vec![], empty());
}

fn close_answer(path: &str, saved: bool, cleanup: &str) -> String {
    format!(
        "{{\"ok\":true,\"session\":\"s1\",\"mode\":\"background\",\"backend\":\"microsoft-office-com\",\"ownership\":\"owned\",\"ownsApplication\":true,\"appPid\":500,\"windowHwnd\":9001,\"documentId\":{id},\"backgroundIsolation\":{report},\"closed\":true,\"saved\":{saved},\"path\":{path},\"cleanup\":{cleanup}}}",
        id = quoted(&format!("docx:{}", path.to_lowercase())),
        report = isolation_report(1),
        path = quoted(path)
    )
}

#[test]
fn close_with_save_saves_closes_quits_and_answers_the_cleanup_in_its_key_order() {
    let (world, mut state, fake, path) = word_session("close-save", |log| close_log(log, true));
    // The application ended by itself once it was told to quit.
    world.platform.kill_process(500);
    let (answer, closed) = world.close(&mut state, json!({"action": "close_session", "session": "s1", "save": true}));
    fake.finish();
    assert!(closed);
    let cleanup = "{\"ok\":true,\"documentClosed\":true,\"detached\":false,\"applicationQuit\":true,\"applicationRetained\":false,\"processExited\":true,\"forcedProcessCleanup\":false,\"errors\":[]}";
    assert_eq!(emit_json(&answer).trim_end(), close_answer(&path, true, cleanup));
    assert_eq!(state.app_pid, 0);
    assert!(state.document.is_none() && state.app.is_none());
}

#[test]
fn close_without_save_does_not_save_and_ends_a_background_application_that_accepted_quit_but_stays() {
    let (world, mut state, fake, path) = word_session("close-nosave", |log| close_log(log, false));
    let (answer, closed) = world.close(&mut state, json!({"action": "close_session", "session": "s1"}));
    fake.finish();
    assert!(closed);
    let cleanup = "{\"ok\":true,\"documentClosed\":true,\"detached\":false,\"applicationQuit\":true,\"applicationRetained\":false,\"processExited\":true,\"forcedProcessCleanup\":true,\"errors\":[]}";
    assert_eq!(emit_json(&answer).trim_end(), close_answer(&path, false, cleanup));
    assert_eq!(world.platform.slept_ms(), 8000, "the 8 s wait ran out first");
    assert!(!world.platform.process_exists(500));
}

#[test]
fn an_application_killed_before_close_leaves_the_state_for_a_retry_and_says_why() {
    let message = "The RPC server is unavailable. (Exception from HRESULT: 0x800706BA)";
    let (world, mut state, fake, _) = word_session("close-killed", |log| {
        log.call_error(3, "Close", vec![i4(0)], -2_147_023_174, message);
        log.get_error(1, "Documents", -2_147_023_174, message);
    });
    world.platform.kill_process(500);
    let (answer, closed) = world.close(&mut state, json!({"action": "close_session", "session": "s1"}));
    fake.finish();
    assert!(!closed);
    let text = emit_json(&answer);
    assert!(
        text.contains(&format!("\"error\":\"Office cleanup incomplete: Document close failed: {message}; Application document count unavailable: {message}\"")),
        "{text}"
    );
    assert!(text.starts_with("{\"ok\":false,") && text.contains("\"closed\":false"), "{text}");
    assert!(text.contains("\"documentClosed\":false,\"detached\":false,\"applicationQuit\":false,\"applicationRetained\":true,\"processExited\":null"), "{text}");
    assert!(state.document.is_some() && state.app.is_some(), "kept for a retry");
}
