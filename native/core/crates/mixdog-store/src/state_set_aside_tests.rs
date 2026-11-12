//! A damaged `state/core.sqlite` does not stop the daemon: `CoreState::open_or_set_aside` keeps it aside and starts a new one.
//! The replay drives the real open over the damage Node's recorder (`record-corrupt-state-file-cases.mjs`, b6f10295a) put on each of
//! its state files, and compares what Node showed any store of such a file must show (`shared`): the damaged bytes kept under
//! `<file>.corrupt-<ms>`, an empty next read, a next write that works, and that write read back.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests damage and inspect the database file")]

use std::path::Path;

use mixdog_rt::testing::tokens;
use mixdog_testkit::Exact;
use serde_json::Value;
use serde_json::json;

use crate::sqlite::DbError;
use crate::state::CoreState;
use crate::state::ProjectRow;
use crate::state::SetAside;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/corrupt-state-file-cases/golden.json");

fn project(path: &str) -> ProjectRow {
    ProjectRow { path: path.into(), alias: Some("A".into()), hidden: false, hidden_rank: None, last_used_at: Some(5), name: Some("alpha".into()) }
}

fn open_aside(path: &Path) -> Result<(CoreState, usize, SetAside), DbError> {
    CoreState::open_or_set_aside(tokens().sqlite_writer_thread, tokens().interactive_io, path)
}

/// A good state file, closed: a project and enough room rows to span many pages.
async fn good_file(path: &Path) {
    let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, path).unwrap();
    state
        .write(|tx| {
            tx.put_project(&project("/work/alpha"))?;
            for n in 0..40 {
                tx.put_room(&format!("room{n:03}"), &"x".repeat(900))?;
            }
            Ok(())
        })
        .await
        .unwrap();
    state.close();
}

/// The recorded damage applied to the file: bytes written over it, or the file cut to half; returns what is on disk after.
fn damage(path: &Path, d: &Value) -> Vec<u8> {
    match d["kind"].as_str().unwrap() {
        "truncated" => {
            let len = std::fs::metadata(path).unwrap().len();
            assert!(len >= 8192, "the good file spans several pages ({len} bytes)");
            std::fs::OpenOptions::new().write(true).open(path).unwrap().set_len(len / 2).unwrap();
        }
        _ => std::fs::write(path, d["bytes"].as_str().unwrap().chars().map(|c| c as u8).collect::<Vec<u8>>()).unwrap(),
    }
    std::fs::read(path).unwrap()
}

/// The set-aside copies of the database itself (`<file>.corrupt-<ms>`), by suffix, with their bytes.
fn asides(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut found: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.unwrap().file_name().into_string().ok())
        .filter_map(|name| name.strip_prefix("core.sqlite").map(str::to_owned))
        .filter(|suffix| suffix.starts_with(".corrupt-") && !suffix.ends_with("-wal") && !suffix.ends_with("-shm"))
        .map(|suffix| {
            let bytes = std::fs::read(dir.join(format!("core.sqlite{suffix}"))).unwrap();
            (suffix, bytes)
        })
        .collect();
    found.sort();
    found
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recorded_damage_of_node_state_files_is_set_aside_and_the_next_read_and_write_work() {
    let recorded = Exact::decode(&serde_json::from_str::<Value>(&GOLDEN).expect("golden is JSON")).expect("golden decodes");
    let runs = recorded.get("cases").as_array()[0].get("observed").get("runs").as_array();
    let mut replayed = 0;
    for run in runs {
        let file = run.get("file").as_str();
        // The cycle state stays a file (replayed over the ledger); a `.bak` has no counterpart (see the manifest's exclusions).
        if file == "memory-cycle-state.json" || run.get("backup").as_bool() {
            continue;
        }
        let shared = run.get("shared");
        let plain = run.to_plain().expect("a run holds no tagged part");
        let stamp = shared.get("asideSuffixes").as_array()[0].as_str().strip_prefix(".corrupt-").unwrap().parse::<u128>().unwrap();
        let _clock = mixdog_statefile::fix_recovery_clock(stamp);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        good_file(&path).await;
        let damaged = damage(&path, &plain["damage"]);

        let (state, _, aside) = open_aside(&path).unwrap_or_else(|e| panic!("{file} {}: the daemon's open must survive: {e}", plain["damage"]["kind"]));
        assert!(aside.file.is_some(), "{file}: a set-aside is reported");
        let kept = asides(dir.path());
        let suffixes = |found: &[(String, Vec<u8>)]| found.iter().map(|(s, _)| json!(s)).collect::<Vec<_>>();
        let hold = !kept.is_empty() && kept.iter().all(|(_, bytes)| *bytes == damaged);
        let empty = state.projects().await.unwrap().is_empty() && state.rooms().await.unwrap().is_empty();
        let wrote = state.write(|tx| tx.put_project(&project("/work/third"))).await.is_ok();
        let read_back = state.projects().await.unwrap().iter().any(|p| p.path == "/work/third");
        let actual = json!({
            "asideSuffixes": suffixes(&kept),
            "asideHoldsDamagedBytes": hold,
            "readIsEmpty": empty,
            "writeSucceeded": wrote,
            "readAfterWriteHasWrite": read_back,
            "asideSuffixesAfterWrite": suffixes(&asides(dir.path())),
        });
        if let Some(difference) = Exact::plain(&actual).difference(shared) {
            panic!("{file} / {}: {difference}", plain["damage"]["kind"]);
        }
        state.close();
        replayed += 1;
    }
    assert_eq!(replayed, 9, "three files and three damages, without a backup");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_database_of_another_identity_is_set_aside_but_one_a_newer_build_wrote_is_left() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE t (x); PRAGMA application_id = 7;").unwrap();
    }
    let (state, _, aside) = open_aside(&path).expect("a foreign database is Rebuild: set aside");
    let (kept, why) = aside.file.expect("set aside");
    assert!(kept.exists() && why.contains("rebuild"), "{kept:?} {why}");
    state.write(|tx| tx.put_project(&project("/work/alpha"))).await.unwrap();
    state.close();
    drop(state);

    let newer = dir.path().join("newer.sqlite");
    good_file(&newer).await;
    {
        let conn = rusqlite::Connection::open(&newer).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
    }
    let before = std::fs::read(&newer).unwrap();
    assert!(matches!(open_aside(&newer), Err(DbError::Rebuild(_))), "a newer build's file is refused, not set aside");
    assert_eq!(std::fs::read(&newer).unwrap(), before, "and left as it was");
    assert!(asides(dir.path()).len() == 1, "only the foreign database was set aside");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_state_gets_its_projects_back_from_the_sessions_recorded_folders() {
    use mixdog_rt::LaneToken;

    use crate::sqlite::DirtyMark;
    use crate::sqlite::SqliteStore;
    use crate::summary::CatalogHead;

    let data = tempfile::tempdir().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let root = data.path().to_path_buf();
    let _job = tokens()
        .maintenance_io
        .submit(&mixdog_rt::CancellationToken::new(), move |lane| {
            let _ = tx.send(SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &root));
        })
        .expect("lane");
    let index = rx.recv().expect("job ran").unwrap();
    for (id, class, path, used) in [("s1", "project", "/work/alpha", 100), ("s2", "project", "/work/alpha", 300), ("s3", "project", "/work/beta", 50), ("s4", "task", "/work/none", 900)] {
        let header = json!({"id": id, "title": "t", "updatedAt": used, "lastUsedAt": used, "desktopSession": {"classification": class, "projectPath": path}});
        let head = CatalogHead { session: id.into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone() };
        index.upsert(head, DirtyMark::Set).await.unwrap();
    }
    let state_dir = tempfile::tempdir().unwrap();
    let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &state_dir.path().join("core.sqlite")).unwrap();
    assert_eq!(crate::state_rebuild::rebuild_projects(&state, &index).await.unwrap(), 2);
    let rows: Vec<(String, Option<String>, Option<i64>, bool)> =
        state.projects().await.unwrap().into_iter().map(|p| (p.path, p.name, p.last_used_at, p.alias.is_none() && !p.hidden)).collect();
    assert_eq!(
        rows,
        [("/work/alpha".to_owned(), Some("alpha".to_owned()), Some(300), true), ("/work/beta".to_owned(), Some("beta".to_owned()), Some(50), true)],
        "one row per Project, last used when its newest session was; a task session is no Project"
    );
    state.close();
    index.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreadable_project_row_is_kept_in_meta_and_the_other_rows_stay() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    good_file(&path).await;
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute("INSERT INTO projects (path, alias, hidden) VALUES ('/work/bad', x'00ff', 0)", []).unwrap();
    }
    let (strict, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &path).unwrap();
    assert!(strict.projects().await.is_err(), "today's read of the table fails whole for one such row");
    strict.close();
    drop(strict);

    let (state, _, aside) = open_aside(&path).unwrap();
    assert_eq!((aside.file, aside.project_rows), (None, 1));
    let paths: Vec<String> = state.projects().await.unwrap().into_iter().map(|p| p.path).collect();
    assert_eq!(paths, ["/work/alpha"]);
    assert_eq!(state.meta("corrupt:projects:/work/bad").await.unwrap().as_deref(), Some(r#"["/work/bad","00ff",0,null,null,null]"#));
    state.close();
}
