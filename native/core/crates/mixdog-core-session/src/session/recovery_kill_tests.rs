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
use mixdog_core_api::{Reply, ThreadHandle};
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
    let directory = SessionDirectory::new(rig.deps_on(store));
    let reopened = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    if stage == "verify" {
        let read = CoreRequest { method: Method("thread/messages/read"), params: json!({}), op: None, ctx: CallContext::internal("test") };
        let Reply::Value(read) = reopened.request(read).await.expect("read") else { panic!("a value") };
        let messages = read["messages"].as_array().expect("messages");
        let shown: Vec<(&str, &str)> = messages.iter().map(|m| (m["role"].as_str().unwrap_or_default(), m["content"].as_str().unwrap_or_default())).collect();
        assert_eq!(shown, [("user", "read a"), ("assistant", "Reading."), ("tool", "Cancelled"), ("user", "[Request interrupted by process restart]")], "{read}");
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

/// Each write the recovery makes (before the store takes it, and after it did) is a point; the process is killed at every one,
/// and the next open finishes the recovery with no row missing or doubled.
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
