//! Owner: s4-engine-approval
//! What an approval is bound to, and the checks that make it a precondition of the dispatch (the TOCTOU rebind of
//! `action-approval.ts`). The person approved one document at one URL, one command, and for an upload these files and this
//! receiving frame. Nothing about the time spent waiting makes the answer stale; what does is the page: after the answer
//! [`verify`] fails closed in the engine if any of it changed, and [`precondition`] puts the same document and URL on every
//! host request of the approved step so a navigation in the last moment is refused by the host itself (-32010) and nothing is
//! sent.

use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use mixdog_app_protocol::v2::browser_engine::BrowserApprovalFile;
use mixdog_app_protocol::v2::browser_engine::Precondition;
use mixdog_rt::CancellationToken;
use sha2::Digest;
use sha2::Sha256;

use super::classify::ApprovalError;
use super::classify::origin_of_url;
use crate::port::FilePort;
use crate::types::ApprovalAnswer;
use crate::types::Binding;
use crate::types::BoundFile;

/// The most files one upload holds.
const MAX_UPLOAD_FILES: usize = 10;

/// The hash of a serialized command: equal exactly when the command the person was shown is the one dispatched.
pub fn command_hash(command_json: &str) -> String {
    Sha256::digest(command_json.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The `expect` of every host request of the approved step. The host checks it synchronously right before the CDP send and
/// answers -32010 when the page has moved on.
pub fn precondition(binding: &Binding) -> Precondition {
    let origin = origin_of_url(&binding.url);
    Precondition {
        document_id: binding.document_id.clone(),
        origin: (!origin.is_empty()).then_some(origin),
        url: Some(binding.url.clone()),
        child_sessions: None,
        receiver_key: (!binding.receiver_key.is_empty()).then(|| binding.receiver_key.clone()),
        snapshot_id: None,
    }
}

/// An upload's real files: 1 to 10 absolute paths of regular files, each bound by its canonical path, size and modification
/// time. The command is then dispatched with the canonical paths (`BoundFile::path`).
pub async fn resolve_upload_files(files: &dyn FilePort, paths: &[String]) -> Result<Vec<BoundFile>, ApprovalError> {
    if paths.is_empty() || paths.len() > MAX_UPLOAD_FILES {
        return Err(ApprovalError::Invalid("upload requires 1\u{2013}10 approved absolute file paths".to_owned()));
    }
    let mut bound = Vec::with_capacity(paths.len());
    for path in paths {
        if !mixdog_js::nodepath::is_absolute_host(path) {
            return Err(ApprovalError::Invalid("upload approval requires absolute file paths".to_owned()));
        }
        let facts = files.stat(Path::new(path)).await;
        let Some(canonical) = facts.canonical.filter(|_| facts.exists) else {
            return Err(ApprovalError::Invalid(format!("upload approval cannot read the file: {path}")));
        };
        if !facts.is_file {
            return Err(ApprovalError::Invalid("upload approval requires regular files".to_owned()));
        }
        bound.push(BoundFile { path: canonical.to_string_lossy().into_owned(), size: facts.size, mtime: facts.modified, realpath: canonical });
    }
    Ok(bound)
}

/// The target as it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedTarget {
    pub url: String,
    pub document_id: String,
}

/// Reads the target again after the answer.
#[async_trait]
pub trait Rebind: Send + Sync {
    /// The page's document and URL now.
    fn target(&self) -> ObservedTarget;
    /// The key of the frame document that would receive an upload's files now; empty when it cannot be confirmed.
    async fn receiver_key(&self) -> String;
}

/// The precondition of the dispatch after the person answered. `command_json` is the command as it stands now. Returns the
/// receiving frame's key an upload is bound to (`None` for any other step); the upload handler checks it once more right
/// before the files move. A grant is for this call only: it cannot be reused by another.
pub async fn verify(
    binding: &Binding,
    answer: &ApprovalAnswer,
    command_json: &str,
    rebind: &dyn Rebind,
    files: &dyn FilePort,
    cancel: &CancellationToken,
) -> Result<Option<String>, ApprovalError> {
    if cancel.is_cancelled() {
        return Err(ApprovalError::Cancelled);
    }
    if let ApprovalAnswer::Deny { reason } = answer {
        return Err(ApprovalError::NotApproved { reason: reason.clone() });
    }
    let current = rebind.target();
    if current.document_id != binding.document_id || current.url != binding.url || command_hash(command_json) != binding.command_hash {
        return Err(ApprovalError::TargetChanged);
    }
    for file in &binding.files {
        let facts = files.stat(&file.realpath).await;
        if !facts.exists || !facts.is_file || facts.size != file.size || facts.modified != file.mtime {
            return Err(ApprovalError::FileChanged);
        }
    }
    let last = rebind.target();
    if cancel.is_cancelled() || last.document_id != binding.document_id || last.url != binding.url {
        return Err(ApprovalError::TargetChangedBeforeDispatch);
    }
    if binding.files.is_empty() {
        return Ok(None);
    }
    if rebind.receiver_key().await != binding.receiver_key {
        return Err(ApprovalError::TargetChanged);
    }
    Ok(Some(binding.receiver_key.clone()))
}

fn inside(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// Marks the files of an upload card that lie outside the asking session's working directory and the user's Downloads folder.
/// Both roots are canonical (the gate reads them through `FilePort::stat`); an unknown working directory marks nothing.
pub fn mark_outside(files: &mut [BrowserApprovalFile], cwd: Option<&Path>, downloads: Option<&Path>) {
    let Some(cwd) = cwd else { return };
    let roots: Vec<PathBuf> = std::iter::once(cwd).chain(downloads).map(Path::to_path_buf).collect();
    for file in files {
        file.outside = !roots.iter().any(|root| inside(root, Path::new(&file.path)));
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::time::Duration;
    use std::time::SystemTime;

    use bytes::Bytes;
    use mixdog_app_protocol::v2::browser_engine::BrowserPreconditionReason;
    use mixdog_app_protocol::v2::browser_engine::HostBrowserPageNavigateParams;
    use mixdog_app_protocol::v2::browser_engine::PageFacts;
    use serde_json::json;

    use super::*;
    use crate::error::HostCallError;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::port::BrowserHost;
    use crate::types::FileFacts;

    #[derive(Default)]
    struct Disk(Mutex<HashMap<PathBuf, FileFacts>>);

    impl Disk {
        fn put(&self, path: &str, size: u64, mtime: u64) {
            let facts = FileFacts {
                exists: true,
                is_file: true,
                size,
                canonical: Some(PathBuf::from(path)),
                modified: Some(SystemTime::UNIX_EPOCH + Duration::from_secs(mtime)),
            };
            self.0.lock().unwrap().insert(PathBuf::from(path), facts);
        }
    }

    #[async_trait]
    impl FilePort for Disk {
        async fn stat(&self, path: &Path) -> FileFacts {
            self.0.lock().unwrap().get(path).cloned().unwrap_or_default()
        }

        async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
            Ok(run_dir.to_path_buf())
        }
    }

    struct Page {
        now: Mutex<ObservedTarget>,
        receiver: Mutex<String>,
    }

    impl Page {
        fn at(url: &str, document: &str, receiver: &str) -> Self {
            Self { now: Mutex::new(ObservedTarget { url: url.into(), document_id: document.into() }), receiver: Mutex::new(receiver.into()) }
        }
    }

    #[async_trait]
    impl Rebind for Page {
        fn target(&self) -> ObservedTarget {
            self.now.lock().unwrap().clone()
        }

        async fn receiver_key(&self) -> String {
            self.receiver.lock().unwrap().clone()
        }
    }

    const ABS: &str = if cfg!(windows) { "C:\\work\\a.txt" } else { "/work/a.txt" };

    fn binding(command: &str) -> Binding {
        Binding { url: "https://a.test/form".into(), document_id: "p:1".into(), command_hash: command_hash(command), files: Vec::new(), receiver_key: String::new() }
    }

    fn allow() -> ApprovalAnswer {
        ApprovalAnswer::Allow { remember: crate::types::Remember::Once }
    }

    fn token() -> CancellationToken {
        CancellationToken::new()
    }

    #[tokio::test]
    async fn an_unchanged_page_and_command_pass_and_a_denial_or_cancel_does_not() {
        let disk = Disk::default();
        let page = Page::at("https://a.test/form", "p:1", "");
        let bound = binding("{\"a\":1}");
        assert_eq!(verify(&bound, &allow(), "{\"a\":1}", &page, &disk, &token()).await, Ok(None));
        let deny = ApprovalAnswer::Deny { reason: "no".into() };
        assert_eq!(verify(&bound, &deny, "{\"a\":1}", &page, &disk, &token()).await, Err(ApprovalError::NotApproved { reason: "no".into() }));
        let cancelled = token();
        cancelled.cancel();
        assert_eq!(verify(&bound, &allow(), "{\"a\":1}", &page, &disk, &cancelled).await, Err(ApprovalError::Cancelled));
    }

    #[tokio::test]
    async fn a_changed_document_url_or_command_after_the_answer_is_refused() {
        let disk = Disk::default();
        let bound = binding("{\"a\":1}");
        for (url, document) in [("https://a.test/other", "p:1"), ("https://a.test/form", "p:2"), ("https://evil.test/form", "p:3")] {
            let page = Page::at(url, document, "");
            assert_eq!(verify(&bound, &allow(), "{\"a\":1}", &page, &disk, &token()).await, Err(ApprovalError::TargetChanged), "{url}");
        }
        let page = Page::at("https://a.test/form", "p:1", "");
        assert_eq!(verify(&bound, &allow(), "{\"a\":2}", &page, &disk, &token()).await, Err(ApprovalError::TargetChanged));
        assert_eq!(ApprovalError::TargetChanged.to_string(), "Browser Use approval target changed; nothing was dispatched");
    }

    #[tokio::test]
    async fn an_upload_binds_its_files_and_its_receiving_frame() {
        let disk = Disk::default();
        disk.put(ABS, 5, 100);
        let files = resolve_upload_files(&disk, &[ABS.to_owned()]).await.expect("files");
        assert_eq!((files[0].size, files[0].path.as_str()), (5, ABS));
        let mut bound = binding("{}");
        bound.files = files;
        bound.receiver_key = "frame-1".into();
        let page = Page::at("https://a.test/form", "p:1", "frame-1");
        assert_eq!(verify(&bound, &allow(), "{}", &page, &disk, &token()).await, Ok(Some("frame-1".to_owned())));
        // The receiving frame changed during the wait.
        *page.receiver.lock().unwrap() = "frame-2".into();
        assert_eq!(verify(&bound, &allow(), "{}", &page, &disk, &token()).await, Err(ApprovalError::TargetChanged));
        *page.receiver.lock().unwrap() = "frame-1".into();
        // A file that changes after approval is refused, whichever fact changed, or is gone.
        for (size, mtime) in [(6, 100), (5, 101)] {
            disk.put(ABS, size, mtime);
            assert_eq!(verify(&bound, &allow(), "{}", &page, &disk, &token()).await, Err(ApprovalError::FileChanged));
        }
        disk.0.lock().unwrap().clear();
        assert_eq!(verify(&bound, &allow(), "{}", &page, &disk, &token()).await, Err(ApprovalError::FileChanged));
        assert_eq!(ApprovalError::FileChanged.to_string(), "approved upload file changed; nothing was dispatched");
    }

    #[tokio::test]
    async fn an_upload_that_cannot_be_confirmed_stays_bound_to_the_empty_key() {
        let disk = Disk::default();
        disk.put(ABS, 5, 100);
        let mut bound = binding("{}");
        bound.files = resolve_upload_files(&disk, &[ABS.to_owned()]).await.unwrap();
        let page = Page::at("https://a.test/form", "p:1", "");
        assert_eq!(verify(&bound, &allow(), "{}", &page, &disk, &token()).await, Ok(Some(String::new())));
        *page.receiver.lock().unwrap() = "frame-9".into();
        assert_eq!(verify(&bound, &allow(), "{}", &page, &disk, &token()).await, Err(ApprovalError::TargetChanged));
    }

    #[tokio::test]
    async fn upload_paths_must_be_one_to_ten_absolute_regular_readable_files() {
        let disk = Disk::default();
        disk.put(ABS, 5, 1);
        let message = |result: Result<Vec<BoundFile>, ApprovalError>| result.unwrap_err().to_string();
        assert_eq!(message(resolve_upload_files(&disk, &[]).await), "upload requires 1\u{2013}10 approved absolute file paths");
        let eleven = vec![ABS.to_owned(); 11];
        assert_eq!(message(resolve_upload_files(&disk, &eleven).await), "upload requires 1\u{2013}10 approved absolute file paths");
        assert_eq!(message(resolve_upload_files(&disk, &["rel/a.txt".to_owned()]).await), "upload approval requires absolute file paths");
        let missing = if cfg!(windows) { "C:\\work\\missing.txt" } else { "/work/missing.txt" };
        assert!(message(resolve_upload_files(&disk, &[missing.to_owned()]).await).starts_with("upload approval cannot read the file"));
        let dir = if cfg!(windows) { "C:\\work" } else { "/work" };
        disk.0.lock().unwrap().insert(PathBuf::from(dir), FileFacts { exists: true, is_file: false, canonical: Some(PathBuf::from(dir)), ..FileFacts::default() });
        assert_eq!(message(resolve_upload_files(&disk, &[dir.to_owned()]).await), "upload approval requires regular files");
        assert_eq!(resolve_upload_files(&disk, &vec![ABS.to_owned(); 10]).await.unwrap().len(), 10);
    }

    #[test]
    fn the_precondition_carries_the_document_origin_url_and_receiver() {
        let mut bound = binding("{}");
        assert_eq!(
            serde_json::to_value(precondition(&bound)).unwrap(),
            json!({"documentId": "p:1", "origin": "https://a.test", "url": "https://a.test/form"})
        );
        bound.receiver_key = "k".into();
        bound.url = "about:blank".into();
        assert_eq!(serde_json::to_value(precondition(&bound)).unwrap(), json!({"documentId": "p:1", "url": "about:blank", "receiverKey": "k"}));
    }

    #[test]
    fn a_card_marks_files_outside_the_working_directory_and_downloads() {
        let file = |path: &str| BrowserApprovalFile { name: "f".into(), path: path.into(), size: 1, outside: false };
        let mut files = vec![file("/proj/src/a.txt"), file("/home/u/Downloads/b.txt"), file("/etc/c.txt"), file("/projects/d.txt")];
        mark_outside(&mut files, Some(Path::new("/proj")), Some(Path::new("/home/u/Downloads")));
        assert_eq!(files.iter().map(|file| file.outside).collect::<Vec<_>>(), [false, false, true, true]);
        // Unknown working directory: nothing is marked.
        let mut files = vec![file("/etc/c.txt")];
        mark_outside(&mut files, None, Some(Path::new("/home/u/Downloads")));
        assert!(!files[0].outside);
    }

    /// Security: approve a submit, the document moves to another origin, dispatch: the host answers -32010 and nothing is sent.
    #[tokio::test]
    async fn a_dispatch_after_the_document_moved_is_refused_by_the_host_with_nothing_sent() {
        let bound = binding("{\"action\":\"click\"}");
        let mut moved = page_facts("p", 2);
        moved["documentId"] = json!("p:2");
        moved["url"] = json!("https://evil.test/");
        let facts: PageFacts = serde_json::from_value(moved).expect("facts");
        let host = Arc::new(FakeHost::scripted(vec![
            Expect::err("host/browser/page/navigate", HostCallError::PreconditionFailed { reason: BrowserPreconditionReason::Origin, facts: Box::new(facts) })
                .with_params(json!({"expect": {"documentId": "p:1", "origin": "https://a.test", "url": "https://a.test/form"}})),
        ]));
        let params: HostBrowserPageNavigateParams = serde_json::from_value(json!({
            "pageId": "p", "kind": "reload", "expect": serde_json::to_value(precondition(&bound)).unwrap()
        }))
        .expect("params");
        let answer = host.page_navigate(params, &token()).await;
        assert!(matches!(answer, Err(HostCallError::PreconditionFailed { reason: BrowserPreconditionReason::Origin, .. })), "{answer:?}");
        assert_eq!(host.calls().len(), 1);
        host.finish().expect("the scripted call was the only one");
        // The engine's own check refuses the same move before any request is made.
        let page = Page::at("https://evil.test/", "p:2", "");
        assert_eq!(verify(&bound, &allow(), "{\"action\":\"click\"}", &page, &Disk::default(), &token()).await, Err(ApprovalError::TargetChanged));
    }
}
