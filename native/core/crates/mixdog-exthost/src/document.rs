//! The `document/*` domain: previews of Office documents and the LibreOffice dependency. Every
//! method is one call on the extension-host pool (`document.*` in `src/ext-host/document.mjs`);
//! this service decodes the request, approves the project root for the call, and maps the pool's
//! failures to coded domain errors.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::Caller;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;
use tokio::sync::OwnedSemaphorePermit;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub struct DocumentService {
    pool: Arc<dyn ExtPool>,
    /// The document each running call is on (see [`Self::turn`]).
    turns: StdMutex<HashMap<String, Arc<Semaphore>>>,
    /// Where converted PDFs and rasterized pages are cached (the runtime keeps its own subfolders).
    cache_root: String,
    /// What a paired phone may render as pages; without it a relay connection renders nothing.
    relay: Option<RelayScope>,
}

struct RelayScope {
    files: Arc<dyn RelayFiles>,
    panes: Arc<crate::VisualizePanes>,
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

/// The code Node's `fs` errors carry: `E` and upper-case letters (`ENOENT`).
fn is_os_error_code(code: &str) -> bool {
    code.len() > 1 && code.starts_with('E') && code.bytes().all(|b| b.is_ascii_uppercase())
}

/// A worker failure as the domain's coded error; the text stays in the worker's log. Codes are the
/// worker's own, upper-cased (`NO_PREVIEW_FOR_TYPE`, `INSTALL_FAILED`, ...).
fn map_error(error: ExtError) -> CoreError {
    match error {
        ExtError::Cancelled => CoreError::Cancelled { by: "caller".into() },
        ExtError::Overloaded => CoreError::QueueFull { queue: "extensionHost".into() },
        ExtError::Unavailable { reason } => CoreError::CapabilityUnavailable { capability: "extensionHost".into(), detail: reason.into() },
        ExtError::UnknownWorker | ExtError::HostExited { .. } => {
            CoreError::DomainError { domain: "document".into(), code: Some("HOST_EXITED".into()), message: None, detail: None }
        }
        ExtError::Failed { code, message } if code == "invalid_params" => invalid("params", &message),
        // The codes whose text Node shows include an external program's own message: the
        // package manager's last output line (`cli-run.ts` installWithPackageManager) and the
        // conversion engine's error (`document-preview.mjs` renderWithEngine and
        // renderWithMicrosoftOffice, which throw uncoded).
        ExtError::Failed { code, message }
            if matches!(code.as_str(), "install_failed" | "install_unsupported" | "package_manager_unavailable" | "executable_not_found" | "failed") =>
        {
            CoreError::DomainError { domain: "document".into(), code: Some(code.to_uppercase().into()), message: Some(message.into()), detail: None }
        }
        // Failures whose text is Node's own sentence about the caller's file (no external program's output in it): a phone shows them
        // as Node did, so they travel with the code - the preview's refusals and the OS's own file errors (`ENOENT`, `EACCES`, ...).
        ExtError::Failed { code, message }
            if matches!(code.as_str(), "no_preview_for_type" | "not_a_file" | "path_outside_project") || is_os_error_code(&code) =>
        {
            CoreError::DomainError { domain: "document".into(), code: Some(code.to_uppercase().into()), message: Some(message.into()), detail: None }
        }
        ExtError::Failed { code, .. } => {
            CoreError::DomainError { domain: "document".into(), code: Some(code.to_uppercase().into()), message: None, detail: None }
        }
    }
}

#[async_trait]
impl DomainService for DocumentService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(&req).await?))
    }

    fn methods(&self) -> &'static [&'static str] {
        &["document/preview", "document/previewPages", "document/libreOfficeStatus", "document/installLibreOffice"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::call::WindowRole;
    use mixdog_core_api::call::WindowScope;
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::ext::ExtWorkerId;
    use mixdog_core_api::domain::ext::ExtWorkerStatus;

    use super::*;

    struct Scripted {
        answer: Result<Value, ExtError>,
        seen: Mutex<Vec<ExtCall>>,
    }

    struct One(Option<ExtFrame>);

    #[async_trait]
    impl EventSource<ExtFrame> for One {
        async fn next(&mut self) -> Option<ExtFrame> {
            self.0.take()
        }
    }

    impl ExtPool for Scripted {
        fn call(&self, call: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
            self.seen.lock().unwrap().push(call);
            Ok(Box::new(One(Some(ExtFrame::Done(self.answer.clone())))))
        }

        fn status(&self) -> Vec<ExtWorkerStatus> {
            Vec::new()
        }

        fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
            Ok(())
        }
    }

    fn request(method: &'static str, params: Value) -> CoreRequest {
        CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("test") }
    }

    fn service(answer: Result<Value, ExtError>) -> (DocumentService, Arc<Scripted>) {
        let pool = Arc::new(Scripted { answer, seen: Mutex::default() });
        (DocumentService::new(pool.clone(), "/cache"), pool)
    }

    #[tokio::test]
    async fn an_external_tools_message_travels_with_its_error() {
        let (service, _) = service_failing("install_failed");
        let error = service.call(request("document/installLibreOffice", json!({ "opId": "x" }))).await.unwrap_err();
        let CoreError::DomainError { code, message, detail, .. } = error else { panic!("a coded error") };
        assert_eq!(code.as_deref(), Some("INSTALL_FAILED"));
        assert_eq!(message.as_deref(), Some("m"));
        assert_eq!(detail, None);
    }

    #[tokio::test]
    async fn every_installer_failure_carries_the_text_node_showed() {
        for code in ["install_unsupported", "package_manager_unavailable", "executable_not_found"] {
            let (service, _) = service_failing(code);
            let error = service.call(request("document/installLibreOffice", json!({ "opId": "x" }))).await.unwrap_err();
            let CoreError::DomainError { message, .. } = error else { panic!("a coded error") };
            assert_eq!(message.as_deref(), Some("m"), "{code}");
        }
    }

    /// The workspace's refusal for a file it does not admit, as the phone-files recording has it (relay scenario,
    /// `previewDocumentPages` on a folder that is no project): the stand-in for every file outside the panes here.
    struct NoFiles(CoreError);

    fn relay(method: &'static str, params: Value) -> CoreRequest {
        let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Relay, CancellationToken::new());
        CoreRequest { method: Method(method), params, op: None, ctx }
    }

    fn service_failing(code: &str) -> (DocumentService, Arc<Scripted>) {
        service(Err(ExtError::Failed { code: code.into(), message: "m".into() }))
    }

    #[tokio::test]
    async fn an_install_ignores_the_callers_cancellation_but_a_preview_honours_it() {
        let (service, pool) = service(Ok(json!({ "installed": true })));
        let install = request("document/installLibreOffice", json!({ "opId": "x" }));
        install.ctx.cancel.cancel();
        assert!(service.call(install).await.is_ok(), "an admitted install completes");
        assert_eq!(pool.seen.lock().unwrap().len(), 1);

        let status = request("document/libreOfficeStatus", json!({}));
        status.ctx.cancel.cancel();
        // The scripted stream answers at once; the cancelled token wins the race (biased select).
        assert!(matches!(service.call(status).await, Err(CoreError::Cancelled { .. })));
    }

    /// A pool whose calls take a few turns of the executor, counting how many are running at once.
    #[derive(Default)]
    struct Counting {
        running: std::sync::atomic::AtomicUsize,
        peak: std::sync::atomic::AtomicUsize,
    }

    struct Slow {
        pool: Arc<Counting>,
        done: bool,
    }

    #[async_trait]
    impl EventSource<ExtFrame> for Slow {
        async fn next(&mut self) -> Option<ExtFrame> {
            if self.done {
                return None;
            }
            for _ in 0..5 {
                tokio::task::yield_now().await;
            }
            self.done = true;
            self.pool.running.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            Some(ExtFrame::Done(Ok(json!({}))))
        }
    }

    struct CountingPool(Arc<Counting>);

    impl ExtPool for CountingPool {
        fn call(&self, _: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
            use std::sync::atomic::Ordering::SeqCst;
            let now = self.0.running.fetch_add(1, SeqCst) + 1;
            self.0.peak.fetch_max(now, SeqCst);
            Ok(Box::new(Slow { pool: Arc::clone(&self.0), done: false }))
        }

        fn status(&self) -> Vec<ExtWorkerStatus> {
            Vec::new()
        }

        fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
            Ok(())
        }
    }

    fn root() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }
    #[tokio::test]
    async fn preview_pages_asks_the_worker_with_the_root_approved() {
        let (service, pool) = service(Ok(json!({ "pageCount": 2, "pages": [] })));
        let params = json!({ "root": root(), "rel": "a.docx", "options": { "pages": [1] } });
        let Reply::Value(value) = service.call(request("document/previewPages", params)).await.unwrap() else { panic!("a value reply") };
        assert_eq!(value["pageCount"], 2);
        let seen = pool.seen.lock().unwrap();
        assert_eq!(seen[0].method, "document.previewPages");
        assert_eq!(seen[0].params["rel"], "a.docx");
        assert_eq!(seen[0].params["cacheRoot"], "/cache");
        assert_eq!(seen[0].params["options"]["pages"], json!([1]));
        assert_eq!(seen[0].paths.len(), 1, "only the project root is approved");
    }
    #[tokio::test]
    async fn bad_requests_and_worker_failures_are_coded() {
        let (service, _) = service(Ok(json!(null)));
        let relative = json!({ "root": "relative/dir", "rel": "a.docx" });
        assert!(matches!(service.call(request("document/preview", relative)).await, Err(CoreError::InvalidParams { .. })));
        assert!(matches!(service.call(request("document/nope", json!({}))).await, Err(CoreError::InvalidParams { .. })));

        let (service, _) = service_failing("no_preview_for_type");
        let error = service.call(request("document/preview", json!({ "root": root(), "rel": "n.txt" }))).await.unwrap_err();
        let CoreError::DomainError { domain, code, .. } = error else { panic!("a coded error") };
        assert_eq!((&*domain, code.as_deref()), ("document", Some("NO_PREVIEW_FOR_TYPE")));
    }
    #[async_trait]
    impl RelayFiles for NoFiles {
        async fn admit(&self, _: &CoreRequest, _: &str, _: &str) -> Result<(String, String), CoreError> {
            Err(self.0.clone())
        }
        async fn private_copy(&self, _: &CoreRequest, root: &str, rel: &str) -> Result<PrivateCopy, CoreError> {
            Ok(PrivateCopy { root: root.to_owned(), rel: rel.to_owned(), guard: Box::new(()) })
        }
    }
    /// The failing path: the window's thumbnail, the panel's conversion and a phone's pages of one document arrive together, each
    /// on its own pool thread, and two workers converted the same document at once. Calls on one document now run one after
    /// another; calls on different documents still overlap.
    #[tokio::test]
    async fn calls_on_one_document_run_one_after_another_and_other_documents_overlap() {
        use std::sync::atomic::Ordering::SeqCst;
        let counting = Arc::new(Counting::default());
        let service = DocumentService::new(Arc::new(CountingPool(Arc::clone(&counting))), "/cache");
        let ask = |method: &'static str, rel: &str| service.call(request(method, json!({ "root": root(), "rel": rel })));
        let (a, b, c) = tokio::join!(ask("document/previewPages", "a.docx"), ask("document/preview", "a.docx"), ask("document/previewPages", "a.docx"));
        assert!(a.is_ok() && b.is_ok() && c.is_ok());
        assert_eq!(counting.peak.load(SeqCst), 1, "one conversion of a document at a time");
        let (spelled, plain) = tokio::join!(ask("document/preview", "./sub/../a.docx"), ask("document/preview", "a.docx"));
        assert!(spelled.is_ok() && plain.is_ok());
        assert_eq!(counting.peak.load(SeqCst), 1, "equivalent spellings of one path take one turn");

        counting.peak.store(0, SeqCst);
        let (d, e) = tokio::join!(ask("document/preview", "a.docx"), ask("document/preview", "b.xlsx"));
        assert!(d.is_ok() && e.is_ok());
        assert_eq!(counting.peak.load(SeqCst), 2, "documents do not wait for each other");
        assert!(service.turns.lock().unwrap().len() <= 2, "an entry outlives its calls only until the next one");
    }

    fn phone_files_refusal() -> (CoreError, Value) {
        let error = CoreError::DomainError {
            domain: "workspace".into(),
            code: Some("PROJECT_UNAVAILABLE".into()),
            message: Some("That folder is not available.".into()),
            detail: None,
        };
        (error, json!({ "ok": false }))
    }

    /// A phone renders a visualize pane's file for a relay connection when it is a PDF or Office pane, the request names the
    /// pane's own file inside the pane's own root (`pane.root`, else the tab's `cwd`), and the pane is still in the desktop's last
    /// published state; every other file gets the workspace's file refusal and the worker is not asked.
    #[tokio::test]
    async fn a_relay_preview_of_a_visualize_pane_needs_the_panes_own_file_in_the_panes_own_root() {
        let base = root();
        let panes = Arc::new(crate::VisualizePanes::default());
        let snapshot = json!([{
            "sessionId": "s1",
            "tabs": [{
                "cwd": base,
                "panes": [
                    { "kind": "pdf", "path": format!("{base}/a.pdf") },
                    { "kind": "document", "path": format!("{base}/sub/b.docx"), "root": format!("{base}/sub") },
                    { "kind": "text", "path": format!("{base}/n.txt") }
                ]
            }]
        }]);
        panes.fold(&snapshot);
        let (refusal, _) = phone_files_refusal();
        let preview = |root: &str, rel: &str| {
            let (service, pool) = service(Ok(json!({ "pageCount": 1 })));
            let service = service.with_relay_scope(Arc::new(NoFiles(refusal.clone())), panes.clone());
            let params = json!({ "root": root, "rel": rel, "options": { "pages": [1] } });
            async move {
                let answer = service.call(relay("document/previewPages", params)).await;
                let asked = pool.seen.lock().unwrap().len();
                (answer, asked)
            }
        };
        let (answer, asked) = preview(&base, "a.pdf").await;
        assert!(answer.is_ok() && asked == 1, "a PDF pane's file in the tab's folder");
        let sub = format!("{base}/sub");
        let (answer, asked) = preview(&sub, "b.docx").await;
        assert!(answer.is_ok() && asked == 1, "an Office pane's file in the pane's own root");
        for (root, rel) in [(base.as_str(), "sub/b.docx"), (base.as_str(), "n.txt"), (base.as_str(), "other.pdf")] {
            let (answer, asked) = preview(root, rel).await;
            assert_eq!(answer.unwrap_err(), refusal, "{root} {rel}");
            assert_eq!(asked, 0, "the worker is not asked for {rel}");
        }
        panes.fold(&json!({ "sessionId": "s1", "state": { "sessionId": "s1", "tabs": [] } }));
        let (answer, asked) = preview(&base, "a.pdf").await;
        assert!(answer.is_err() && asked == 0, "an emptied session takes its panes away");
    }

    /// The file rule is the workspace's (`RelayFiles`); a desktop connection is not asked it, and a relay connection with no
    /// scope wired renders nothing.
    #[tokio::test]
    async fn only_a_relay_preview_is_held_to_the_phones_files() {
        let (refusal, _) = phone_files_refusal();
        let params = json!({ "root": root(), "rel": "a.pdf" });
        let (service, pool) = service(Ok(json!({ "pageCount": 1 })));
        let service = service.with_relay_scope(Arc::new(NoFiles(refusal.clone())), Arc::default());
        assert_eq!(service.call(relay("document/previewPages", params.clone())).await.unwrap_err(), refusal);
        assert!(service.call(request("document/previewPages", params.clone())).await.is_ok(), "a desktop call");
        // A window's socket is `Local` (or `Ssh`), not `Relay`: main, and a server-role window, are not asked the phone's file rule.
        for role in [WindowRole::Main, WindowRole::Server { connection_id: "c1".into() }] {
            let mut req = request("document/previewPages", params.clone());
            req.ctx = req.ctx.with_window(Some(WindowScope { id: "w1".into(), role: role.clone() }));
            assert!(service.call(req).await.is_ok(), "{role:?}: a window call");
        }
        assert_eq!(pool.seen.lock().unwrap().len(), 3);
        let (bare, _) = service_failing("x");
        assert!(matches!(bare.call(relay("document/previewPages", params)).await, Err(CoreError::CapabilityUnavailable { .. })));
    }
}

/// The files a paired phone may name by path: a registered project's entry or a file its device holds a one-file grant for
/// (the workspace's `relay_file`), answering Node's refusal otherwise. The answer is the folder and the entry as admitted
/// (Node's `target.root`, `target.rel`): the worker is asked for those, not for what the phone sent.
#[async_trait]
pub trait RelayFiles: Send + Sync {
    async fn admit(&self, req: &CoreRequest, root: &str, rel: &str) -> Result<(String, String), CoreError>;
    /// The admitted file as a private copy made through its authorized open handle: what the worker renders is the bytes that were
    /// authorized, never the path, which could be swapped between the check and the open (Node's `withAuthorizedFile`).
    async fn private_copy(&self, req: &CoreRequest, root: &str, rel: &str) -> Result<PrivateCopy, CoreError>;
}
/// A private copy of a file: the folder and name the worker is asked for. The copy is removed when this drops.
pub struct PrivateCopy {
    pub root: String,
    pub rel: String,
    pub guard: Box<dyn std::any::Any + Send + Sync>,
}
impl DocumentService {
    pub fn new(pool: Arc<dyn ExtPool>, cache_root: impl Into<String>) -> Self {
        Self { pool, turns: StdMutex::default(), cache_root: cache_root.into(), relay: None }
    }

    /// The turn on one document: the sharing, not the safety. The desktop's window, its main process and a paired phone ask for
    /// the same document in the same breath, each on its own pool thread and so on its own worker process, and workers share
    /// nothing but the cache directory. Calls on one document wait for each other here, and a later one finds the PDF the first
    /// made, so a version is converted once. Safety does not depend on it: a conversion works in a staging directory and
    /// publishes atomically (`mixdog-office-pdf` `preview/convert.rs`), so a cancelled call that releases its turn before its
    /// worker has stopped, or a path spelled another way, can only cost a duplicate conversion. Each call looks at the file when
    /// it starts, so none is answered with an older version than the one it asked for.
    async fn turn(&self, cancel: &CancellationToken, root: &str, rel: &str) -> Result<OwnedSemaphorePermit, CoreError> {
        // The path the worker resolves to (`.` and `..` folded away), so `a.docx` and `./a.docx` take one turn.
        let mut parts: Vec<String> = Vec::new();
        for part in format!("{}/{}", root.replace('\\', "/"), rel.replace('\\', "/")).split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                part => parts.push(part.to_owned()),
            }
        }
        let key = parts.join("/");
        let key = if cfg!(windows) { key.to_lowercase() } else { key };
        let lock = {
            let mut turns = self.turns.lock().unwrap_or_else(PoisonError::into_inner);
            // Only a document someone is on or waits for keeps an entry.
            turns.retain(|_, lock| Arc::strong_count(lock) > 1);
            Arc::clone(turns.entry(key).or_insert_with(|| Arc::new(Semaphore::new(1))))
        };
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(CoreError::Cancelled { by: "caller".into() }),
            guard = lock.acquire_owned() => Ok(guard.expect("a document turn gate is never closed")),
        }
    }

    /// What a relay connection's `document/previewPages` may name: Node's `previewDocumentPages` took a project file or a
    /// granted one (`remoteFileTarget`), its `visualizePanePages` a PDF or Office pane's own file inside the pane's root.
    pub fn with_relay_scope(mut self, files: Arc<dyn RelayFiles>, panes: Arc<crate::VisualizePanes>) -> Self {
        self.relay = Some(RelayScope { files, panes });
        self
    }

    /// A relay connection's page request, checked before the worker is asked: the folder and the entry the worker is asked
    /// for. A pane's are the pane's own root and file, which is what was matched; a file's are the workspace's answer.
    async fn admit_relay(&self, req: &CoreRequest, root: &str, abs: &AbsPath, rel: &str) -> Result<PrivateCopy, CoreError> {
        let Some(scope) = &self.relay else {
            return Err(CoreError::CapabilityUnavailable { capability: "relayFiles".into(), detail: "noClaimant".into() });
        };
        let (root, rel) = if scope.panes.page_file(abs.as_path(), rel) { (root.to_owned(), rel.to_owned()) } else { scope.files.admit(req, root, rel).await? };
        scope.files.private_copy(req, &root, &rel).await
    }

    /// One pool call to completion. `cancel`: dropping the stream cancels the worker's call; an
    /// install passes `None` (an admitted mutation completes even if its caller leaves).
    async fn ext(&self, thread: ThreadId, method: &str, params: Value, paths: Vec<AbsPath>, cancel: Option<&CancellationToken>) -> Result<Value, CoreError> {
        let mut stream = self.pool.call(ExtCall { thread, method: method.to_owned(), params, paths }).map_err(map_error)?;
        loop {
            let frame = match cancel {
                Some(token) => tokio::select! {
                    biased;
                    () = token.cancelled() => return Err(CoreError::Cancelled { by: "caller".into() }),
                    frame = stream.next() => frame,
                },
                None => stream.next().await,
            };
            match frame {
                Some(ExtFrame::Chunk(_)) => {}
                Some(ExtFrame::Done(outcome)) => return outcome.map_err(map_error),
                None => return Err(map_error(ExtError::UnknownWorker)),
            }
        }
    }

    async fn dispatch(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let thread = match &req.ctx.caller {
            Caller::Connection(id) => ThreadId::from(format!("document:{id:?}").as_str()),
            Caller::Internal(name) => ThreadId::from(format!("document:{name}").as_str()),
        };
        let text = |key: &str| req.params.get(key).and_then(Value::as_str);
        let root = || -> Result<(String, AbsPath), CoreError> {
            let root = text("root").ok_or_else(|| invalid("root", "a project root path"))?;
            let abs = AbsPath::new(PathBuf::from(root)).ok_or_else(|| invalid("root", "an absolute path"))?;
            Ok((root.to_owned(), abs))
        };
        match req.method.as_str() {
            "document/preview" => {
                let (root, abs) = root()?;
                let rel = text("rel").ok_or_else(|| invalid("rel", "a project-relative path"))?;
                let params = json!({ "root": root, "rel": rel, "cacheRoot": self.cache_root });
                let _turn = self.turn(&req.ctx.cancel, &root, rel).await?;
                self.ext(thread, "document.preview", params, vec![abs], Some(&req.ctx.cancel)).await
            }
            "document/previewPages" => {
                let (root, abs) = root()?;
                let rel = text("rel").ok_or_else(|| invalid("rel", "a project-relative path"))?.to_owned();
                // A phone's file is rendered from a private copy of the bytes its authorization opened; the copy lives until the
                // answer is made.
                let (root, abs, rel, _copy) = if req.ctx.origin == mixdog_protocol::Origin::Relay {
                    let copy = self.admit_relay(req, &root, &abs, &rel).await?;
                    let abs = AbsPath::new(PathBuf::from(&copy.root)).ok_or_else(|| invalid("root", "an absolute path"))?;
                    (copy.root.clone(), abs, copy.rel.clone(), Some(copy))
                } else {
                    (root, abs, rel, None)
                };
                let options = req.params.get("options").cloned().unwrap_or_else(|| json!({}));
                let params = json!({ "root": root, "rel": rel, "options": options, "cacheRoot": self.cache_root });
                let _turn = self.turn(&req.ctx.cancel, &root, &rel).await?;
                self.ext(thread, "document.previewPages", params, vec![abs], Some(&req.ctx.cancel)).await
            }
            "document/libreOfficeStatus" => {
                let refresh = req.params.get("refresh") == Some(&Value::Bool(true));
                let params = json!({ "refresh": refresh });
                self.ext(thread, "document.libreOfficeStatus", params, Vec::new(), Some(&req.ctx.cancel)).await
            }
            "document/installLibreOffice" => self.ext(thread, "document.installLibreOffice", json!({}), Vec::new(), None).await,
            _ => Err(invalid("method", "document/*")),
        }
    }
}
/// A visualize pane's pages for a paired phone: the same `document/previewPages` call, whose relay admission accepts a PDF or
/// Office pane's own file inside the pane's root (`VisualizePanes::page_file`).
#[async_trait]
impl crate::PanePages for DocumentService {
    async fn converted(&self, req: &CoreRequest, root: String, rel: String) -> Result<PathBuf, CoreError> {
        let Some(scope) = &self.relay else {
            return Err(CoreError::CapabilityUnavailable { capability: "relayFiles".into(), detail: "noClaimant".into() });
        };
        let copy = scope.files.private_copy(req, &root, &rel).await?;
        let abs = AbsPath::new(PathBuf::from(&copy.root)).ok_or_else(|| invalid("root", "an absolute path"))?;
        let thread = match &req.ctx.caller {
            Caller::Connection(id) => ThreadId::from(format!("document:{id:?}").as_str()),
            Caller::Internal(name) => ThreadId::from(format!("document:{name}").as_str()),
        };
        let params = json!({ "root": copy.root, "rel": copy.rel, "cacheRoot": self.cache_root });
        let _turn = self.turn(&req.ctx.cancel, &copy.root, &copy.rel).await?;
        let converted = self.ext(thread, "document.preview", params, vec![abs], Some(&req.ctx.cancel)).await?;
        let path = converted.get("path").and_then(Value::as_str).map(PathBuf::from).filter(|path| !path.starts_with(&copy.root));
        path.ok_or(CoreError::DomainError {
            domain: "visualize".into(),
            code: None,
            message: Some("The document preview is unavailable.".into()),
            detail: None,
        })
    }

    async fn pages(&self, req: &CoreRequest, root: String, rel: String, options: Value) -> Result<Value, CoreError> {
        let inner = CoreRequest {
            method: Method("document/previewPages"),
            params: json!({ "root": root, "rel": rel, "options": options }),
            op: None,
            ctx: req.ctx.clone(),
        };
        self.dispatch(&inner).await
    }
}
