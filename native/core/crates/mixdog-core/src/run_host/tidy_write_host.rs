//! The real `WriteHost` of the `tidy` tool: what Node's `runtime/tidy/apply.mjs` does around a
//! formatted file.
//!
//! - `atomic_write`: `atomicWrite(fullPath, content)` is the file service's atomic replace on the
//!   durability lane; a failure reads as the failing step's `err.message`.
//! - `note_written`: the post-write invalidation the edit adapters run (`noteWrittenFile`): the
//!   cached answers about the path are dropped and the session's read snapshot becomes
//!   `source: 'tidy'`, the whole file, replacing any existing one. Node also calls
//!   `markCodeGraphDirtyPaths`; the Rust `code_graph` tool keeps no cache of the tree, so there
//!   is nothing to mark.
//! - `record_changes`: `recordToolFileChanges({ sessionId, basePath: cwd, changes })`; a side
//!   over `PATCH_EDIT_MAX_BYTES` is an omitted marker (`reviewFileContent`).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::fs::WritePrecondition;
use mixdog_core_api::domain::fs::WriteRequest;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::turn_review::CallChange;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_services::tidy::apply::FileChange;
use mixdog_services::local_provider::assets::Fetcher;
use mixdog_services::tidy::apply::WriteHost;
use mixdog_services::tidy::function_length::OutlineSource;
use mixdog_services::tidy::tool::TidyHost;
use mixdog_tools::fs::FileVersion;
use mixdog_tools::fs::ReadState;
use mixdog_tools::fs::SnapshotMeta;
use mixdog_tools::fs::read_state_key;
use mixdog_tools::fs::write_failure_message;
use tokio_util::sync::CancellationToken;

/// `PATCH_EDIT_MAX_BYTES`: the largest side the turn review keeps (the review tracker's own
/// constant is private to its crate).
const PATCH_EDIT_MAX_BYTES: usize = 64 * 1024 * 1024;

/// `abortReasonOf(signal)` of a signal that carries no reason.
const ABORTED: &str = "atomicWrite aborted";

pub struct ReviewedWriteHost {
    files: Arc<dyn FileService>,
    io: ToolIo,
    /// The one `ReadState` the file tools of the process carry.
    read_state: Arc<ReadState>,
    review: Arc<dyn TurnReviewApi>,
}

impl ReviewedWriteHost {
    pub fn new(files: Arc<dyn FileService>, io: ToolIo, read_state: Arc<ReadState>, review: Arc<dyn TurnReviewApi>) -> Self {
        Self { files, io, read_state, review }
    }
}

fn bounded(bytes: Vec<u8>) -> ReviewContent {
    if bytes.len() > PATCH_EDIT_MAX_BYTES {
        return ReviewContent::Omitted { size: bytes.len() as u64, reason: Some("oversized".to_owned()) };
    }
    ReviewContent::bytes(bytes)
}

fn absolute(path: &Path) -> Result<AbsPath, String> {
    AbsPath::new(path.to_owned()).ok_or_else(|| format!("path is not absolute: {}", path.display()))
}

#[async_trait]
impl WriteHost for ReviewedWriteHost {
    async fn atomic_write(&self, path: &Path, content: &[u8], _session_id: Option<&str>, cancel: Option<&CancellationToken>) -> Result<(), String> {
        // The first of `atomicWrite`'s abort checks; the file service replaces the file in one
        // job that cannot be cut, so the check before the rename has no counterpart.
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(ABORTED.to_owned());
        }
        let request = WriteRequest { path: absolute(path)?, content: content.to_vec(), precondition: WritePrecondition::Unconditional };
        self.files.write(self.io.durability, request).await.map(|_| ()).map_err(|error| write_failure_message(&error, path))
    }

    async fn note_written(&self, paths: &[PathBuf], session_id: Option<&str>) {
        for path in paths {
            let key = read_state_key(path);
            self.read_state.invalidate(&[key.as_str()]);
            // Best effort, as Node's: a path that cannot be read has no snapshot to record.
            let Ok(abs) = absolute(path) else { continue };
            let Ok(stat) = self.files.stat(self.io.interactive, abs).await else { continue };
            let meta = SnapshotMeta { replace_existing: true, ..SnapshotMeta::new("tidy") };
            self.read_state.record(session_id, &key, FileVersion::of(&stat), meta);
        }
    }

    async fn record_changes(&self, cwd: &Path, session_id: &str, changes: Vec<FileChange>) {
        let changes: Vec<CallChange> = changes
            .into_iter()
            .map(|change| CallChange {
                path: change.full_path.to_string_lossy().into_owned(),
                new_path: None,
                before: bounded(change.before),
                after: bounded(change.after),
            })
            .collect();
        self.review.record_tool_changes(session_id, &cwd.to_string_lossy(), changes).await;
    }
}

/// The `tidy` tool's host: the process's data directory, graph binary, write host, outline source
/// and network fetcher, each built where the rest of the process builds it.
pub struct ProcessTidyHost {
    pub plugin_data: PathBuf,
    pub graph_binary: Option<PathBuf>,
    pub write_host: Arc<dyn WriteHost>,
    pub outline_source: Arc<dyn OutlineSource>,
    pub fetcher: Arc<dyn Fetcher>,
}

#[async_trait]
impl TidyHost for ProcessTidyHost {
    fn plugin_data(&self) -> PathBuf {
        self.plugin_data.clone()
    }
    fn graph_binary(&self) -> Option<PathBuf> {
        self.graph_binary.clone()
    }
    fn write_host(&self) -> Arc<dyn WriteHost> {
        self.write_host.clone()
    }
    fn outline_source(&self) -> Arc<dyn OutlineSource> {
        self.outline_source.clone()
    }
    fn fetcher(&self) -> Arc<dyn Fetcher> {
        self.fetcher.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_side_over_the_review_limit_is_an_omitted_marker_never_bytes() {
        assert_eq!(bounded(vec![0; 3]), ReviewContent::bytes(vec![0; 3]));
        assert_eq!(
            bounded(vec![0; PATCH_EDIT_MAX_BYTES + 1]),
            ReviewContent::Omitted { size: PATCH_EDIT_MAX_BYTES as u64 + 1, reason: Some("oversized".into()) }
        );
    }
}
