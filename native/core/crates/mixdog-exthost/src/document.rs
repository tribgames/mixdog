//! The `document/*` domain: previews of Office documents and the LibreOffice dependency. Every
//! method is one call on the extension-host pool (`document.*` in `src/ext-host/document.mjs`);
//! this service decodes the request, approves the project root for the call, and maps the pool's
//! failures to coded domain errors.

use std::path::PathBuf;
use std::sync::Arc;

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
use tokio_util::sync::CancellationToken;

pub struct DocumentService {
    pool: Arc<dyn ExtPool>,
    /// Where converted PDFs and rasterized pages are cached (the runtime keeps its own subfolders).
    cache_root: String,
    /// What a paired phone may render as pages; without it a relay connection renders nothing.
    relay: Option<RelayScope>,
}

/// The files a paired phone may name by path: a registered project's entry or a file its device holds a one-file grant for
/// (the workspace's `relay_file`), answering Node's refusal otherwise. The answer is the folder and the entry as admitted
/// (Node's `target.root`, `target.rel`): the worker is asked for those, not for what the phone sent.
#[async_trait]
pub trait RelayFiles: Send + Sync {
    async fn admit(&self, req: &CoreRequest, root: &str, rel: &str) -> Result<(String, String), CoreError>;
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
        ExtError::Unavailable { reason } => {
            CoreError::CapabilityUnavailable { capability: "extensionHost".into(), detail: reason.into() }
        }
        ExtError::UnknownWorker | ExtError::HostExited { .. } => {
            CoreError::DomainError {
                domain: "document".into(),
                code: Some("HOST_EXITED".into()),
                message: None,
                detail: None,
            }
        }
        ExtError::Failed { code, message } if code == "invalid_params" => invalid("params", &message),
        // The codes whose text Node shows include an external program's own message: the
        // package manager's last output line (`cli-run.ts` installWithPackageManager) and the
        // conversion engine's error (`document-preview.mjs` renderWithEngine and
        // renderWithMicrosoftOffice, which throw uncoded).
        ExtError::Failed { code, message }
            if matches!(code.as_str(), "install_failed" | "install_unsupported" | "package_manager_unavailable" | "executable_not_found" | "failed") => CoreError::DomainError {
            domain: "document".into(),
            code: Some(code.to_uppercase().into()),
            message: Some(message.into()),
            detail: None,
        },
        // Failures whose text is Node's own sentence about the caller's file (no external program's output in it): a phone shows them
        // as Node did, so they travel with the code - the preview's refusals and the OS's own file errors (`ENOENT`, `EACCES`, ...).
        ExtError::Failed { code, message } if matches!(code.as_str(), "no_preview_for_type" | "not_a_file" | "path_outside_project") || is_os_error_code(&code) => {
            CoreError::DomainError { domain: "document".into(), code: Some(code.to_uppercase().into()), message: Some(message.into()), detail: None }
        }
        ExtError::Failed { code, .. } => CoreError::DomainError {
            domain: "document".into(),
            code: Some(code.to_uppercase().into()),
            message: None,
            detail: None,
        },
    }
}

impl DocumentService {
    pub fn new(pool: Arc<dyn ExtPool>, cache_root: impl Into<String>) -> Self {
        Self { pool, cache_root: cache_root.into(), relay: None }
    }

    /// What a relay connection's `document/previewPages` may name: Node's `previewDocumentPages` took a project file or a
    /// granted one (`remoteFileTarget`), its `visualizePanePages` a PDF or Office pane's own file inside the pane's root.
    pub fn with_relay_scope(mut self, files: Arc<dyn RelayFiles>, panes: Arc<crate::VisualizePanes>) -> Self {
        self.relay = Some(RelayScope { files, panes });
        self
    }

    /// A relay connection's page request, checked before the worker is asked: the folder and the entry the worker is asked
    /// for. A pane's are the pane's own root and file, which is what was matched; a file's are the workspace's answer.
    async fn admit_relay(&self, req: &CoreRequest, root: &str, abs: &AbsPath, rel: &str) -> Result<(String, String), CoreError> {
        let Some(scope) = &self.relay else {
            return Err(CoreError::CapabilityUnavailable { capability: "relayFiles".into(), detail: "noClaimant".into() });
        };
        if scope.panes.page_file(abs.as_path(), rel) {
            return Ok((root.to_owned(), rel.to_owned()));
        }
        scope.files.admit(req, root, rel).await
    }

    /// One pool call to completion. `cancel`: dropping the stream cancels the worker's call; an
    /// install passes `None` (an admitted mutation completes even if its caller leaves).
    async fn ext(
        &self,
        thread: ThreadId,
        method: &str,
        params: Value,
        paths: Vec<AbsPath>,
        cancel: Option<&CancellationToken>,
    ) -> Result<Value, CoreError> {
        let mut stream = self
            .pool
            .call(ExtCall { thread, method: method.to_owned(), params, paths })
            .map_err(map_error)?;
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
                self.ext(thread, "document.preview", params, vec![abs], Some(&req.ctx.cancel)).await
            }
            "document/previewPages" => {
                let (root, abs) = root()?;
                let rel = text("rel").ok_or_else(|| invalid("rel", "a project-relative path"))?.to_owned();
                let (root, abs, rel) = if req.ctx.origin == mixdog_protocol::Origin::Relay {
                    let (root, rel) = self.admit_relay(req, &root, &abs, &rel).await?;
                    let abs = AbsPath::new(PathBuf::from(&root)).ok_or_else(|| invalid("root", "an absolute path"))?;
                    (root, abs, rel)
                } else {
                    (root, abs, rel)
                };
                let options = req.params.get("options").cloned().unwrap_or_else(|| json!({}));
                let params = json!({ "root": root, "rel": rel, "options": options, "cacheRoot": self.cache_root });
                self.ext(thread, "document.previewPages", params, vec![abs], Some(&req.ctx.cancel)).await
            }
            "document/libreOfficeStatus" => {
                let refresh = req.params.get("refresh") == Some(&Value::Bool(true));
                let params = json!({ "refresh": refresh });
                self.ext(thread, "document.libreOfficeStatus", params, Vec::new(), Some(&req.ctx.cancel)).await
            }
            "document/installLibreOffice" => {
                self.ext(thread, "document.installLibreOffice", json!({}), Vec::new(), None).await
            }
            _ => Err(invalid("method", "document/*")),
        }
    }
}

#[async_trait]
impl DomainService for DocumentService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(&req).await?))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "document/preview",
            "document/previewPages",
            "document/libreOfficeStatus",
            "document/installLibreOffice",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::call::CallContext;
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
        CoreRequest {
            method: Method(method),
            params,
            op: None,
            ctx: CallContext::internal("test"),
        }
    }

    fn service(answer: Result<Value, ExtError>) -> (DocumentService, Arc<Scripted>) {
        let pool = Arc::new(Scripted { answer, seen: Mutex::default() });
        (DocumentService::new(pool.clone(), "/cache"), pool)
    }

    fn root() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn preview_pages_asks_the_worker_with_the_root_approved() {
        let (service, pool) = service(Ok(json!({ "pageCount": 2, "pages": [] })));
        let params = json!({ "root": root(), "rel": "a.docx", "options": { "pages": [1] } });
        let Reply::Value(value) = service.call(request("document/previewPages", params)).await.unwrap() else {
            panic!("a value reply")
        };
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
        assert!(matches!(
            service.call(request("document/preview", relative)).await,
            Err(CoreError::InvalidParams { .. })
        ));
        assert!(matches!(
            service.call(request("document/nope", json!({}))).await,
            Err(CoreError::InvalidParams { .. })
        ));

        let (service, _) = service_failing("no_preview_for_type");
        let error = service
            .call(request("document/preview", json!({ "root": root(), "rel": "n.txt" })))
            .await
            .unwrap_err();
        let CoreError::DomainError { domain, code, .. } = error else { panic!("a coded error") };
        assert_eq!((&*domain, code.as_deref()), ("document", Some("NO_PREVIEW_FOR_TYPE")));
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

    #[async_trait]
    impl RelayFiles for NoFiles {
        async fn admit(&self, _: &CoreRequest, _: &str, _: &str) -> Result<(String, String), CoreError> {
            Err(self.0.clone())
        }
    }

    fn relay(method: &'static str, params: Value) -> CoreRequest {
        let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Relay, CancellationToken::new());
        CoreRequest { method: Method(method), params, op: None, ctx }
    }

    fn phone_files_refusal() -> (CoreError, Value) {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../../../apps/mobile/fixtures/phone-files/golden.json")).unwrap();
        let frame = golden["scenarios"]["relay"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|step| step["call"] == "previewDocumentPages" && step["frame"]["errorCode"] == "PROJECT_UNAVAILABLE")
            .unwrap()["frame"]
            .clone();
        let error = CoreError::DomainError {
            domain: "workspace".into(),
            code: frame["errorCode"].as_str().map(|code| code.to_owned().into()),
            message: frame["error"].as_str().map(|text| text.to_owned().into()),
            detail: None,
        };
        (error, frame)
    }

    /// Node's `visualizePanePages` over its mirror of one snapshot (`fixtures/phone-guards/golden.json`, `visualize`): a pane Node
    /// rendered is rendered for a relay connection that names the pane's file in the pane's root (`pane.root ?? tab.cwd`), with no
    /// project or grant behind it; a pane Node refused is not, and gets the file refusal. An event that empties the session takes
    /// its panes away, as Node's mirror dropped the session.
    #[tokio::test]
    async fn a_relay_preview_of_a_visualize_pane_follows_nodes_mirror() {
        let golden: Value =
            serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/phone-guards/golden.json"))).unwrap();
        let recorded = &golden["scenarios"]["visualize"];
        let (refusal, refusal_frame) = phone_files_refusal();
        let panes = Arc::new(crate::VisualizePanes::default());
        panes.fold(&recorded["snapshot"]);
        let tab = &recorded["snapshot"][0]["tabs"][0];
        let request_for = |index: usize| -> Option<Value> {
            let pane = tab["panes"].get(index)?;
            let root = pane["root"].as_str().or(tab["cwd"].as_str()).unwrap();
            let rel = std::path::Path::new(pane["path"].as_str().unwrap()).strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            Some(json!({ "root": root, "rel": rel, "options": { "pages": [1] } }))
        };
        let mut rendered = 0;
        for (index, step) in recorded["steps"].as_array().unwrap().iter().enumerate() {
            let frame = &step["frame"];
            let Some(params) = request_for(index) else {
                // A closed pane has no file a request could name.
                assert_eq!(frame["error"], "This visualize pane is closed.");
                continue;
            };
            let (service, pool) = service(Ok(frame["value"].clone()));
            let service = service.with_relay_scope(Arc::new(NoFiles(refusal.clone())), panes.clone());
            let answer = service.call(relay("document/previewPages", params.clone())).await;
            let seen = pool.seen.lock().unwrap();
            if frame["ok"] == true {
                let Ok(Reply::Value(value)) = answer else { panic!("{params}: {answer:?}") };
                assert_eq!(json!({ "ok": true, "value": value }), *frame, "{params}");
                assert_eq!((seen.len(), &seen[0].params["root"], &seen[0].params["rel"]), (1, &params["root"], &params["rel"]));
                rendered += 1;
            } else {
                let Err(CoreError::DomainError { code, message, .. }) = answer else { panic!("{params}: {answer:?}") };
                assert_eq!(json!({ "ok": false, "error": message.as_deref(), "errorCode": code.as_deref() }), refusal_frame, "{params}");
                assert!(seen.is_empty(), "{params}: the worker is not asked");
            }
        }
        assert_eq!(rendered, 2);

        panes.fold(&json!({ "sessionId": "s1", "state": { "sessionId": "s1", "tabs": [] } }));
        let (service, pool) = service(Ok(json!({})));
        let service = service.with_relay_scope(Arc::new(NoFiles(refusal.clone())), panes.clone());
        assert!(service.call(relay("document/previewPages", request_for(0).unwrap())).await.is_err(), "the session is gone");
        assert!(pool.seen.lock().unwrap().is_empty());
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
        assert_eq!(pool.seen.lock().unwrap().len(), 1);
        let (bare, _) = service_failing("x");
        assert!(matches!(bare.call(relay("document/previewPages", params)).await, Err(CoreError::CapabilityUnavailable { .. })));
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
}
