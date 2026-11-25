//! The one client capability offered to an agent: reading a text file of the session's folder.
//! Writing is not offered, so the agent keeps editing with its own tools and reports diffs.

use std::path::Component;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use serde_json::Value;
use serde_json::json;

use crate::connection::RpcError;

#[async_trait]
pub trait TextFiles: Send + Sync {
    async fn read(&self, path: AbsPath) -> Result<String, String>;
    /// `path` with every link on it followed: the place a read of it reaches.
    async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String>;
    /// Puts `text` in a new file at `path`, its folders made: the file appears with all of its text at once, and one
    /// already there is kept. The agent definitions Mixdog starts a CLI with, each at a place its text names.
    async fn create(&self, path: AbsPath, text: String) -> Result<(), String>;
    /// Makes the folder `path` with its parents; one already there is kept. The temporary folder of an agent's server.
    async fn make_folder(&self, _path: AbsPath) -> Result<(), String> {
        Err("no folder is made here".to_owned())
    }
    /// Removes the folder `path` with all it holds; one that is not there is removed already.
    async fn remove_folder(&self, _path: AbsPath) -> Result<(), String> {
        Err("no folder is removed here".to_owned())
    }
    /// The names of the folders directly in `path`; none where `path` is not there.
    async fn folders(&self, _path: AbsPath) -> Result<Vec<String>, String> {
        Err("no folder is listed here".to_owned())
    }
    /// Puts `text` in the file at `path`, its folders made, in place of one already there: a reader finds the old text
    /// whole or the new text whole. What the agents keep of their builds and of what they told.
    async fn replace(&self, _path: AbsPath, _text: String) -> Result<(), String> {
        Err("no file is written here".to_owned())
    }
    /// Moves the file or folder `from` to `to`, the folders of `to` made; a file at `to` is replaced at once.
    async fn rename(&self, _from: AbsPath, _to: AbsPath) -> Result<(), String> {
        Err("nothing is moved here".to_owned())
    }
    /// Removes the file `path`; one that is not there is removed already.
    async fn remove_file(&self, _path: AbsPath) -> Result<(), String> {
        Err("no file is removed here".to_owned())
    }
}

impl ServiceFiles {
    /// Runs `job` on the files' lane; `what` names what it does, for its failure.
    async fn on_lane<R: Send + 'static>(&self, what: &str, job: impl FnOnce() -> std::io::Result<R> + Send + 'static) -> Result<R, String> {
        match self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| job()) {
            Ok(job) => job.await.map_err(|_| format!("{what} failed"))?.map_err(|error| error.to_string()),
            Err(_) => Err(format!("{what} failed")),
        }
    }
}

/// [`TextFiles`] over the core's file service.
pub struct ServiceFiles {
    pub files: Arc<dyn FileService>,
    pub lane: InteractiveIo,
}

#[async_trait]
impl TextFiles for ServiceFiles {
    async fn read(&self, path: AbsPath) -> Result<String, String> {
        let read = self.files.read(self.lane, path, ReadRange::default()).await.map_err(|error| format!("{:?}", error.kind))?;
        String::from_utf8(read.bytes).map_err(|_| "the file is not UTF-8 text".to_owned())
    }

    async fn resolved(&self, path: AbsPath) -> Result<AbsPath, String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| std::fs::canonicalize(path.as_path()));
        let resolved = match job {
            Ok(job) => job.await.map_err(|_| "the file could not be looked at".to_owned())?,
            Err(_) => return Err("the file could not be looked at".to_owned()),
        };
        resolved.map_err(|error| error.to_string()).and_then(|path| AbsPath::new(path).ok_or_else(|| "the file has no absolute place".to_owned()))
    }

    async fn create(&self, path: AbsPath, text: String) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| {
            let folder = path.as_path().parent().ok_or_else(|| std::io::Error::other("the file has no folder"))?;
            std::fs::create_dir_all(folder)?;
            // Written whole beside its place, then linked into it: a CLI starting meanwhile reads all of it or nothing.
            let staged = folder.join(format!(".{}.staged", uuid::Uuid::new_v4().simple()));
            std::fs::write(&staged, text)?;
            let linked = std::fs::hard_link(&staged, path.as_path());
            std::fs::remove_file(&staged)?;
            match linked {
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                linked => linked,
            }
        });
        match job {
            Ok(job) => job.await.map_err(|_| "the file could not be written".to_owned())?.map_err(|error| error.to_string()),
            Err(_) => Err("the file could not be written".to_owned()),
        }
    }

    async fn make_folder(&self, path: AbsPath) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| std::fs::create_dir_all(path.as_path()));
        match job {
            Ok(job) => job.await.map_err(|_| "the folder could not be made".to_owned())?.map_err(|error| error.to_string()),
            Err(_) => Err("the folder could not be made".to_owned()),
        }
    }

    async fn remove_folder(&self, path: AbsPath) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| match std::fs::remove_dir_all(path.as_path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            removed => removed,
        });
        match job {
            Ok(job) => job.await.map_err(|_| "the folder could not be removed".to_owned())?.map_err(|error| error.to_string()),
            Err(_) => Err("the folder could not be removed".to_owned()),
        }
    }

    async fn folders(&self, path: AbsPath) -> Result<Vec<String>, String> {
        #[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "a lane job")]
        let job = self.lane.submit(&tokio_util::sync::CancellationToken::new(), move |_| {
            let entries = match std::fs::read_dir(path.as_path()) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                entries => entries?,
            };
            let mut folders = Vec::new();
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    folders.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
            Ok::<_, std::io::Error>(folders)
        });
        match job {
            Ok(job) => job.await.map_err(|_| "the folder could not be listed".to_owned())?.map_err(|error| error.to_string()),
            Err(_) => Err("the folder could not be listed".to_owned()),
        }
    }

    async fn replace(&self, path: AbsPath, text: String) -> Result<(), String> {
        // Written whole beside its place, then moved onto it.
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = move || {
            let folder = path.as_path().parent().ok_or_else(|| std::io::Error::other("the file has no folder"))?;
            std::fs::create_dir_all(folder)?;
            let staged = folder.join(format!(".{}.staged", uuid::Uuid::new_v4().simple()));
            std::fs::write(&staged, text)?;
            let renamed = std::fs::rename(&staged, path.as_path());
            if renamed.is_err() {
                let _ = std::fs::remove_file(&staged);
            }
            renamed
        };
        self.on_lane("writing the file", job).await
    }

    async fn rename(&self, from: AbsPath, to: AbsPath) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = move || {
            if let Some(folder) = to.as_path().parent() {
                std::fs::create_dir_all(folder)?;
            }
            std::fs::rename(from.as_path(), to.as_path())
        };
        self.on_lane("moving the file", job).await
    }

    async fn remove_file(&self, path: AbsPath) -> Result<(), String> {
        #[allow(clippy::disallowed_methods, reason = "a lane job")]
        let job = move || match std::fs::remove_file(path.as_path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            removed => removed,
        };
        self.on_lane("removing the file", job).await
    }
}

/// The place to read for `path`, when it names one inside `cwd` without leaving it, by its name and by where its links
/// lead: a link or junction inside the folder that points out of it is outside. The place is the resolved one that was
/// checked, so a link changed after the check leads the read nowhere else.
async fn inside(files: &dyn TextFiles, cwd: &AbsPath, path: &str) -> Option<AbsPath> {
    let path = AbsPath::new(path)?;
    let rest = path.as_path().strip_prefix(cwd.as_path()).ok()?;
    if !rest.components().all(|part| matches!(part, Component::Normal(_))) {
        return None;
    }
    // A place that cannot be resolved (no such file) leads nowhere: its read tells why.
    let Ok(place) = files.resolved(path.clone()).await else { return Some(path) };
    let folder = files.resolved(cwd.clone()).await.ok()?;
    place.as_path().starts_with(folder.as_path()).then_some(place)
}

fn invalid(message: &str) -> RpcError {
    RpcError { code: -32602, message: message.to_owned(), data: Value::Null }
}

/// The answer to the agent's `fs/read_text_file`: `line` is 1-based, `limit` counts lines.
pub async fn read_text_file(files: &dyn TextFiles, cwd: &AbsPath, params: &Value) -> Result<Value, RpcError> {
    let requested = params.get("path").and_then(Value::as_str).ok_or_else(|| invalid("path is required"))?;
    let Some(path) = inside(files, cwd, requested).await else {
        return Err(invalid(&format!("{} is outside the session's folder {}", requested, Path::display(cwd.as_path()))));
    };
    let text = files.read(path).await.map_err(|message| RpcError { code: -32603, message, data: Value::Null })?;
    let first = params.get("line").and_then(Value::as_u64).unwrap_or(1).max(1) as usize - 1;
    let content = match (first, params.get("limit").and_then(Value::as_u64)) {
        (0, None) => text,
        (first, limit) => {
            let lines = text.split_inclusive('\n').skip(first);
            match limit {
                Some(limit) => lines.take(limit as usize).collect(),
                None => lines.collect(),
            }
        }
    };
    Ok(json!({ "content": content }))
}
