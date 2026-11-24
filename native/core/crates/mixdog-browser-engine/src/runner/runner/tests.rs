use std::path::Path;

use bytes::Bytes;

use super::approval::approval_command;
use super::facts::Observed;
use super::*;
use crate::actions::registry::is_action;
use crate::actions::target::ActionPage;
use crate::fake::Expect;
use crate::fake::FakeHost;
use crate::fake::page_facts;
use crate::queue::key::QueueKeyHost;
use crate::refs::ref_set::tests::element;
use crate::refs::ref_set::tests::payload;
use crate::types::BrowserApprovalPrompt;
use crate::types::FileFacts;
use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind;
use mixdog_app_protocol::v2::browser_engine::BrowserPreconditionReason;
use mixdog_app_protocol::v2::browser_engine::BrowserUserInputReason;

struct Masks;

impl SecretGuard for Masks {
    fn redact(&self, _session_id: &str, text: &str) -> String {
        text.replace("hunter2", "[secret]")
    }

    fn remember(&self, _session_id: &str, _secret: &str) {}
}

struct Allows;

#[async_trait]
impl ApprovalPort for Allows {
    async fn ask(&self, _prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
        Ok(ApprovalAnswer::Allow { remember: crate::types::Remember::Once })
    }
}

struct Takeovers(Option<&'static str>);

impl TakeoverPort for Takeovers {
    fn begin(&self, _session_id: &str) -> Result<TakeoverGuard, String> {
        match self.0 {
            Some(refusal) => Err(refusal.to_owned()),
            None => Ok(TakeoverGuard::new(CancellationToken::new(), None)),
        }
    }
}

struct NoBlobs;

#[async_trait]
impl BlobPort for NoBlobs {
    async fn read(&self, _digest: &str) -> Result<Bytes, String> {
        Err("no blobs".to_owned())
    }
}

struct NoFiles;

#[async_trait]
impl FilePort for NoFiles {
    async fn stat(&self, _path: &Path) -> FileFacts {
        FileFacts::default()
    }

    async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
        Ok(run_dir.to_path_buf())
    }
}

fn engine(host: &Arc<FakeHost>, takeover: Option<&'static str>) -> BrowserEngine {
    engine_with(host, takeover, ActionPolicy::from_env(None, None, None, is_action))
}

fn engine_with(host: &Arc<FakeHost>, takeover: Option<&'static str>, approval_policy: ActionPolicy) -> BrowserEngine {
    engine_over(host, takeover, approval_policy, Arc::new(NoFiles))
}

fn engine_over(host: &Arc<FakeHost>, takeover: Option<&'static str>, approval_policy: ActionPolicy, files: Arc<dyn FilePort>) -> BrowserEngine {
    BrowserEngine::new(
        host.clone(),
        EnginePorts {
            mirror: Arc::new(Mirror::new()),
            hold: Arc::new(UserHold::new()),
            approvals: Arc::new(Allows),
            takeover: Arc::new(Takeovers(takeover)),
            blobs: Arc::new(NoBlobs),
            files,
            secrets: Arc::new(Masks),
            approval_policy,
            urls: UrlPolicy::default(),
            frame_dir: PathBuf::from("frames"),
        },
    )
}

fn thread() -> ThreadId {
    ThreadId::from("s1")
}

async fn run(engine: &BrowserEngine, action: &str, input: Value) -> Result<ToolReply, ToolError> {
    let input = input.as_object().cloned().unwrap_or_default();
    engine.run(&thread(), action, &input, &CancellationToken::new()).await.map_err(|failure| failure.error)
}

fn page_row(page: &str, tab: &str) -> Value {
    json!({"pageId": page, "tabId": tab, "sessionId": "s1", "background": false, "facts": page_facts(page, 1)})
}

fn resolved(page: &str) -> Expect {
    Expect::ok("host/browser/pages/resolve", json!({"page": page_row(page, "v1"), "leaseId": "lease-1"}))
}

/// The page the host just made for the command (`created`), which the turn may reclaim (`disposable`).
fn resolved_new(page: &str) -> Expect {
    let mut row = page_row(page, "v1");
    row["created"] = json!(true);
    row["disposable"] = json!(true);
    Expect::ok("host/browser/pages/resolve", json!({"page": row, "leaseId": "lease-1"}))
}

fn snapshot_answer() -> Expect {
    let body = payload("p1-s1", vec![element("p1-s1-e1", "button", "Go")], "https://a.test/");
    Expect::ok(
        "host/browser/snapshot",
        json!({"snapshotId": "p1-s1", "documentId": "p1:1", "revision": 1, "payload": serde_json::to_value(body).expect("payload"), "warnings": [], "facts": page_facts("p1", 2)}),
    )
}

fn no_downloads() -> Expect {
    Expect::ok("host/browser/downloads", json!({"items": []}))
}

/// A disk that holds the files it is told of.
struct FilesOn(&'static str);

#[async_trait]
impl FilePort for FilesOn {
    async fn stat(&self, path: &Path) -> FileFacts {
        FileFacts { exists: path == Path::new(self.0), is_file: path == Path::new(self.0), size: 4, ..FileFacts::default() }
    }

    async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
        Ok(run_dir.to_path_buf())
    }
}

#[async_trait]
impl DownloadFiles for FilesOn {
    async fn read_file(&self, _path: &Path, _limit: u64) -> std::io::Result<Bytes> {
        Ok(Bytes::from_static(b"%PDF"))
    }
}

fn download(id: &str, state: &str, path: &str) -> Value {
    json!({"id": id, "file": "report.pdf", "path": path, "url": "https://a.test/report.pdf", "mimeType": "application/pdf", "state": state, "received": 4, "total": 4, "startedAt": 1})
}

fn downloads_of(items: &[Value]) -> Expect {
    Expect::ok("host/browser/downloads", json!({"items": items}))
}

#[tokio::test]
async fn an_attached_download_is_returned_inline_and_is_refused_when_it_is_no_readable_file_or_not_complete() {
    let saved = "/dl/report.pdf";
    let finished = download("d1", "completed", saved);
    let on_disk = Arc::new(FakeHost::scripted(vec![downloads_of(&[finished.clone()])]));
    let engine_on = engine_over(&on_disk, None, ActionPolicy::from_env(None, None, None, is_action), Arc::new(FilesOn(saved)));
    engine_on.set_download_files(Arc::new(FilesOn(saved)));
    let reply = run(&engine_on, "downloads", json!({"attach": true})).await.expect("the download is a file");
    assert!(reply.text.ends_with("Attached download d1 as report.pdf."), "{}", reply.text);
    let file = reply.file.expect("the file rides in the reply");
    assert_eq!((file.name.as_str(), file.mime_type.as_str(), &file.bytes[..]), ("report.pdf", "application/pdf", &b"%PDF"[..]));

    let gone = Arc::new(FakeHost::scripted(vec![downloads_of(&[finished])]));
    let engine_gone = engine(&gone, None);
    engine_gone.set_download_files(Arc::new(FilesOn(saved)));
    let error = run(&engine_gone, "downloads", json!({"attach": true})).await.expect_err("no file at the path");
    assert_eq!(error.message_for_model, "download d1 is not a readable file");

    let running = Arc::new(FakeHost::scripted(vec![downloads_of(&[download("d2", "in_progress", saved)])]));
    let error = run(&engine(&running, None), "downloads", json!({"attach": true, "downloadId": "d2"})).await.expect_err("not complete");
    assert_eq!(error.message_for_model, "download d2 is in_progress; wait for completion before attaching");

    let none = Arc::new(FakeHost::scripted(vec![downloads_of(&[download("d3", "interrupted", saved)])]));
    let error = run(&engine(&none, None), "downloads", json!({"attach": true})).await.expect_err("nothing completed");
    assert_eq!(error.message_for_model, "no completed download is available to attach");
}

#[tokio::test]
async fn downloads_with_wait_polls_until_the_newest_download_completes_then_lists_it() {
    let saved = "/dl/report.pdf";
    let host = Arc::new(FakeHost::scripted(vec![
        downloads_of(&[download("d1", "in_progress", saved)]),
        downloads_of(&[download("d1", "completed", saved)]),
        downloads_of(&[download("d1", "completed", saved)]),
    ]));
    let reply = run(&engine(&host, None), "downloads", json!({"wait": true})).await.expect("the download completes");
    assert!(reply.text.contains("d1"), "{}", reply.text);
    host.finish().expect("two polls and the listing");
}

#[tokio::test]
async fn downloads_with_wait_fails_with_the_state_a_download_ended_in() {
    let host = Arc::new(FakeHost::scripted(vec![downloads_of(&[download("d1", "interrupted", "/dl/report.pdf")])]));
    let error = run(&engine(&host, None), "downloads", json!({"wait": true})).await.expect_err("the download ended without completing");
    assert!(error.message_for_model.contains("d1") && error.message_for_model.contains("interrupted"), "{}", error.message_for_model);
    host.finish().expect("one poll");
}

#[tokio::test]
async fn list_tabs_asks_the_host_for_the_sessions_pages_and_carries_its_timing() {
    let host = Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({"pages": [page_row("p1", "v1")], "activePageId": "p1"}))]));
    let reply = run(&engine(&host, None), "list_tabs", json!({})).await.expect("lists");
    assert!(reply.text.contains("p1"), "{}", reply.text);
    assert!(reply.timing.is_some());
    host.finish().expect("one call");
}

#[tokio::test]
async fn a_command_the_contract_does_not_know_fails_before_it_reaches_the_host() {
    let host = Arc::new(FakeHost::scripted(Vec::new()));
    let error = run(&engine(&host, None), "teleport", json!({})).await.expect_err("unknown");
    assert_eq!(error.message_for_model, "unknown browser action \"teleport\"");
    assert!(host.calls().is_empty());
}

#[tokio::test]
async fn a_session_a_person_took_over_is_refused_with_the_takeover_text() {
    let host = Arc::new(FakeHost::scripted(Vec::new()));
    let error = run(&engine(&host, Some("a person has this session")), "snapshot", json!({})).await.expect_err("taken over");
    assert_eq!(error.message_for_model, "a person has this session");
    assert!(host.calls().is_empty());
}

#[tokio::test]
async fn a_snapshot_resolves_the_page_under_a_lease_reports_it_and_releases_the_lease() {
    let host = Arc::new(FakeHost::scripted(vec![
        resolved("p1").with_params(json!({"sessionId": "s1", "lease": {"ttlMs": 42_000}})),
        snapshot_answer(),
        no_downloads(),
    ]));
    let reply = run(&engine(&host, None), "snapshot", json!({})).await.expect("snapshot");
    assert!(reply.text.contains("Go"), "{}", reply.text);
    assert!(reply.timing.is_some_and(|timing| timing.snapshots == 1));
    host.finish().expect("resolve, snapshot, downloads");
    let released = host.notifications();
    assert_eq!(released.len(), 1);
    assert_eq!(released[0].method, "host/browser/lease/release");
    assert_eq!(released[0].params["leaseId"], "lease-1");
}

#[tokio::test]
async fn the_snapshot_after_a_failed_multi_field_fill_keeps_the_callers_max_chars() {
    let host = Arc::new(FakeHost::scripted(vec![resolved("p1"), snapshot_answer(), no_downloads()]));
    let error =
        run(&engine(&host, None), "fill", json!({"fields": [{"ref": "p1-s1-e9", "text": "x"}], "maxChars": 123})).await.expect_err("the ref is unknown");
    assert!(error.message_for_model.contains("Fill stopped at field 1 of 1"), "{}", error.message_for_model);
    let snapshots: Vec<Value> = host.calls().into_iter().filter(|call| call.method == "host/browser/snapshot").map(|call| call.params).collect();
    assert!(snapshots.iter().any(|params| params["textChars"] == 123), "{snapshots:?}");
}

#[tokio::test]
async fn a_page_a_turn_made_is_closed_when_the_turn_is_aborted_and_kept_when_it_finished() {
    let script = |turn_end: Option<Expect>| {
        let mut calls = vec![resolved_new("p1"), snapshot_answer(), no_downloads()];
        calls.extend(turn_end);
        Arc::new(FakeHost::scripted(calls))
    };
    let kept = script(None);
    let engine_kept = engine(&kept, None);
    run(&engine_kept, "snapshot", json!({})).await.expect("snapshot");
    assert_eq!(engine_kept.finish_turn(&thread(), false).await, 0);
    kept.finish().expect("nothing closed");
    let ended = kept.calls().into_iter().rfind(|call| call.method == "host/browser/turn").expect("the host is told the turn ended");
    assert_eq!((ended.params["op"].as_str(), ended.params["turn"].as_i64(), ended.params["aborted"].as_bool()), (Some("end"), Some(1), Some(false)));

    let aborted = script(Some(Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p1", "reason": "turnEnd"}))));
    let engine_aborted = engine(&aborted, None);
    run(&engine_aborted, "snapshot", json!({})).await.expect("snapshot");
    assert_eq!(engine_aborted.finish_turn(&thread(), true).await, 1);
    aborted.finish().expect("the page closed");
    // The next command is the next turn's: it owns pages of its own and is not refused.
    assert_eq!(locked(&engine_aborted.inner.tasks).current("s1"), 2);
}

#[tokio::test]
async fn the_first_command_after_a_turn_ended_is_the_next_turns_even_before_the_ended_turns_pages_are_closed() {
    let close = Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p1", "reason": "turnEnd"}));
    let host =
        Arc::new(FakeHost::scripted(vec![resolved_new("p1"), snapshot_answer(), no_downloads(), resolved("p1"), snapshot_answer(), no_downloads(), close]));
    let engine = engine(&host, None);
    run(&engine, "snapshot", json!({})).await.expect("snapshot");
    // What `turn_ended` does before it hands the closing to a task.
    let ended = engine.inner.end_turn(&thread(), true).expect("a command ran in the turn");
    assert_eq!((ended.turn, ended.closing.as_slice()), (1, ["p1".to_owned()].as_slice()));
    run(&engine, "snapshot", json!({})).await.expect("the next turn's first command");
    {
        let mut tasks = locked(&engine.inner.tasks);
        assert_eq!(tasks.current("s1"), 2);
        assert!(tasks.take_touched("s1"), "the command is counted in the turn that is running");
    }
    assert_eq!(engine.inner.close_ended(&thread(), ended, true).await, 1);
    host.finish().expect("the ended turn's page closed after the next turn's command");
}

#[tokio::test]
async fn a_turn_that_starts_after_a_command_ran_is_told_to_the_host_and_one_of_a_session_that_never_used_the_browser_is_not() {
    let host = Arc::new(FakeHost::scripted(vec![resolved("p1"), snapshot_answer(), no_downloads()]));
    let engine = engine(&host, None);
    engine.turn_begun(&thread());
    tokio::task::yield_now().await;
    assert!(host.calls().iter().all(|call| call.method != "host/browser/turn"), "nothing to tell before the session used the browser");
    run(&engine, "snapshot", json!({})).await.expect("snapshot");
    engine.inner.turn_note(&thread(), BrowserTurnOp::Begin, Some(2), false).await;
    let begun = host.calls().into_iter().rfind(|call| call.method == "host/browser/turn").expect("the host is told the turn started");
    assert_eq!((begun.params["op"].as_str(), begun.params["turn"].as_i64()), (Some("begin"), Some(2)));
}

#[tokio::test]
async fn a_turn_the_host_was_told_began_is_told_it_ended_though_it_ran_no_command_and_only_once() {
    let host = Arc::new(FakeHost::scripted(vec![resolved("p1"), snapshot_answer(), no_downloads()]));
    let engine = engine(&host, None);
    run(&engine, "snapshot", json!({})).await.expect("snapshot");
    engine.finish_turn(&thread(), false).await;
    // The next turn only reasons and asks the user: it never runs a browser command. What `turn_begun` does before it hands
    // the note to a task.
    assert_eq!(engine.inner.begin_turn(&thread()), Some(2), "the host is told turn 2 began");
    engine.finish_turn(&thread(), false).await;
    // A runtime that stops after the turn settled ends it again: nothing is left to tell.
    engine.finish_turn(&thread(), false).await;
    let ends: Vec<Option<i64>> = host
        .calls()
        .into_iter()
        .filter(|call| call.method == "host/browser/turn" && call.params["op"] == "end")
        .map(|call| call.params["turn"].as_i64())
        .collect();
    assert_eq!(ends, [Some(1), Some(2)]);
    assert_eq!(locked(&engine.inner.tasks).current("s1"), 3, "the next turn is told as a newer one");
}

#[tokio::test]
async fn the_document_revision_of_a_page_is_read_from_the_host_now_and_unknown_when_the_host_cannot_say() {
    let revision =
        |value: i64| Expect::ok("host/browser/revision", json!({"revision": value, "facts": page_facts("p1", 3)})).with_params(json!({"pageId": "p1"}));
    let host = Arc::new(FakeHost::scripted(vec![revision(7), Expect::err("host/browser/revision", HostCallError::Failed { message: "page is gone".into() })]));
    let engine = engine(&host, None);
    let page = PageCtx {
        inner: engine.inner.clone(),
        slot: engine.inner.slot("p1"),
        page_id: "p1".to_owned(),
        thread: thread(),
        turn: 1,
        cancel: CancelSource::new().view(),
        user_wait: UserWait::new(),
        timer: Arc::new(CommandTimer::start(0.0)),
        background: false,
    };
    assert_eq!(page.document_revision(&CancellationToken::new()).await, Some(7));
    assert_eq!(page.document_revision(&CancellationToken::new()).await, None);
    host.finish().expect("both reads were made");
}

#[tokio::test]
async fn a_page_the_host_did_not_call_disposable_is_never_closed_by_a_turn_and_an_idle_turn_tells_the_host_nothing() {
    let host = Arc::new(FakeHost::scripted(vec![resolved("p1"), snapshot_answer(), no_downloads()]));
    let engine = engine(&host, None);
    assert_eq!(engine.finish_turn(&thread(), true).await, 0);
    run(&engine, "snapshot", json!({})).await.expect("snapshot");
    assert_eq!(engine.finish_turn(&thread(), true).await, 0);
    host.finish().expect("no close");
    let told = host.calls().into_iter().filter(|call| call.method == "host/browser/turn").count();
    assert_eq!(told, 1, "only the turn that ran a command ends at the host");
}

#[tokio::test]
async fn a_command_that_failed_after_it_ran_carries_its_timing_and_an_invalid_request_none() {
    let host = Arc::new(FakeHost::scripted(vec![
        resolved("p1"),
        Expect::err("host/browser/snapshot", HostCallError::Failed { message: "page is unavailable".into() }),
    ]));
    let engine = engine(&host, None);
    let failure = engine.run(&thread(), "snapshot", &Map::new(), &CancellationToken::new()).await.expect_err("the snapshot fails");
    assert_eq!(failure.error.message_for_model, "page is unavailable");
    let timing = failure.timing.expect("the command held its lane");
    assert!(timing.command_ms >= 0.0 && timing.command_ms >= timing.snapshot_ms);

    // Screenshot options on a gesture without includeScreenshot are refused before the command takes its place
    // (`screenshotOptionsError`); a field a snapshot does not take is the bridge's refusal, not the engine's.
    let invalid = json!({"fullPage": true}).as_object().cloned().unwrap_or_default();
    let failure = engine.run(&thread(), "click", &invalid, &CancellationToken::new()).await.expect_err("screenshot options without includeScreenshot");
    assert!(failure.timing.is_none(), "an invalid request never took its place");
}

#[tokio::test]
async fn a_failure_on_a_page_the_command_made_closes_the_blank_page_and_says_so() {
    let host = Arc::new(FakeHost::scripted(vec![
        resolved_new("p1"),
        Expect::err("host/browser/snapshot", HostCallError::Failed { message: "page is unavailable".into() }),
        Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p1", "reason": "discard"})),
    ]));
    let error = run(&engine(&host, None), "snapshot", json!({})).await.expect_err("fails");
    assert_eq!(error.message_for_model, "page is unavailable. The blank tab this command opened was closed.");
    host.finish().expect("resolve, snapshot, discard");
    // A page that was not the command's own is left alone, and so is one the host kept (it answers not closed).
    let kept = Arc::new(FakeHost::scripted(vec![
        resolved("p1"),
        Expect::err("host/browser/snapshot", HostCallError::Failed { message: "page is unavailable".into() }),
    ]));
    let error = run(&engine(&kept, None), "snapshot", json!({})).await.expect_err("fails");
    assert_eq!(error.message_for_model, "page is unavailable");
    kept.finish().expect("no discard");
}

/// The page a command just opened in the background: the host answers before the page committed its first blank document, so
/// its facts name the document and no address (`describe` of the host's `pages.ts` right after `ensureOffscreen`).
fn resolved_blank(page: &str, tab: &str) -> Expect {
    let mut row = page_row(page, tab);
    row["background"] = json!(true);
    row["created"] = json!(true);
    row["disposable"] = json!(true);
    row["facts"]["url"] = json!("");
    row["facts"]["background"] = json!(true);
    row["facts"]["visible"] = json!(false);
    Expect::ok("host/browser/pages/resolve", json!({"page": row, "leaseId": "lease-1"}))
}

/// A page's facts on `document` with a dialog open: a navigation that ends on one answers with the dialog, without the settle.
fn facts_with_dialog(page: &str, seq: u64, document: &str) -> Value {
    let mut facts = page_facts(page, seq);
    facts["documentId"] = json!(document);
    facts["url"] = json!("https://b.test/app");
    facts["pendingDialog"] = json!({"type": "alert", "message": "Arrived", "openedAt": 1, "bridge": false});
    facts
}

fn sent(host: &FakeHost, method: &str) -> Vec<Value> {
    host.calls().into_iter().filter(|call| call.method == method).map(|call| call.params).collect()
}

fn page_ctx(engine: &BrowserEngine, page: &str) -> PageCtx {
    PageCtx {
        inner: engine.inner.clone(),
        slot: engine.inner.slot(page),
        page_id: page.to_owned(),
        thread: thread(),
        turn: 1,
        cancel: CancelSource::new().view(),
        user_wait: UserWait::new(),
        timer: Arc::new(CommandTimer::start(0.0)),
        background: false,
    }
}

#[tokio::test]
async fn a_navigate_into_the_background_tab_it_just_opened_is_decided_against_the_document_alone() {
    let host = Arc::new(FakeHost::scripted(vec![
        resolved_blank("p1", "live").with_params(json!({"background": true, "tab": {"pageId": "live"}, "open": {"reveal": false}})),
        Expect::ok("host/browser/page/navigate", json!({"facts": facts_with_dialog("p1", 2, "p1:2")})).with_params(json!({"pageId": "p1", "kind": "url"})),
    ]));
    let reply =
        run(&engine(&host, None), "navigate", json!({"url": "https://b.test/app", "background": true, "tab": "live"})).await.expect("the navigation is sent");
    assert!(reply.text.contains("Arrived"), "{}", reply.text);
    host.finish().expect("resolve, navigate");
    // The blank page's own first load commits `about:blank` after the host described it: the address is not part of the guard, so
    // that commit is no change under the command; nor are the origin, the frames or an observation, which the move discards.
    assert_eq!(sent(&host, "host/browser/page/navigate")[0]["expect"], json!({"documentId": "p1:1"}));
    assert!(sent(&host, "host/browser/pages/close").is_empty(), "the tab holds the page now");
}

#[tokio::test]
async fn a_navigate_reload_and_back_name_the_document_alone_on_a_page_with_an_address_and_an_observation() {
    let moves = [("navigate", json!({"url": "https://b.test/app"}), "url"), ("navigate", json!({"reload": true}), "reload"), ("back", json!({}), "back")];
    for (action, input, kind) in moves {
        let host = Arc::new(FakeHost::scripted(vec![
            resolved("p1"),
            snapshot_answer(),
            no_downloads(),
            resolved("p1"),
            Expect::ok("host/browser/page/navigate", json!({"facts": facts_with_dialog("p1", 3, "p1:2")})).with_params(json!({"pageId": "p1", "kind": kind})),
        ]));
        let engine = engine(&host, None);
        run(&engine, "snapshot", json!({})).await.expect("snapshot");
        run(&engine, action, input).await.expect(kind);
        host.finish().expect(kind);
        assert_eq!(sent(&host, "host/browser/page/navigate")[0]["expect"], json!({"documentId": "p1:1"}), "{kind}");
    }
}

fn refused_document(document: &str, seq: u64) -> Expect {
    let mut facts = page_facts("p1", seq);
    facts["documentId"] = json!(document);
    Expect::err(
        "host/browser/page/navigate",
        HostCallError::PreconditionFailed { reason: BrowserPreconditionReason::Document, facts: Box::new(serde_json::from_value(facts).expect("facts")) },
    )
}

#[tokio::test]
async fn a_navigate_the_host_refused_for_its_document_is_sent_once_more_against_the_document_the_refusal_told() {
    let host = Arc::new(FakeHost::scripted(vec![
        resolved("p1"),
        refused_document("p1:2", 5).with_params(json!({"expect": {"documentId": "p1:1"}})),
        Expect::ok("host/browser/page/navigate", json!({"facts": facts_with_dialog("p1", 6, "p1:3")})).with_params(json!({"expect": {"documentId": "p1:2"}})),
    ]));
    let reply = run(&engine(&host, None), "navigate", json!({"url": "https://b.test/app"})).await.expect("the second send moves the page");
    assert!(reply.text.contains("Arrived"), "{}", reply.text);
    host.finish().expect("resolve, navigate refused, navigate");
}

#[tokio::test]
async fn a_navigate_refused_for_its_document_twice_is_the_failure_in_the_words_of_a_page_that_changed() {
    let racing = Arc::new(FakeHost::scripted(vec![
        resolved("p1"),
        refused_document("p1:2", 5),
        refused_document("p1:3", 6).with_params(json!({"expect": {"documentId": "p1:2"}})),
    ]));
    let error = run(&engine(&racing, None), "navigate", json!({"url": "https://b.test/app"})).await.expect_err("refused twice");
    assert_eq!(
        error.message_for_model,
        "the page changed before the action was sent (Document); nothing was dispatched. Take a fresh snapshot before continuing."
    );
    racing.finish().expect("two sends, no third");
}

/// The tab a refused navigate opened is closed again: the host is asked once, for the page the command made.
fn discarded(page: &str) -> Expect {
    Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": page, "reason": "discard"}))
}

#[tokio::test]
async fn a_navigate_the_url_rules_refuse_ends_at_once_in_the_rules_words_and_its_address_never_reaches_the_host() {
    let refusals = [
        ("file:///C:/Windows/win.ini", "only http(s) navigation is allowed (got file:)"),
        ("javascript:alert(1)", "only http(s) navigation is allowed (got javascript:)"),
        ("data:text/html,<h1>x</h1>", "only http(s) navigation is allowed (got data:)"),
        ("about:blank", "only http(s) navigation is allowed (got about:)"),
        ("blob:https://a.test/0b9c", "only http(s) navigation is allowed (got blob:)"),
        ("view-source:https://a.test/", "only http(s) navigation is allowed (got view-source:)"),
        ("chrome://settings", "only http(s) navigation is allowed (got chrome:)"),
        ("ftp://a.test/file", "only http(s) navigation is allowed (got ftp:)"),
        ("ws://a.test/socket", "only http(s) navigation is allowed (got ws:)"),
        ("http://user:pw@127.0.0.1:8080/app", "URLs containing embedded credentials are not allowed"),
        ("http://169.254.169.254/latest/meta-data/", "navigation to cloud metadata endpoints is blocked"),
    ];
    for (url, sentence) in refusals {
        let host = Arc::new(FakeHost::scripted(vec![
            resolved_blank("p1", "policy").with_params(json!({"background": true, "tab": {"pageId": "policy"}, "open": {"reveal": false}})),
            discarded("p1"),
        ]));
        let error = run(&engine(&host, None), "navigate", json!({"url": url, "background": true, "tab": "policy"})).await.expect_err(url);
        assert_eq!(error.message_for_model, format!("{sentence}. The blank tab this command opened was closed."), "{url}");
        // Two requests and no more: the page the command works on, and its close. Nothing waits on a load.
        host.finish().expect(url);
        assert_eq!(host.calls().len(), 2, "{url}");
        assert!(sent(&host, "host/browser/page/navigate").is_empty(), "{url}: the address never reaches the host");
    }
}

#[tokio::test]
async fn a_navigate_the_url_rules_refuse_on_an_already_open_page_sends_nothing_but_the_resolve() {
    let open = Arc::new(FakeHost::scripted(vec![resolved("p1")]));
    let error = run(&engine(&open, None), "navigate", json!({"url": "file:///C:/Windows/win.ini"})).await.expect_err("refused");
    assert_eq!(error.message_for_model, "only http(s) navigation is allowed (got file:)");
    open.finish().expect("the resolve alone");
    assert_eq!(open.calls().len(), 1);
}

#[tokio::test]
async fn a_host_that_cannot_close_the_refused_tab_changes_nothing_of_the_refusal_the_agent_reads() {
    let closing = Arc::new(FakeHost::scripted(vec![resolved_blank("p1", "policy"), Expect::err("host/browser/pages/close", HostCallError::ConnectionLost)]));
    let error =
        run(&engine(&closing, None), "navigate", json!({"url": "file:///C:/Windows/win.ini", "background": true, "tab": "policy"})).await.expect_err("refused");
    assert_eq!(error.message_for_model, "only http(s) navigation is allowed (got file:)");
    closing.finish().expect("resolve, the close that failed");
}

#[tokio::test]
async fn a_navigate_the_host_refused_or_failed_is_the_failure_and_is_sent_once() {
    // The host admits the address once more against what the name resolves to (`admitUrl` of the host's `page.ts`, -32015). Only a
    // refused document is sent again (`PageCtx::moved`): a refusal of the address, a failed load and a `refused` answer are not.
    let private = "navigation to intranet.test resolved to blocked private or internal address 10.0.0.7";
    let failed = "navigation failed: net::ERR_NAME_NOT_RESOLVED";
    let answers = [
        (Expect::err("host/browser/page/navigate", HostCallError::Refused { reason: private.into() }), private),
        (Expect::err("host/browser/page/navigate", HostCallError::Failed { message: failed.into() }), failed),
        (Expect::ok("host/browser/page/navigate", json!({"facts": page_facts("p1", 2), "refused": {"reason": "nowhere to go"}})), "nowhere to go"),
    ];
    for (answer, message) in answers {
        let host = Arc::new(FakeHost::scripted(vec![resolved_blank("p1", "policy"), answer, discarded("p1")]));
        let error =
            run(&engine(&host, None), "navigate", json!({"url": "https://intranet.test/", "background": true, "tab": "policy"})).await.expect_err(message);
        assert_eq!(error.message_for_model, format!("{message}. The blank tab this command opened was closed."));
        host.finish().expect(message);
        assert_eq!(sent(&host, "host/browser/page/navigate").len(), 1, "{message}: one send");
    }
}

#[tokio::test]
async fn a_page_with_no_address_binds_a_call_to_its_document_and_one_with_an_address_to_the_address_too() {
    let host = Arc::new(FakeHost::scripted(Vec::new()));
    let engine = engine(&host, None);
    let page = page_ctx(&engine, "p1");
    let mut blank = page_facts("p1", 1);
    blank["url"] = json!("");
    engine.inner.store.record(&serde_json::from_value(blank).expect("facts"));
    let expect = serde_json::to_value(page.page_precondition()).expect("precondition");
    assert_eq!(expect, json!({"documentId": "p1:1", "childSessions": []}), "no address to bind before the first document commits");

    // The host then tells the blank document: the address binds every later call, and so does the origin once the page has one.
    let mut committed = page_facts("p1", 2);
    committed["url"] = json!("about:blank");
    engine.inner.store.record(&serde_json::from_value(committed).expect("facts"));
    assert_eq!(serde_json::to_value(page.page_precondition()).expect("precondition"), json!({"documentId": "p1:1", "url": "about:blank", "childSessions": []}));
    engine.inner.store.record(&serde_json::from_value(page_facts("p1", 3)).expect("facts"));
    let bound = serde_json::to_value(page.page_precondition()).expect("precondition");
    assert_eq!(bound, json!({"documentId": "p1:1", "origin": "https://a.test", "url": "https://a.test/", "childSessions": []}));
    assert_eq!(serde_json::to_value(page.navigation_precondition()).expect("precondition"), json!({"documentId": "p1:1"}));
}

#[tokio::test]
async fn a_script_on_the_blank_tab_the_command_opened_is_bound_to_the_document_and_not_to_an_address() {
    let host = Arc::new(FakeHost::scripted(vec![
        resolved_blank("p1", "calc"),
        Expect::err("host/browser/page/eval", HostCallError::Failed { message: "the script threw".into() }),
        Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p1", "reason": "discard"})),
    ]));
    let error = run(&engine(&host, None), "evaluate", json!({"script": "1 + 1", "background": true, "tab": "calc"})).await.expect_err("the script fails");
    assert_eq!(error.message_for_model, "the script threw. The blank tab this command opened was closed.");
    host.finish().expect("resolve, eval, discard");
    assert_eq!(sent(&host, "host/browser/page/eval")[0]["expect"], json!({"documentId": "p1:1", "childSessions": []}));
}

#[tokio::test]
async fn a_page_that_changed_under_an_observation_still_refuses_the_call_bound_to_it() {
    let mut moved = page_facts("p1", 4);
    moved["url"] = json!("https://a.test/elsewhere");
    let host = Arc::new(FakeHost::scripted(vec![
        resolved("p1"),
        snapshot_answer(),
        no_downloads(),
        resolved("p1"),
        Expect::err(
            "host/browser/page/eval",
            HostCallError::PreconditionFailed { reason: BrowserPreconditionReason::Url, facts: Box::new(serde_json::from_value(moved).expect("facts")) },
        ),
    ]));
    let engine = engine(&host, None);
    run(&engine, "snapshot", json!({})).await.expect("snapshot");
    let error = run(&engine, "evaluate", json!({"script": "document.title"})).await.expect_err("the page moved on");
    assert_eq!(error.message_for_model, "the page changed before the action was sent (Url); nothing was dispatched. Take a fresh snapshot before continuing.");
    host.finish().expect("one eval, not sent again");
    // The call carried everything the observation was made of: the document, the address and origin, the frames and the snapshot.
    let expect = &sent(&host, "host/browser/page/eval")[0]["expect"];
    assert_eq!(*expect, json!({"documentId": "p1:1", "origin": "https://a.test", "url": "https://a.test/", "childSessions": [], "snapshotId": "p1-s1"}));
    assert_eq!(
        engine.inner.store.get("p1").map(|facts| facts.url),
        Some("https://a.test/elsewhere".to_owned()),
        "the refusal's facts are the page's present ones"
    );
}

#[tokio::test]
async fn a_sign_in_the_host_made_leads_a_fresh_observation_and_a_linked_identity_leads_the_reply() {
    let note = "Signed in to a.test with its saved login (the password never left the host).";
    let host = Arc::new(FakeHost::scripted(vec![
        resolved("p1"),
        snapshot_answer(),
        no_downloads(),
        Expect::ok("host/browser/signIn", json!({"note": note, "line": "Linked sign-in: a.test used Google."}))
            .with_params(json!({"op": "afterCommand", "sessionId": "s1", "pageId": "p1", "turn": 1, "explicitFill": false})),
        snapshot_answer(),
        no_downloads(),
    ]));
    let reply = run(&engine(&host, None), "snapshot", json!({})).await.expect("snapshot");
    assert!(reply.text.starts_with(&format!("Linked sign-in: a.test used Google.\n\n{note}\n\n")), "{}", reply.text);
    assert!(reply.text.contains("Go"), "{}", reply.text);
    host.finish().expect("the observation was taken again");
}

#[tokio::test]
async fn a_page_a_dialog_holds_answers_with_the_dialog_and_the_sign_in_hooks_are_not_asked() {
    let mut page = page_row("p1", "v1");
    page["facts"]["pendingDialog"] = json!({"type": "alert", "message": "Sure?", "openedAt": 1, "bridge": false});
    let host = Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/resolve", json!({"page": page, "leaseId": "lease-1"}))]));
    let reply = run(&engine(&host, None), "click", json!({"ref": "e1"})).await.expect("the dialog is the reply");
    assert!(reply.text.contains("Sure?"), "{}", reply.text);
    assert!(!host.calls().iter().any(|call| call.method == "host/browser/signIn"), "a page a dialog blocks is not read by the sign-in hooks");
}

#[tokio::test]
async fn a_host_that_cannot_answer_the_sign_in_hooks_leaves_the_reply_as_it_was() {
    let host = Arc::new(FakeHost::scripted(vec![
        resolved("p1"),
        snapshot_answer(),
        no_downloads(),
        Expect::err("host/browser/signIn", HostCallError::Failed { message: "vault unreadable".into() }),
    ]));
    let reply = run(&engine(&host, None), "snapshot", json!({})).await.expect("snapshot");
    assert!(reply.text.contains("Go") && !reply.text.contains("vault"), "{}", reply.text);
    host.finish().expect("asked once");
}

#[tokio::test]
async fn the_page_state_the_host_pushes_is_kept_with_the_facts_of_its_answers() {
    let host = Arc::new(FakeHost::scripted(Vec::new()));
    let engine = engine(&host, None);
    let lane: Arc<dyn EngineSink> = Arc::new(crate::lane::sink::EngineSinkImpl::new(Arc::new(Mirror::new()), Arc::new(UserHold::new())));
    let sink = engine.sink(lane);
    let facts: PageFacts = serde_json::from_value(page_facts("p9", 4)).expect("facts");
    sink.facts(HostBrowserPageFactsParams { page_id: "p9".into(), seq: 4, facts: facts.clone() });
    assert_eq!(engine.inner.store.get("p9"), Some(facts));
    sink.host_gone();
    assert_eq!(engine.inner.store.get("p9"), None);
}

#[test]
fn an_open_says_where_the_page_is_or_fails_to_place_it() {
    let facts: PageFacts = serde_json::from_value(page_facts("p1", 1)).expect("facts");
    let shown = placement_line(&facts, Some(BrowserPlacement::Shown)).expect("shown");
    assert_eq!(shown, "Shown in the browser panel: page p1 \u{2014} (untitled) (https://a.test/).");
    let pending = placement_line(&facts, Some(BrowserPlacement::Pending)).expect("pending");
    assert!(pending.starts_with("Not on screen yet: page p1") && pending.ends_with("Do not tell the user it is on screen."), "{pending}");
    assert!(matches!(placement_line(&facts, None), Err(RunError::Failed(_))));
}

#[test]
fn the_host_failures_a_command_meets_are_told_in_the_agents_words() {
    assert!(matches!(RunError::from(HostCallError::Cancelled), RunError::Cancelled(None)));
    assert!(matches!(RunError::from(HostCallError::UserInput { until: None }), RunError::Failed(text) if text == LOCAL_INPUT_TAKEOVER));
    assert!(matches!(RunError::from(HostCallError::Refused { reason: "blocked scheme".into() }), RunError::Failed(text) if text == "blocked scheme"));
    let dialog: BrowserPendingDialog = serde_json::from_value(json!({"type": "alert", "message": "Sure?", "openedAt": 1, "bridge": false})).expect("dialog");
    match RunError::from(HostCallError::DialogBlocking { dialog: Box::new(dialog) }) {
        RunError::Reply(reply) => assert_eq!(reply.outcome, Some(ReplyOutcome::Blocked)),
        other => panic!("{other:?}"),
    }
}

/// The connection loss is the typed cause, not a wording: a page exception whose text equals the transport message stays an
/// ordinary failure.
#[test]
fn only_the_typed_connection_loss_marks_a_command_failure_as_lost() {
    let lost = RunError::from(HostCallError::ConnectionLost);
    assert!(matches!(lost, RunError::ConnectionLost));
    let message = HostCallError::ConnectionLost.to_string();
    let thrown = RunError::from(HostCallError::Failed { message: message.clone() });
    assert!(matches!(&thrown, RunError::Failed(text) if *text == message));
    let unsupported = RunError::from(HostCallError::Unavailable { detail: "unsupportedMethod".into() });
    assert!(matches!(unsupported, RunError::Failed(_)));
    assert_eq!(lost.into_tool_error(&Masks, "s1").message_for_model, message);
}

/// Every conversion between the host call and the tool answer keeps the typed loss: the follow-up snapshot of a form edit
/// (`into_ref`), a step (`into_action`), an observation (`into_observe`), and the settle's and the reply wait's errors.
#[test]
fn the_typed_connection_loss_survives_every_conversion() {
    assert_eq!(RunError::ConnectionLost.into_ref(), RefError::Host(HostCallError::ConnectionLost));
    assert_eq!(RunError::ConnectionLost.into_action(), ActionError::Host(HostCallError::ConnectionLost));
    assert_eq!(RunError::ConnectionLost.into_observe(), observe::ActionError::Host(HostCallError::ConnectionLost));
    assert!(matches!(RunError::from(SettleError::ConnectionLost), RunError::ConnectionLost));
    assert!(matches!(RunError::from(ReplyWaitError::Settle(SettleError::ConnectionLost)), RunError::ConnectionLost));
    // Down the other way: a ref error that carries it is a host error that carries it.
    assert_eq!(ref_to_host(RefError::Host(HostCallError::ConnectionLost)), HostCallError::ConnectionLost);
    assert_eq!(action_to_ref(ActionError::Host(HostCallError::ConnectionLost)), RefError::Host(HostCallError::ConnectionLost));
}

#[test]
fn a_failure_leaves_through_the_secret_guard_and_a_refusal_keeps_its_type() {
    let failed = RunError::Failed("could not type hunter2".into()).into_tool_error(&Masks, "s1");
    assert_eq!(failed.message_for_model, "could not type [secret]");
    let denied = RunError::from(ApprovalError::NotApproved { reason: "no".into() }).into_tool_error(&Masks, "s1");
    assert_eq!(denied.code, ToolErrorCode::PermissionDenied);
    assert_eq!(RunError::Cancelled(None).into_tool_error(&Masks, "s1").code, ToolErrorCode::Cancelled);
}

#[test]
fn the_approval_reads_what_a_step_targets_and_what_it_submits_without_its_values() {
    let command = json!({
        "action": "sequence", "session_life": "life-1", "unattended_run": true, "unattended_agent": " bot ",
        "steps": [{"action": "click", "target": {"role": "button", "name": "Send"}}, {"action": "fill", "ref": "p1-s1-e2", "submit": true, "text": "hunter2"}],
    });
    let read = approval_command(&thread(), &command, "p1:1");
    assert_eq!(read.steps.len(), 2);
    assert_eq!((read.steps[0].action.as_str(), read.steps[0].target_name.as_str()), ("click", "Send"));
    assert_eq!(read.steps[0].describe, "button \"Send\"");
    assert!(read.steps[1].submit);
    assert_eq!(read.steps[1].describe, "p1-s1-e2");
    assert_eq!((read.session_life.as_str(), read.unattended, read.unattended_agent.as_str()), ("life-1", true, "bot"));
    let bare = approval_command(&thread(), &json!({"action": "press", "key": "Enter"}), "p1:1");
    assert_eq!((bare.step.key.as_str(), bare.step.describe.as_str()), ("Enter", "p1:1"));
}

/// An approval port that records what it was asked and answers every step the same way.
struct Asked {
    prompts: Mutex<Vec<BrowserApprovalPrompt>>,
    allow: bool,
}

impl Asked {
    fn answering(allow: bool) -> Arc<Self> {
        Arc::new(Self { prompts: Mutex::default(), allow })
    }

    fn prompts(&self) -> Vec<BrowserApprovalPrompt> {
        self.prompts.lock().unwrap().clone()
    }
}

#[async_trait]
impl ApprovalPort for Asked {
    async fn ask(&self, prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
        self.prompts.lock().unwrap().push(prompt);
        Ok(if self.allow { ApprovalAnswer::Allow { remember: crate::types::Remember::Once } } else { ApprovalAnswer::Deny { reason: String::new() } })
    }
}

/// A disk on which every path is a regular file of 16 bytes that is its own canonical path.
struct EveryFile;

#[async_trait]
impl FilePort for EveryFile {
    async fn stat(&self, path: &Path) -> FileFacts {
        FileFacts { exists: true, is_file: true, size: 16, canonical: Some(path.to_path_buf()), modified: Some(SystemTime::UNIX_EPOCH) }
    }

    async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
        Ok(run_dir.to_path_buf())
    }
}

fn engine_asking(host: &Arc<FakeHost>, approvals: &Arc<Asked>, approval_policy: ActionPolicy) -> BrowserEngine {
    BrowserEngine::new(
        host.clone(),
        EnginePorts {
            mirror: Arc::new(Mirror::new()),
            hold: Arc::new(UserHold::new()),
            approvals: approvals.clone(),
            takeover: Arc::new(Takeovers(None)),
            blobs: Arc::new(NoBlobs),
            files: Arc::new(EveryFile),
            secrets: Arc::new(Masks),
            approval_policy,
            urls: UrlPolicy::default(),
            frame_dir: PathBuf::from("frames"),
        },
    )
}

/// A page of this PC's own loopback server.
const LOOPBACK_PAGE: &str = "http://127.0.0.1:5173/app";

fn loopback_facts(seq: u64) -> Value {
    let mut facts = page_facts("p1", seq);
    facts["url"] = json!(LOOPBACK_PAGE);
    facts
}

fn resolved_on_loopback(session: &str) -> Expect {
    let row = json!({"pageId": "p1", "tabId": "v1", "sessionId": session, "background": false, "facts": loopback_facts(1)});
    Expect::ok("host/browser/pages/resolve", json!({"page": row, "leaseId": "lease-1"}))
}

fn no_payment_evidence() -> Expect {
    Expect::ok("host/browser/page/eval", json!({"value": false, "facts": loopback_facts(2)}))
}

async fn run_in(engine: &BrowserEngine, session: &str, action: &str, input: Value) -> Result<ToolReply, ToolError> {
    let input = input.as_object().cloned().unwrap_or_default();
    engine.run(&ThreadId::from(session), action, &input, &CancellationToken::new()).await.map_err(|failure| failure.error)
}

/// What the host was asked, by wire name, without the hooks asked around every command.
fn asked_of(host: &FakeHost) -> Vec<String> {
    host.calls().into_iter().map(|call| call.method).filter(|method| method != "host/browser/signIn" && method != "host/browser/turn").collect()
}

/// The sessions a step is handed to the port from: a bot's home chat, its room seat, a task session and a coding session. For
/// which of them a person is asked is the port's rule (`approval-dialog.ts`: a bot's own session only), never the engine's.
const ASKING_SESSIONS: [&str; 4] = ["sess_home_ann", "sess_rmem_room01_ann", "sess_task", "s1"];

#[tokio::test]
async fn a_submit_is_handed_to_the_approval_port_before_anything_is_dispatched_on_a_loopback_page_too_from_every_session() {
    for session in ASKING_SESSIONS {
        let host = Arc::new(FakeHost::scripted(vec![resolved_on_loopback(session), no_payment_evidence()]));
        let approvals = Asked::answering(false);
        let engine = engine_asking(&host, &approvals, ActionPolicy::from_env(None, None, None, is_action));
        let command = json!({"ref": "p1-s1-e1", "text": "live-submit hunter2", "submit": true});
        let denied = run_in(&engine, session, "type", command).await.expect_err("the person said no");
        assert_eq!(denied.message_for_model, browser_not_approved(""), "{session}");
        assert_eq!(denied.code, ToolErrorCode::PermissionDenied, "{session}");
        let prompts = approvals.prompts();
        assert_eq!(prompts.len(), 1, "{session}: asked once");
        let prompt = &prompts[0];
        assert_eq!(prompt.kinds, [BrowserApprovalRememberKind::Submit], "{session}");
        assert_eq!((prompt.action.as_str(), prompt.url.as_str()), ("type", LOOPBACK_PAGE), "{session}");
        assert_eq!((prompt.session_id.as_str(), prompt.thread_id.as_ref().map(ThreadId::as_str)), (session, Some(session)), "{session}");
        // The card names the target and that the form is submitted, never what was typed.
        assert_eq!(prompt.target, "p1-s1-e1\nSubmit form", "{session}");
        assert!(prompt.paths.is_empty() && prompt.files.is_empty() && prompt.receiver_origin.is_empty(), "{session}");
        assert!(!prompt.payment && !prompt.unattended && prompt.session_life.is_empty(), "{session}");
        // The page was resolved and read for payment evidence; nothing was typed or submitted.
        assert_eq!(asked_of(&host), ["host/browser/pages/resolve", "host/browser/page/eval"], "{session}");
        host.finish().expect("no call beyond the script");
    }
}

#[test]
fn the_directory_knows_the_selected_page_and_the_named_background_pages_of_a_session() {
    let page = |id: &str, tab: &str, background: bool| -> PageDescriptor {
        serde_json::from_value(json!({"pageId": id, "tabId": tab, "sessionId": "s1", "background": background, "facts": page_facts(id, 1)})).expect("page")
    };
    let mut directory = Directory::default();
    directory.observe_list("s1", &[page("p1", "v1", false), page("p2", "research", true)], Some("p1"));
    assert_eq!(directory.current_page_id("s1").as_deref(), Some("p1"));
    assert_eq!(directory.background_page_id("s1", "research").as_deref(), Some("p2"));
    assert_eq!(directory.background_name_by_page_id("s1", "p2").as_deref(), Some("research"));
    assert_eq!(directory.current_page_id("s2"), None);
    let key = QueueKey::for_command(&directory, &KeyInput { session: Some("s1"), action: "click", tab: "research", background: false }).expect("key");
    assert_eq!((key.lane(), key.page()), ("session:s1:background:research", Some("p2")));
    directory.forget_page("p2");
    assert_eq!(directory.background_page_id("s1", "research"), None);
}

#[tokio::test]
async fn close_tab_closes_a_background_page_by_its_name_and_refuses_the_visible_tab() {
    let background = json!({"pageId": "p2", "tabId": "research", "sessionId": "s1", "background": true, "facts": page_facts("p2", 1)});
    // A tab the person opened with "+": shown (`background: false`) but named, so it is no visible `vN`.
    let user = json!({"pageId": "p3", "tabId": "user-tab-1", "sessionId": "s1", "background": false, "facts": page_facts("p3", 1)});
    let listing = || Expect::ok("host/browser/pages/list", json!({"pages": [page_row("p1", "v1"), background.clone(), user.clone()], "activePageId": "p1"}));
    let host = Arc::new(FakeHost::scripted(vec![
        listing(),
        Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p2", "reason": "agent"})),
        listing(),
        listing(),
        listing(),
        Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p3", "reason": "agent"})),
        listing(),
        Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p3", "reason": "agent"})),
    ]));
    let engine = engine(&host, None);
    let closed = run(&engine, "close_tab", json!({"tab": "research"})).await.expect("closes");
    assert_eq!(closed.text, "Closed background tab \"research\".");
    let visible = run(&engine, "close_tab", json!({"tab": "v1"})).await.expect_err("visible");
    assert!(visible.message_for_model.starts_with("\"v1\" is the visible tab"), "{}", visible.message_for_model);
    let unknown = run(&engine, "close_tab", json!({"tab": "nowhere"})).await.expect_err("unknown");
    assert_eq!(unknown.message_for_model, "unknown background tab \"nowhere\"; call list_tabs");
    // The user-opened tab closes by its page id in any case, and by its name.
    let by_id = run(&engine, "close_tab", json!({"tab": "P3"})).await.expect("closes");
    assert_eq!(by_id.text, "Closed background tab \"user-tab-1\".");
    let by_name = run(&engine, "close_tab", json!({"tab": "user-tab-1"})).await.expect("closes");
    assert_eq!(by_name.text, "Closed background tab \"user-tab-1\".");
    // An empty name is refused before the host is asked.
    let empty = run(&engine, "close_tab", json!({"tab": ""})).await.expect_err("empty");
    assert_eq!(empty.message_for_model, "a background tab name is required");
    host.finish().expect("list, close, list, list, list, close, list, close");
}

#[tokio::test]
async fn status_without_a_tab_reports_the_background_pages_when_no_visible_page_is_open() {
    let background = |id: &str, name: &str| json!({"pageId": id, "tabId": name, "sessionId": "s1", "background": true, "facts": page_facts(id, 1)});
    let host =
        Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({"pages": [background("p1", "alpha"), background("p2", "beta")]}))]));
    let reply = run(&engine(&host, None), "status", json!({})).await.expect("reports the session's pages");
    assert!(!reply.text.contains("No browser page is open"), "{}", reply.text);
    assert!(reply.text.contains("- p1 [\"alpha\"] (background):") && reply.text.contains("- p2 [\"beta\"] (background):"), "{}", reply.text);
    host.finish().expect("the listing only: no page was resolved");
}

#[tokio::test]
async fn status_asking_for_the_visible_page_reports_the_background_pages_when_none_is_visible() {
    let background = |id: &str, name: &str| json!({"pageId": id, "tabId": name, "sessionId": "s1", "background": true, "facts": page_facts(id, 1)});
    let host = Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({"pages": [background("p1", "alpha")]}))]));
    let reply = run(&engine(&host, None), "status", json!({"background": false})).await.expect("reports the session's pages");
    assert!(!reply.text.contains("No browser page is open"), "{}", reply.text);
    assert!(reply.text.contains("- p1 [\"alpha\"] (background):"), "{}", reply.text);
    host.finish().expect("the listing only: no page was resolved");
}

#[tokio::test]
async fn status_without_a_tab_still_reads_the_page_when_a_visible_one_is_open() {
    let host = Arc::new(FakeHost::scripted(vec![
        Expect::ok("host/browser/pages/list", json!({"pages": [page_row("p1", "v1")], "activePageId": "p1"})),
        resolved("p1"),
    ]));
    let reply = run(&engine(&host, None), "status", json!({})).await.expect("status");
    assert!(reply.text.contains("Page: p1"), "{}", reply.text);
}

#[tokio::test]
async fn list_tabs_numbers_only_the_visible_tab_and_names_a_user_opened_one() {
    let user = json!({"pageId": "p3", "tabId": "user-tab-1", "sessionId": "s1", "background": false, "facts": page_facts("p3", 1)});
    let host = Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({"pages": [page_row("p1", "v1"), user], "activePageId": "p3"}))]));
    let reply = run(&engine(&host, None), "list_tabs", json!({})).await.expect("lists");
    assert!(
        reply.text.contains("- p1 [v1]:") && reply.text.contains("- p3 [\"user-tab-1\"] (background):") && !reply.text.contains("(active)"),
        "{}",
        reply.text
    );
    host.finish().expect("one call");
}

/// A `tab:` target goes to the host as it was named, `v1` for the pane's tab and the name for a user-opened one.
#[tokio::test]
async fn a_tab_target_is_handed_to_the_host_as_named() {
    for tab in ["v1", "user-tab-1"] {
        let host = Arc::new(FakeHost::scripted(vec![resolved("p1"), Expect::ok("host/browser/snapshot", json!({"facts": page_facts("p1", 2)}))]));
        let _ = run(&engine(&host, None), "snapshot", json!({"tab": tab})).await;
        let resolve = host.calls().into_iter().find(|call| call.method == "host/browser/pages/resolve").expect("resolve call");
        assert_eq!(resolve.params["tab"]["pageId"], json!(tab));
    }
}

#[tokio::test]
async fn hide_asks_the_host_to_put_the_panel_away() {
    let host = Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/surface", json!({})).with_params(json!({"sessionId": "s1", "op": "hide"}))]));
    let reply = run(&engine(&host, None), "hide", json!({})).await.expect("hides");
    assert_eq!(reply.text, "Browser panel hide requested; tabs and page state are preserved.");
    host.finish().expect("one call");
}

#[tokio::test]
async fn an_open_shows_the_page_and_says_where_it_is() {
    let answer = Expect::ok("host/browser/pages/resolve", json!({"page": page_row("p1", "v1"), "leaseId": "lease-1", "placement": "shown"}))
        .with_params(json!({"sessionId": "s1", "open": {"reveal": true}}));
    let host = Arc::new(FakeHost::scripted(vec![answer]));
    let reply = run(&engine(&host, None), "open", json!({})).await.expect("opens");
    assert_eq!(reply.text, "Shown in the browser panel: page p1 \u{2014} (untitled) (https://a.test/).");
    host.finish().expect("one call");
    assert_eq!(host.notifications().len(), 1);
}

#[tokio::test]
async fn a_step_the_operator_denied_is_refused_before_anything_reaches_the_page() {
    let host = Arc::new(FakeHost::scripted(vec![resolved("p1")]));
    let policy = ActionPolicy::from_env(None, Some("click"), None, is_action);
    let error = run(&engine_with(&host, None, policy), "click", json!({"ref": "p1-s1-e1"})).await.expect_err("denied");
    assert_eq!(error.message_for_model, "Browser Use action is denied by policy; nothing was dispatched");
    host.finish().expect("only the page was resolved");
}

#[tokio::test]
async fn a_turns_pages_are_closed_after_the_commands_in_flight_when_it_ended_are_done() {
    let close = Expect::ok("host/browser/pages/close", json!({"closed": true})).with_params(json!({"pageId": "p1", "reason": "turnEnd"}));
    let host = Arc::new(FakeHost::scripted(vec![resolved_new("p1"), snapshot_answer(), no_downloads(), close]));
    let engine = engine(&host, None);
    run(&engine, "snapshot", json!({})).await.expect("snapshot");
    // A command of the session is still queued or running when the turn ends.
    let flight = engine.inner.track("s1");
    let other_session = engine.inner.track("s2");
    let ended = engine.inner.end_turn(&thread(), true).expect("a command ran in the turn");
    assert_eq!(ended.in_flight.len(), 1, "only the session's own commands are waited for");
    let session = thread();
    let mut closing = pin!(engine.inner.close_ended(&session, ended, true));
    assert!(std::future::poll_fn(|cx| Poll::Ready(closing.as_mut().poll(cx).is_pending())).await, "the page is not closed under the running command");
    assert!(host.calls().iter().all(|call| call.method != "host/browser/pages/close"));
    drop(flight);
    assert_eq!(closing.await, 1);
    drop(other_session);
    host.finish().expect("the page closed once the command was done");
}

#[tokio::test]
async fn a_close_that_failed_is_retried_unless_the_page_was_destroyed_meanwhile() {
    let gone = Expect::err("host/browser/pages/close", HostCallError::PageGone);
    let host = Arc::new(FakeHost::scripted(vec![resolved_new("p1"), snapshot_answer(), no_downloads(), gone]));
    let engine = engine(&host, None);
    run(&engine, "snapshot", json!({})).await.expect("snapshot");
    assert_eq!(engine.finish_turn(&thread(), true).await, 0);
    assert!(!locked(&engine.inner.tasks).owns("p1"), "a destroyed page is not owned again");

    let failed = Expect::err("host/browser/pages/close", HostCallError::Failed { message: "window close failed".into() });
    let host = Arc::new(FakeHost::scripted(vec![resolved_new("p1"), snapshot_answer(), no_downloads(), failed]));
    let engine = self::engine(&host, None);
    run(&engine, "snapshot", json!({})).await.expect("snapshot");
    assert_eq!(engine.finish_turn(&thread(), true).await, 0);
    assert!(locked(&engine.inner.tasks).owns("p1"), "a failed close leaves the page owned for a later cleanup");
}

#[tokio::test]
async fn releasing_a_session_ends_the_persons_hold_on_its_pages() {
    use crate::queue::key::QueueKey;
    use crate::queue::user_hold::UserInputParams;
    let host = Arc::new(FakeHost::scripted(vec![resolved("p1"), snapshot_answer(), no_downloads()]));
    let engine = engine(&host, None);
    run(&engine, "snapshot", json!({})).await.expect("snapshot");
    let hold = engine.inner.ports.hold.clone();
    hold.on_user_input(UserInputParams { page_id: "p1".into(), seq: 1, held: true, until: None, reason: BrowserUserInputReason::Pointer });
    let key = QueueKey::new("session:s1:foreground", Some("p1".into()));
    assert!(hold.takeover_error(&key).is_err());
    engine.forget_session(&thread()).await;
    assert_eq!(hold.takeover_error(&key), Ok(()));
    assert!(locked(&engine.inner.directory).sessions.is_empty());
}

#[test]
fn a_selector_match_the_snapshot_did_not_list_joins_the_snapshots_ref_set() {
    let store = FactsStore::default();
    let result: HostBrowserSnapshotResult = serde_json::from_value(serde_json::json!({
        "snapshotId": "p1-s1", "documentId": "p1:1", "revision": 1, "warnings": [], "facts": page_facts("p1", 2),
        "payload": serde_json::to_value(payload("p1-s1", vec![element("p1-s1-e1", "button", "Go")], "https://a.test/")).expect("payload"),
    }))
    .expect("snapshot");
    result.observe(&store);
    let covered = store.snapshot("p1", "p1-s1").expect("observed").refs.covered_elements;
    // The host minted `p1-s1-t1` for a match the snapshot did not list; the one it listed keeps its own place.
    let minted: HostBrowserRefMintResult = serde_json::from_value(serde_json::json!({
        "count": 2, "facts": page_facts("p1", 3),
        "matches": [{"ref": "p1-s1-e1", "role": "button", "name": "Go"}, {"ref": "p1-s1-t1", "role": "div", "name": "card"}],
    }))
    .expect("mint");
    minted.observe(&store);
    let joined = store.snapshot("p1", "p1-s1").expect("still observed").refs.clone();
    let found = joined.get("p1-s1-t1").expect("the minted ref joined");
    assert_eq!((found.role.as_str(), found.name.as_str(), found.url.as_str()), ("div", "card", "https://a.test/"));
    assert_eq!((joined.len(), joined.covered_elements, joined.document_id.as_str()), (2, covered, "p1:1"));
    // A ref of another snapshot is not this one's.
    store.register_minted("p1", "p1-s9", &[crate::refs::target_resolve::css_element("p1-s9-t1".into(), "div".into(), "x".into())]);
    assert!(store.snapshot("p1", "p1-s1").expect("kept").refs.get("p1-s9-t1").is_none());
}

#[tokio::test]
async fn an_upload_is_handed_to_the_approval_port_with_its_files_before_they_move_whatever_folder_they_are_in_from_every_session() {
    let file = std::env::temp_dir().join("mixdog-live-upload").join("live-upload.txt").to_string_lossy().into_owned();
    for session in ASKING_SESSIONS {
        let receiver = Expect::ok("host/browser/upload/receiver", json!({"key": "frame-1", "url": LOOPBACK_PAGE, "facts": loopback_facts(2)}))
            .with_params(json!({"pageId": "p1", "snapshotId": "p1-s1", "ref": "p1-s1-e1"}));
        let host = Arc::new(FakeHost::scripted(vec![resolved_on_loopback(session), receiver]));
        let approvals = Asked::answering(false);
        let engine = engine_asking(&host, &approvals, ActionPolicy::from_env(None, None, None, is_action));
        let denied = run_in(&engine, session, "upload", json!({"ref": "p1-s1-e1", "paths": [file]})).await.expect_err("the person said no");
        assert_eq!(denied.message_for_model, browser_not_approved(""), "{session}");
        let prompts = approvals.prompts();
        assert_eq!(prompts.len(), 1, "{session}: asked once");
        let prompt = &prompts[0];
        assert_eq!(prompt.kinds, [BrowserApprovalRememberKind::Upload], "{session}");
        assert_eq!((prompt.action.as_str(), prompt.url.as_str(), prompt.target.as_str()), ("upload", LOOPBACK_PAGE, "p1-s1-e1"), "{session}");
        assert_eq!((prompt.session_id.as_str(), prompt.thread_id.as_ref().map(ThreadId::as_str)), (session, Some(session)), "{session}");
        assert_eq!(prompt.paths, [file.clone()], "{session}");
        let named: Vec<(&str, &str, i64, bool)> = prompt.files.iter().map(|file| (file.name.as_str(), file.path.as_str(), file.size, file.outside)).collect();
        assert_eq!(named, [("live-upload.txt", file.as_str(), 16, false)], "{session}");
        assert_eq!(prompt.receiver_origin, "http://127.0.0.1:5173", "{session}");
        assert!(!prompt.payment, "{session}: an upload reads no payment evidence");
        // The receiving frame was read for the card; the files never reached the page.
        assert_eq!(asked_of(&host), ["host/browser/pages/resolve", "host/browser/upload/receiver"], "{session}");
        host.finish().expect("no call beyond the script");
    }
}
#[tokio::test]
async fn a_step_that_neither_submits_posts_nor_uploads_goes_on_with_no_question_and_the_operators_opt_out_asks_none() {
    // The port of this test denies whatever it is asked, so a step that was asked ends as not approved. A step that was not
    // asked goes on to the action itself, which refuses the ref of a snapshot this page never took (an upload reads its
    // element first).
    const WENT_ON: &str = "ref p1-s1-e1 is not from the latest snapshot; take a fresh snapshot first";
    let file = std::env::temp_dir().join("mixdog-live-upload").join("live-upload.txt").to_string_lossy().into_owned();
    let default = || ActionPolicy::from_env(None, None, None, is_action);
    // `MIXDOG_BROWSER_CONFIRM_SUBMIT=0`: the operator turned the default asks off.
    let opted_out = || ActionPolicy::from_env(None, None, Some("0"), is_action);
    let steps: [(&str, Value, ActionPolicy); 5] = [
        // Typing with no submit, and a click or a hover on a ref (a control's name is read from a `target` only, as
        // `action-approval.ts` reads it: a ref names no send or post control).
        ("type", json!({"ref": "p1-s1-e1", "text": "live"}), default()),
        ("click", json!({"ref": "p1-s1-e1"}), default()),
        ("hover", json!({"ref": "p1-s1-e1"}), default()),
        ("type", json!({"ref": "p1-s1-e1", "text": "live", "submit": true}), opted_out()),
        ("upload", json!({"ref": "p1-s1-e1", "paths": [file]}), opted_out()),
    ];
    for (action, command, policy) in steps {
        let host = Arc::new(FakeHost::scripted(vec![resolved_on_loopback("sess_home_ann")]));
        let approvals = Asked::answering(false);
        let engine = engine_asking(&host, &approvals, policy);
        let outcome = run_in(&engine, "sess_home_ann", action, command.clone()).await.map(|reply| reply.text).map_err(|error| error.message_for_model);
        assert!(approvals.prompts().is_empty(), "{action} {command} asked");
        match action {
            // The upload went on to read the element it hands the files to (which this script does not answer); no receiving
            // frame was read for a card.
            "upload" => assert_eq!(asked_of(&host), ["host/browser/pages/resolve", "host/browser/ref/call"], "{action} {command}: {outcome:?}"),
            _ => assert_eq!(outcome, Err(WENT_ON.to_owned()), "{action} {command}"),
        }
    }
}
