//! The `media/` namespace. Arguments ride in the request's `params` member.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::Admit;
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use serde_json::{Value, json};

use super::jobs::MediaJobs;
use super::store::{MediaError, MediaStore};

pub struct MediaService {
    store: Arc<MediaStore>,
    jobs: Arc<MediaJobs>,
}

fn domain(code: &str) -> CoreError {
    CoreError::DomainError { domain: "media".into(), code: code.into(), detail: None }
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

fn open_with_os(path: &Path, reveal: bool) -> bool {
    let platform = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
    let (program, args) = open_command(path, reveal, platform);
    std::process::Command::new(program).args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().is_ok()
}

impl MediaService {
    pub fn new(store: Arc<MediaStore>, jobs: Arc<MediaJobs>) -> Self {
        Self { store, jobs }
    }

    async fn dispatch(&self, method: &str, request: &Value) -> Result<Value, CoreError> {
        let args = request.get("params").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({}));
        let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("");
        let id = text("id");
        match method {
            "media/getMediaDefault" => Ok(self.store.get_default(args.get("kind"))),
            "media/getMediaPins" => Ok(self.store.get_pins()),
            "media/setMediaDefault" => Ok(self.store.set_default(&args)?),
            "media/setMediaPin" => Ok(self.store.set_pin(&args)?),
            "media/getMediaJob" => Ok(self.jobs.get(id).unwrap_or(Value::Null)),
            "media/listMediaLanes" => Ok(self.jobs.lanes().await),
            "media/startMediaJob" => self.jobs.start(&args).await.map_err(|f| domain(f.code.as_deref().unwrap_or("MEDIA_FAILED"))),
            "media/cancelMediaJob" => Ok(self.jobs.cancel(id)),
            "media/listMediaAssets" => Ok(self.store.list_assets(
                args.get("limit").and_then(Value::as_f64),
                args.get("offset").and_then(Value::as_f64),
                args.get("kind").and_then(Value::as_str).filter(|k| !k.is_empty()),
                text("boardId"),
            )?),
            "media/listMediaBoards" => Ok(self.store.list_boards()?),
            "media/readMediaAsset" => Ok(self.store.read_asset(id)?.unwrap_or(Value::Null)),
            "media/resolveMediaFile" => Ok(self.store.resolve_file(id)?.unwrap_or(Value::Null)),
            "media/deleteMediaAsset" => Ok(self.store.delete_asset(id)?),
            "media/deleteMediaAssets" => Ok(self.store.delete_assets(&args)?),
            "media/createMediaBoard" => Ok(self.store.create_board(args.get("name"))?),
            "media/renameMediaBoard" => Ok(self.store.rename_board(args.get("id"), args.get("name"))?),
            "media/deleteMediaBoard" => Ok(self.store.delete_board(args.get("id"))?),
            "media/setMediaAssetBoard" => Ok(self.store.set_asset_board(args.get("ids").or(args.get("id")).unwrap_or(&Value::Null), args.get("boardId").unwrap_or(&Value::Null))?),
            // Rendition caches retired; Chromium-made thumbnails are not kept.
            "media/cacheMediaThumbnail" => Ok(json!({"id": id, "available": false})),
            "media/openMediaAsset" => {
                let opened = self.store.asset_path(id)?.is_some_and(|p| open_with_os(&p, false));
                Ok(json!({"id": id, "opened": opened}))
            }
            "media/openMediaFolder" => {
                if id.is_empty() {
                    let root = self.store.assets_root();
                    return Ok(json!({"path": root.to_string_lossy(), "opened": open_with_os(&root, false)}));
                }
                match self.store.asset_path(id)? {
                    Some(path) => Ok(json!({"id": id, "path": path.parent().map(|p| p.to_string_lossy()), "opened": open_with_os(&path, true)})),
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
