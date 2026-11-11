//! `pruneCompactedOffloads` (`compaction-runner.mjs:470`) through the core's commit of a compaction: the session actor
//! applies the result to an idle thread and the host prunes the thread's tool-result sidecars on disk against what the
//! session then holds. A sidecar the kept transcript names, one reachable through an archive it names, one a queued
//! message names, a young one, one reused by a turn just now and another session's stay; old ones nothing reaches go.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::offload::ArtifactStore;
use mixdog_core_api::CoreError;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::{ItemId, ThreadId};
use mixdog_core_run::run_host::artifact::ToolResultArtifacts;
use mixdog_core_session::session::run::Compaction;
use mixdog_core_session::session::testing::offload_replay::{item, within};
use mixdog_core_session::session::testing::{Rig, TestCompaction};
use mixdog_core_session::session::turn_ops::{Books, CompactionCommit, ManualCompaction};
use mixdog_core_session::session::{SessionDirectory, SystemClock};
use mixdog_store::schema::record::{Header, Record};
use serde_json::{Value, json};

use super::compaction_node_harness::io;

/// The rig's compaction engine, with the host's own prune over `data`.
struct Pruning {
    rig: Arc<TestCompaction>,
    data: std::path::PathBuf,
    /// How many listings the host's prune has made (the open's reconcile is the first).
    listings: tokio::sync::watch::Sender<usize>,
    /// How many prunes of listed sidecars have ended.
    prunes: tokio::sync::watch::Sender<usize>,
}

#[async_trait]
impl ManualCompaction for Pruning {
    async fn compact(&self, thread: &ThreadId, trigger: &str, require_reduction: bool) -> Result<Option<Value>, CoreError> {
        self.rig.compact(thread, trigger, require_reduction).await
    }
    async fn compact_for_heir(&self, source: &ThreadId, budget_tokens: u64, summarize: bool) -> Result<Option<Vec<Value>>, CoreError> {
        self.rig.compact_for_heir(source, budget_tokens, summarize).await
    }
    async fn post_compact(&self, thread: &ThreadId, trigger: &str) {
        self.rig.post_compact(thread, trigger).await;
    }
    async fn offload_candidates(&self, thread: &ThreadId) -> Vec<std::path::PathBuf> {
        let candidates = super::manual_compaction::offload_candidates(&io(), &self.data, thread).await;
        self.listings.send_modify(|count| *count += 1);
        candidates
    }
    async fn prune_offloads(&self, thread: &ThreadId, candidates: Vec<std::path::PathBuf>, transcripts: String) {
        super::manual_compaction::prune_offloads(&io(), &self.data, &SystemClock, thread, candidates, transcripts).await;
        self.prunes.send_modify(|count| *count += 1);
    }
    async fn rearm(&self, thread: &ThreadId) {
        self.rig.rearm(thread).await;
    }
    fn recover_workers(&self, thread: &ThreadId) {
        self.rig.recover_workers(thread);
    }
    fn invalidate_context_status(&self, thread: &ThreadId) {
        self.rig.invalidate_context_status(thread);
    }
    fn books(&self, thread: &ThreadId, header: &Header) -> Option<Books> {
        self.rig.books(thread, header)
    }
    async fn prepare_books(&self, thread: &ThreadId, provider: &str, messages: &[AgentMessage]) {
        self.rig.prepare_books(thread, provider, messages).await;
    }
    fn synced_compaction(&self, header: &Header, install: bool) -> Option<Value> {
        self.rig.synced_compaction(header, install)
    }
    fn route_config(&self, header: &Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
        self.rig.route_config(header)
    }
    fn settings_changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        self.rig.settings_changes()
    }
}

/// An hour old: past the ten minutes a sidecar is kept whatever names it.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup ages a fixture file")]
fn age(path: &str) {
    let file = std::fs::File::options().write(true).open(path).expect("the sidecar");
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3_600)).expect("aged");
}

async fn persist(store: &ToolResultArtifacts, text: &str) -> String {
    store.persist(text).await.expect("persisted").path
}

#[allow(clippy::disallowed_methods, reason = "test reads the data dir")]
fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_committed_compaction_prunes_the_sidecars_nothing_the_session_holds_reaches() {
    let data = tempfile::tempdir().expect("data dir");
    let id = ThreadId::from("sess_prune");
    let store = ToolResultArtifacts::new(io(), data.path(), id.as_str());
    let other = ToolResultArtifacts::new(io(), data.path(), "sess_other");

    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    let (listings, mut listed) = tokio::sync::watch::channel(0);
    let prunes = tokio::sync::watch::channel(0).0;
    deps.compaction = Arc::new(Pruning { rig: rig.compaction.clone(), data: data.path().to_path_buf(), listings, prunes });
    let creator = SessionDirectory::new(rig.deps());
    creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({})).await.expect("create");
    // The queued message names its sidecar by file name (the content's SHA-256), before the sidecar is written.
    let queued_name = format!("{:x}.txt", <sha2::Sha256 as sha2::Digest>::digest("a queued message names this".as_bytes()));
    let entry: Record = serde_json::from_value(json!({
        "k": "queue", "qid": "q1", "action": "enqueue",
        "entry": { "inline": { "message": format!("look at {queued_name}"), "enqueuedAt": 1, "priority": "next" } },
    }))
    .expect("queue record");
    rig.store.seed(&id, vec![entry]);
    let directory = SessionDirectory::new(Arc::new(deps));
    directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    // The open reconciles the session's sidecars with what it stores; the sidecars are written once it has listed.
    within("the open lists", listed.wait_for(|count| *count >= 1)).await.expect("the open lists");

    let reached = persist(&store, "reached through the kept archive").await;
    let kept = persist(&store, &json!({ "path": reached }).to_string()).await;
    let dropped = persist(&store, "a result the compaction dropped").await;
    let stray = persist(&store, "nothing names this").await;
    let queued = persist(&store, "a queued message names this").await;
    assert!(queued.ends_with(&queued_name), "{queued}");
    let reused = persist(&store, "a turn reuses this").await;
    let foreign = persist(&other, "another session's result").await;
    for path in [&reached, &kept, &dropped, &stray, &queued, &reused, &foreign] {
        age(path);
    }
    let young = persist(&store, "written a moment ago").await;

    // A turn persists a result whose sidecar is already there: it is the turn's now.
    assert_eq!(persist(&store, "a turn reuses this").await, reused);
    let summary = (ItemId::from("sum1".to_owned()), json!({ "role": "tool", "toolCallId": "c1", "content": format!("[archived: {kept}]") }));
    let compaction = Compaction { replacement: vec![summary], at: 5, dropped_count: 1, dropped: None };
    assert_eq!(directory.commit_compaction(&id, Vec::new(), compaction, None).await.expect("answered"), CompactionCommit::Applied);

    let state = |path: &String| (path.rsplit(['/', '\\']).next().unwrap_or_default().to_owned(), exists(path));
    let got: Vec<(String, bool)> = [&kept, &reached, &queued, &young, &reused, &foreign, &dropped, &stray].into_iter().map(state).collect();
    let want: Vec<(String, bool)> = [(&kept, true), (&reached, true), (&queued, true), (&young, true), (&reused, true), (&foreign, true), (&dropped, false), (&stray, false)]
        .into_iter()
        .map(|(path, kept)| (state(path).0, kept))
        .collect();
    assert_eq!(got, want);
}
