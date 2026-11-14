//! The `import/` namespace: `getConversationImportJobs`, `listImportableConversations`,
//! `startConversationImport`, `cancelConversationImport`, `registerConversationImportFile`.
//! Every method carries its arguments in the `params` member of its protocol params
//! (`ImportStartConversationImportParams.params`, …): the one object Node's `createConversationImportApi` methods take.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::Admit;
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use serde_json::Value;

use super::convert::{Limits, Source};
use super::discovery::{Discovery, ListParams};
use super::fsutil::ImportError;
use super::jobs::ImportJobs;

const MAX_REQUEST_ID_LENGTH: usize = 200;

pub struct ImportService {
    discovery: Arc<Discovery>,
    jobs: Arc<ImportJobs>,
    limits: Limits,
}

/// A caller error, reported as `invalidParams`.
#[derive(Debug)]
struct Invalid(&'static str, &'static str);

enum Failure {
    Invalid(Invalid),
    Import(ImportError),
}

impl From<ImportError> for Failure {
    fn from(error: ImportError) -> Self {
        Self::Import(error)
    }
}

impl From<Invalid> for Failure {
    fn from(invalid: Invalid) -> Self {
        Self::Invalid(invalid)
    }
}

impl From<Failure> for CoreError {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Invalid(Invalid(path, expected)) => CoreError::InvalidParams { path: path.into(), expected: expected.into() },
            Failure::Import(ImportError(code)) => CoreError::DomainError { domain: "import".into(), code: Some(code.into()), message: None, detail: None },
        }
    }
}

fn object(params: &Value) -> Result<&Value, Invalid> {
    crate::params::object(params).ok_or(Invalid("params", "object"))
}

fn source_of(value: Option<&Value>) -> Result<Source, Invalid> {
    value.and_then(Value::as_str).and_then(Source::parse).ok_or(Invalid("params.source", "codex | claude | cowork"))
}

fn optional_time(value: Option<&Value>, name: &'static str) -> Result<Option<f64>, Invalid> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_f64().filter(|f| f.is_finite()).map(Some).ok_or(Invalid(name, "timestamp in milliseconds")),
    }
}

fn list_params(args: &Value) -> Result<ListParams, Invalid> {
    let limit = match args.get("limit") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_f64()
                .map(f64::floor)
                .filter(|f| f.is_finite() && *f >= 1.0)
                .ok_or(Invalid("params.limit", "positive integer"))? as usize,
        ),
    };
    let text = |key: &str| args.get(key).and_then(Value::as_str);
    Ok(ListParams {
        source: Some(source_of(args.get("source"))?),
        query: text("query").unwrap_or("").to_owned(),
        project: text("project").map(str::to_owned),
        cursor: text("cursor").map(str::to_owned),
        limit,
        modified_after: optional_time(args.get("modifiedAfter"), "params.modifiedAfter")?,
        modified_before: optional_time(args.get("modifiedBefore"), "params.modifiedBefore")?,
    })
}

impl ImportService {
    pub fn new(discovery: Arc<Discovery>, jobs: Arc<ImportJobs>, limits: Limits) -> Self {
        Self { discovery, jobs, limits }
    }

    async fn selection_ids(&self, selection: Option<&Value>) -> Result<Vec<String>, Failure> {
        let selection = selection.filter(|s| s.is_object()).ok_or(Invalid("params.selection", "object"))?;
        if let Some(ids) = selection.get("ids").and_then(Value::as_array) {
            let mut out: Vec<String> = Vec::new();
            for id in ids {
                let id = id.as_str().filter(|s| !s.is_empty()).ok_or(Invalid("params.selection.ids", "ids"))?;
                if !out.iter().any(|x| x == id) {
                    out.push(id.to_owned());
                }
            }
            return Ok(out);
        }
        let view_id = selection.get("viewId").and_then(Value::as_str).ok_or(Invalid("params.selection", "ids or viewId"))?;
        let exclude: Vec<String> = match selection.get("excludeIds") {
            None => Vec::new(),
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
            Some(_) => return Err(Invalid("params.selection.excludeIds", "ids").into()),
        };
        let imported = self.jobs.imported_lookup().await;
        Ok(self.discovery.resolve_view_selection(view_id, &exclude, &imported).await?)
    }

    async fn dispatch(&self, method: &str, request: &Value) -> Result<Value, Failure> {
        // `requireParams(params)`; only `getConversationImportJobs(params = {})` may leave the member out.
        let args = match request.get("params") {
            None | Some(Value::Null) if method == "import/getConversationImportJobs" => &Value::Null,
            params => object(params.unwrap_or(&Value::Null))?,
        };
        match method {
            "import/getConversationImportJobs" => Ok(self.jobs.get_jobs(args.get("jobId"))),
            "import/listImportableConversations" => {
                let params = list_params(args)?;
                let imported = self.jobs.imported_lookup().await;
                Ok(self.discovery.list_conversations(&params, &imported).await?)
            }
            "import/registerConversationImportFile" => {
                let source = source_of(args.get("source"))?;
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                let imported = self.jobs.imported_lookup().await;
                Ok(self.discovery.register_file(source, path, &imported, self.limits).await?)
            }
            "import/startConversationImport" => {
                let request_id = args
                    .get("requestId")
                    .and_then(Value::as_str)
                    .filter(|r| !mixdog_js::js_trim(r).is_empty() && mixdog_js::utf16_len(r) <= MAX_REQUEST_ID_LENGTH)
                    .ok_or(Invalid("params.requestId", "string"))?;
                if let Some(existing) = self.jobs.existing(request_id) {
                    return Ok(existing);
                }
                let ids = self.selection_ids(args.get("selection")).await?;
                Ok(self.jobs.start(request_id, ids))
            }
            "import/cancelConversationImport" => Ok(self.jobs.cancel(args.get("jobId").and_then(Value::as_str).unwrap_or(""))?),
            _ => Err(Invalid("method", "import/*").into()),
        }
    }
}

#[async_trait]
impl DomainService for ImportService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(req.method.as_str(), &req.params).await?))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "import/getConversationImportJobs",
            "import/listImportableConversations",
            "import/registerConversationImportFile",
            "import/startConversationImport",
            "import/cancelConversationImport",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn list_params_are_type_checked() {
        let ok = list_params(&json!({"source": "claude", "limit": 7.9, "modifiedAfter": 5})).unwrap();
        assert_eq!((ok.source, ok.limit, ok.modified_after), (Some(Source::Claude), Some(7), Some(5.0)));
        assert!(list_params(&json!({"source": "gemini"})).is_err());
        assert!(list_params(&json!({"source": "codex", "limit": 0})).is_err());
        assert!(list_params(&json!({"source": "codex", "modifiedBefore": "x"})).is_err());
    }

    struct Quiet;

    #[async_trait]
    impl super::super::jobs::ImportSessions for Quiet {
        async fn imported_sessions(&self) -> Vec<(String, String)> {
            Vec::new()
        }
        async fn session_exists(&self, _: &str) -> bool {
            false
        }
        async fn prepare_lead(&self) -> Result<(), String> {
            Ok(())
        }
        async fn create_imported_session(&self, _: super::super::jobs::ImportedSession) -> Result<String, String> {
            Err("none".into())
        }
    }

    /// The protocol params' `params` member is the arguments: a start, the jobs filter and a cancel reach the job they name (a
    /// null filter lists every job, one that is not text none); `cancelConversationImport` of an unknown job answers the
    /// `jobNotFound` code (`conversation-import/service.mjs` `importError('jobNotFound')`), a start with no `requestId` is refused
    /// for that field, and arguments left at the top level are refused as a missing params object (`requireParams`).
    #[tokio::test]
    async fn the_params_member_reaches_the_method() {
        let home = tempfile::tempdir().unwrap();
        let env = super::super::candidate::Env { home: home.path().to_path_buf(), ..Default::default() };
        let discovery = Discovery::new(env, mixdog_rt::testing::tokens().maintenance_io);
        let jobs = ImportJobs::new(discovery.clone(), Arc::new(Quiet), Limits::default());
        let service = ImportService::new(discovery, jobs, Limits::default());
        let call = |method: &'static str, params: Value| {
            service.call(CoreRequest { method: Method(method), params, op: None, ctx: mixdog_core_api::CallContext::internal("test") })
        };
        let value = |reply: Result<Reply, CoreError>| match reply.unwrap() {
            Reply::Value(v) => v,
            _ => panic!("not a value"),
        };
        let started = value(call("import/startConversationImport", json!({"opId": "o", "params": {"requestId": "r", "selection": {"ids": []}}})).await);
        let job_id = started["jobId"].as_str().unwrap().to_owned();
        let named = value(call("import/getConversationImportJobs", json!({"params": {"jobId": job_id}})).await);
        assert_eq!(named["jobs"][0]["jobId"], started["jobId"]);
        assert_eq!(value(call("import/getConversationImportJobs", json!({"params": {"jobId": "no-such-job"}})).await), json!({"jobs": []}));
        assert_eq!(value(call("import/getConversationImportJobs", json!({})).await)["jobs"].as_array().map(Vec::len), Some(1));
        assert_eq!(value(call("import/getConversationImportJobs", json!({"params": {"jobId": null}})).await)["jobs"].as_array().map(Vec::len), Some(1));
        assert_eq!(value(call("import/getConversationImportJobs", json!({"params": {"jobId": 5}})).await), json!({"jobs": []}));
        let cancelled = value(call("import/cancelConversationImport", json!({"opId": "o", "params": {"jobId": job_id}})).await);
        assert_eq!(cancelled["jobId"], started["jobId"]);
        match call("import/cancelConversationImport", json!({"opId": "o", "params": {"jobId": "no-such-job"}})).await.err().unwrap() {
            CoreError::DomainError { code, .. } => assert_eq!(code.as_deref(), Some("jobNotFound")),
            other => panic!("{other:?}"),
        }
        match call("import/startConversationImport", json!({"opId": "o", "params": {"selection": {"ids": []}}})).await.err().unwrap() {
            CoreError::InvalidParams { path, .. } => assert_eq!(&*path, "params.requestId"),
            other => panic!("{other:?}"),
        }
        match call("import/listImportableConversations", json!({"source": "claude"})).await.err().unwrap() {
            CoreError::InvalidParams { path, .. } => assert_eq!(&*path, "params"),
            other => panic!("{other:?}"),
        }
    }
}
