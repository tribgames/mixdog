//! The actions between the request loop and the application code, against the replaying fake dispatch object and the
//! scripted platform: detect, the live and background one-shot paths, the batch transaction (Word's undo record, the
//! refusal of a batch that changed nothing, the undo of a failed one), the Excel checkpoint restore, the render wait, the
//! session actions of an owned background Word session, and the DPI repair on the bytes of a package.
//!
//! The call logs are written by hand from `office-com-host.ps1` and `office-com-session-host.ps1`; the logs recorded from the
//! PowerShell hosts against Office (`recorder/scenarios/actions.json`, run on a PC with Microsoft Office) are held to the same
//! ports once they exist. The readers and the editor here are stand-ins that call nothing: the actions are exercised without
//! the application code, as the recorded scenarios use the smallest operation of each format for the same reason.

use std::io::Cursor;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_fsio::Unlaned;
use mixdog_office_com::actions::Actions;
use mixdog_office_com::actions::OneShotEntry;
use mixdog_office_com::actions::document::render_document;
use mixdog_office_com::actions::document::restore_excel_checkpoint;
use mixdog_office_com::actions::dpi::repair_excel_page_setup_dpi;
use mixdog_office_com::actions::preview::PASSWORD_PROTECTED;
use mixdog_office_com::actions::preview::assert_preview_not_encrypted;
use mixdog_office_com::actions::session_actions::invoke_session_action;
use mixdog_office_com::com::Error;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::Result as ComResult;
use mixdog_office_com::com::fake::Fake;
use mixdog_office_com::drivers::Drivers;
use mixdog_office_com::format::EditContext;
use mixdog_office_com::format::FormatEditor;
use mixdog_office_com::format::FormatReader;
use mixdog_office_com::host::Emitter;
use mixdog_office_com::host::OneShotHandler;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::ScriptedApplications;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::platform::FakeWindow;
use mixdog_office_com::ps::ObjectKind;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::convert;
use mixdog_office_com::ps::json::emit_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::SessionState;
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

fn missing() -> Json {
    json!({"t": "missing"})
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

    fn put(&mut self, id: u64, member: &str, value: Json) {
        self.push(json!({"obj": id, "kind": "put", "member": member, "flags": 4, "args": [], "value": value, "result": empty()}));
    }

    fn end_of_enumeration(&mut self, id: u64) {
        self.push(json!({"obj": id, "kind": "enum-next", "member": "", "flags": 0, "args": [], "result": null}));
    }

    fn next(&mut self, id: u64, result: Json) {
        self.push(json!({"obj": id, "kind": "enum-next", "member": "", "flags": 0, "args": [], "result": result}));
    }

    fn fake(&self) -> Fake {
        Fake::from_lines(&self.lines.iter().map(Json::to_string).collect::<Vec<_>>().join("\n"))
    }

    /// `Find-OpenDocument` of Word: the application's documents, listed first, then each one's full name.
    fn find_word_document(&mut self, path: &str) {
        self.get(1, "Documents", obj(2));
        self.next(2, obj(3));
        self.end_of_enumeration(2);
        self.get(3, "FullName", s(path));
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Stand-ins for the application code.

struct Reader;

impl FormatReader for Reader {
    fn snapshot(&self, _env: &Env<'_>, _document: &Obj, _payload: &Value) -> ComResult<Value> {
        Ok(Value::object(ObjectKind::Ordered, vec![("paragraphs", Value::Int(1))]))
    }

    fn issues(&self, _env: &Env<'_>, _document: &Obj, _payload: &Value) -> ComResult<Value> {
        Ok(Value::Array(Vec::new()))
    }

    fn selection(&self, _env: &Env<'_>, _document: &Obj) -> ComResult<Value> {
        Err(Error::host("no selection"))
    }
}

/// An editor whose operations are named for what they answer: `ok` changes the document, `same` changes nothing, `boom` fails
/// and `none` answers nothing structured.
struct Editor;

impl FormatEditor for Editor {
    fn apply_operation(
        &self,
        _context: &mut EditContext<'_>,
        _document: &Obj,
        op: &Value,
        _live: bool,
        _allow_ui_activation: bool,
    ) -> ComResult<Option<Value>> {
        let name = convert::to_ps_string(&payload::property(op, "op"));
        match name.as_str() {
            "boom" => Err(Error::host("boom")),
            "none" => Ok(None),
            "same" | "replace_text" => Ok(Some(Value::object(
                ObjectKind::Ordered,
                vec![("op", Value::String(name.clone())), ("changed", Value::Bool(false))],
            ))),
            _ => Ok(Some(Value::object(ObjectKind::Ordered, vec![("op", Value::String(name.clone())), ("changed", Value::Bool(true))]))),
        }
    }

    fn operation_names(&self) -> &'static [&'static str] {
        &["ok", "same", "boom", "none", "replace_text"]
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

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-actions-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

fn request(value: Json) -> Value {
    payload::parse_payload(&value.to_string()).expect("a request")
}

fn line(value: &Value) -> String {
    emit_json(value).trim_end().to_owned()
}

fn emitter() -> (Emitter, Shared, Shared) {
    let (stdout, stderr) = (Shared::default(), Shared::default());
    (Emitter::new(Box::new(stdout.clone()), Box::new(stderr.clone())), stdout, stderr)
}

/// The one-shot handler of a Word-only world: Word and PowerPoint are installed, and the running Word is `active`.
fn one_shot<'a>(drivers: Drivers<'a>, active: Option<Obj>) -> OneShotEntry<'a, Unlaned> {
    let platform = FakePlatform::new();
    platform.install("Word.Application");
    platform.install("PowerPoint.Application");
    let apps = ScriptedApplications::new();
    if let Some(app) = active {
        apps.set_active("Word.Application", app);
    }
    OneShotEntry::new(&Unlaned, Box::new(platform), Box::new(apps), drivers)
}

fn word_drivers<'a>(readers: &'a [(&'a str, &'a dyn FormatReader)], editors: &'a [(&'a str, &'a dyn FormatEditor)]) -> Drivers<'a> {
    Drivers::new(readers, editors)
}

fn full_path_in_temp(name: &str) -> String {
    std::env::temp_dir().join(name).to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------------------------------------------------
// detect.

#[test]
fn detect_without_a_path_says_what_is_installed_and_running() {
    let fake = Log::default().fake();
    let mut handler = one_shot(word_drivers(&[], &[]), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let answer = handler.handle(&mut out, &request(json!({"action": "detect", "format": "docx"}))).expect("an answer");
    assert_eq!(
        line(&answer),
        "{\"ok\":true,\"backend\":\"microsoft-office-com\",\"available\":true,\"applications\":[\
         {\"format\":\"docx\",\"installed\":true,\"active\":true,\"documentOpen\":false},\
         {\"format\":\"xlsx\",\"installed\":false,\"active\":false,\"documentOpen\":false},\
         {\"format\":\"pptx\",\"installed\":true,\"active\":false,\"documentOpen\":false}]}"
    );
    fake.finish();
}

#[test]
fn detect_with_a_path_reports_the_document_open_for_that_format_only() {
    let path = full_path_in_temp("held.docx");
    let mut log = Log::default();
    log.find_word_document(&path);
    let fake = log.fake();
    let mut handler = one_shot(word_drivers(&[], &[]), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let answer = handler.handle(&mut out, &request(json!({"action": "detect", "format": "docx", "path": path}))).expect("an answer");
    assert!(line(&answer).contains("{\"format\":\"docx\",\"installed\":true,\"active\":true,\"documentOpen\":true}"), "{}", line(&answer));
    fake.finish();
}

// ---------------------------------------------------------------------------------------------------------------------
// The one-shot entry.

#[test]
fn an_application_that_is_not_installed_and_one_that_is_not_running_are_refused_with_the_scripts_texts() {
    let path = full_path_in_temp("a.docx");
    let (mut out, _, _) = emitter();
    let mut handler = one_shot(word_drivers(&[], &[]), None);
    let refused = handler.handle(&mut out, &request(json!({"action": "snapshot", "format": "xlsx", "path": path}))).unwrap_err();
    assert_eq!(refused, "Microsoft Office application for .xlsx is not installed");
    let refused = handler.handle(&mut out, &request(json!({"action": "snapshot", "format": "docx", "path": path, "mode": "live"}))).unwrap_err();
    assert_eq!(refused, "No running Microsoft Office application for .docx");
}

#[test]
fn a_live_request_for_a_document_the_application_does_not_hold_is_refused() {
    let path = full_path_in_temp("absent.docx");
    let mut log = Log::default();
    log.get(1, "Documents", obj(2));
    log.end_of_enumeration(2);
    let fake = log.fake();
    let mut handler = one_shot(word_drivers(&[], &[]), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let refused = handler.handle(&mut out, &request(json!({"action": "snapshot", "format": "docx", "path": path, "mode": "live"}))).unwrap_err();
    assert_eq!(refused, format!("The exact document is not open in Microsoft Office: {path}"));
    fake.finish();
}

#[test]
fn a_live_snapshot_answers_the_readers_value_and_leaves_the_users_document_open() {
    let path = full_path_in_temp("live.docx");
    let mut log = Log::default();
    log.find_word_document(&path);
    let fake = log.fake();
    let readers: [(&str, &dyn FormatReader); 1] = [("docx", &Reader)];
    let mut handler = one_shot(word_drivers(&readers, &[]), Some(fake.object(1)));
    let (mut out, stdout, stderr) = emitter();
    let answer = handler.handle(&mut out, &request(json!({"action": "snapshot", "format": "docx", "path": path, "mode": "live"}))).expect("an answer");
    assert_eq!(line(&answer), "{\"ok\":true,\"backend\":\"microsoft-office-com\",\"mode\":\"live\",\"value\":{\"paragraphs\":1}}");
    handler.finish(&mut out);
    fake.finish();
    assert_eq!((stdout.text(), stderr.text()), (String::new(), String::new()), "a live document is neither closed nor quit");
}

#[test]
fn a_live_save_rebuilds_the_tables_of_contents_then_saves() {
    let path = full_path_in_temp("save.docx");
    let mut log = Log::default();
    log.find_word_document(&path);
    log.get(3, "TablesOfContents", null());
    log.call(3, "Save", vec![], empty());
    let fake = log.fake();
    let mut handler = one_shot(word_drivers(&[], &[]), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let answer = handler.handle(&mut out, &request(json!({"action": "save", "format": "docx", "path": path, "mode": "live"}))).expect("an answer");
    assert_eq!(line(&answer), format!("{{\"ok\":true,\"backend\":\"microsoft-office-com\",\"mode\":\"live\",\"saved\":true,\"path\":{}}}", json!(path)));
    fake.finish();
}

#[test]
fn an_unknown_action_is_refused_with_the_scripts_text_after_the_document_was_found() {
    let path = full_path_in_temp("live.docx");
    let mut log = Log::default();
    log.find_word_document(&path);
    let fake = log.fake();
    let mut handler = one_shot(word_drivers(&[], &[]), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let refused = handler.handle(&mut out, &request(json!({"action": "frobnicate", "format": "docx", "path": path, "mode": "live"}))).unwrap_err();
    assert_eq!(refused, "Unsupported Office host action: frobnicate");
    fake.finish();
}

// ---------------------------------------------------------------------------------------------------------------------
// Apply-Operations, through a live one-shot Word batch.

/// The calls that begin a live Word batch on a saved document (`Saved` read, the undo record started).
fn word_batch_start(log: &mut Log) {
    log.get(3, "Saved", b(true));
    log.get(3, "Application", obj(1));
    log.get(1, "UndoRecord", obj(5));
    log.call(5, "StartCustomRecord", vec![s("Mixdog Office transaction")], empty());
}

fn live_batch(path: &str, operations: Json, extra: Json) -> Value {
    let mut body = json!({"action": "batch", "format": "docx", "path": path, "mode": "live", "operations": operations});
    if let (Some(map), Some(more)) = (body.as_object_mut(), extra.as_object()) {
        for (key, value) in more {
            map.insert(key.clone(), value.clone());
        }
    }
    request(body)
}

#[test]
fn a_live_word_batch_is_one_undo_record_and_reports_one_undo_unit() {
    let path = full_path_in_temp("batch.docx");
    let mut log = Log::default();
    log.find_word_document(&path);
    word_batch_start(&mut log);
    log.call(5, "EndCustomRecord", vec![], empty());
    let fake = log.fake();
    let editors: [(&str, &dyn FormatEditor); 1] = [("docx", &Editor)];
    let mut handler = one_shot(word_drivers(&[], &editors), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let answer = handler.handle(&mut out, &live_batch(&path, json!([{"op": "ok"}]), json!({}))).expect("an answer");
    assert_eq!(
        line(&answer),
        "{\"ok\":true,\"backend\":\"microsoft-office-com\",\"mode\":\"live\",\"saved\":false,\"results\":[{\"op\":\"ok\",\"changed\":true}],\"undoUnits\":1}"
    );
    fake.finish();
}

#[test]
fn a_failed_word_batch_that_changed_something_is_undone_and_named_for_the_failing_operation() {
    let path = full_path_in_temp("fail.docx");
    let mut log = Log::default();
    log.find_word_document(&path);
    word_batch_start(&mut log);
    log.call(5, "EndCustomRecord", vec![], empty());
    log.call(3, "Undo", vec![i4(1)], empty());
    let fake = log.fake();
    let editors: [(&str, &dyn FormatEditor); 1] = [("docx", &Editor)];
    let mut handler = one_shot(word_drivers(&[], &editors), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let failure = handler.handle(&mut out, &live_batch(&path, json!([{"op": "ok"}, {"op": "boom"}]), json!({}))).unwrap_err();
    assert!(failure.starts_with("boom failed at apply.rs:") && failure.ends_with(": boom"), "{failure}");
    fake.finish();
}

#[test]
fn a_batch_that_changed_nothing_is_refused_with_the_phrase_that_matched_nothing_and_takes_nothing_back() {
    let path = full_path_in_temp("same.docx");
    let mut log = Log::default();
    log.find_word_document(&path);
    word_batch_start(&mut log);
    log.call(5, "EndCustomRecord", vec![], empty());
    // The batch touched nothing, so Undo(1) is not sent: it would take back the batch before this one.
    log.get(3, "Saved", b(true));
    let fake = log.fake();
    let editors: [(&str, &dyn FormatEditor); 1] = [("docx", &Editor)];
    let mut handler = one_shot(word_drivers(&[], &editors), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let failure = handler
        .handle(&mut out, &live_batch(&path, json!([{"op": "replace_text", "find": "hello"}]), json!({"requireChanges": true})))
        .unwrap_err();
    let expected = "replace_text produced no change (\"hello\" appears nowhere; read the wording as written with action:query and a word from it)";
    assert!(failure.starts_with("replace_text failed at apply.rs:") && failure.ends_with(&format!(": {expected}")), "{failure}");
    fake.finish();
}

#[test]
fn allow_no_change_lets_an_unchanged_operation_through_and_leaves_no_undo_unit() {
    let path = full_path_in_temp("allow.docx");
    let mut log = Log::default();
    log.find_word_document(&path);
    word_batch_start(&mut log);
    log.call(5, "EndCustomRecord", vec![], empty());
    let fake = log.fake();
    let editors: [(&str, &dyn FormatEditor); 1] = [("docx", &Editor)];
    let mut handler = one_shot(word_drivers(&[], &editors), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let answer = handler
        .handle(&mut out, &live_batch(&path, json!([{"op": "same", "allowNoChange": true}]), json!({"requireChanges": true})))
        .expect("an answer");
    assert!(line(&answer).ends_with("\"results\":[{\"op\":\"same\",\"changed\":false}],\"undoUnits\":0}"), "{}", line(&answer));
    fake.finish();
}

#[test]
fn an_operation_that_answers_nothing_structured_fails_the_batch() {
    let path = full_path_in_temp("none.docx");
    let mut log = Log::default();
    log.find_word_document(&path);
    word_batch_start(&mut log);
    log.call(5, "EndCustomRecord", vec![], empty());
    log.get(3, "Saved", b(true));
    let fake = log.fake();
    let editors: [(&str, &dyn FormatEditor); 1] = [("docx", &Editor)];
    let mut handler = one_shot(word_drivers(&[], &editors), Some(fake.object(1)));
    let (mut out, _, _) = emitter();
    let failure = handler.handle(&mut out, &live_batch(&path, json!([{"op": "none"}]), json!({}))).unwrap_err();
    assert!(failure.starts_with("none failed at apply.rs:") && failure.ends_with(": none returned no structured operation result"), "{failure}");
}

// ---------------------------------------------------------------------------------------------------------------------
// Document actions.

fn actions<'a>(platform: &'a FakePlatform, apps: &'a ScriptedApplications, drivers: Drivers<'a>) -> Actions<'a, Unlaned> {
    Actions { env: Env { platform, applications: apps }, proof: &Unlaned, drivers }
}

#[test]
fn a_workbook_is_restored_from_its_checkpoint_sheet_by_sheet_with_alerts_put_back() {
    let mut log = Log::default();
    // The book is object 3; its application 1; the checkpoint opens as 11.
    log.get(3, "Application", obj(1));
    log.get(1, "DisplayAlerts", b(true));
    log.put(1, "DisplayAlerts", b(false));
    log.get(1, "Workbooks", obj(10));
    log.call(10, "Open", vec![s("C:\\cp.xlsx"), null(), b(true)], obj(11));
    log.get(3, "Worksheets", obj(20));
    log.next(20, obj(21));
    log.next(20, obj(22));
    log.end_of_enumeration(20);
    log.get(3, "Worksheets", obj(20));
    log.call(20, "Add", vec![], obj(23));
    log.put(23, "Name", s("__MixdogRestoref4c30000"));
    log.call(21, "Delete", vec![], empty());
    log.call(22, "Delete", vec![], empty());
    log.get(11, "Worksheets", obj(30));
    log.next(30, obj(31));
    log.end_of_enumeration(30);
    log.get(3, "Worksheets", obj(20));
    log.get(3, "Worksheets", obj(20));
    log.get(20, "Count", i4(1));
    log.get_with(20, "Item", vec![i4(1)], obj(24));
    log.call(31, "Copy", vec![missing(), obj(24)], empty());
    log.call(23, "Delete", vec![], empty());
    log.put(3, "Saved", b(false));
    log.call(11, "Close", vec![b(false)], empty());
    log.put(1, "DisplayAlerts", b(true));
    let fake = log.fake();
    let (platform, apps) = (FakePlatform::new(), ScriptedApplications::new());
    let actions = actions(&platform, &apps, word_drivers(&[], &[]));
    restore_excel_checkpoint(&actions, &fake.object(3), "C:\\cp.xlsx").expect("restored");
    fake.finish();
}

#[test]
fn a_rendered_file_is_waited_for_until_its_size_is_seen_twice() {
    let dir = scratch("render");
    let output = dir.join("deck.pdf").to_string_lossy().into_owned();
    mixdog_fsio::write(&Unlaned, &output, b"%PDF").expect("a file");
    let mut log = Log::default();
    log.call(1, "SaveCopyAs", vec![s(&output), i4(32)], empty());
    let fake = log.fake();
    let (platform, apps) = (FakePlatform::new(), ScriptedApplications::new());
    let actions = actions(&platform, &apps, word_drivers(&[], &[]));
    render_document(&actions, &fake.object(1), "pptx", &output).expect("rendered");
    fake.finish();
    assert_eq!(platform.slept_ms(), 150, "the first look sees the size, the second sees it again");
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}

#[test]
fn a_render_that_never_appears_fails_after_thirty_seconds_with_the_scripts_text() {
    let dir = scratch("render-missing");
    let output = dir.join("none.pdf").to_string_lossy().into_owned();
    let mut log = Log::default();
    log.call(1, "ExportAsFixedFormat", vec![s(&output), i4(17)], empty());
    let fake = log.fake();
    let (platform, apps) = (FakePlatform::new(), ScriptedApplications::new());
    let actions = actions(&platform, &apps, word_drivers(&[], &[]));
    let failure = render_document(&actions, &fake.object(1), "docx", &output).unwrap_err();
    assert_eq!(failure, format!("Rendered PDF did not appear at {output} within 30 seconds."));
    assert!(platform.slept_ms() >= 30_000);
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}

#[test]
fn a_workbook_render_fits_only_the_sheets_without_a_fit_of_their_own_and_puts_each_page_setup_back() {
    let dir = scratch("render-xlsx");
    let output = dir.join("book.pdf").to_string_lossy().into_owned();
    mixdog_fsio::write(&Unlaned, &output, b"%PDF").expect("a file");
    let mut log = Log::default();
    log.get(1, "Worksheets", obj(2));
    log.next(2, obj(3));
    log.next(2, obj(4));
    log.end_of_enumeration(2);
    // Sheet 3 has a zoom of 100 and is fitted one page wide; sheet 4 declares a fit (Zoom is False) and is left alone.
    log.get(3, "PageSetup", obj(5));
    log.get(5, "Zoom", i4(100));
    log.get(5, "Zoom", i4(100));
    log.get(5, "FitToPagesWide", i4(0));
    log.get(5, "FitToPagesTall", i4(0));
    log.put(5, "Zoom", b(false));
    log.put(5, "FitToPagesWide", i4(1));
    log.put(5, "FitToPagesTall", b(false));
    log.get(4, "PageSetup", obj(6));
    log.get(6, "Zoom", b(false));
    log.call(1, "ExportAsFixedFormat", vec![i4(0), s(&output)], empty());
    log.put(5, "Zoom", i4(100));
    log.put(5, "FitToPagesWide", i4(0));
    log.put(5, "FitToPagesTall", i4(0));
    let fake = log.fake();
    let (platform, apps) = (FakePlatform::new(), ScriptedApplications::new());
    let actions = actions(&platform, &apps, word_drivers(&[], &[]));
    render_document(&actions, &fake.object(1), "xlsx", &output).expect("rendered");
    fake.finish();
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}

// ---------------------------------------------------------------------------------------------------------------------
// The session actions of an owned background Word session.

struct World {
    platform: Rc<FakePlatform>,
    apps: ScriptedApplications,
    dir: PathBuf,
    out: Emitter,
    stdout: Shared,
}

impl World {
    fn new(name: &str) -> World {
        let (out, stdout, _) = emitter();
        World { platform: Rc::new(FakePlatform::new()), apps: ScriptedApplications::new(), dir: scratch(name), out, stdout }
    }

    fn word_session(&mut self, log: &Log, path: &str) -> (SessionState, Fake) {
        let fake = log.fake();
        let platform = self.platform.clone();
        self.apps.queue_create_then("Word.Application", Ok(fake.object(1)), move || {
            platform.add_process(500, "WINWORD", START_TICKS);
            let mut window = FakeWindow::new(9001, 500, "OpusApp", "document");
            window.visible = false;
            platform.add_window(window);
        });
        let env = Env { platform: &*self.platform, applications: &self.apps };
        let open = request(json!({"action": "open_session", "session": "s1", "format": "docx", "path": path, "mode": "background"}));
        (open_session_state(&Unlaned, &env, &mut self.out, &open).expect("opened"), fake)
    }

    fn act(&mut self, readers: &[(&str, &dyn FormatReader)], state: &mut SessionState, body: Json) -> Result<Value, String> {
        let env = Env { platform: &*self.platform, applications: &self.apps };
        let actions = Actions { env, proof: &Unlaned, drivers: Drivers::new(readers, &[]) };
        invoke_session_action(&actions, &mut self.out, state, &request(body))
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, &self.dir);
    }
}

/// The calls of opening an existing Word document in a new background application (process 500, window 9001).
fn word_background_open(log: &mut Log, path: &str) {
    log.get(1, "Hwnd", null());
    log.get(1, "HWND", null());
    log.put(1, "DisplayAlerts", i4(0));
    log.put(1, "AutomationSecurity", i4(3));
    log.put(1, "Visible", b(false));
    log.get(1, "Documents", obj(2));
    log.call(2, "Open", vec![s(path)], obj(3));
    log.get(3, "ActiveWindow", obj(4));
    log.get(4, "Hwnd", i4(9001));
}

fn isolation_report(checks: u32) -> String {
    format!(
        "{{\"strict\":true,\"isolatedProcess\":true,\"checks\":{checks},\"hiddenWindows\":0,\"focusRestorations\":0,\"observedVisibleWindows\":[],\"foregroundBefore\":0,\"foregroundAfter\":0,\"visibleOwnedWindows\":0,\"ownedForeground\":false}}"
    )
}

fn session_head(state: &SessionState, checks: u32) -> String {
    format!(
        "{{\"ok\":true,\"session\":\"s1\",\"mode\":\"background\",\"backend\":\"microsoft-office-com\",\"ownership\":\"owned\",\"ownsApplication\":true,\"appPid\":500,\"windowHwnd\":9001,\"documentId\":{},\"backgroundIsolation\":{}",
        json!(state.document_id),
        isolation_report(checks)
    )
}

fn word_world(name: &str) -> (World, String) {
    let world = World::new(name);
    let path = world.dir.join("a.docx").to_string_lossy().into_owned();
    mixdog_fsio::write(&Unlaned, &path, b"document").expect("a document");
    (world, path)
}

#[test]
fn a_session_save_rebuilds_the_tables_of_contents_saves_and_answers_with_the_path() {
    let (mut world, path) = word_world("session-save");
    let mut log = Log::default();
    word_background_open(&mut log, &path);
    let (mut state, _opened) = world.word_session(&log, &path);
    let mut more = Log::default();
    more.get(3, "TablesOfContents", null());
    more.call(3, "Save", vec![], empty());
    // The replaying fake of the open ends with its own log: the actions' calls continue on a fresh one for the same objects.
    let fake = more.fake();
    state.document = Some(fake.object(3));
    let answer = world.act(&[], &mut state, json!({"action": "save", "session": "s1"})).expect("an answer");
    fake.finish();
    assert_eq!(line(&answer), format!("{},\"saved\":true,\"path\":{}}}", session_head(&state, 1), json!(path)));
}

#[test]
fn an_unknown_session_action_and_the_background_only_actions_are_refused_with_the_scripts_texts() {
    let (mut world, path) = word_world("session-refusals");
    let mut log = Log::default();
    word_background_open(&mut log, &path);
    let (mut state, _opened) = world.word_session(&log, &path);
    let refused = world.act(&[], &mut state, json!({"action": "frobnicate"})).unwrap_err();
    assert_eq!(refused, "Unsupported Office session action: frobnicate");
    let refused = world.act(&[], &mut state, json!({"action": "reload_document"})).unwrap_err();
    assert_eq!(refused, "Document reload is available only for owned background PowerPoint sessions");
    let refused = world.act(&[], &mut state, json!({"action": "replace_presentation_from_source", "source": "a.pptx", "checkpoint": "b.pptx"})).unwrap_err();
    assert_eq!(refused, "PowerPoint source replacement is available only for owned background sessions");
}

#[test]
fn post_save_validate_reopens_an_owned_background_word_document_and_reads_it_back() {
    let (mut world, path) = word_world("session-psv");
    let mut log = Log::default();
    word_background_open(&mut log, &path);
    let (mut state, _opened) = world.word_session(&log, &path);
    let mut more = Log::default();
    more.get(3, "TablesOfContents", null());
    more.call(3, "Save", vec![], empty());
    more.call(3, "Close", vec![b(false)], empty());
    more.get(1, "Documents", obj(2));
    more.call(2, "Open", vec![s(&path)], obj(6));
    more.get(6, "Saved", b(true));
    more.get(6, "Saved", b(true));
    more.get(6, "Saved", b(true));
    let fake = more.fake();
    state.document = Some(fake.object(3));
    state.app = Some(fake.object(1));
    let readers: [(&str, &dyn FormatReader); 1] = [("docx", &Reader)];
    let answer = world.act(&readers, &mut state, json!({"action": "post_save_validate", "session": "s1"})).expect("an answer");
    fake.finish();
    assert_eq!(
        line(&answer),
        format!(
            "{},\"value\":{{\"ok\":true,\"opened\":true,\"reopened\":true,\"persisted\":true,\"excelDpiRepairs\":0,\"issueCount\":0,\"issues\":[],\"documentSaved\":true}}}}",
            session_head(&state, 1)
        )
    );
    assert_eq!(world.stdout.text(), "{\"ok\":true,\"session\":\"s1\",\"ownership\":\"owned\",\"ownsApplication\":true,\"appPid\":500,\"lifecycle\":\"initializing\"}\r\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// The DPI repair.

fn package(parts: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in parts {
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file(*name, options).expect("entry");
        writer.write_all(content).expect("content");
    }
    writer.finish().expect("finish").into_inner()
}

fn entry_text(bytes: &[u8], name: &str) -> String {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).expect("a package");
    let mut text = String::new();
    archive.by_name(name).expect("entry").read_to_string(&mut text).expect("text");
    text
}

#[test]
fn the_repair_rewrites_the_file_it_opened_exclusively_and_counts_the_entries_it_changed() {
    let dir = scratch("dpi");
    let path = dir.join("zero.xlsx").to_string_lossy().into_owned();
    let bytes = package(&[
        ("xl/worksheets/sheet1.xml", b"<worksheet><pageSetup horizontalDpi=\"0\" verticalDpi=\"0\"/></worksheet>"),
        ("xl/worksheets/sheet2.xml", b"<worksheet><pageSetup horizontalDpi=\"96\"/></worksheet>"),
        ("xl/workbook.xml", b"<workbook verticalDpi=\"0\"/>"),
    ]);
    mixdog_fsio::write(&Unlaned, &path, &bytes).expect("a workbook");
    let (platform, apps) = (FakePlatform::new(), ScriptedApplications::new());
    platform.put_file(&path, &bytes);
    let actions = actions(&platform, &apps, word_drivers(&[], &[]));
    assert_eq!(repair_excel_page_setup_dpi(&actions, &path), Ok(1));
    let written = mixdog_fsio::read(&Unlaned, &path).expect("the file");
    assert_eq!(entry_text(&written, "xl/worksheets/sheet1.xml"), "<worksheet><pageSetup horizontalDpi=\"96\" verticalDpi=\"96\"/></worksheet>");
    assert_eq!(entry_text(&written, "xl/worksheets/sheet2.xml"), "<worksheet><pageSetup horizontalDpi=\"96\"/></worksheet>");
    assert_eq!(entry_text(&written, "xl/workbook.xml"), "<workbook verticalDpi=\"0\"/>");
    // A second run finds nothing to repair and leaves the file as it is.
    platform.put_file(&path, &written);
    assert_eq!(repair_excel_page_setup_dpi(&actions, &path), Ok(0));
    assert_eq!(mixdog_fsio::read(&Unlaned, &path).expect("the file"), written);
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}

#[test]
fn a_workbook_someone_else_holds_is_refused_instead_of_changed() {
    let dir = scratch("dpi-locked");
    let path = dir.join("held.xlsx").to_string_lossy().into_owned();
    let (platform, apps) = (FakePlatform::new(), ScriptedApplications::new());
    platform.put_file(&path, b"x");
    platform.set_locked(&path, true);
    let actions = actions(&platform, &apps, word_drivers(&[], &[]));
    let refused = repair_excel_page_setup_dpi(&actions, &path).unwrap_err();
    assert!(refused.starts_with("Exception calling \"Open\" with \"4\" argument(s): "), "{refused}");
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}

// ---------------------------------------------------------------------------------------------------------------------
// The read-only preview's encryption check.

fn input(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("actions").join("inputs").join(name).to_string_lossy().into_owned()
}

#[test]
fn an_ole_container_with_a_package_extension_is_refused_as_password_protected_and_a_zip_package_is_not() {
    let (platform, apps) = (FakePlatform::new(), ScriptedApplications::new());
    let actions = actions(&platform, &apps, word_drivers(&[], &[]));
    assert_eq!(assert_preview_not_encrypted(&actions, &input("ole-header.docx")), Err(PASSWORD_PROTECTED.to_owned()));
    assert_eq!(assert_preview_not_encrypted(&actions, &input("zero-dpi.xlsx")), Ok(()));
    // A legacy extension is not a package: it is not read at all, so a file that does not exist passes.
    assert_eq!(assert_preview_not_encrypted(&actions, &input("absent.doc")), Ok(()));
}
