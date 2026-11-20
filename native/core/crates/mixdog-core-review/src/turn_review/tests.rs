//! Goldens of the turn review against Node's real functions (fixtures under
//! `fixtures/turn-review/`), and the behaviour of the component around them.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories and a real git")]

use std::path::Path;
use std::path::PathBuf;

use mixdog_core_api::turn_review::CallChange;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;

use super::call_diff::patch_header_path_for_resolved;
use super::nodepath;
use super::testing::review_at;

#[test]
fn header_paths_are_relative_to_the_base() {
    assert_eq!(patch_header_path_for_resolved("/ws", "/ws/a/b.txt"), "a/b.txt");
}

// ── whole turns ─────────────────────────────────────────────────────────────

pub(super) fn plain(path: &Path) -> String {
    path.to_string_lossy().trim_start_matches(r"\\?\").to_owned()
}

/// Every file under `dir` with its bytes' length and a cheap checksum, for before/after comparison.
fn tree_listing(dir: &Path) -> Vec<(String, u64, u64)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, u64, u64)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let bytes = std::fs::read(&path).unwrap();
                let sum = bytes.iter().fold(0u64, |a, b| a.wrapping_mul(31).wrapping_add(*b as u64));
                out.push((path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), bytes.len() as u64, sum));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

/// Where a review starts is recorded where the turn's snapshot is taken: the turn's own tree under its
/// checkpoint, the thread's first tree for the session, the durable record again after a restart, and
/// nothing once the thread is forgotten.
#[tokio::test(flavor = "multi_thread")]
async fn review_starts_are_recorded_at_the_snapshot_and_forgotten_with_the_thread() {
    use mixdog_app_protocol::v2::domain::ReviewScope;
    use mixdog_scm::service::ReviewBases;

    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
    let (ws, data) = (base.join("ws"), base.join("data"));
    std::fs::create_dir_all(&ws).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(&ws).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    std::fs::write(ws.join("a.txt"), "one\ntwo\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "first"]);
    let ws_text = plain(&ws);
    let thread = mixdog_protocol::ThreadId::from("s1");
    let (review, bases) = super::testing::review_with_bases(&data);
    let token = review.begin_turn(&ws_text, "s1", TurnOpen { checkpoint_id: "cp1".into(), continue_turn: false }).await;
    let first = bases.base(&thread, ReviewScope::Turn, Some("cp1")).await.expect("the turn's start");
    assert_eq!(nodepath::resolve_host(&[&plain(&first.0)]), nodepath::resolve_host(&[&ws_text]));
    assert!(!first.1.0.is_empty());
    assert_eq!(bases.base(&thread, ReviewScope::Session, None).await.map(|b| b.1.0), Some(first.1.0.clone()), "the session starts at its first turn");
    std::fs::write(ws.join("a.txt"), "one\n2\n").unwrap();
    let change = CallChange {
        path: plain(&ws.join("a.txt")),
        new_path: None,
        before: ReviewContent::bytes(b"one\ntwo\n".to_vec()),
        after: ReviewContent::bytes(b"one\n2\n".to_vec()),
    };
    review.record_tool_changes("s1", &ws_text, vec![change]).await;
    assert!(review.complete_turn("s1", token.as_ref()).await);
    review.begin_turn(&ws_text, "s1", TurnOpen { checkpoint_id: "cp2".into(), continue_turn: false }).await;
    let second = bases.base(&thread, ReviewScope::Turn, Some("cp2")).await.expect("the second turn's start");
    assert_ne!(second.1.0, first.1.0, "the second turn starts from the edited tree");
    assert_eq!(bases.base(&thread, ReviewScope::Session, None).await.map(|b| b.1.0), Some(first.1.0.clone()), "the session start does not move");
    // A restarted process holds none; the sealed turn's durable record gives its start back.
    let (restarted, fresh) = super::testing::review_with_bases(&data);
    assert!(fresh.base(&thread, ReviewScope::Turn, Some("cp1")).await.is_none());
    assert!(restarted.restore_bases(&thread).await);
    assert_eq!(fresh.base(&thread, ReviewScope::Turn, Some("cp1")).await.map(|b| b.1.0), Some(first.1.0.clone()));
    TurnReviewApi::forget_session(&review, "s1");
    assert!(bases.base(&thread, ReviewScope::Turn, Some("cp1")).await.is_none() && bases.base(&thread, ReviewScope::Session, None).await.is_none());
}
/// The baseline tree and tool baselines live in the shadow repository (borrowing the user's
/// objects through `objects/info/alternates`): the user's `.git` gains no object, no ref and no
/// index change from a whole turn, its session review and its undo.
#[tokio::test(flavor = "multi_thread")]
async fn user_repository_is_never_written() {
    let dir = tempfile::tempdir().unwrap();
    let base = PathBuf::from(plain(&dir.path().canonicalize().unwrap()));
    let (ws, data) = (base.join("ws"), base.join("data"));
    std::fs::create_dir_all(&ws).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(&ws).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    std::fs::write(ws.join("a.txt"), "one\ntwo\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "first"]);
    let before = tree_listing(&ws.join(".git"));
    let ws_text = plain(&ws);
    let review = review_at(&data);
    let token = review.begin_turn(&ws_text, "s1", TurnOpen { checkpoint_id: "cp1".into(), continue_turn: false }).await;
    std::fs::write(ws.join("a.txt"), "one\n2\n").unwrap();
    std::fs::write(ws.join("b.txt"), "new\n").unwrap();
    let change = |path: &str, before: ReviewContent, after: &str| CallChange {
        path: plain(&ws.join(path)),
        new_path: None,
        before,
        after: ReviewContent::bytes(after.as_bytes().to_vec()),
    };
    review
        .record_tool_changes(
            "s1",
            &ws_text,
            vec![change("a.txt", ReviewContent::bytes(b"one\ntwo\n".to_vec()), "one\n2\n"), change("b.txt", ReviewContent::Absent, "new\n")],
        )
        .await;
    let reply = review.turn_review_diff(&ws_text, "s1", ReviewRead::default()).await;
    assert_eq!(reply["files"].as_array().unwrap().len(), 2);
    assert!(review.complete_turn("s1", token.as_ref()).await);
    review.session_review_diff(&ws_text, "s1").await;
    review.revert_turn_review(&ws_text, "s1", "cp1").await.unwrap();
    assert_eq!(tree_listing(&ws.join(".git")), before, "the user's .git changed");
    // The baseline lives in the shadow repository: one directory under the snapshot store, with
    // the user's objects borrowed.
    let shadows: Vec<PathBuf> = std::fs::read_dir(data.join("turn-worktree-snapshots-v1")).unwrap().map(|e| e.unwrap().path()).collect();
    assert_eq!(shadows.len(), 1);
    let name = shadows[0].file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.len() == 24 && name.bytes().all(|b| b.is_ascii_hexdigit()), "{name}");
    let alternates = std::fs::read_to_string(shadows[0].join("objects").join("info").join("alternates")).unwrap();
    assert!(alternates.lines().any(|l| nodepath::resolve_host(&[l]) == nodepath::resolve_host(&[&plain(&ws.join(".git").join("objects"))])), "{alternates}");
    assert!(shadows[0].join("objects").read_dir().unwrap().count() > 2, "the baseline objects are in the shadow repository");
}
