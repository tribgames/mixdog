//! The `media/` namespace. Arguments ride in the request's `params` member.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::Admit;
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use serde_json::{Value, json};

use mixdog_core_base::support::{coded, failed};
use mixdog_protocol::ThreadId;

use super::jobs::MediaJobs;
use super::renditions::StillRenditions;
use super::store::{MediaError, MediaStore};
use super::variants;
use crate::params;
use crate::tidy::process::{Processes, RunOptions};

const OPENER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub struct MediaService {
    store: Arc<MediaStore>,
    jobs: Arc<MediaJobs>,
    processes: Processes,
    renditions: StillRenditions,
}

fn domain(code: &str) -> CoreError {
    CoreError::DomainError { domain: "media".into(), code: Some(code.into()), message: None, detail: None }
}

impl From<MediaError> for CoreError {
    fn from(e: MediaError) -> Self {
        match e {
            // Node's `Error`/`TypeError` text is what the window shows; `invalidParams` would drop it.
            MediaError::Invalid(message) => failed("media", message),
            MediaError::BoardNotFound => failed("media", e.to_string()),
            // What `fs` threw on Node's path (`EPERM: operation not permitted, rename '<tmp>' -> '<index>'`).
            MediaError::Fs(failure) => mixdog_core_base::support::io_failure("media", &failure),
            other => domain(other.code()),
        }
    }
}

/// `explorer.exe`/`open`/`xdg-open` with the path as one argument, never a shell string.
pub fn open_command(path: &Path, reveal: bool, platform: &str) -> (&'static str, Vec<String>) {
    let text = path.to_string_lossy().into_owned();
    let parent = || path.parent().map_or_else(|| text.clone(), |p| p.to_string_lossy().into_owned());
    match (platform, reveal) {
        ("windows", true) => ("explorer.exe", vec!["/select,".into(), text]),
        ("macos", true) => ("open", vec!["-R".into(), text]),
        ("windows", false) => ("explorer.exe", vec![text]),
        ("macos", false) => ("open", vec![text]),
        (_, true) => ("xdg-open", vec![parent()]),
        _ => ("xdg-open", vec![text]),
    }
}

/// Hands the path to the OS opener under the shared process manager; whether it could be
/// started is the answer, not how it exits (`explorer.exe` exits 1 after opening).
async fn open_with_os(processes: &Processes, path: &Path, reveal: bool) -> bool {
    let platform = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
    let (program, args) = open_command(path, reveal, platform);
    let cwd = std::env::temp_dir();
    let mut options = RunOptions::new(&cwd);
    options.timeout = OPENER_TIMEOUT;
    processes.run(program, &args, options).await.error_code.is_empty()
}

/// The object a method's Node implementation receives, from the wire params. Five methods carry it
/// in one field (`setMediaDefault`/`setMediaPin`/`startMediaJob`: `input`, `deleteMediaAssets`:
/// `filter`, `listMediaAssets`: `options`); a missing or empty one is `{}` (`input || {}`). Every
/// other method reads its few fields flat from the params.
fn wire_args(method: &str, params: &Value) -> Value {
    let field = match method {
        "media/setMediaDefault" | "media/setMediaPin" | "media/startMediaJob" => "input",
        "media/deleteMediaAssets" => "filter",
        "media/listMediaAssets" => "options",
        _ => return params.clone(),
    };
    match params.get(field) {
        Some(value) if !matches!(value, Value::Null | Value::Bool(false)) && value != "" && value.as_f64() != Some(0.0) => value.clone(),
        _ => json!({}),
    }
}

impl MediaService {
    pub fn new(store: Arc<MediaStore>, jobs: Arc<MediaJobs>, processes: Processes, renditions: StillRenditions) -> Self {
        Self { store, jobs, processes, renditions }
    }

    async fn dispatch(&self, method: &str, wire: &Value) -> Result<Value, CoreError> {
        let params = params::object(wire).cloned().unwrap_or_else(|| json!({}));
        // What the store and the jobs take: the object Node's method receives (`setMediaPin(input)`).
        let args = wire_args(method, &params);
        let text = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("");
        let id = text("id");
        let thread = ThreadId(if text("threadId").is_empty() { "media".to_owned() } else { text("threadId").to_owned() });
        let options = params.get("options").cloned().unwrap_or_else(|| json!({}));
        let input = params.get("input").cloned().unwrap_or(Value::Null);
        // Every store call reads or writes files: it runs as one job on the store's lane.
        let store = &self.store;
        let owned = args.clone();
        let owned_id = id.to_owned();
        match method {
            "media/getMediaDefault" => Ok(store.run(move |s| s.get_default(owned.get("kind"))).await?),
            "media/getMediaPins" => Ok(store.run(|s| s.get_pins()).await?),
            "media/setMediaDefault" => Ok(store.run(move |s| s.set_default(&owned)).await??),
            "media/setMediaPin" => Ok(store.run(move |s| s.set_pin(&owned)).await??),
            "media/getMediaJob" => Ok(self.jobs.get(id).unwrap_or(Value::Null)),
            "media/listMediaLanes" => Ok(self.jobs.lanes().await),
            "media/startMediaJob" => self.jobs.start(&args).await.map_err(|f| coded("media", f.code.as_deref().unwrap_or("MEDIA_FAILED"), f.message)),
            "media/cancelMediaJob" => Ok(self.jobs.cancel(id)),
            "media/listMediaAssets" => Ok(store
                .run(move |s| {
                    s.list_assets(
                        owned.get("limit").and_then(Value::as_f64),
                        owned.get("offset").and_then(Value::as_f64),
                        owned.get("kind").and_then(Value::as_str).filter(|k| !k.is_empty()),
                        owned.get("boardId").and_then(Value::as_str).unwrap_or(""),
                    )
                })
                .await??),
            "media/listMediaBoards" => Ok(store.run(|s| s.list_boards()).await??),
            "media/readMediaAsset" => Ok(variants::read_media_asset(store, &self.renditions, &thread, id, options).await?),
            "media/resolveMediaFile" => Ok(variants::resolve_media_file(store, &self.renditions, &thread, id, options).await?),
            "media/deleteMediaAsset" => Ok(store.run(move |s| s.delete_asset(&owned_id)).await??),
            "media/deleteMediaAssets" => Ok(store.run(move |s| s.delete_assets(&owned)).await??),
            "media/createMediaBoard" => Ok(store.run(move |s| s.create_board(owned.get("name"))).await??),
            "media/renameMediaBoard" => Ok(store.run(move |s| s.rename_board(owned.get("id"), owned.get("name"))).await??),
            "media/deleteMediaBoard" => Ok(store.run(move |s| s.delete_board(owned.get("id"))).await??),
            "media/setMediaAssetBoard" => Ok(store
                .run(move |s| s.set_asset_board(owned.get("ids").or(owned.get("id")).unwrap_or(&Value::Null), owned.get("boardId").unwrap_or(&Value::Null)))
                .await??),
            "media/cacheMediaThumbnail" => Ok(variants::cache_media_thumbnail(store, &self.renditions, id, input).await?),
            "media/openMediaAsset" => {
                let found = store.run(move |s| s.asset_path(&owned_id)).await??;
                let opened = match found {
                    Some(path) => open_with_os(&self.processes, &path, false).await,
                    None => false,
                };
                Ok(json!({"id": id, "opened": opened}))
            }
            "media/openMediaFolder" => {
                if id.is_empty() {
                    let root = store.run(|s| s.assets_root()).await?;
                    return Ok(json!({"path": root.to_string_lossy(), "opened": open_with_os(&self.processes, &root, false).await}));
                }
                match store.run(move |s| s.asset_path(&owned_id)).await?? {
                    Some(path) => Ok(json!({"id": id, "path": path.parent().map(|p| p.to_string_lossy()), "opened": open_with_os(&self.processes, &path, true).await})),
                    None => Ok(json!({"id": id, "path": "", "opened": false})),
                }
            }
            _ => Err(CoreError::InvalidParams { path: "method".into(), expected: "media/*".into() }),
        }
    }
}

#[async_trait]
impl DomainService for MediaService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(req.method.as_str(), &req.params).await?))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "media/getMediaDefault",
            "media/getMediaPins",
            "media/setMediaDefault",
            "media/setMediaPin",
            "media/getMediaJob",
            "media/listMediaLanes",
            "media/startMediaJob",
            "media/cancelMediaJob",
            "media/listMediaAssets",
            "media/listMediaBoards",
            "media/readMediaAsset",
            "media/resolveMediaFile",
            "media/deleteMediaAsset",
            "media/deleteMediaAssets",
            "media/createMediaBoard",
            "media/renameMediaBoard",
            "media/deleteMediaBoard",
            "media/setMediaAssetBoard",
            "media/cacheMediaThumbnail",
            "media/openMediaAsset",
            "media/openMediaFolder",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_commands_pass_the_path_as_one_argument() {
        let p = Path::new("/a/b & c/x.png");
        assert_eq!(open_command(p, false, "windows").1, vec!["/a/b & c/x.png".to_owned()]);
        assert_eq!(open_command(p, true, "macos"), ("open", vec!["-R".to_owned(), "/a/b & c/x.png".to_owned()]));
        assert_eq!(open_command(p, true, "linux").1, vec!["/a/b & c".to_owned()]);
    }

    const METHOD_TABLE: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../mixdog-app-protocol/schema/method_table.json");
    const CLIENT_REQUEST: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../mixdog-app-protocol/schema/client_request.json");

    /// The property names the protocol schema gives `method`'s params.
    fn schema_fields(method: &str) -> Vec<String> {
        let table: Value = serde_json::from_str(&METHOD_TABLE).unwrap();
        let name = table["clientMethods"].as_array().unwrap().iter().find(|m| m["method"] == method).unwrap_or_else(|| panic!("{method} is not in the protocol"))["params"].as_str().unwrap().to_owned();
        let requests: Value = serde_json::from_str(&CLIENT_REQUEST).unwrap();
        requests["definitions"][&name]["properties"].as_object().unwrap_or_else(|| panic!("no schema for {name}")).keys().cloned().collect()
    }

    fn object(entries: &[(&str, Value)]) -> Value {
        Value::Object(entries.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
    }

    #[test]
    fn the_object_methods_read_the_field_the_wire_carries_it_in() {
        // The wire shapes of the schema: `{ opId, threadId?, <field>: <the object Node's method takes> }`.
        let pin = json!({"kind": "image", "lane": "xai", "model": "grok-imagine-image"});
        for (method, field) in [("media/setMediaPin", "input"), ("media/setMediaDefault", "input"), ("media/startMediaJob", "input"), ("media/deleteMediaAssets", "filter"), ("media/listMediaAssets", "options")] {
            assert!(schema_fields(method).contains(&field.to_owned()), "{method}: the schema has no `{field}`");
            let wire = object(&[("opId", json!("op-1")), ("threadId", Value::Null), (field, pin.clone())]);
            assert_eq!(wire_args(method, &wire), pin, "{method}");
            assert_eq!(wire_args(method, &json!({"opId": "op-1"})), json!({}), "{method}: a missing object is `{{}}`");
            assert_eq!(wire_args(method, &object(&[(field, Value::Null)])), json!({}), "{method}: a null object is `{{}}`");
        }
        // A start carries the account, session and source type inside `input`.
        let start = json!({"opId": "op-2", "input": {"lane": "gemini", "kind": "image", "prompt": "p", "account": "work", "sessionId": "s", "sourceType": "lead"}});
        assert_eq!(wire_args("media/startMediaJob", &start)["account"], "work");
        assert_eq!(wire_args("media/listMediaAssets", &json!({"options": {"limit": 5, "offset": 10, "kind": "video", "boardId": "b"}}))["limit"], 5);
    }

    #[test]
    fn every_other_method_reads_flat_fields_the_schema_has() {
        for (method, fields) in [
            ("media/getMediaDefault", &["kind"][..]),
            ("media/getMediaJob", &["id"]),
            ("media/cancelMediaJob", &["id"]),
            ("media/readMediaAsset", &["id", "options"]),
            ("media/resolveMediaFile", &["id", "options"]),
            ("media/deleteMediaAsset", &["id"]),
            ("media/createMediaBoard", &["name"]),
            ("media/renameMediaBoard", &["id", "name"]),
            ("media/deleteMediaBoard", &["id"]),
            ("media/setMediaAssetBoard", &["ids", "boardId"]),
            ("media/cacheMediaThumbnail", &["id", "input"]),
            ("media/openMediaAsset", &["id"]),
            ("media/openMediaFolder", &["id"]),
        ] {
            let schema = schema_fields(method);
            for field in fields {
                assert!(schema.contains(&(*field).to_owned()), "{method}: the schema has no `{field}`");
            }
            let params = json!({"id": "a", "name": "n"});
            assert_eq!(wire_args(method, &params), params, "{method}: params are read as they come");
        }
    }

    struct NoLanes;

    #[async_trait]
    impl super::super::jobs::MediaGenerator for NoLanes {
        async fn resolve(&self, lane: &str, _: &str, _: &str) -> Result<super::super::jobs::ResolvedMedia, super::super::jobs::MediaFailure> {
            Err(super::super::jobs::MediaFailure::new(format!("unknown media lane \"{lane}\""), "MEDIA_LANE_UNKNOWN"))
        }
        async fn generate(&self, _: super::super::jobs::GenerationRequest) -> Result<super::super::jobs::GeneratedMedia, super::super::jobs::MediaFailure> {
            unreachable!("no lane resolves")
        }
        async fn lanes(&self) -> Value {
            json!([])
        }
    }

    async fn call(service: &MediaService, method: &'static str, params: Value) -> Result<Reply, CoreError> {
        let request = CoreRequest { method: Method(method), params, op: None, ctx: mixdog_core_api::CallContext::internal("test") };
        service.call(request).await
    }

    fn value(reply: Result<Reply, CoreError>) -> Value {
        match reply.unwrap() {
            Reply::Value(v) => v,
            _ => panic!("not a value"),
        }
    }

    fn message(reply: Result<Reply, CoreError>) -> (Option<String>, String) {
        match reply.err().unwrap() {
            CoreError::DomainError { code, message, .. } => (code.map(|c| c.to_string()), message.map(|m| m.to_string()).unwrap_or_default()),
            other => panic!("{other:?}"),
        }
    }

    /// The request's `params` are the method's arguments (`CoreRequest::params`, not a nested
    /// `params` member), and a failure answers Node's message. Texts are Node's (`store.mjs`,
    /// `lanes.mjs`).
    #[tokio::test]
    async fn the_wire_params_reach_the_method() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(MediaStore::new(dir.path(), mixdog_rt::testing::tokens().durability_io));
        let jobs = MediaJobs::new(store.clone(), Arc::new(NoLanes), None);
        let host = super::super::renditions::tests::scripted(super::super::renditions::tests::webp("AQID"), std::time::Duration::ZERO);
        let renditions = StillRenditions::new(Arc::new(mixdog_exthost::ExtImageCodec::new(host)), mixdog_rt::testing::tokens().durability_io, store.renditions_dir());
        let service = MediaService::new(store, jobs, Processes::for_tests(), renditions);

        let board = value(call(&service, "media/createMediaBoard", json!({"opId": "o", "name": "Harness Board"})).await);
        assert_eq!(board["name"], "Harness Board");
        let renamed = value(call(&service, "media/renameMediaBoard", json!({"opId": "o", "id": board["id"], "name": "Renamed"})).await);
        assert_eq!(renamed["name"], "Renamed");
        assert_eq!(value(call(&service, "media/cancelMediaJob", json!({"opId": "o", "id": "j"})).await)["id"], "j");
        assert_eq!(value(call(&service, "media/deleteMediaAsset", json!({"opId": "o", "id": "a"})).await)["id"], "a");
        assert_eq!(message(call(&service, "media/renameMediaBoard", json!({"opId": "o", "id": "nope", "name": "Renamed"})).await), (None, "board not found".to_owned()));
        let start = json!({"opId": "o", "input": {"kind": "image", "prompt": "harness", "lane": "harness-no-such-lane"}});
        assert_eq!(
            message(call(&service, "media/startMediaJob", start).await),
            (Some("MEDIA_LANE_UNKNOWN".to_owned()), "unknown media lane \"harness-no-such-lane\"".to_owned())
        );
    }}
