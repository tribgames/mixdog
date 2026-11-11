//! The external-edit watch of the config file (`ensureConfigWatcher` in `config.mjs`): a change
//! another process (or a hand edit) makes to `mixdog-config.json` reaches the document and is
//! published. It rides the workspace's one file-watch service (`FolderWatcher`), which batches
//! events; bursts then coalesce into one reload after the last batch, as Node's trailing 100 ms
//! debounce does. A reload that finds the same bytes publishes nothing, and an unparsable file
//! keeps the current document (`Config::reload`).
//!
//! The directory is watched, not the file: the atomic rename replaces the file, which would
//! orphan a file-level watch.

use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use mixdog_workspace::watcher::ChangeKind;
use mixdog_workspace::watcher::ChangeSink;
use mixdog_workspace::watcher::FolderWatcher;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::Config;
use super::ConfigError;
use super::SecretChanges;

const DEBOUNCE: Duration = Duration::from_millis(100);
const WATCH_ID: &str = "config-file";

/// Keeps the watch and its reload task alive; dropping it stops both.
pub struct ConfigWatcher {
    watcher: FolderWatcher,
    task: JoinHandle<()>,
}

impl Drop for ConfigWatcher {
    fn drop(&mut self) {
        self.watcher.unwatch(WATCH_ID);
        self.task.abort();
    }
}

struct Sink {
    files: Vec<OsString>,
    heard: mpsc::UnboundedSender<()>,
}

impl ChangeSink for Sink {
    fn changed(&self, _watch_id: &str, paths: Vec<String>, _kind: ChangeKind) {
        // A batch naming no file is a rescan: it may be any file.
        if paths.is_empty() || paths.iter().any(|path| Path::new(path).file_name().is_some_and(|name| self.files.iter().any(|file| file == name))) {
            let _ = self.heard.send(());
        }
    }
}

impl ConfigWatcher {
    /// Watches the directory of `config`'s file. Fails when the directory cannot be watched.
    pub fn start(config: Config) -> Result<Self, ConfigError> {
        Self::start_with(config, None)
    }

    /// As [`ConfigWatcher::start`], and the stored-secret change marker beside the file is
    /// followed too: another process saving a key reaches `secrets` (Node's one directory watch
    /// serves the config file and its marker alike).
    pub fn start_with_secrets(config: Config, secrets: Arc<SecretChanges>) -> Result<Self, ConfigError> {
        Self::start_with(config, Some(secrets))
    }

    fn start_with(config: Config, secrets: Option<Arc<SecretChanges>>) -> Result<Self, ConfigError> {
        let path = config.shared.path.clone();
        let (Some(dir), Some(file)) = (path.parent(), path.file_name()) else {
            return Err(ConfigError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, "the config file has no directory")));
        };
        let (heard, mut events) = mpsc::unbounded_channel();
        let io = |error: mixdog_workspace::error::WsError| ConfigError::Io(std::io::Error::other(error.to_string()));
        let watcher = FolderWatcher::new(Arc::new(Sink { files: vec![file.to_owned(), OsString::from(SecretChanges::marker_name())], heard })).map_err(io)?;
        watcher.watch(WATCH_ID, dir, false).map_err(io)?;
        let task = tokio::spawn(async move {
            while events.recv().await.is_some() {
                // Trailing debounce: the reload reads after the last batch of the burst.
                while let Ok(Some(())) = tokio::time::timeout(DEBOUNCE, events.recv()).await {}
                // A file that does not parse yet is a write in progress: the document stays, and
                // the completing write raises the next event.
                let _ = config.reload().await;
                if let Some(secrets) = &secrets {
                    secrets.sync().await;
                }
                config.shared.passes.send_modify(|passes| *passes += 1);
            }
        });
        Ok(Self { watcher, task })
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;