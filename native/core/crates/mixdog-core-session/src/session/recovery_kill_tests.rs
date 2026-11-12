//! The recovery of a turn the process died in, killed for real at each write it makes: a child process (this test binary,
//! `recovery_kill_child`) opens the thread over the real store with a hook around every commit, holds there, and the parent
//! ends it (`Child::kill`). A fresh open after each kill must finish the recovery: the cancelled result and the restart line
//! once each, whichever write the kill cut (Node keeps the checkpoint until the recovery is saved).

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use mixdog_core_api::call::{CallContext, CoreRequest};
use mixdog_core_api::ids::{ItemId, Method};
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::{ConnectionId, SubscriptionId};
use mixdog_core_api::mock::{MockConnection, MockLimits};
use mixdog_core_api::sink::ConnectionSink;
use mixdog_core_api::{FeedSource, Reply, ThreadDirectory, ThreadHandle};
use serde_json::json;

use super::testing::{CallCounted, CommitHook, Rig};
use super::tests::{real_store, start_thread, turn};
use super::seams::RunOutcome;
use super::{ItemCommit, SessionDirectory};

const STAGE: &str = "MIXDOG_RECOVERY_KILL_STAGE";
const DIR: &str = "MIXDOG_RECOVERY_KILL_DIR";
const POINT: &str = "MIXDOG_RECOVERY_KILL_POINT";
const THREAD: &str = "MIXDOG_RECOVERY_KILL_THREAD";

/// What the child said before the parent let it go.
enum Ended {
    /// It stopped where asked (and the parent killed it), naming what it held.
    Held(String),
    /// It ran to its end.
    Done,
}

/// A report line. The test harness may print the test's name on the same line before it, so the parent finds it after the tag.
fn say(line: &str) {
    use std::io::Write;
    println!("{TAG}{line}");
    let _ = std::io::stdout().flush();
}

const TAG: &str = "RK:";

/// Holds the calling thread until the parent kills the process.
fn held(what: &str) -> ! {
    say(&format!("HELD {what}"));
    loop {
        std::thread::park();
    }
}

/// The child half: a no-op in a normal run. `seed` leaves a thread whose process died with a tool call unanswered; `recover`
/// opens it with the commit hook that holds at the point `POINT` names; `verify` opens it plainly and checks the conversation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "the child reads the variables the parent set")]
async fn recovery_kill_child() {
    let Ok(stage) = std::env::var(STAGE) else {
        return;
    };
    let dir = PathBuf::from(std::env::var(DIR).expect("the data dir"));
    let rig = Rig::new();
    let committed = Arc::new(tokio::sync::Notify::new());
    let told = committed.clone();
    rig.set_script(Arc::new(move |run| {
        let told = told.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call = json!({ "role": "assistant", "content": "Reading.", "toolCalls": [{ "id": "call_1", "name": "read", "arguments": { "path": "a.txt" } }] });
            let item = ItemCommit { iid: ItemId::from("itm_call"), role: Some("assistant".into()), model: true, visible: true, body: call, prompt: None };
            run.port.commit_item(item).await.expect("commit");
            told.notify_one();
            std::future::pending::<RunOutcome>().await
        })
    }));
    if stage == "seed" {
        let directory = SessionDirectory::new(rig.deps_on(real_store(&dir).await));
        let handle = start_thread(&directory).await;
        turn(&handle, "read a", "op-1").await;
        super::testing::awaiting(|| "the tool call row to be durable".to_owned(), committed.notified()).await;
        held(handle.id.as_str());
    }
    let id = mixdog_core_api::ids::ThreadId::from(std::env::var(THREAD).expect("the thread").as_str());
    let store: Arc<dyn super::ThreadStore> = match std::env::var(POINT) {
        Ok(point) => {
            let (point, seen) = (point.parse::<usize>().expect("a point"), Arc::new(AtomicUsize::new(0)));
            let hook: CommitHook = Arc::new(move |_| {
                let at = seen.fetch_add(1, Ordering::SeqCst);
                if at == point {
                    held(&at.to_string());
                }
            });
            CallCounted::with_commit_hook(real_store(&dir).await, hook)
        }
        Err(_) => real_store(&dir).await,
    };
    // The product's transcript, as a client's attach shows the recovered rows through it (the rig's text stub shows none of them as Node does).
    let mut deps = rig.deps_parts(store);
    deps.transcript = Arc::new(super::transcript::RecordTranscript::new());
    let directory = SessionDirectory::new(Arc::new(deps));
    let reopened = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    if stage == "verify" {
        let read = CoreRequest { method: Method("thread/messages/read"), params: json!({}), op: None, ctx: CallContext::internal("test") };
        let Reply::Value(read) = reopened.request(read).await.expect("read") else { panic!("a value") };
        let messages = read["messages"].as_array().expect("messages");
        let shown: Vec<(&str, &str)> = messages.iter().map(|m| (m["role"].as_str().unwrap_or_default(), m["content"].as_str().unwrap_or_default())).collect();
        assert_eq!(shown, [("user", "read a"), ("assistant", "Reading."), ("tool", "Cancelled"), ("user", "[Request interrupted by process restart]")], "{read}");
        // A client attaching now is sent the recovered turn in its feed: the call closed as cancelled and the cancelled end of the turn
        // (Node shows the stored restart line as a cancelled end, `restore.mjs` `isTranscriptCancelledStatusText`), each once.
        let connection = MockConnection::new(ConnectionId(1), MockLimits::default());
        let source: Arc<dyn FeedSource> = reopened.clone();
        let attached = mixdog_core_api::feed::subscribe(&source, SubscriptionId::from("sub1"), Window::LastItems(50), None, &connection).expect("attach");
        connection.send_control_release(bytes::Bytes::from_static(b"{}"), attached.release).expect("release");
        let snapshot = connection
            .drain_text()
            .iter()
            .filter_map(|text| serde_json::from_str::<serde_json::Value>(text.split_once(':').expect("a rendered frame").1).ok())
            .find(|frame| frame["method"] == "thread/snapshot")
            .expect("the attach is answered with a snapshot");
        let items = snapshot["params"]["items"].as_array().expect("the snapshot's items");
        let count = |wanted: &dyn Fn(&serde_json::Value) -> bool| items.iter().filter(|item| wanted(item)).count();
        let said = |item: &serde_json::Value, text: &str| item.to_string().contains(text);
        assert_eq!(count(&|item| item["type"] == "toolCall" && said(item, "Cancelled")), 1, "the cancelled call once: {items:?}");
        assert_eq!(count(&|item| item["type"] == "turnEnd" && item["status"] == "cancelled"), 1, "the cancelled end of the turn once: {items:?}");
    }
    say("DONE");
}

#[allow(clippy::disallowed_methods, reason = "the parent starts the child from this test binary")]
fn run_child(dir: &Path, stage: &str, point: Option<usize>, thread: Option<&str>) -> Ended {
    let mut command = Command::new(std::env::current_exe().expect("this test binary"));
    command
        .args(["--exact", &format!("{}::recovery_kill_child", module_path!().trim_start_matches("mixdog_core_session::")), "--nocapture", "--test-threads=1"])
        .env(STAGE, stage)
        .env(DIR, dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(point) = point {
        command.env(POINT, point.to_string());
    }
    if let Some(thread) = thread {
        command.env(THREAD, thread);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().expect("the child starts");
    for line in std::io::BufReader::new(child.stdout.take().expect("piped")).lines() {
        let line = line.expect("a line");
        let Some((_, report)) = line.split_once(TAG) else { continue };
        if let Some(what) = report.strip_prefix("HELD ") {
            child.kill().expect("the child is killed");
            child.wait().expect("the child is gone");
            return Ended::Held(what.to_owned());
        }
        if report == "DONE" {
            assert!(child.wait().expect("the child ended").success(), "the {stage} child failed");
            return Ended::Done;
        }
    }
    panic!("the {stage} child ended without finishing: {:?}", child.wait());
}

/// A script whose turn commits a call named `call` and never ends (the process dies there); `told` fires once the row is durable.
fn dies_after_call(rig: &Rig, call: &'static str, told: Arc<tokio::sync::Notify>) {
    rig.set_script(Arc::new(move |run| {
        let told = told.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let body = json!({ "role": "assistant", "content": "Reading.", "toolCalls": [{ "id": call, "name": "read", "arguments": { "path": "a.txt" } }] });
            let item = ItemCommit { iid: ItemId::from(format!("itm_{call}")), role: Some("assistant".into()), model: true, visible: true, body, prompt: None };
            run.port.commit_item(item).await.expect("commit");
            told.notify_one();
            std::future::pending::<RunOutcome>().await
        })
    }));
}

/// `thread/modelMessages/list`: what a client reads, as (role, content) with the whole rows for the mark check.
async fn listed(directory: &SessionDirectory, id: &mixdog_core_api::ids::ThreadId) -> Vec<serde_json::Value> {
    let read = CoreRequest { method: Method("thread/modelMessages/list"), params: json!({ "threadId": id, "start": 0 }), op: None, ctx: CallContext::internal("test") };
    let Reply::Value(reply) = directory.request(read).await.expect("thread/modelMessages/list") else { panic!("a value reply") };
    reply["messages"].as_array().cloned().expect("the messages")
}

/// A fork taken after a recovery inherits its rows, mark included; a kill in the fork's own turn and the recovery of it must close
/// only the fork's turn: the parent's cancelled result and restart line are not derived again, and no client read shows the mark.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recovery_in_a_fork_leaves_the_rows_of_the_recovered_parent_alone() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let told = Arc::new(tokio::sync::Notify::new());
    dies_after_call(&rig, "call_parent", told.clone());
    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let parent = start_thread(&first).await;
    turn(&parent, "one", "op-1").await;
    super::testing::awaiting(|| "the parent's call row to be durable".to_owned(), told.notified()).await;

    // The process dies; the next open recovers the parent, and a fork is taken from the recovered thread.
    let second = SessionDirectory::new(rig.deps_on(store.clone()));
    let recovered = second.open_handle(&parent.id, &CallContext::internal("test")).await.expect("the parent reopens");
    let fork = CoreRequest { method: Method("thread/fork"), params: json!({ "threadId": parent.id, "opId": "op-fork" }), op: Some(mixdog_core_api::ids::OpId::from("op-fork")), ctx: CallContext::internal("test") };
    let Reply::Value(forked) = recovered.request(fork).await.expect("thread/fork") else { panic!("thread/fork answers a value") };
    let fork_id = mixdog_core_api::ids::ThreadId::from(forked["thread"]["id"].as_str().expect("the fork's id"));
    let parent_rows = listed(&second, &parent.id).await;
    assert_eq!(parent_rows.len(), 4, "{parent_rows:?}");

    dies_after_call(&rig, "call_fork", told.clone());
    let heir = second.open_handle(&fork_id, &CallContext::internal("test")).await.expect("the fork opens");
    turn(&heir, "two", "op-2").await;
    super::testing::awaiting(|| "the fork's call row to be durable".to_owned(), told.notified()).await;

    let third = SessionDirectory::new(rig.deps_on(store));
    third.open_handle(&fork_id, &CallContext::internal("test")).await.expect("the fork reopens");
    let heir_rows = listed(&third, &fork_id).await;
    let shown: Vec<(&str, &str)> = heir_rows.iter().map(|m| (m["role"].as_str().unwrap_or_default(), m["content"].as_str().unwrap_or_default())).collect();
    let restart = "[Request interrupted by process restart]";
    // The parent's four rows once, then the fork's own turn closed once (the inheritance boundary row, if any, is not a recovery row).
    let closed: Vec<&(&str, &str)> = shown.iter().filter(|(role, content)| *role == "tool" && *content == "Cancelled").collect();
    assert_eq!(closed.len(), 2, "one cancelled result per turn: {shown:?}");
    assert_eq!(shown.iter().filter(|(_, content)| *content == restart).count(), 2, "one restart line per turn: {shown:?}");
    // The inheritance boundary is stamped on the fork's last inherited row (`meta.sessionInheritances`), so the rows are compared by what they say.
    let said = |rows: &[serde_json::Value]| rows.iter().map(|m| (m["role"].clone(), m["content"].clone())).collect::<Vec<_>>();
    assert_eq!(said(&heir_rows[..4]), said(&parent_rows), "the parent's rows come first, as they were");
    assert!(heir_rows.iter().chain(&parent_rows).all(|row| row.pointer("/meta/restartRecovery").is_none()), "no read shows the stored mark");
}

/// The kill points are every boundary a kill can leave the store at, three kinds (`CommitPoint`): before a commit's batch reaches the
/// store, after the store acknowledged it, and between two records of one batch. The last kind is needed: the store's format
/// (`mixdog-store/FORMAT.md` §7, "a crash is recovered automatically") keeps every complete frame of a batch the crash cut, so a
/// kill inside one commit leaves a prefix of its records, a state neither commit boundary shows. The hooked log writes a batch a
/// record at a time to hold the process after each prefix; a cut inside one record's frame (a torn frame) is dropped by the open
/// and leaves the prefix before it. So every state a kill can leave is a prefix of the records the recovery writes, at every
/// position, and each is killed at here: the next open finishes the recovery with no row missing or doubled.
#[test]
fn a_kill_at_any_write_of_a_recovery_leaves_it_to_finish_at_the_next_open() {
    let mut killed_at = 0;
    for point in 0..64 {
        let dir = tempfile::tempdir().expect("data dir");
        let Ended::Held(thread) = run_child(dir.path(), "seed", None, None) else { panic!("the seed holds") };
        let ended = run_child(dir.path(), "recover", Some(point), Some(&thread));
        killed_at += usize::from(matches!(ended, Ended::Held(_)));
        assert!(matches!(run_child(dir.path(), "verify", None, Some(&thread)), Ended::Done));
        if matches!(ended, Ended::Done) {
            assert!(killed_at >= 2, "the recovery wrote nothing to cut: {killed_at}");
            return;
        }
    }
    panic!("the recovery never ended within 64 points");
}

/// The process is killed again during a recovery that an earlier kill had cut: at every pair of write points (the first kill at the
/// `first`-th write of the first recovery, the second at the `second`-th write of the next), the open after the second kill still
/// leaves the cancelled result, the restart line and the cancelled end once each, in the conversation and in what an attaching client is
/// sent.
#[test]
fn a_second_kill_during_the_recovery_leaves_each_row_once() {
    let mut pairs = 0;
    for first in 0..64 {
        let mut finished_first = false;
        for second in 0..64 {
            let dir = tempfile::tempdir().expect("data dir");
            let Ended::Held(thread) = run_child(dir.path(), "seed", None, None) else { panic!("the seed holds") };
            if !matches!(run_child(dir.path(), "recover", Some(first), Some(&thread)), Ended::Held(_)) {
                finished_first = true;
                break;
            }
            let again = run_child(dir.path(), "recover", Some(second), Some(&thread));
            pairs += usize::from(matches!(again, Ended::Held(_)));
            assert!(matches!(run_child(dir.path(), "verify", None, Some(&thread)), Ended::Done));
            if matches!(again, Ended::Done) {
                break;
            }
        }
        if finished_first {
            break;
        }
    }
    assert!(pairs >= 2, "the second recovery wrote nothing to cut: {pairs}");
}
