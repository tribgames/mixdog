//! `StoredWorktreeSessions` against `fixtures/worktree-sessions/golden.json`
//! (`record-worktree-sessions.mjs`): the store files real Node wrote, migrated, and the ids,
//! activity and sidebar marks Node's maintenance read from them; the running shells come from the
//! task registry.

use std::collections::HashSet;
use std::sync::Arc;

use mixdog_scm::worktree::maintenance::SessionSource;
use mixdog_spawn::tasks::HostShellJobs;
use mixdog_spawn::tasks::ShellJobsState;
use mixdog_spawn::tasks::TaskOutcome;
use mixdog_spawn::tasks::TaskPublisher;
use mixdog_spawn::tasks::TaskRegistry;
use mixdog_spawn::tasks::TaskSpec;
use mixdog_spawn::tasks::TaskStatus;
use serde_json::Value;
use serde_json::json;

use super::StoredWorktreeSessions;
use crate::session::search_backfill::StoredSearchSessions;
use crate::session::search_backfill::tests::migrated;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/worktree-sessions/golden.json")).expect("golden.json")
}

struct NoPublisher;
impl TaskPublisher for NoPublisher {
    fn thread_updated(&self, _: &str, _: &ShellJobsState) {}
    fn host_updated(&self, _: &HostShellJobs) {}
    fn schedule_expiry(&self, _: u64) {}
}

fn tasks() -> Arc<TaskRegistry> {
    Arc::new(TaskRegistry::new(Arc::new(NoPublisher), || 1_767_323_045_678))
}

fn start(tasks: &TaskRegistry, id: &str, owner: Option<&str>, cwd: &str, foreground: bool) {
    tasks
        .start(TaskSpec {
            task_id: id.into(),
            surface: "shell".into(),
            op: "shell".into(),
            command: "sleep 100".into(),
            cwd: cwd.into(),
            owner: owner.map(str::to_owned),
            foreground,
            process: None,
            started_at_ms: 1_767_323_000_000,
        })
        .expect("task started");
}

fn sorted(ids: HashSet<String>) -> Vec<String> {
    let mut ids: Vec<String> = ids.into_iter().collect();
    ids.sort();
    ids
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("array").iter().map(|id| id.as_str().expect("id").to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_ids_activity_and_marks_are_the_ones_nodes_maintenance_read() {
    let golden = golden();
    let (_dir, threads, lanes) = migrated(&golden).await;
    let source = StoredWorktreeSessions::new(Arc::new(StoredSearchSessions::new(threads, lanes)), tasks());

    assert_eq!(sorted(source.stored_session_ids().await.expect("ids")), strings(&golden["ids"]));
    assert_eq!(sorted(source.favorites().await.expect("favorites")), strings(&golden["favorites"]));
    assert_eq!(sorted(source.archived().await.expect("archived")), strings(&golden["archived"]));

    // Asked for a session twice and for one the store does not have: each stored one once, the
    // absent one left out.
    let mut asked = strings(&golden["ids"]);
    asked.push(asked[0].clone());
    asked.push("sess_absent".into());
    let got: serde_json::Map<String, Value> = source
        .activity(&asked)
        .await
        .into_iter()
        .map(|(id, row)| (id, json!({ "lastActiveAt": row.last_active_at, "title": row.title })))
        .collect();
    assert_eq!(Value::Object(got), golden["activity"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_running_jobs_are_the_background_shells_with_their_folders() {
    let golden = golden();
    let (_dir, threads, lanes) = migrated(&golden).await;
    let registry = tasks();
    let source = StoredWorktreeSessions::new(Arc::new(StoredSearchSessions::new(threads, lanes)), registry.clone());

    start(&registry, "t1", Some("sess_titled"), "/p/wt", false);
    start(&registry, "t2", None, "/p", false);
    start(&registry, "t3", Some("sess_named"), "/p/fg", true);
    start(&registry, "t4", Some("sess_named"), "/p/done", false);
    registry.finish("t4", TaskOutcome { status: TaskStatus::Completed, exit_code: Some(0) }).expect("finished");

    let jobs: Vec<(Option<String>, Option<String>)> =
        source.running_jobs().await.expect("jobs").into_iter().map(|job| (job.cwd, job.owner_session_id)).collect();
    assert_eq!(
        jobs,
        vec![(Some("/p/wt".to_owned()), Some("sess_titled".to_owned())), (Some("/p".to_owned()), None)]
    );

    // A running shell with no folder cannot be inspected: the listing is refused.
    start(&registry, "t5", None, "", false);
    let refused = source.running_jobs().await.expect_err("refused");
    assert_eq!(refused.to_string(), "Cannot inspect shell job t5.");
}
