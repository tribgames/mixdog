//! Owner: s4-engine-actions-upload
//! Putting files on the page (`ref-upload.ts`, decision half; the dispatch half is the host's `host/browser/upload`). A file-input
//! ref takes the files directly, any other ref is clicked to open its picker (and a zone that never shows one takes them as a
//! drop), and no ref answers the picker the page already opened. The engine reads the files and the page, picks the route, binds
//! the dispatch to what the person approved (document, URL, receiving frame; the files are the canonical paths the approval
//! bound), and reads what the host reports back: whether the page's file input now holds the files.
//!
//! The host decides between `fileInput`, `pickerClick` and `drop` for a ref when it dispatches (a click that opens no picker
//! falls to a drop, with the drop guards of `assets/page/file-drop.js` on its side); the route sent is the engine's reading of
//! the element, and `chooser` is the only one that takes no ref.

use std::fmt;
use std::path::Path;

use mixdog_app_protocol::v2::browser_engine::BrowserPendingFileChooser;
use mixdog_app_protocol::v2::browser_engine::BrowserUploadReceiver;
use mixdog_app_protocol::v2::browser_engine::BrowserUploadRoute;
use mixdog_app_protocol::v2::browser_engine::HostBrowserUploadParams;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_app_protocol::v2::browser_engine::Precondition;
use mixdog_rt::CancellationToken;
use serde::Deserialize;

use crate::approval::binding::precondition;
use crate::approval::classify::origin_of_url;
use crate::error::HostCallError;
use crate::port::BrowserHost;
use crate::port::FilePort;
use crate::refs::access::RefError;
use crate::refs::access::RefTarget;
use crate::refs::access::call_ref;
use crate::types::Binding;

/// The most files one upload holds.
const MAX_UPLOAD_FILES: usize = 10;

/// What a dispatch that finds the receiving chooser no longer the approved one fails with.
pub const UPLOAD_TARGET_CHANGED: &str = "upload target changed; nothing was dispatched";

/// What an upload that cannot tell which frame document receives its files fails with.
pub const UNIDENTIFIED_RECEIVER: &str = "the frame receiving the upload could not be identified";

const NEEDS_REF_OR_CHOOSER: &str = "upload requires ref unless the page has opened a file chooser";

/// The chooser mode of a picker that takes one file.
const CHOOSER_SINGLE: &str = "selectSingle";

/// Read in the page, as the ref's element: the document that receives the files (its URL) and whether the element is a file input.
const RECEIVER_PROBE: &str = "function() {
  const doc = this.ownerDocument || this;
  return {
    url: String((doc.location && doc.location.href) || ''),
    fileInput: (this.tagName || '').toLowerCase() === 'input' && String(this.type || '').toLowerCase() === 'file',
  };
}";

/// Why an upload was not dispatched or did not finish.
#[derive(Debug, Clone, PartialEq)]
pub enum UploadError {
    /// The command cannot be carried out as given; nothing was dispatched.
    Invalid(String),
    /// The page or the host refused, or the target is not what it was decided against.
    Failed(String),
    /// The host call itself failed (a changed page -32010, a gone page, a person at the page, a cancel).
    Host(HostCallError),
}

impl fmt::Display for UploadError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) | Self::Failed(message) => out.write_str(message),
            Self::Host(error) => fmt::Display::fmt(error, out),
        }
    }
}

impl std::error::Error for UploadError {}

impl From<HostCallError> for UploadError {
    fn from(error: HostCallError) -> Self {
        Self::Host(error)
    }
}

impl From<RefError> for UploadError {
    fn from(error: RefError) -> Self {
        match error {
            RefError::Host(error) => Self::Host(error),
            RefError::Refused { message, .. } | RefError::Failed(message) => Self::Failed(message),
        }
    }
}

/// The element an upload names: a ref of a snapshot, or (`None`) the picker the page already opened.
#[derive(Debug, Clone, Copy)]
pub struct UploadTarget<'a> {
    pub page_id: &'a str,
    /// The snapshot the ref belongs to; read only with a ref.
    pub snapshot_id: &'a str,
    pub ref_id: Option<&'a str>,
}

/// The frame document that receives an upload's files.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Receiver {
    /// What an approval binds. Empty when the document could not be told apart from the page's others (a ref's frame has no
    /// key the engine can read; the document and URL precondition still binds the step).
    pub key: String,
    /// What the card shows (the frame document's URL); empty when it is not known.
    pub url: String,
}

/// What the page showed after the files were handed over.
#[derive(Debug, Clone, PartialEq)]
pub struct UploadOutcome {
    pub route: BrowserUploadRoute,
    pub files: usize,
    /// The page's own file input holds exactly these files now.
    pub verified: bool,
    pub receiver: Option<BrowserUploadReceiver>,
    pub facts: PageFacts,
}

impl UploadOutcome {
    /// The line the agent reads: the page confirmed the files, or only that they were handed over.
    pub fn summary(&self) -> String {
        let noun = if self.files == 1 { "file" } else { "files" };
        if self.verified {
            return format!("Uploaded {} {noun}; the page's file input holds them.", self.files);
        }
        let seen = match &self.receiver {
            Some(receiver) => format!(" (the receiving element is a <{}>)", receiver.tag),
            None => String::new(),
        };
        format!("Handed {} {noun} to the page{seen}; the page's file input does not show them, so check the page.", self.files)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReceiverProbe {
    #[serde(default)]
    url: String,
    #[serde(default)]
    file_input: bool,
}

/// Which way the files go: the open chooser without a ref, a file input directly, any other element by clicking it open.
pub fn choose_route(has_ref: bool, file_input: bool) -> BrowserUploadRoute {
    match (has_ref, file_input) {
        (false, _) => BrowserUploadRoute::Chooser,
        (true, true) => BrowserUploadRoute::FileInput,
        (true, false) => BrowserUploadRoute::PickerClick,
    }
}

/// 1 to 10 absolute paths of regular files (`assertUploadPaths`).
async fn check_paths(disk: &dyn FilePort, paths: &[String]) -> Result<(), UploadError> {
    if paths.is_empty() || paths.len() > MAX_UPLOAD_FILES {
        return Err(UploadError::Invalid("upload requires 1\u{2013}10 file paths".to_owned()));
    }
    for path in paths {
        if !mixdog_js::nodepath::is_absolute_host(path) {
            return Err(UploadError::Invalid(format!("upload path must be absolute: {path}")));
        }
        let facts = disk.stat(Path::new(path)).await;
        if !facts.exists {
            return Err(UploadError::Invalid(format!("upload path cannot be read: {path}")));
        }
        if !facts.is_file {
            return Err(UploadError::Invalid(format!("upload path is not a file: {path}")));
        }
    }
    Ok(())
}

fn chooser_of(facts: &PageFacts) -> Result<&BrowserPendingFileChooser, UploadError> {
    facts.pending_file_chooser.as_ref().ok_or_else(|| UploadError::Invalid(NEEDS_REF_OR_CHOOSER.to_owned()))
}

async fn probe(host: &dyn BrowserHost, target: &RefTarget<'_>, cancel: &CancellationToken) -> Result<ReceiverProbe, UploadError> {
    let value = call_ref(host, target, RECEIVER_PROBE, Vec::new(), cancel).await?;
    serde_json::from_value(value).map_err(|_| UploadError::Failed(UNIDENTIFIED_RECEIVER.to_owned()))
}

/// The frame document that would receive an upload to the target now (`receiver`): the open chooser's key, or the URL of the
/// document the ref's element lives in. A document whose URL cannot be read is [`UNIDENTIFIED_RECEIVER`].
pub async fn receiver(host: &dyn BrowserHost, target: &UploadTarget<'_>, facts: &PageFacts, cancel: &CancellationToken) -> Result<Receiver, UploadError> {
    let Some(ref_id) = target.ref_id else {
        return Ok(Receiver { key: chooser_of(facts)?.receiver_key.clone(), url: String::new() });
    };
    let ref_target = RefTarget { page_id: target.page_id, snapshot_id: target.snapshot_id, ref_id, expect: None };
    let read = probe(host, &ref_target, cancel).await?;
    if read.url.is_empty() {
        return Err(UploadError::Failed(UNIDENTIFIED_RECEIVER.to_owned()));
    }
    Ok(Receiver { key: String::new(), url: read.url })
}

/// What the dispatch is decided against when no approval bound it: the page as the engine sees it now.
fn decided_against(facts: &PageFacts) -> Precondition {
    let origin = origin_of_url(&facts.url);
    Precondition {
        document_id: facts.document_id.clone(),
        origin: (!origin.is_empty()).then_some(origin),
        url: Some(facts.url.clone()),
        child_sessions: None,
        receiver_key: None,
        snapshot_id: None,
    }
}

/// Hand `paths` to the page. `approved` is what the person approved (`None` when the step asked nobody): the dispatch carries its
/// document, URL and receiving frame as a precondition the host checks right before each dispatch, so a page that moved on is
/// refused there (-32010) and nothing is sent. The paths are the canonical ones the approval bound.
pub async fn upload_files(
    host: &dyn BrowserHost,
    disk: &dyn FilePort,
    target: &UploadTarget<'_>,
    paths: &[String],
    facts: &PageFacts,
    approved: Option<&Binding>,
    cancel: &CancellationToken,
) -> Result<UploadOutcome, UploadError> {
    check_paths(disk, paths).await?;
    let mut expect = approved.map_or_else(|| decided_against(facts), precondition);
    let approved_key = approved.map(|binding| binding.receiver_key.as_str()).unwrap_or_default();
    let (route, receiver_key) = match target.ref_id {
        None => {
            let chooser = chooser_of(facts)?;
            if chooser.mode == CHOOSER_SINGLE && paths.len() > 1 {
                return Err(UploadError::Invalid("the open file chooser accepts a single file".to_owned()));
            }
            if !approved_key.is_empty() && chooser.receiver_key != approved_key {
                return Err(UploadError::Failed(UPLOAD_TARGET_CHANGED.to_owned()));
            }
            // The host compares this against the chooser it holds: it is the chooser's key (or the approved one it must equal).
            let key = if approved_key.is_empty() { chooser.receiver_key.clone() } else { approved_key.to_owned() };
            expect.receiver_key = (!key.is_empty()).then(|| key.clone());
            (BrowserUploadRoute::Chooser, key)
        }
        Some(ref_id) => {
            // A ref's frame key is the host's own reading of the document, not a chooser's: the host compares it where it
            // dispatches, so it travels as the upload's `receiverKey` and not in the precondition.
            expect.receiver_key = None;
            expect.snapshot_id = Some(target.snapshot_id.to_owned());
            let ref_target = RefTarget { page_id: target.page_id, snapshot_id: target.snapshot_id, ref_id, expect: Some(&expect) };
            let read = probe(host, &ref_target, cancel).await?;
            (choose_route(true, read.file_input), approved_key.to_owned())
        }
    };
    let params = HostBrowserUploadParams {
        page_id: target.page_id.to_owned(),
        route,
        snapshot_id: target.ref_id.map(|_| target.snapshot_id.to_owned()),
        ref_id: target.ref_id.map(str::to_owned),
        files: paths.to_vec(),
        receiver_key,
        expect,
    };
    let result = host.upload(params, cancel).await?;
    if !result.dispatched {
        return Err(UploadError::Failed("the files were not handed to the page".to_owned()));
    }
    Ok(UploadOutcome { route, files: paths.len(), verified: result.verified, receiver: result.receiver, facts: result.facts })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use async_trait::async_trait;
    use bytes::Bytes;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::types::BoundFile;
    use crate::types::FileFacts;

    const A: &str = if cfg!(windows) { "C:\\work\\a.txt" } else { "/work/a.txt" };
    const B: &str = if cfg!(windows) { "C:\\work\\b.txt" } else { "/work/b.txt" };
    const DIR: &str = if cfg!(windows) { "C:\\work" } else { "/work" };

    struct Disk;

    #[async_trait]
    impl FilePort for Disk {
        async fn stat(&self, path: &Path) -> FileFacts {
            let name = path.to_string_lossy();
            if name.ends_with("missing.txt") {
                return FileFacts::default();
            }
            FileFacts { exists: true, is_file: name != DIR, size: 1, canonical: Some(path.to_path_buf()), modified: None }
        }

        async fn write_frame(&self, _run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
            Ok(PathBuf::new())
        }
    }

    fn facts_with(chooser: Option<Value>) -> PageFacts {
        let mut value = page_facts("p1", 3);
        if let Some(chooser) = chooser {
            value["pendingFileChooser"] = chooser;
        }
        serde_json::from_value(value).expect("facts")
    }

    fn chooser(mode: &str, key: &str) -> Value {
        json!({"mode": mode, "openedAt": 1, "receiverKey": key})
    }

    fn target(ref_id: Option<&'static str>) -> UploadTarget<'static> {
        UploadTarget { page_id: "p1", snapshot_id: "p1-s2", ref_id }
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| (*path).to_owned()).collect()
    }

    fn probe_answer(url: &str, file_input: bool) -> Expect {
        Expect::ok("host/browser/ref/call", json!({"value": {"url": url, "fileInput": file_input}, "facts": page_facts("p1", 4)}))
    }

    fn upload_answer(verified: bool) -> Expect {
        Expect::ok(
            "host/browser/upload",
            json!({"dispatched": true, "verified": verified, "receiver": {"tag": "input", "accept": "image/*", "multiple": false}, "facts": page_facts("p1", 5)}),
        )
    }

    fn binding(key: &str) -> Binding {
        Binding {
            url: "https://a.test/".into(),
            document_id: "p1:1".into(),
            command_hash: "h".into(),
            files: vec![BoundFile { path: A.into(), size: 1, mtime: None, realpath: A.into() }],
            receiver_key: key.into(),
        }
    }

    async fn run(host: &FakeHost, target: UploadTarget<'_>, list: &[&str], facts: &PageFacts, approved: Option<&Binding>) -> Result<UploadOutcome, UploadError> {
        upload_files(host, &Disk, &target, &paths(list), facts, approved, &CancellationToken::new()).await
    }

    #[test]
    fn the_route_follows_the_element() {
        assert_eq!(choose_route(false, false), BrowserUploadRoute::Chooser);
        assert_eq!(choose_route(false, true), BrowserUploadRoute::Chooser);
        assert_eq!(choose_route(true, true), BrowserUploadRoute::FileInput);
        assert_eq!(choose_route(true, false), BrowserUploadRoute::PickerClick);
    }

    #[tokio::test]
    async fn a_file_input_ref_takes_the_files_directly_and_the_page_confirms_them() {
        let host = FakeHost::scripted(vec![
            probe_answer("https://a.test/", true).with_params(json!({"snapshotId": "p1-s2", "ref": "p1-s2-e1"})),
            upload_answer(true).with_params(json!({
                "pageId": "p1", "route": "fileInput", "snapshotId": "p1-s2", "ref": "p1-s2-e1", "files": [A], "receiverKey": "",
                "expect": {"documentId": "p1:1", "url": "https://a.test/", "origin": "https://a.test", "snapshotId": "p1-s2"}
            })),
        ]);
        let outcome = run(&host, target(Some("p1-s2-e1")), &[A], &facts_with(None), None).await.expect("uploaded");
        assert_eq!(outcome.route, BrowserUploadRoute::FileInput);
        assert!(outcome.verified);
        assert_eq!(outcome.summary(), "Uploaded 1 file; the page's file input holds them.");
        host.finish().expect("two calls");
    }

    #[tokio::test]
    async fn any_other_ref_is_clicked_open_and_an_unconfirmed_upload_says_so() {
        let host = FakeHost::scripted(vec![
            probe_answer("https://a.test/", false),
            upload_answer(false).with_params(json!({"route": "pickerClick", "files": [A, B]})),
        ]);
        let outcome = run(&host, target(Some("p1-s2-e9")), &[A, B], &facts_with(None), None).await.expect("uploaded");
        assert_eq!(outcome.route, BrowserUploadRoute::PickerClick);
        assert!(!outcome.verified);
        assert!(outcome.summary().starts_with("Handed 2 files to the page (the receiving element is a <input>)"));
        host.finish().expect("two calls");
    }

    #[tokio::test]
    async fn an_approved_ref_upload_carries_the_approved_frame_and_page_on_the_wire() {
        let host = FakeHost::scripted(vec![
            probe_answer("https://a.test/", true),
            upload_answer(true).with_params(json!({
                "route": "fileInput", "receiverKey": "S1\nF1\nL1\nhttps://a.test/",
                "expect": {"documentId": "p1:1", "url": "https://a.test/", "snapshotId": "p1-s2"}
            })),
        ]);
        let approved = binding("S1\nF1\nL1\nhttps://a.test/");
        run(&host, target(Some("p1-s2-e1")), &[A], &facts_with(None), Some(&approved)).await.expect("uploaded");
        let calls = host.calls();
        assert!(calls[1].params.get("expect").and_then(|expect| expect.get("receiverKey")).is_none(), "a ref's frame key is not a chooser key");
        host.finish().expect("two calls");
    }

    #[tokio::test]
    async fn the_open_chooser_answers_a_refless_upload_under_its_own_key() {
        let host = FakeHost::scripted(vec![upload_answer(true).with_params(json!({
            "route": "chooser", "files": [A], "receiverKey": "S|F|7", "expect": {"receiverKey": "S|F|7"}
        }))]);
        let facts = facts_with(Some(chooser("selectMultiple", "S|F|7")));
        let outcome = run(&host, target(None), &[A], &facts, None).await.expect("uploaded");
        assert_eq!(outcome.route, BrowserUploadRoute::Chooser);
        assert!(host.calls()[0].params.get("ref").is_none());
        host.finish().expect("one call");
    }

    #[tokio::test]
    async fn without_a_ref_and_without_a_chooser_nothing_is_sent() {
        let host = FakeHost::scripted(vec![]);
        let error = run(&host, target(None), &[A], &facts_with(None), None).await.expect_err("no chooser");
        assert_eq!(error, UploadError::Invalid("upload requires ref unless the page has opened a file chooser".into()));
        host.finish().expect("no call");
    }

    #[tokio::test]
    async fn a_single_file_chooser_takes_one_file() {
        let host = FakeHost::scripted(vec![]);
        let facts = facts_with(Some(chooser("selectSingle", "k")));
        let error = run(&host, target(None), &[A, B], &facts, None).await.expect_err("two files");
        assert_eq!(error.to_string(), "the open file chooser accepts a single file");
        host.finish().expect("no call");
    }

    #[tokio::test]
    async fn a_chooser_that_is_not_the_approved_one_is_refused_before_any_dispatch() {
        let host = FakeHost::scripted(vec![]);
        let facts = facts_with(Some(chooser("selectMultiple", "other")));
        let error = run(&host, target(None), &[A], &facts, Some(&binding("approved"))).await.expect_err("changed");
        assert_eq!(error, UploadError::Failed(UPLOAD_TARGET_CHANGED.into()));
        host.finish().expect("no call");
    }

    #[tokio::test]
    async fn the_paths_are_one_to_ten_absolute_regular_files() {
        let host = FakeHost::scripted(vec![]);
        let facts = facts_with(Some(chooser("selectMultiple", "k")));
        let missing = if cfg!(windows) { "C:\\work\\missing.txt" } else { "/work/missing.txt" };
        let eleven = vec![A; 11];
        for (list, message) in [
            (vec![], "upload requires 1\u{2013}10 file paths".to_owned()),
            (eleven, "upload requires 1\u{2013}10 file paths".to_owned()),
            (vec!["rel/a.txt"], "upload path must be absolute: rel/a.txt".to_owned()),
            (vec![DIR], format!("upload path is not a file: {DIR}")),
            (vec![missing], format!("upload path cannot be read: {missing}")),
        ] {
            let error = run(&host, target(None), &list, &facts, None).await.expect_err("refused");
            assert_eq!(error, UploadError::Invalid(message));
        }
        host.finish().expect("no call");
    }

    #[tokio::test]
    async fn a_page_that_moved_on_is_the_hosts_refusal_and_a_stale_ref_is_a_failure() {
        let moved = FakeHost::scripted(vec![probe_answer("https://a.test/", true), Expect::err("host/browser/upload", HostCallError::StaleSnapshot)]);
        let error = run(&moved, target(Some("r")), &[A], &facts_with(None), None).await.expect_err("stale");
        assert_eq!(error, UploadError::Host(HostCallError::StaleSnapshot));
        let stale = FakeHost::scripted(vec![Expect::ok(
            "host/browser/ref/call",
            json!({"exception": {"text": "ref r is stale or unknown; take a fresh snapshot first"}, "facts": page_facts("p1", 4)}),
        )]);
        let error = run(&stale, target(Some("r")), &[A], &facts_with(None), None).await.expect_err("stale ref");
        assert_eq!(error.to_string(), "ref r is stale or unknown; take a fresh snapshot first");
    }

    #[tokio::test]
    async fn files_the_host_did_not_hand_over_are_an_error() {
        let host = FakeHost::scripted(vec![Expect::ok("host/browser/upload", json!({"dispatched": false, "verified": false, "facts": page_facts("p1", 5)}))]);
        let facts = facts_with(Some(chooser("selectMultiple", "k")));
        let error = run(&host, target(None), &[A], &facts, None).await.expect_err("not dispatched");
        assert_eq!(error.to_string(), "the files were not handed to the page");
    }

    #[tokio::test]
    async fn the_receiver_is_the_chooser_key_or_the_document_url_of_the_ref() {
        let cancel = CancellationToken::new();
        let facts = facts_with(Some(chooser("selectMultiple", "S|F|7")));
        let host = FakeHost::scripted(vec![]);
        assert_eq!(receiver(&host, &target(None), &facts, &cancel).await, Ok(Receiver { key: "S|F|7".into(), url: String::new() }));
        assert_eq!(
            receiver(&host, &target(None), &facts_with(None), &cancel).await,
            Err(UploadError::Invalid("upload requires ref unless the page has opened a file chooser".into()))
        );
        let by_ref = FakeHost::scripted(vec![probe_answer("https://pay.example/embed", false), probe_answer("", false)]);
        assert_eq!(
            receiver(&by_ref, &target(Some("r")), &facts, &cancel).await,
            Ok(Receiver { key: String::new(), url: "https://pay.example/embed".into() })
        );
        assert_eq!(receiver(&by_ref, &target(Some("r")), &facts, &cancel).await, Err(UploadError::Failed(UNIDENTIFIED_RECEIVER.into())));
    }
}
