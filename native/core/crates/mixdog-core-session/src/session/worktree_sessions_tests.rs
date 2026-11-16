//! `StoredWorktreeSessions` against `fixtures/worktree-sessions/golden.json`
//! (`record-worktree-sessions.mjs`): the store files real Node wrote, migrated, and the ids,
//! activity and sidebar marks Node's maintenance read from them; the running shells come from the
//! task registry.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::Ordering;

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
async fn a_mark_written_after_a_scan_is_what_the_next_ask_reads_whatever_the_age() {
    use crate::session::seams::CommitRecord;
    use crate::session::seams::EncodedRecord;
    use crate::session::seams::SessionLog;
    use crate::session::seams::ThreadStore;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_rt::LaneToken as _;
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::HeaderChange;
    use mixdog_store::schema::record::MetaRecord;
    use mixdog_store::schema::record::Record;

    let golden = golden();
    let (_dir, threads, lanes) = migrated(&golden).await;
    let source = StoredWorktreeSessions::new(Arc::new(StoredSearchSessions::new(threads.clone(), lanes.clone())), tasks());
    let commit = |record: Record| {
        let encoded = EncodedRecord(mixdog_store::encode::encode_record(record.clone()).expect("encodes"));
        CommitRecord { record: Arc::new(record), encoded }
    };
    let session = commit(
        serde_json::from_value(json!({"k":"session","v":2,"id":"sess_kept","log_id":"4f1c2a9e0b7d3c5a6e8f9012","header":{"inline":{"title":"kept","archivedAt":7}}}))
            .expect("a record"),
    );
    let thread = ThreadId::from("sess_kept".to_owned());
    let log = {
        let (threads, thread) = (threads.clone(), thread.clone());
        lanes
            .durability
            .submit(&mixdog_rt::CancellationToken::new(), move |lane| threads.create_log(lane, &thread, &session).expect("created").0)
            .expect("lane")
            .await
            .expect("job ran")
    };
    let log = Arc::new(std::sync::Mutex::new(log));
    let meta = |set: &[(&str, Value)], unset: &[&str]| {
        commit(Record::Meta(MetaRecord {
            op: None,
            change: Slot::Inline(HeaderChange {
                set: set.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect(),
                unset: unset.iter().map(|key| (*key).to_owned()).collect(),
            }),
        }))
    };
    let write = |record: CommitRecord| {
        let log = log.clone();
        let lanes = lanes.clone();
        async move {
            lanes
                .durability
                .submit(&mixdog_rt::CancellationToken::new(), move |lane| log.lock().unwrap().commit(lane, &[record]).expect("committed"))
                .expect("lane")
                .await
                .expect("job ran");
        }
    };

    // Primed: archived, not favorite.
    assert!(source.archived().await.expect("archived").contains("sess_kept"));
    assert!(!source.favorites().await.expect("favorites").contains("sess_kept"));
    let scans = source.scans.load(Ordering::Relaxed);
    assert!(source.favorites().await.is_some());
    assert_eq!(source.scans.load(Ordering::Relaxed), scans, "nothing was written: the scan is served as held");

    // A favorite written now is what cleanup reads next, with no wait for an age.
    write(meta(&[("favoriteAt", json!(9))], &[])).await;
    assert!(source.favorites().await.expect("favorites").contains("sess_kept"), "a newly favorited session is protected at once");
    // An un-archive likewise.
    write(meta(&[], &["archivedAt"])).await;
    assert!(!source.archived().await.expect("archived").contains("sess_kept"), "a restored session is no longer archived");
    // A write of any other key moves nothing.
    assert!(source.favorites().await.is_some());
    let scans = source.scans.load(Ordering::Relaxed);
    write(meta(&[("title", json!("renamed"))], &[])).await;
    assert!(source.favorites().await.is_some());
    assert_eq!(source.scans.load(Ordering::Relaxed), scans, "a title is no retention mark");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_marks_are_scanned_once_for_overlapping_asks() {
    let golden = golden();
    let (_dir, threads, lanes) = migrated(&golden).await;
    let source = Arc::new(StoredWorktreeSessions::new(Arc::new(StoredSearchSessions::new(threads, lanes)), tasks()));
    let asks: Vec<_> = (0..6)
        .map(|n| {
            let source = source.clone();
            tokio::spawn(async move { if n % 2 == 0 { source.favorites().await } else { source.archived().await } })
        })
        .collect();
    for ask in asks {
        assert!(ask.await.expect("joined").is_some());
    }
    assert_eq!(source.scans.load(Ordering::Relaxed), 2, "one scan per mark key however many asks overlap");
    source.favorites().await.expect("favorites");
    assert_eq!(source.scans.load(Ordering::Relaxed), 2, "an answer is served as held until a mark is written");
    assert_eq!(sorted(source.favorites().await.expect("favorites")), strings(&golden["favorites"]));
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

    // A foreground command whose kill was not confirmed keeps its folder reserved (Node holds its workspace admission until the
    // exit is confirmed), and the hold ends with the exit.
    start(&registry, "t6", Some("sess_named"), "/p/held", true);
    registry.set_termination_unconfirmed("t6", true).expect("held");
    async fn held(source: &StoredWorktreeSessions) -> bool {
        source.running_jobs().await.expect("jobs").into_iter().filter_map(|job| job.cwd).any(|cwd| cwd == "/p/held")
    }
    assert!(held(&source).await, "the unconfirmed foreground command reserves its folder");
    registry.set_termination_unconfirmed("t6", false).expect("confirmed");
    assert!(!held(&source).await, "its confirmed exit frees the folder");

    // A running shell with no folder cannot be inspected: the listing is refused.
    start(&registry, "t5", None, "", false);
    let refused = source.running_jobs().await.expect_err("refused");
    assert_eq!(refused.to_string(), "Cannot inspect shell job t5.");
}
