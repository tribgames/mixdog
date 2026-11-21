//! A session's cached read-only tool results live as long as the session, not as long as one turn: a later turn's run of the
//! same session is answered from what an earlier turn read while the file is unchanged, a changed file is read again, one
//! session's cache holds at most a hundred entries (the oldest goes first), and another session never sees it.

use std::sync::Arc;

use mixdog_agent::env::Clock;
use mixdog_agent::env::ResultReuse;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::tool::{ToolIo, ToolOutput};
use serde_json::json;

use super::result_reuse::LiveReuses;

struct Fixed;

impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        0
    }
}

fn io() -> ToolIo {
    let tokens = mixdog_rt::testing::tokens();
    ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io }
}

fn read(path: &str) -> ToolCall {
    ToolCall { id: "c".into(), name: "read".into(), arguments: json!({ "path": path }), native_type: None }
}

async fn fill(cache: &dyn ResultReuse, cwd: &std::path::Path, path: &str, body: &str) {
    let call = ToolCall { id: "tool_1".into(), ..read(path) };
    cache.prepare(&call, cwd).await.unwrap().store(body, &ToolOutput::default()).await;
}

#[allow(clippy::disallowed_methods, reason = "test setup lays out its files")]
fn workspace(files: &[(&str, &str)]) -> tempfile::TempDir {
    let dir =
        tempfile::Builder::new().tempdir_in(mixdog_workspace::pathguard::canonical(&std::env::temp_dir()).expect("the temp folder")).expect("a workspace");
    for (name, text) in files {
        std::fs::write(dir.path().join(name), text).expect("a file");
    }
    dir
}

#[tokio::test]
async fn a_later_turns_read_of_an_unchanged_file_is_answered_from_the_cache_an_earlier_turn_filled() {
    let dir = workspace(&[("a.txt", "alpha")]);
    let sessions = LiveReuses::default();
    let first_turn = sessions.run(io(), "sess_1", Arc::new(Fixed));
    assert!(first_turn.lookup(&read("a.txt"), dir.path(), true).await.is_none(), "nothing is cached yet");
    fill(first_turn.as_ref(), dir.path(), "a.txt", "alpha body").await;

    let second_turn = sessions.run(io(), "sess_1", Arc::new(Fixed));
    let hit = second_turn.lookup(&read("a.txt"), dir.path(), true).await.expect("answered from the session's cache");
    assert_eq!((hit.content.as_str(), hit.first_tool_use_id.as_str()), ("alpha body", "tool_1"));
}

#[tokio::test]
async fn a_file_changed_between_turns_is_read_again() {
    let dir = workspace(&[("a.txt", "alpha")]);
    let sessions = LiveReuses::default();
    let first_turn = sessions.run(io(), "sess_1", Arc::new(Fixed));
    fill(first_turn.as_ref(), dir.path(), "a.txt", "alpha body").await;
    rewrite(dir.path(), "a.txt", "alpha, changed");
    let second_turn = sessions.run(io(), "sess_1", Arc::new(Fixed));
    assert!(second_turn.lookup(&read("a.txt"), dir.path(), true).await.is_none());
}

#[allow(clippy::disallowed_methods, reason = "test setup changes the file")]
fn rewrite(dir: &std::path::Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).expect("a write");
}

#[tokio::test]
async fn another_sessions_cache_is_not_seen() {
    let dir = workspace(&[("a.txt", "alpha")]);
    let sessions = LiveReuses::default();
    let mine = sessions.run(io(), "sess_1", Arc::new(Fixed));
    fill(mine.as_ref(), dir.path(), "a.txt", "alpha body").await;
    let other = sessions.run(io(), "sess_2", Arc::new(Fixed));
    assert!(other.lookup(&read("a.txt"), dir.path(), true).await.is_none());
}

#[tokio::test]
async fn the_hundred_and_first_entry_of_a_session_evicts_the_first() {
    let names: Vec<String> = (0..101).map(|n| format!("f{n}.txt")).collect();
    let files: Vec<(&str, &str)> = names.iter().map(|name| (name.as_str(), "x")).collect();
    let dir = workspace(&files);
    let sessions = LiveReuses::default();
    let run = sessions.run(io(), "sess_1", Arc::new(Fixed));
    for name in &names {
        fill(run.as_ref(), dir.path(), name, "x").await;
    }
    assert!(run.lookup(&read("f0.txt"), dir.path(), true).await.is_none(), "the oldest entry went");
    assert!(run.lookup(&read("f1.txt"), dir.path(), true).await.is_some(), "the next oldest stays");
    assert!(run.lookup(&read("f100.txt"), dir.path(), true).await.is_some());
}
