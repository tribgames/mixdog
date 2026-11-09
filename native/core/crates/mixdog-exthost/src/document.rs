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
        Self { pool, cache_root: cache_root.into() }
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
                let rel = text("rel").ok_or_else(|| invalid("rel", "a project-relative path"))?;
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
