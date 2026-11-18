//! The local forget of a saved server answers by code. The store failing leaves the row and says `saved-entry-removal-failed`
//! through the one service both the list's Forget and the cleanup that removed the server software use; a second Forget, which
//! never touches the server, then finishes the job.
#![allow(clippy::disallowed_methods, reason = "tests break and repair the store's file on disk")]

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{SshAskpass, SshForgetResult, SshProgress};
use mixdog_core_api::ids::ConnectionId;
use mixdog_ssh::connect_failure::ConnectError;
use mixdog_ssh::context::AttemptContext;
use mixdog_ssh::session::Progress;

use crate::attempts::{Attempts, ConnectionsPush, ServerLinks};
use crate::host_list_ops::{forget_saved, HostLinks, HostList, LocalForget};
use crate::host_store::{SshHostRecord, SshHostStore};
use crate::link::LinkSpec;
use crate::link_machine::ModelLogin;
use crate::paths::ConnectionsPaths;

struct NoLinks;

#[async_trait]
impl ServerLinks for NoLinks {
    fn is_open(&self, _id: &str) -> bool {
        false
    }

    async fn open(&self, _spec: LinkSpec, _context: AttemptContext, _progress: Option<Progress>, _cancel: Option<&tokio_util::sync::CancellationToken>) -> Result<crate::link::LinkOpen, ConnectError> {
        unreachable!("a forget opens nothing")
    }

    async fn close(&self, _id: &str) {}
}

#[async_trait]
impl HostLinks for NoLinks {
    async fn apply_model_login(&self, _id: &str, _login: ModelLogin) -> Result<(), ConnectError> {
        unreachable!("a forget applies no login")
    }
}

struct NoPush;

impl ConnectionsPush for NoPush {
    fn askpass(&self, _to: ConnectionId, _question: SshAskpass) {}

    fn progress(&self, _to: ConnectionId, _progress: SshProgress) {}
}

fn attempts() -> Arc<Attempts> {
    Attempts::new(Arc::new(NoLinks), Arc::new(NoPush))
}

async fn saved_box() -> (tempfile::TempDir, ConnectionsPaths, Arc<SshHostStore>, String) {
    let dir = tempfile::tempdir().expect("a folder");
    let paths = ConnectionsPaths::new(dir.path());
    let hosts = Arc::new(SshHostStore::load(&paths, mixdog_rt::testing::tokens().durability_io).await);
    let record = hosts
        .save(SshHostRecord { id: "box-id".to_owned(), name: "Box".to_owned(), target: "ops@box".to_owned(), last_connected_at: None, settings: None })
        .await
        .expect("saved");
    (dir, paths, hosts, record.id)
}

/// The store's file can no longer be replaced: a folder stands where it is.
fn break_store(paths: &ConnectionsPaths) -> Vec<u8> {
    let file = paths.ssh_hosts();
    let kept = std::fs::read(&file).expect("the saved list");
    std::fs::remove_file(&file).expect("removed");
    std::fs::create_dir_all(file.join("blocker")).expect("a folder in its place");
    kept
}

fn repair_store(paths: &ConnectionsPaths, kept: &[u8]) {
    let file = paths.ssh_hosts();
    std::fs::remove_dir_all(&file).expect("the folder");
    std::fs::write(&file, kept).expect("the list again");
}

#[tokio::test]
async fn a_store_that_fails_keeps_the_row_and_says_so_by_code_then_forget_finishes() {
    let (_dir, paths, hosts, id) = saved_box().await;
    let kept = break_store(&paths);
    let attempts = attempts();

    let LocalForget::Failed { message, notice } = forget_saved(&hosts, &attempts, &id).await else { panic!("the store cannot write") };
    assert_eq!(notice.code, "saved-entry-removal-failed");
    assert_eq!(notice.params.get("name").map(String::as_str), Some("Box"));
    assert_eq!(message, "The saved entry for Box could not be removed.", "the operating system's words go to the log, not to the person");
    assert!(hosts.get(&id).is_some(), "the row stays, so Forget can be tried again");

    repair_store(&paths, &kept);
    let LocalForget::Done = forget_saved(&hosts, &attempts, &id).await else { panic!("the retry finishes") };
    assert!(hosts.get(&id).is_none());
}

#[tokio::test]
async fn the_lists_forget_answers_with_the_same_code_and_never_with_raw_text() {
    let (_dir, paths, hosts, id) = saved_box().await;
    let list = HostList::new(hosts.clone(), Arc::new(NoLinks), attempts());
    break_store(&paths);

    let SshForgetResult::Failed(failed) = list.forget(&id).await.expect("an answer") else { panic!("the store cannot write") };
    assert!(!failed.ok);
    assert_eq!(failed.notice.expect("every failure is coded").code, "saved-entry-removal-failed");
    assert!(hosts.get(&id).is_some());
}
