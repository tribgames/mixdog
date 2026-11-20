//! The author action's own work, with the runners scripted: the route it takes for each format, the staging folder and what it
//! leaves behind, the checks that refuse a document before anything lands, the landing over the target, and the session that
//! holds it afterwards. The host writes the staged document itself, so no browser, script runtime or Office is involved.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mixdog_fsio::Unlaned;
use mixdog_office::author::pptx_session::{
    AuthorError, STAGING_PREFIX, land_staged_deck, release_existing_session, release_staging_target, reusable_authored_session, staging_target,
    swap_authored_document, throw_if_authoring_cancelled,
};
use mixdog_office::author::{AuthorCall, AuthorHost, StageHost, author};
use mixdog_office::session::registry::lock;
use mixdog_office::session::{Backend, DesignState, Mode, Session, SessionHandle, SessionInit, SnapshotCache};
use mixdog_office_author::html_browser::RunError;
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

fn run<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().build().expect("runtime").block_on(future)
}

/// A host on a real folder with scripted runners.
struct Fake {
    sessions: Mutex<Vec<(String, SessionHandle)>>,
    /// What the HTML runners answer (the staged file is written by the host).
    answer: RefCell<Value>,
    deck_snapshot: RefCell<Result<Value, String>>,
    office: RefCell<Vec<Value>>,
    closed: Cell<usize>,
    noted: RefCell<Vec<String>>,
    runs: Cell<usize>,
}

impl Fake {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(Vec::new()),
            answer: RefCell::new(json!({ "ok": true, "bytes": 11, "logs": [], "kit": "html", "elapsedMs": 4, "slideCount": 2 })),
            deck_snapshot: RefCell::new(Ok(json!({ "slides": [] }))),
            office: RefCell::new(Vec::new()),
            closed: Cell::new(0),
            noted: RefCell::new(Vec::new()),
            runs: Cell::new(0),
        }
    }

    fn register(&self, target: &str, backend: Backend, mode: Mode, authored: bool) -> SessionHandle {
        let format = target.rsplit('.').next().unwrap_or("pptx").to_owned();
        let mut session = Session::new(SessionInit {
            id: format!("session-{}", self.sessions.lock().expect("sessions").len() + 1),
            source: target.to_owned(),
            target: target.to_owned(),
            file_kind: format.clone(),
            format,
            mode,
            backend,
            opened_at: String::new(),
            data_dir: PathBuf::new(),
            created: true,
            created_new_file: None,
            design_state: DesignState::default(),
        });
        session.authored.authored = authored;
        session.com.ownership = Some("owned".to_owned());
        session.com.visible = Some(false);
        let handle = Arc::new(Mutex::new(session));
        self.sessions.lock().expect("sessions").push((target.to_owned(), Arc::clone(&handle)));
        handle
    }

    fn write_staged(&self, output: &Path, text: &str) {
        mixdog_fsio::write(&Unlaned, output, text).expect("write the staged document");
    }
}

impl StageHost for Fake {
    async fn exists(&self, path: &Path) -> bool {
        mixdog_fsio::exists(&Unlaned, path).unwrap_or(false)
    }

    async fn read_text(&self, path: &Path) -> Result<String, String> {
        mixdog_fsio::read_to_string(&Unlaned, path).map_err(|error| error.to_string())
    }

    async fn make_directory(&self, parent: &Path, prefix: &str) -> Result<PathBuf, String> {
        mixdog_fsio::create_dir_all(&Unlaned, parent).map_err(|error| error.to_string())?;
        for count in 0..1000 {
            let path = parent.join(format!("{prefix}{count}"));
            match mixdog_fsio::create_dir(&Unlaned, &path) {
                Ok(()) => return Ok(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("no folder".to_owned())
    }

    async fn copy_file(&self, from: &Path, to: &Path) -> Result<(), String> {
        mixdog_fsio::copy(&Unlaned, from, to).map(drop).map_err(|error| error.to_string())
    }

    async fn remove_file(&self, path: &Path) {
        let _ = mixdog_fsio::remove_file(&Unlaned, path);
    }

    async fn remove_dir_all(&self, path: &Path) {
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, path);
    }

    fn session_for_document(&self, target: &str) -> Option<SessionHandle> {
        self.sessions.lock().expect("sessions").iter().find(|(path, _)| path == target).map(|(_, handle)| Arc::clone(handle))
    }

    fn release_session(&self, handle: &SessionHandle) {
        self.sessions.lock().expect("sessions").retain(|(_, held)| !Arc::ptr_eq(held, handle));
    }

    async fn close_session(&self, _handle: &SessionHandle, _signal: Option<&CancellationToken>) -> Result<(), String> {
        self.closed.set(self.closed.get() + 1);
        Ok(())
    }
}

impl AuthorHost for Fake {
    fn note_write(&self, path: &Path) {
        self.noted.borrow_mut().push(path.to_string_lossy().into_owned());
    }

    fn now_iso(&self) -> String {
        "2026-01-01T00:00:00.000Z".to_owned()
    }

    async fn office_call(&self, _request: &Value, _signal: Option<&CancellationToken>) -> Value {
        let mut scripted = self.office.borrow_mut();
        if scripted.is_empty() { json!({ "ok": false }) } else { scripted.remove(0) }
    }

    async fn create_authored_session(&self, _args: &Value, target: &str, _signal: Option<&CancellationToken>) -> Result<SessionHandle, String> {
        Ok(self.register(target, Backend::MixdogOoxml, Mode::Portable, true))
    }

    fn register_html_pdf_session(&self, _args: &Value, target: &str, _target_existed: bool, _receipt: Value) -> Result<SessionHandle, String> {
        Ok(self.register(target, Backend::MixdogPdf, Mode::Portable, false))
    }

    async fn release_overwritten_session(&self, target: &str) -> Result<(), String> {
        if let Some(held) = self.session_for_document(target) {
            self.release_session(&held);
        }
        Ok(())
    }

    async fn snapshot_deck(&self, _path: &Path) -> Result<Value, String> {
        self.deck_snapshot.borrow().clone()
    }

    async fn snapshot_pdf_pages(&self, _path: &Path) -> Result<Vec<Value>, String> {
        Ok(vec![json!({ "index": 1, "text": "Revenue grew 41%\n1 / 2" })])
    }

    async fn run_pptx_script(&self, _script: &str, _output: &Path, _cwd: &Path) -> Result<Value, String> {
        Err("no script runtime".to_owned())
    }

    async fn run_pptx_html(&self, _html: &str, output: &Path, _target: &Path, _signal: Option<&CancellationToken>, _frame: bool) -> Result<Value, RunError> {
        self.runs.set(self.runs.get() + 1);
        let answer = self.answer.borrow().clone();
        if answer["ok"] == json!(true) {
            self.write_staged(output, "<html deck>");
        }
        Ok(answer)
    }

    async fn run_docx_html(&self, _html: &str, output: &Path, _target: &Path, _signal: Option<&CancellationToken>) -> Result<Value, RunError> {
        self.runs.set(self.runs.get() + 1);
        self.write_staged(output, "<html docx>");
        Ok(json!({ "ok": true, "bytes": 11, "logs": [], "elapsedMs": 2, "htmlPages": [] }))
    }

    async fn run_xlsx_html(&self, _html: &str, output: &Path, _target: &Path, _signal: Option<&CancellationToken>) -> Result<Value, RunError> {
        self.runs.set(self.runs.get() + 1);
        self.write_staged(output, "<html xlsx>");
        Ok(json!({ "ok": false, "error": { "message": "no data-sheet" }, "elapsedMs": 2 }))
    }

    async fn print_pdf(
        &self,
        _html: &str,
        output: &Path,
        _source: &Path,
        _properties: &Value,
        _frame: bool,
        _signal: Option<&CancellationToken>,
    ) -> Result<Value, RunError> {
        self.runs.set(self.runs.get() + 1);
        self.write_staged(output, "%PDF printed");
        Ok(json!({ "ok": true, "bytes": 12, "pageCount": 2, "area": { "width": 794, "height": 1123 }, "warnings": [], "elapsedMs": 3 }))
    }

    async fn inline_audit(&self, _handle: &SessionHandle, _exclude: &[String]) -> Option<Value> {
        None
    }

    async fn render(&self, _handle: &SessionHandle, _args: &Value, _cwd: &Path) -> Result<Value, String> {
        Ok(json!({ "output": "preview.pdf", "pageCount": 2, "images": [], "_images": [], "reviewToken": "t" }))
    }

    async fn read_composition_receipt(&self, _handle: &SessionHandle) -> Option<Value> {
        None
    }

    fn receipt_for_delivery(&self, _handle: &SessionHandle, receipt: &Value) -> Value {
        receipt.clone()
    }

    async fn write_html_comparisons(&self, _target: &Path, _shots: &Value, _images: &[Value]) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }

    async fn measure_html_drift(&self, _shots: &Value, _text: &Value, _images: &[Value]) -> Result<Value, String> {
        Ok(json!({ "pages": [] }))
    }

    async fn read_bytes(&self, _path: &Path) -> Result<Vec<u8>, String> {
        Err("no image".to_owned())
    }

    async fn write_bytes(&self, _path: &Path, _bytes: Vec<u8>) -> Result<(), String> {
        Ok(())
    }

    async fn compose_comparison(&self, _left: Option<Vec<u8>>, _right: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
}

const SLIDE_HTML: &str = "<!doctype html><section class=\"slide\"><h1>Retention rose</h1></section>";

fn call<'a>(cwd: &'a str, signal: Option<&'a CancellationToken>) -> AuthorCall<'a> {
    AuthorCall { cwd, signal }
}

fn folder(directory: &tempfile::TempDir) -> String {
    directory.path().to_string_lossy().into_owned()
}

fn names(directory: &Path) -> Vec<String> {
    let mut found: Vec<String> = mixdog_fsio::read_dir(&Unlaned, directory)
        .expect("read the folder")
        .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found
}

fn put(path: &Path, text: &str) {
    mixdog_fsio::write(&Unlaned, path, text).expect("write a file");
}

fn get(path: &Path) -> String {
    mixdog_fsio::read_to_string(&Unlaned, path).expect("read a file")
}

fn there(path: &Path) -> bool {
    mixdog_fsio::exists(&Unlaned, path).unwrap_or(false)
}

fn author_with(host: &Fake, args: Value, cwd: &str) -> Result<Value, AuthorError> {
    run(author(host, &args, &call(cwd, None)))
}

// office-authoring.test.mjs

#[test]
fn author_without_a_script_points_at_the_pptx_skill_instead_of_serving_a_guide() {
    let directory = tempfile::tempdir().expect("folder");
    let error = author_with(&Fake::new(), json!({ "action": "author" }), &folder(&directory)).expect_err("a bare author is refused");
    assert!(error.message().contains("Skill name:\"pptx\""), "{error}");
    let error = author_with(&Fake::new(), json!({ "script": "<p>" }), &folder(&directory)).expect_err("a script with no path is refused");
    assert_eq!(error.message(), "author requires path");
}

#[test]
fn author_without_a_script_or_a_kept_source_names_the_source_it_looked_for() {
    let directory = tempfile::tempdir().expect("folder");
    let error = author_with(&Fake::new(), json!({ "path": "deck.pptx" }), &folder(&directory)).expect_err("no source");
    assert!(error.message().starts_with("author requires script: HTML slides or a pptxgenjs script"), "{error}");
}

#[test]
fn a_pptx_authored_from_html_lands_opens_a_session_and_leaves_no_staging_folder() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    let host = Fake::new();
    let result = author_with(&host, json!({ "path": "deck.pptx", "script": SLIDE_HTML, "render": false }), &cwd).expect("authored");
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["session"], json!("session-1"));
    assert_eq!(result["backend"], json!("mixdog-ooxml"));
    assert_eq!(result["mode"], json!("portable"));
    assert_eq!(result["kit"], json!("html"));
    assert!(result["nextAction"].as_str().expect("next action").starts_with("Written and measured clean, not visually reviewed"));
    assert_eq!(get(&directory.path().join("deck.pptx")), "<html deck>");
    assert!(!names(directory.path()).iter().any(|name| name.starts_with(STAGING_PREFIX)), "{:?}", names(directory.path()));
    // The write receipts: the document and the sidecars kept beside it.
    let target = directory.path().join("deck.pptx").to_string_lossy().into_owned();
    let noted = host.noted.borrow().clone();
    assert!(
        noted.iter().any(|path| *path == target)
            && noted.contains(&format!("{target}.mixdog-source.html"))
            && noted.contains(&format!("{target}.mixdog-html.pdf")),
        "{noted:?}"
    );
}

#[test]
fn a_run_that_failed_leaves_the_existing_deck_and_no_staging_folder() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    put(&directory.path().join("deck.pptx"), "unrelated existing deck");
    let host = Fake::new();
    *host.answer.borrow_mut() = json!({ "ok": false, "error": { "message": "bad html", "line": 3 }, "logs": [], "elapsedMs": 9 });
    let result = author_with(&host, json!({ "path": "deck.pptx", "script": SLIDE_HTML, "overwrite": true }), &cwd).expect("a refusal is an answer");
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["reason"], json!("html_failed"));
    assert_eq!(result["error"]["message"], json!("bad html"));
    assert_eq!(result["nextAction"], json!("Fix the HTML the error names and call author again."));
    assert_eq!(get(&directory.path().join("deck.pptx")), "unrelated existing deck");
    assert_eq!(names(directory.path()), vec!["deck.pptx".to_owned()]);
}

#[test]
fn an_existing_target_is_replaced_only_with_overwrite_or_from_its_own_source() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    put(&directory.path().join("deck.pptx"), "old");
    let host = Fake::new();
    let error = author_with(&host, json!({ "path": "deck.pptx", "script": SLIDE_HTML }), &cwd).expect_err("refused");
    assert!(error.message().contains("pass overwrite:true to replace it"), "{error}");
    assert_eq!(host.runs.get(), 0, "nothing ran");
    author_with(&host, json!({ "path": "deck.pptx", "script": SLIDE_HTML, "overwrite": true, "render": false }), &cwd).expect("overwritten");
    assert_eq!(get(&directory.path().join("deck.pptx")), "<html deck>");
    // With no script the deck is built again from the HTML kept beside it, and that needs no overwrite.
    put(&directory.path().join("deck.pptx.mixdog-source.html"), SLIDE_HTML);
    host.release_session(&host.session_for_document(&directory.path().join("deck.pptx").to_string_lossy()).expect("the session"));
    author_with(&host, json!({ "path": "deck.pptx", "render": false }), &cwd).expect("rebuilt from its own source");
}

#[test]
fn author_rejects_invalid_modes_before_closing_or_rewriting_an_existing_deck() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    let path = directory.path().join("untouched.pptx");
    put(&path, "original deck");
    let host = Fake::new();
    let target = path.to_string_lossy().into_owned();
    let held = host.register(&target, Backend::MicrosoftOfficeCom, Mode::Background, true);
    for mode in ["visible", "attach", "live", "unsupported"] {
        let error = author_with(&host, json!({ "path": target, "script": SLIDE_HTML, "mode": mode, "render": false }), &cwd).expect_err("refused");
        assert!(error.message().contains("author requires") || error.message().contains("Unsupported Office mode"), "{error}");
        assert_eq!(get(&path), "original deck");
        assert!(Arc::ptr_eq(&host.session_for_document(&target).expect("still registered"), &held));
    }
    assert_eq!(host.closed.get(), 0);
}

#[test]
fn author_session_reuse_respects_the_requested_backend_and_ownership_boundaries() {
    let host = Fake::new();
    let target = "reuse.pptx";
    let held = host.register(target, Backend::MicrosoftOfficeCom, Mode::Background, true);
    assert!(reusable_authored_session(&host, target, "auto").is_some_and(|found| Arc::ptr_eq(&found, &held)));
    assert!(reusable_authored_session(&host, target, "background").is_some());
    assert!(reusable_authored_session(&host, target, "portable").is_none());
    let changes: [Box<dyn Fn(&mut Session)>; 4] = [
        Box::new(|session| session.com.ownership = Some("attached".to_owned())),
        Box::new(|session| session.com.visible = Some(true)),
        Box::new(|session| session.authored.authored = false),
        Box::new(|session| session.backend = Backend::MixdogOoxml),
    ];
    for change in changes {
        let session = host.register("other.pptx", Backend::MicrosoftOfficeCom, Mode::Background, true);
        change(&mut lock(&session));
        assert!(reusable_authored_session(&host, "other.pptx", "background").is_none());
        host.release_session(&session);
    }
}

#[test]
fn every_authoring_format_isolates_simultaneous_stages_and_cleans_only_its_own_directory() {
    let directory = tempfile::tempdir().expect("folder");
    let host = Fake::new();
    for format in ["pptx", "docx", "xlsx", "pdf"] {
        let target = directory.path().join(format!("report.{format}"));
        let neighbour = directory.path().join(format!(".report.authoring.{format}"));
        put(&neighbour, &format!("existing {format}"));
        let (first, second) = run(async { (staging_target(&host, &target).await.expect("first"), staging_target(&host, &target).await.expect("second")) });
        assert_ne!(first.parent(), second.parent());
        assert_eq!(first.parent().and_then(Path::parent), Some(directory.path()));
        put(&first, "first document");
        put(&second, "second document");
        run(release_staging_target(&host, &first));
        assert_eq!(get(&second), "second document");
        run(release_staging_target(&host, &second));
        assert_eq!(get(&neighbour), format!("existing {format}"));
    }
    assert!(!names(directory.path()).iter().any(|name| name.starts_with(STAGING_PREFIX)));
}

#[test]
fn a_cancelled_fallback_preserves_the_target_and_does_not_consume_the_staged_deck() {
    let directory = tempfile::tempdir().expect("folder");
    let (target, staging) = (directory.path().join("target.pptx"), directory.path().join("staged.pptx"));
    put(&target, "old deck");
    put(&staging, "new deck");
    let signal = CancellationToken::new();
    let _ = signal.cancel();
    let error = run(land_staged_deck(&Fake::new(), &staging, &target, Some(&signal))).expect_err("cancelled");
    assert!(error.is_abort());
    assert_eq!(get(&target), "old deck");
    assert_eq!(get(&staging), "new deck");
    // Uncancelled, the staged deck lands and goes.
    run(land_staged_deck(&Fake::new(), &staging, &target, None)).expect("landed");
    assert_eq!(get(&target), "new deck");
    assert!(!there(&staging));
}

fn swap_session() -> SessionHandle {
    let host = Fake::new();
    let handle = host.register("unused.pptx", Backend::MicrosoftOfficeCom, Mode::Background, true);
    {
        let mut session = lock(&handle);
        session.id = "swapped".to_owned();
        session.snapshot_version = 7;
        session.com.app_pid = Some(json!(101));
        session.com.window_hwnd = Some(json!(10));
        session.caches.snapshot = Some(SnapshotCache { key: String::new(), value: json!({ "old": true }) });
        session.caches.render = Some(json!({ "old": true }));
        session.design_state.requires_visual_review = true;
        session.design_state.rendered_version = json!(3);
    }
    handle
}

#[test]
fn a_cancelled_document_swap_stops_instead_of_entering_replacement_recovery() {
    // The host answers that it was cancelled: the old version is intact.
    let handle = swap_session();
    let error = run(swap_authored_document(&handle, Path::new("unused-staging.pptx"), None, "now", |_| async {
        json!({ "ok": false, "cancelled": true, "error": "cancelled by host" })
    }))
    .expect_err("cancelled");
    assert!(error.is_abort());
    assert_eq!(error.message(), "cancelled by host");
    {
        let session = lock(&handle);
        assert_eq!((session.snapshot_version, session.com.app_pid.clone()), (7, Some(json!(101))));
        assert!(session.caches.render.is_some(), "a cancelled replacement leaves the old version intact");
    }
    // The signal is raised while the swap completes: the new identity is kept and the old deck is not exposed.
    let handle = swap_session();
    let signal = CancellationToken::new();
    let raised = signal.clone();
    let error = run(swap_authored_document(&handle, Path::new("unused-staging.pptx"), Some(&signal), "now", |_| async move {
        let _ = raised.cancel();
        json!({ "ok": true, "appPid": 202 })
    }))
    .expect_err("cancelled");
    assert!(error.is_abort());
    let session = lock(&handle);
    assert_eq!(session.com.app_pid, Some(json!(202)));
    assert_eq!(session.snapshot_version, 8);
    assert!(session.caches.render.is_none() && session.caches.snapshot.is_none(), "late cancellation cannot expose a cached old deck");
}

#[test]
fn document_swaps_publish_fresh_application_identity_and_invalidate_prior_readings() {
    let handle = swap_session();
    let swapped = run(swap_authored_document(&handle, Path::new("unused-staging.pptx"), None, "2026-01-01T00:00:00.000Z", |request| async move {
        assert_eq!(request["action"], json!("reload_document"));
        assert_eq!(request["source"], json!("unused-staging.pptx"));
        assert_eq!(request["mode"], json!("background"));
        json!({ "ok": true, "appPid": 202, "windowHwnd": 20, "documentId": "new-document" })
    }))
    .expect("swapped");
    assert!(swapped);
    let session = lock(&handle);
    assert_eq!(
        (session.com.app_pid.clone(), session.com.window_hwnd.clone(), session.com.document_id.clone()),
        (Some(json!(202)), Some(json!(20)), Some(json!("new-document")))
    );
    assert_eq!(session.snapshot_version, 8);
    assert!(session.caches.render.is_none() && session.caches.snapshot.is_none());
    assert!(session.design_state.requires_visual_review);
    assert_eq!(session.opened_at, "2026-01-01T00:00:00.000Z");
}

#[test]
fn a_host_that_refuses_the_swap_leaves_the_session_for_the_old_landing() {
    let handle = swap_session();
    let swapped = run(swap_authored_document(&handle, Path::new("s.pptx"), None, "now", |_| async { json!({ "ok": false }) })).expect("not cancelled");
    assert!(!swapped);
    assert_eq!(lock(&handle).snapshot_version, 7);
}

#[test]
fn a_reusable_session_swaps_its_document_and_the_target_still_receives_the_staged_deck_on_a_refusal() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    let host = Fake::new();
    let target = directory.path().join("deck.pptx").to_string_lossy().into_owned();
    put(Path::new(&target), "old");
    let held = host.register(&target, Backend::MicrosoftOfficeCom, Mode::Background, true);
    host.office.borrow_mut().push(json!({ "ok": true, "appPid": 9 }));
    let result = author_with(&host, json!({ "path": "deck.pptx", "script": SLIDE_HTML, "render": false }), &cwd).expect("swapped");
    assert_eq!(result["reusedSession"], json!(true));
    assert_eq!(result["session"], json!(lock(&held).id));
    assert_eq!(host.closed.get(), 0, "the hidden process is kept");
    // A host that refuses the swap: the session is released and the file lands the old way.
    host.office.borrow_mut().push(json!({ "ok": false }));
    let result = author_with(&host, json!({ "path": "deck.pptx", "script": SLIDE_HTML, "render": false }), &cwd).expect("landed");
    assert!(result.get("reusedSession").is_none());
    assert_eq!(get(Path::new(&target)), "<html deck>");
    assert_eq!(host.closed.get(), 1);
}

#[test]
fn release_existing_session_answers_the_id_it_released() {
    let host = Fake::new();
    let held = host.register("a.pptx", Backend::MixdogOoxml, Mode::Portable, true);
    let released = run(release_existing_session(&host, "a.pptx", None)).expect("released");
    assert_eq!(released, Some(lock(&held).id.clone()));
    assert!(host.session_for_document("a.pptx").is_none());
    assert_eq!(run(release_existing_session(&host, "a.pptx", None)).expect("nothing"), None);
}

#[test]
fn a_cancellation_is_an_abort_whatever_raised_it() {
    let signal = CancellationToken::new();
    assert!(throw_if_authoring_cancelled(Some(&signal), None).is_ok());
    assert!(throw_if_authoring_cancelled(None, Some(&json!({ "cancelled": true, "error": "stopped" }))).is_err_and(|error| error.message() == "stopped"));
    let _ = signal.cancel();
    assert!(throw_if_authoring_cancelled(Some(&signal), None).is_err_and(|error| error.message() == "Office authoring was cancelled"));
}

// the gates (pptx-html-reauthor.slow.test.mjs, the brief and plan tests of the author route)

const BRIEF_HTML: &str =
    "<!doctype html><!-- BRIEF\nsubject/audience/action: board - approve the plan\n--><section class=\"slide\"><h1>Revenue grew 41%</h1></section>";

#[test]
fn a_figure_with_no_fact_behind_it_is_refused_before_anything_lands() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    let host = Fake::new();
    *host.deck_snapshot.borrow_mut() = Ok(json!({ "slides": [{ "index": 1, "shapes": [{ "text": "Revenue grew 41%" }] }] }));
    let result = author_with(&host, json!({ "path": "deck.pptx", "script": BRIEF_HTML }), &cwd).expect("a refusal is an answer");
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["reason"], json!("facts_gate"));
    assert_eq!(result["gate"]["code"], json!("facts_missing"));
    assert_eq!(result["gate"]["facts"], json!(0));
    assert!(result["nextAction"].as_str().expect("next action").starts_with("The deck shows figures (slide 1: 41"));
    assert!(!there(&directory.path().join("deck.pptx")));
    assert_eq!(names(directory.path()), Vec::<String>::new());
    assert!(host.session_for_document(&directory.path().join("deck.pptx").to_string_lossy()).is_none());
}

#[test]
fn a_sample_declaration_passes_the_facts_gate_and_an_unreadable_deck_is_left_to_qa() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    let sample = "<!doctype html><!-- BRIEF\nfacts: sample - illustrative numbers\n--><section class=\"slide\"><h1>Revenue grew 41%</h1></section>";
    let host = Fake::new();
    *host.deck_snapshot.borrow_mut() = Ok(json!({ "slides": [{ "index": 1, "shapes": [{ "text": "Revenue grew 41%" }] }] }));
    assert_eq!(author_with(&host, json!({ "path": "a.pptx", "script": sample, "render": false }), &cwd).expect("sample")["ok"], json!(true));
    *host.deck_snapshot.borrow_mut() = Err("not a package".to_owned());
    assert_eq!(author_with(&host, json!({ "path": "b.pptx", "script": BRIEF_HTML, "render": false }), &cwd).expect("unreadable")["ok"], json!(true));
}

#[test]
fn a_geometry_finding_refuses_the_deck_and_lists_the_slide_and_message() {
    let directory = tempfile::tempdir().expect("folder");
    let host = Fake::new();
    *host.answer.borrow_mut() =
        json!({ "ok": true, "bytes": 1, "logs": [], "elapsedMs": 2, "geometry": [{ "slide": 2, "findings": [{ "message": "label is 14px off its mark" }] }] });
    let result = author_with(&host, json!({ "path": "deck.pptx", "script": SLIDE_HTML }), &folder(&directory)).expect("a refusal is an answer");
    assert_eq!(result["reason"], json!("geometry_gate"));
    assert_eq!(result["gate"]["code"], json!("geometry"));
    assert!(result["nextAction"].as_str().expect("next action").contains("slide 2: label is 14px off its mark"));
    assert!(!there(&directory.path().join("deck.pptx")));
}

#[test]
fn a_script_with_no_runtime_says_so_and_changes_nothing() {
    let directory = tempfile::tempdir().expect("folder");
    let error = author_with(&Fake::new(), json!({ "path": "deck.pptx", "script": "const pptxgen = require('pptxgenjs');" }), &folder(&directory))
        .expect_err("no runtime");
    assert_eq!(error.message(), "no script runtime");
    assert_eq!(names(directory.path()), Vec::<String>::new());
}

#[test]
fn a_re_author_reports_the_batch_edits_it_replaced_and_keeps_counting_audit_rounds() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    let host = Fake::new();
    let target = directory.path().join("deck.pptx").to_string_lossy().into_owned();
    put(Path::new(&target), "old");
    let held = host.register(&target, Backend::MixdogOoxml, Mode::Portable, true);
    {
        let mut session = lock(&held);
        session.authored.html_source = Some(format!("{target}.mixdog-source.html"));
        session.authored.html_source_edits = 3;
        session.caches.inline_audit = Some(json!({ "rounds": 2 }));
    }
    let result = author_with(&host, json!({ "path": "deck.pptx", "script": SLIDE_HTML, "render": false }), &cwd).expect("authored");
    assert_eq!(result["replacedEdits"]["count"], json!(3));
    let session = host.session_for_document(&target).expect("the new session");
    assert!(!Arc::ptr_eq(&session, &held));
    assert_eq!(lock(&session).caches.inline_audit, Some(json!({ "rounds": 2 })));
    assert_eq!(lock(&session).authored.html_source_edits, 0);
}

// the PDF route

#[test]
fn a_pdf_is_printed_landed_and_opened_as_a_created_pdf() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    let host = Fake::new();
    let result = author_with(&host, json!({ "path": "report.pdf", "script": "<!doctype html><h1>Report</h1>", "render": false }), &cwd).expect("printed");
    assert_eq!(result["ok"], json!(true));
    assert_eq!((result["pageCount"].clone(), result["printableArea"].clone()), (json!(2), json!({ "width": 794, "height": 1123 })));
    assert_eq!(result["backend"], json!("mixdog-pdf"));
    assert!(result.get("designedPages").is_none());
    assert_eq!(get(&directory.path().join("report.pdf")), "%PDF printed");
    assert!(result["htmlSource"].as_str().expect("source").ends_with("report.pdf.mixdog-source.html"));
    assert!(result["nextAction"].as_str().expect("next action").starts_with("Printed and laid out clean, not visually reviewed"));
    assert_eq!(names(directory.path()), vec!["report.pdf".to_owned()]);
}

#[test]
fn a_pdf_needs_html_and_says_where_to_read_the_contract() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    let error = author_with(&Fake::new(), json!({ "path": "report.pdf", "script": "plain text" }), &cwd).expect_err("not html");
    assert_eq!(error.message(), "author writes a PDF from an HTML document only (a source that opens with <).");
    let error = author_with(&Fake::new(), json!({ "path": "report.pdf" }), &cwd).expect_err("no source");
    assert!(error.message().contains("Skill name:\"pdf\""), "{error}");
}

#[test]
fn a_flowing_pdf_reports_a_figure_its_brief_does_not_carry_and_still_lands() {
    let directory = tempfile::tempdir().expect("folder");
    let html = "<!doctype html><!-- BRIEF\nsubject/audience/action: board - approve\n--><h1>Revenue grew 41%</h1>";
    let result = author_with(&Fake::new(), json!({ "path": "report.pdf", "script": html, "render": false }), &folder(&directory)).expect("printed");
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["facts"]["code"], json!("facts_missing"));
    assert_eq!(result["facts"]["pages"][0]["page"], json!(1));
    assert!(result["facts"]["pages"][0]["figures"][0].as_str().expect("a figure").starts_with("41"));
}

// the Word and Excel route

#[test]
fn a_word_document_is_written_landed_and_opened_with_its_html_source_named() {
    let directory = tempfile::tempdir().expect("folder");
    let cwd = folder(&directory);
    let result = author_with(&Fake::new(), json!({ "path": "memo.docx", "script": "<!doctype html><p>Memo</p>", "render": false }), &cwd).expect("authored");
    assert_eq!(result["ok"], json!(true));
    assert_eq!(get(&directory.path().join("memo.docx")), "<html docx>");
    assert!(result["htmlSource"].as_str().expect("source").ends_with("memo.docx.mixdog-source.html"));
    assert!(result["nextAction"].as_str().expect("next").starts_with("Written and measured, not visually reviewed"));
}

#[test]
fn an_excel_run_that_failed_lands_nothing_and_names_the_html() {
    let directory = tempfile::tempdir().expect("folder");
    let result =
        author_with(&Fake::new(), json!({ "path": "book.xlsx", "script": "<!doctype html><p>x</p>" }), &folder(&directory)).expect("a refusal is an answer");
    assert_eq!(result["reason"], json!("html_failed"));
    assert_eq!(result["error"]["message"], json!("no data-sheet"));
    assert!(result["htmlSource"].as_str().expect("source").ends_with("book.xlsx.mixdog-source.html"));
    assert_eq!(names(directory.path()), Vec::<String>::new());
}

#[test]
fn a_word_or_excel_author_without_its_source_points_at_its_skill() {
    let directory = tempfile::tempdir().expect("folder");
    let error = author_with(&Fake::new(), json!({ "path": "memo.docx" }), &folder(&directory)).expect_err("no source");
    assert!(error.message().contains("Skill name:\"docx\"") && error.message().contains("an HTML document for a Word file"), "{error}");
    let error = author_with(&Fake::new(), json!({ "path": "book.xlsx" }), &folder(&directory)).expect_err("no source");
    assert!(error.message().contains("Skill name:\"xlsx\"") && error.message().contains("an HTML document for an Excel workbook"), "{error}");
}
