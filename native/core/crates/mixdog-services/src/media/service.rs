//! The `media/` namespace. Arguments ride in the request's `params` member.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::Admit;
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use serde_json::{Value, json};

use mixdog_protocol::ThreadId;

use super::jobs::MediaJobs;
use super::renditions::StillRenditions;
use super::store::{MediaError, MediaStore};
use super::variants;
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
            MediaError::Invalid(message) => CoreError::InvalidParams { path: "params".into(), expected: message.into() },
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

impl MediaService {
    pub fn new(store: Arc<MediaStore>, jobs: Arc<MediaJobs>, processes: Processes, renditions: StillRenditions) -> Self {
        Self { store, jobs, processes, renditions }
    }

    async fn dispatch(&self, method: &str, request: &Value) -> Result<Value, CoreError> {
        let args = request.get("params").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({}));
        let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
        let id = text("id");
        let thread = ThreadId(if text("threadId").is_empty() { "media".to_owned() } else { text("threadId").to_owned() });
        let options = args.get("options").cloned().unwrap_or_else(|| json!({}));
        let input = args.get("input").cloned().unwrap_or(Value::Null);
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
            "media/startMediaJob" => self.jobs.start(&args).await.map_err(|f| domain(f.code.as_deref().unwrap_or("MEDIA_FAILED"))),
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
}
