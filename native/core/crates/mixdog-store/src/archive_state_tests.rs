//! The archive authority over a real `state/core.sqlite`: the resolution rule, one transaction per change, and what survives a
//! reopen (a restart).

use std::path::Path;

use mixdog_rt::testing::tokens;
use serde_json::json;

use super::*;
use crate::state::OpRowState;

fn open_state(path: &Path) -> CoreState {
    CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, path).unwrap().0
}

/// With no entry a session is what its header says; an archived entry is archived at its stamp; a restored entry is not archived
/// even while its header still holds a stamp.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_resolves_from_its_entry_else_its_header() {
    let dir = tempfile::tempdir().unwrap();
    let states = ArchiveStates::open(open_state(&dir.path().join("core.sqlite"))).await.unwrap();
    let stamp = json!(1_700_000_000_000_i64);
    assert_eq!(states.resolve("legacy", Some(&stamp)).archived_at, Some(1_700_000_000_000.0), "no entry: the header's stamp");
    assert!(!states.resolve("plain", None).archived());
    states.commit(|_, _| Ok(((), vec![("a".to_owned(), ArchiveEntry::Archived(5.0)), ("r".to_owned(), ArchiveEntry::Restored(6.0))]))).await.unwrap();
    assert_eq!(states.resolve("a", None).archived_at, Some(5.0));
    let restored = states.resolve("r", Some(&stamp));
    assert!(!restored.archived() && restored.restored_at() == Some(6.0), "an explicit restore wins over the header");
}

/// A legacy header stamp, an explicit restore and a child's own stamp all survive a restart: the entries are read back whole.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn entries_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let state = open_state(&path);
    let states = ArchiveStates::open(state.clone()).await.unwrap();
    states
        .commit(|_, _| Ok(((), vec![("root".to_owned(), ArchiveEntry::Restored(9.0)), ("child".to_owned(), ArchiveEntry::Archived(3.0))])))
        .await
        .unwrap();
    state.close();
    let again = ArchiveStates::open(open_state(&path)).await.unwrap();
    let stamp = json!(2);
    assert!(!again.resolve("root", Some(&stamp)).archived(), "the restore stands over the header's stamp");
    assert_eq!(again.resolve("child", None).archived_at, Some(3.0), "the child keeps its own stamp");
    assert_eq!(again.resolve("legacy", Some(&stamp)).archived_at, Some(2.0), "no entry: the header still decides");
    assert!(!again.snapshot().lost());
}

/// A commit whose decision fails writes nothing: no entry, no op record, the snapshot unchanged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_commit_changes_no_member() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(&dir.path().join("core.sqlite"));
    let states = ArchiveStates::open(state.clone()).await.unwrap();
    let row = OpRow { method: "session/autoArchive".into(), payload_digest: "root".into(), state: OpRowState::Applied, outcome: None, created_at: 1, completed_at: Some(1) };
    let failed = states
        .commit(move |_, tx| {
            tx.put_op(OP_SCOPE, "op-1", &row)?;
            tx.put_meta(&format!("{ENTRY_PREFIX}root"), &ArchiveEntry::Archived(1.0).encode())?;
            Err::<((), Vec<(String, ArchiveEntry)>), _>(DbError::Write("refused".into()))
        })
        .await;
    assert!(failed.is_err());
    assert!(states.snapshot().entry("root").is_none());
    assert_eq!(states.snapshot().version(), 0);
    assert!(states.outcome("op-1").await.unwrap().is_none(), "the op record rolled back with the entries");
    assert!(state.meta_prefix(ENTRY_PREFIX).await.unwrap().is_empty());
}

/// Every member's entry and the op record of the outcome are one transaction: after the commit the outcome answers for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tree_commit_writes_every_member_with_its_outcome() {
    let dir = tempfile::tempdir().unwrap();
    let states = ArchiveStates::open(open_state(&dir.path().join("core.sqlite"))).await.unwrap();
    let row = OpRow {
        method: "session/autoArchive".into(),
        payload_digest: "root".into(),
        state: OpRowState::Applied,
        outcome: Some(json!({ "archived": ["root", "c1", "c2"] }).to_string()),
        created_at: 1,
        completed_at: Some(1),
    };
    let committed = states
        .commit(move |_, tx| {
            tx.put_op(OP_SCOPE, "op-2", &row)?;
            Ok(((), ["root", "c1", "c2"].iter().map(|id| ((*id).to_owned(), ArchiveEntry::Archived(7.0))).collect()))
        })
        .await
        .unwrap();
    assert_eq!(committed.changed, ["root", "c1", "c2"]);
    assert!(committed.indexed.is_ok(), "no index bound: nothing to project");
    let snapshot = states.snapshot();
    assert!(["root", "c1", "c2"].iter().all(|id| snapshot.entry(id) == Some(ArchiveEntry::Archived(7.0))));
    assert!(states.outcome("op-2").await.unwrap().is_some());
}

/// An entry that does not parse fails the open: it is never taken as absent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_corrupt_entry_fails_the_open() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(&dir.path().join("core.sqlite"));
    state.write(|tx| tx.put_meta(&format!("{ENTRY_PREFIX}bad"), "{\"archivedAt\":\"x\"}")).await.unwrap();
    assert!(ArchiveStates::open(state).await.is_err());
}

/// An automatic delete admitted against the entry it judged holds it: a restore committed while it is held fails whole, and a
/// claim judged against an entry a restore has since replaced is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_claim_and_a_restore_exclude_each_other() {
    let dir = tempfile::tempdir().unwrap();
    let states = ArchiveStates::open(open_state(&dir.path().join("core.sqlite"))).await.unwrap();
    states.commit(|_, _| Ok(((), vec![("s".to_owned(), ArchiveEntry::Archived(5.0))]))).await.unwrap();
    let judged = states.snapshot().entry("s");
    // The delete is admitted first: the restore fails and changes nothing.
    let claim = states.claim_delete("s", judged).expect("admitted");
    assert!(states.claim_delete("s", judged).is_none(), "one delete at a time");
    let restore = states.commit(|_, _| Ok(((), vec![("s".to_owned(), ArchiveEntry::Restored(6.0))]))).await;
    assert!(restore.is_err(), "a restore of a session being deleted fails");
    assert_eq!(states.snapshot().entry("s"), Some(ArchiveEntry::Archived(5.0)));
    drop(claim);
    // The restore commits first: the delete judged before it is refused.
    states.commit(|_, _| Ok(((), vec![("s".to_owned(), ArchiveEntry::Restored(7.0))]))).await.unwrap();
    assert!(states.claim_delete("s", judged).is_none(), "judged against an entry that is gone");
}

/// The catalog projection failing after a commit: the commit stands, the projection is owed, and the recent search (which filters
/// by the projected column) settles it before it reads, so a session archived by the authority is not listed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_projection_is_owed_and_settled_before_the_search_reads() {
    use mixdog_rt::LaneToken;

    use crate::sqlite::DirtyMark;
    use crate::sqlite::SqliteStore;
    use crate::summary::CatalogHead;

    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    let at = data.clone();
    let _job = tokens()
        .maintenance_io
        .submit(&mixdog_rt::CancellationToken::new(), move |lane| {
            let _ = tx.send(SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &at));
        })
        .expect("lane");
    let index = rx.recv().expect("job ran").expect("index");
    let header = json!({ "id": "s1", "title": "Kept", "updatedAt": 1, "desktopSession": { "classification": "task", "projectPath": "/p" } });
    let head = CatalogHead { session: "s1".into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone() };
    index.upsert(head, DirtyMark::Set).await.unwrap();
    let states = ArchiveStates::open(open_state(&data.join("core.sqlite"))).await.unwrap();
    states.bind_index(&index).await.unwrap();
    let listed = |rows: &[String]| rows.iter().any(|row| row.contains("\"s1\""));
    assert!(listed(&index.search("", 10, None).await.unwrap()), "listed while not archived");
    index.fail_archive_projections(1);
    let committed = states.commit(|_, _| Ok(((), vec![("s1".to_owned(), ArchiveEntry::Archived(9.0))]))).await.unwrap();
    assert!(committed.indexed.is_err(), "the projection failed");
    assert_eq!(states.resolve("s1", None).archived_at, Some(9.0), "the commit stands");
    assert!(index.archive_owed());
    assert!(!listed(&index.search("", 10, None).await.unwrap()), "the search settled the owed projection first");
    assert!(!index.archive_owed());
}

/// A deferred bind returns before the projection ran: the entries are owed, and the search settles them before it reads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deferred_bind_owes_the_entries_and_the_search_settles_them() {
    use mixdog_rt::LaneToken;

    use crate::sqlite::DirtyMark;
    use crate::sqlite::SqliteStore;
    use crate::summary::CatalogHead;

    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    let at = data.clone();
    let _job = tokens()
        .maintenance_io
        .submit(&mixdog_rt::CancellationToken::new(), move |lane| {
            let _ = tx.send(SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &at));
        })
        .expect("lane");
    let index = rx.recv().expect("job ran").expect("index");
    let header = json!({ "id": "s1", "title": "Kept", "updatedAt": 1, "desktopSession": { "classification": "task", "projectPath": "/p" } });
    let head = CatalogHead { session: "s1".into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone() };
    index.upsert(head, DirtyMark::Set).await.unwrap();
    let states = ArchiveStates::open(open_state(&data.join("core.sqlite"))).await.unwrap();
    states.commit(|_, _| Ok(((), vec![("s1".to_owned(), ArchiveEntry::Archived(9.0))]))).await.unwrap();
    states.bind_index_deferred(&index).unwrap();
    assert!(index.archive_owed(), "owed until projected");
    let rows = index.search("", 10, None).await.unwrap();
    assert!(!rows.iter().any(|row| row.contains("\"s1\"")), "the search settled the archived session first");
    assert!(!index.archive_owed());
}

/// The background projection settles what a deferred bind owed; once the store's stop ended it, a later start does nothing and the
/// entries stay owed (the next start owes them again).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_background_projection_settles_the_debt_and_ends_with_the_stop() {
    for stopped_first in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (index, states) = indexed(dir.path()).await;
        states.commit(|_, _| Ok(((), vec![("s1".to_owned(), ArchiveEntry::Archived(9.0))]))).await.unwrap();
        index.owe_archive(vec!["s1".to_owned()]);
        if stopped_first {
            states.close_projection().await;
        }
        states.start_projection();
        if !stopped_first {
            for _ in 0..200 {
                if !index.archive_owed() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
        states.close_projection().await;
        assert_eq!(index.archive_owed(), stopped_first, "owed exactly when the stop came before the projection started");
    }
}

/// An index over `data` holding the task session `s1`, and the authority bound to it.
async fn indexed(data: &Path) -> (crate::sqlite::SqliteStore, Arc<ArchiveStates>) {
    use mixdog_rt::LaneToken;

    use crate::sqlite::DirtyMark;
    use crate::sqlite::SqliteStore;
    use crate::summary::CatalogHead;

    let (tx, rx) = std::sync::mpsc::channel();
    let at = data.to_path_buf();
    let _job = tokens()
        .maintenance_io
        .submit(&mixdog_rt::CancellationToken::new(), move |lane| {
            let _ = tx.send(SqliteStore::open(lane, tokens().sqlite_writer_thread, tokens().interactive_io, &at));
        })
        .expect("lane");
    let index = rx.recv().expect("job ran").expect("index");
    let header = json!({ "id": "s1", "title": "Kept", "updatedAt": 1, "desktopSession": { "classification": "task", "projectPath": "/p" } });
    let head = CatalogHead { session: "s1".into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone() };
    index.upsert(head, DirtyMark::Set).await.unwrap();
    let states = ArchiveStates::open(open_state(&data.join("core.sqlite"))).await.unwrap();
    states.bind_index(&index).await.unwrap();
    (index, states)
}

/// An older archive projection that succeeded is acknowledged only after a newer restore's projection failed: the restore stays
/// owed (the older success read its state before the failure), and the search settles it before it reads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_older_success_acknowledged_after_a_newer_failure_leaves_it_owed() {
    let dir = tempfile::tempdir().unwrap();
    let (index, states) = indexed(dir.path()).await;
    let listed = |rows: &[String]| rows.iter().any(|row| row.contains("\"s1\""));
    let (arrived, go) = index.hold_archive_ack();
    let archiving = states.clone();
    let archive = tokio::spawn(async move { archiving.commit(|_, _| Ok(((), vec![("s1".to_owned(), ArchiveEntry::Archived(9.0))]))).await.unwrap() });
    arrived.await.expect("the archive's projection wrote and waits to acknowledge");
    index.fail_archive_projections(1);
    let restore = states.commit(|_, _| Ok(((), vec![("s1".to_owned(), ArchiveEntry::Restored(10.0))]))).await.unwrap();
    assert!(restore.indexed.is_err(), "the restore's projection failed");
    go.send(()).unwrap();
    assert!(archive.await.unwrap().indexed.is_ok(), "the older projection succeeded");
    assert!(index.archive_owed(), "the restore is still owed");
    assert!(listed(&index.search("", 10, None).await.unwrap()), "the search settled the restore first");
    assert!(!index.archive_owed());
}

/// After the state database was set aside, a state only a header gives is not trusted; one from an entry is.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn after_a_set_aside_header_states_are_not_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(&dir.path().join("core.sqlite"));
    ArchiveStates::mark_lost(&state).await.unwrap();
    let states = ArchiveStates::open(state).await.unwrap();
    let stamp = json!(4);
    let header_only = states.resolve("legacy", Some(&stamp));
    assert!(header_only.archived() && !header_only.trusted());
    states.commit(|_, _| Ok(((), vec![("own".to_owned(), ArchiveEntry::Archived(8.0))]))).await.unwrap();
    assert!(states.resolve("own", None).trusted());
}
