// A HEAD written outside the session (`git switch`, a branch rename, a detach): the checkout's watch wakes every session of its
// repository, which reads its live workspace again, so the branch the island and the sidebar show is the new one.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use serde_json::json;

use crate::session::SessionDirectory;
use crate::session::testing::Rig;
use crate::session::worktree::LiveWorkspace;

/// The live workspace of a rig session: the branch the checkout's HEAD file names, as `getLiveWorkspace` reads it.
struct HeadFile(PathBuf);

#[async_trait]
impl LiveWorkspace for HeadFile {
    async fn live(&self, _session: &str) -> Option<Value> {
        let text = std::fs::read_to_string(self.0.join(".git/HEAD")).ok()?;
        let branch = text.trim().strip_prefix("ref: refs/heads/")?.to_owned();
        Some(json!({ "branch": branch }))
    }
}

async fn open(directory: &SessionDirectory, id: &str, cwd: &Path) -> Arc<crate::session::SessionHandle> {
    let header = json!({ "cwd": cwd.to_string_lossy() }).as_object().cloned().expect("header");
    directory.create_with_id(ThreadId::from(id), header, json!({})).await.expect("create");
    directory.open_handle(&ThreadId::from(id), &mixdog_core_api::call::CallContext::internal("test")).await.expect("opened")
}

async fn branch_of(handle: &crate::session::SessionHandle, expected: &str) -> bool {
    for _ in 0..160 {
        let state = serde_json::to_value(&handle.cell.view.load_full().state).unwrap();
        if state["workspace"]["branch"] == json!(expected) {
            return true;
        }
        mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[tokio::test]
async fn a_branch_switched_outside_the_app_reaches_every_session_of_the_repository() {
    let repo = tempfile::tempdir().unwrap();
    let git = repo.path().join(".git");
    std::fs::create_dir_all(git.join("refs/heads")).unwrap();
    std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    let inner = repo.path().join("pkg");
    std::fs::create_dir_all(&inner).unwrap();

    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.live_workspace = Arc::new(HeadFile(repo.path().to_path_buf()));
    let directory = SessionDirectory::new(Arc::new(deps));
    let first = open(&directory, "sess_head_a", repo.path()).await;
    let second = open(&directory, "sess_head_b", &inner).await;
    assert!(branch_of(&first, "main").await && branch_of(&second, "main").await, "the load's own read");

    // What `git switch topic` leaves: the new HEAD written to HEAD.lock and renamed over HEAD.
    std::fs::write(git.join("HEAD.lock"), "ref: refs/heads/topic\n").unwrap();
    std::fs::rename(git.join("HEAD.lock"), git.join("HEAD")).unwrap();
    assert!(branch_of(&first, "topic").await, "the session in the repository root names the new branch");
    assert!(branch_of(&second, "topic").await, "the session in a folder of it names it too");
}
