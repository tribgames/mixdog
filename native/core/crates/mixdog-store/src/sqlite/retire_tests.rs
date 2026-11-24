//! The writer's answer to a retirement (`Command::Retire`), step by step: the mark goes only with the session's row, only
//! once the index holds the retired log through its end, and never for a writer marked after it.
#![allow(clippy::disallowed_types, reason = "test-only check of the index writer")]

use serde_json::json;

use super::*;

const BASE: &str = "sess_plain_1";
const FORK: &str = "sess_plain_3";
const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";

fn head(session: &str, base: Option<&str>) -> Arc<CatalogHead> {
    let mut header = serde_json::Map::new();
    header.insert("updatedAt".into(), json!(1000.0));
    header.insert("createdAt".into(), json!(500.0));
    Arc::new(CatalogHead { session: session.into(), log_id: LOG_ID.into(), base_session: base.map(str::to_owned), header: header.into() })
}

fn frame(ordinal: u64, kind: FrameKind) -> ProjectedFrame {
    ProjectedFrame {
        pos: FramePos { ordinal, file_no: 0, offset: ordinal * 10 },
        frame_len: 10,
        kind,
        op: None,
        receipt: None,
        history_rev: ordinal,
        rows: ordinal,
        visible_rows: ordinal,
    }
}

fn item(ordinal: u64) -> ProjectedFrame {
    frame(
        ordinal,
        FrameKind::Item {
            iid: format!("i{ordinal}"),
            turn: None,
            form: Form::Message,
            model: true,
            visible: true,
            prompt: None,
            msg: Some(crate::message_state::MessageRow::of(&json!({"role": "user", "content": format!("text {ordinal}")}))),
            facets: None,
            aliases: Vec::new(),
        },
    )
}

/// Where the log of a session whose last frame has `last` as its ordinal ends.
fn end_after(last: u64) -> FramePos {
    FramePos { ordinal: last + 1, file_no: 0, offset: last * 10 + 10 }
}

fn writer(dir: &tempfile::TempDir) -> Writer {
    drop(open_writer(&dir.path().join("i.sqlite"), Some(&runtime_ddl())).expect("index"));
    let w = Writer::start(&dir.path().join("i.sqlite")).expect("writer");
    w.conn.pragma_update(None, "synchronous", "OFF").expect("pragma");
    w
}

/// Runs append transactions until nothing they write is queued.
fn appended(w: &mut Writer) {
    for _ in 0..100 {
        if w.projections.is_empty() && w.upserts.is_empty() && w.small.is_empty() {
            return;
        }
        w.append_answered();
    }
    panic!("the writer's appends do not end");
}

/// The activation every writer of these tests marks with, unless the test names another.
const ACTIVATION: u64 = 7;

fn mark(w: &mut Writer, session: &str, activation: u64) -> oneshot::Receiver<Result<(), DbError>> {
    let (ack, answer) = oneshot::channel();
    w.take(Command::MarkDirty { session: session.into(), log_id: LOG_ID.into(), activation, ack });
    answer
}

/// A session created (its row marked for [`ACTIVATION`]) with `frames` projected, the first its `session` frame.
fn created(w: &mut Writer, session: &str, base: Option<&str>, frames: Vec<ProjectedFrame>) {
    w.take(Command::Upsert { head: head(session, base), dirty: DirtyMark::Set, ack: None });
    appended(w);
    let mut marked = mark(w, session, ACTIVATION);
    appended(w);
    marked.try_recv().expect("the mark is answered").expect("marked");
    w.take(Command::Project { projection: Projection { session: session.into(), frames, head: head(session, base) }, ack: None });
    appended(w);
}

fn retire(w: &mut Writer, session: &str, base: Option<&str>, frames: Vec<ProjectedFrame>, end: FramePos) -> oneshot::Receiver<Result<(), DbError>> {
    let (ack, answer) = oneshot::channel();
    let projection = Projection { session: session.into(), frames, head: head(session, base) };
    w.take(Command::Retire { projection, retirement: Retirement { log_id: LOG_ID.into(), end, activation: ACTIVATION }, ack });
    answer
}

fn fork_base(session: &str, end: u64) -> crate::schema::record::Base {
    serde_json::from_value(json!({"session": session, "log_id": LOG_ID, "end_ordinal_exclusive": end})).expect("base")
}

/// Runs the view steps, each followed by its append transaction, until no retirement is left waiting.
fn viewed(w: &mut Writer) {
    for _ in 0..1000 {
        if w.retires.is_empty() {
            break;
        }
        w.views = true;
        w.view_step();
        w.append_answered();
    }
}

fn dirty(w: &Writer, session: &str) -> bool {
    w.conn.query_row("SELECT dirty FROM sessions WHERE id = ?1", [session], |r| r.get(0)).expect("the row")
}

/// The mark of another activation queued behind a retirement, in the same transaction: the writer applies the mark first (a
/// small command) and the retirement's row after it, which must not clear it. That activation's own retirement does.
#[test]
fn a_mark_queued_behind_a_retirement_outlives_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = writer(&dir);
    created(&mut w, BASE, None, vec![frame(0, FrameKind::Session { base: None }), item(1)]);
    let mut retired = retire(&mut w, BASE, None, Vec::new(), end_after(1));
    let mut marked = mark(&mut w, BASE, ACTIVATION + 1);
    appended(&mut w);
    marked.try_recv().expect("the mark is answered").expect("marked");
    let refused = retired.try_recv().expect("the retirement is answered");
    assert!(matches!(&refused, Err(DbError::Write(why)) if why.contains("not this writer's activation")), "{refused:?}");
    assert!(dirty(&w, BASE), "the retirement cleared the mark of the writer marked after it");

    let (ack, mut own) = oneshot::channel();
    let projection = Projection { session: BASE.into(), frames: Vec::new(), head: head(BASE, None) };
    w.take(Command::Retire { projection, retirement: Retirement { log_id: LOG_ID.into(), end: end_after(1), activation: ACTIVATION + 1 }, ack });
    appended(&mut w);
    own.try_recv().expect("the retirement is answered").expect("clean");
    assert!(!dirty(&w, BASE));
}

/// A fork whose view waits on its base (the base has not projected up to the fork point): no step of this process is known
/// to compute it, so its retirement is refused at once, the mark left; it is not kept waiting.
#[test]
fn a_retirement_whose_fork_view_cannot_run_is_refused_at_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = writer(&dir);
    created(&mut w, BASE, None, vec![frame(0, FrameKind::Session { base: None }), item(1)]);
    let base = fork_base(BASE, 5);
    created(&mut w, FORK, Some(BASE), vec![frame(5, FrameKind::Session { base: Some(base) })]);
    let mut retired = retire(&mut w, FORK, Some(BASE), Vec::new(), end_after(5));
    appended(&mut w);
    let refused = retired.try_recv().expect("the retirement is answered in the transaction that reached its row");
    assert!(matches!(&refused, Err(DbError::Write(why)) if why.contains("fork view")), "{refused:?}");
    assert!(dirty(&w, FORK));
    assert!(w.retires.is_empty());
}

/// A fork of a fork whose own view is still being computed (its base is at the fork point and whole): the steps reach both
/// views in turn, so the retirement waits for them and ends clean; it is not refused for a view that merely is not ready.
#[test]
fn a_retirement_waits_while_its_parents_view_is_still_being_computed() {
    const GRANDCHILD: &str = "sess_plain_5";
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = writer(&dir);
    w.step_rows = 1;
    created(&mut w, BASE, None, vec![frame(0, FrameKind::Session { base: None }), item(1), item(2), item(3)]);
    let base = fork_base(BASE, 3);
    created(&mut w, FORK, Some(BASE), vec![frame(3, FrameKind::Session { base: Some(base) })]);
    let parent = fork_base(FORK, 4);
    created(&mut w, GRANDCHILD, Some(FORK), vec![frame(4, FrameKind::Session { base: Some(parent) })]);
    let pending: i64 = w.conn.query_row("SELECT count(*) FROM message_views WHERE state = 'pending'", [], |r| r.get(0)).expect("views");
    assert_eq!(pending, 2, "the fork's view and its own fork's are both still to be computed");
    let mut retired = retire(&mut w, GRANDCHILD, Some(FORK), Vec::new(), end_after(4));
    appended(&mut w);
    assert!(retired.try_recv().is_err(), "the retirement was answered while its parent's view was being computed");
    assert!(dirty(&w, GRANDCHILD));
    viewed(&mut w);
    retired.try_recv().expect("the retirement is answered once both views are done").expect("clean");
    assert!(!dirty(&w, GRANDCHILD));
}

/// A view step that fails stops the view work: a retirement whose row waits for a view is refused then, its mark left, and
/// is not left waiting for an answer no later step gives.
#[test]
fn a_failed_view_step_refuses_the_retirements_waiting_for_a_view() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = writer(&dir);
    w.step_rows = 1;
    created(&mut w, BASE, None, vec![frame(0, FrameKind::Session { base: None }), item(1), item(2), item(3)]);
    let base = fork_base(BASE, 3);
    created(&mut w, FORK, Some(BASE), vec![frame(3, FrameKind::Session { base: Some(base) })]);
    let mut retired = retire(&mut w, FORK, Some(BASE), Vec::new(), end_after(3));
    appended(&mut w);
    assert!(retired.try_recv().is_err(), "the retirement waits for the fork's view");
    // The step's own statement fails from here.
    w.conn.execute_batch("ALTER TABLE message_views RENAME TO message_views_gone").expect("rename");
    w.views = true;
    w.view_step();
    let refused = retired.try_recv().expect("the failed step answers the retirement");
    assert!(matches!(&refused, Err(DbError::Write(why)) if why.contains("fork view") && why.contains("failed")), "{refused:?}");
    assert!(w.retires.is_empty() && !w.views);
    w.conn.execute_batch("ALTER TABLE message_views_gone RENAME TO message_views").expect("rename back");
    assert!(dirty(&w, FORK), "a refused retirement left the mark");
}

const OTHER: &str = "sess_plain_7";
const FAILED: &str = "sess_plain_9";

fn project(w: &mut Writer, session: &str, frames: Vec<ProjectedFrame>) -> oneshot::Receiver<Result<(), DbError>> {
    let (ack, answer) = oneshot::channel();
    w.take(Command::Project { projection: Projection { session: session.into(), frames, head: head(session, None) }, ack: Some(ack) });
    answer
}

fn upsert(w: &mut Writer, session: &str) -> oneshot::Receiver<Result<(), DbError>> {
    let (ack, answer) = oneshot::channel();
    w.take(Command::Upsert { head: head(session, None), dirty: DirtyMark::Keep, ack: Some(ack) });
    answer
}

/// The ordinal the index holds `session`'s log through, and whether it is noted as holed.
fn cursor(w: &Writer, session: &str) -> (Option<i64>, bool) {
    let at = w.conn.query_row("SELECT projected_ordinal FROM sessions WHERE id = ?1", [session], |r| r.get(0)).expect("the row");
    let holed = w.conn.query_row("SELECT 1 FROM meta WHERE key = ?1", [hole_key(session)], |_| Ok(())).optional().expect("meta").is_some();
    (at, holed)
}

/// A writer whose append transactions fail where a test says ([`reconcile_seam::fail_append`]).
fn faulted(dir: &tempfile::TempDir) -> Writer {
    let mut w = writer(dir);
    w.seam = Some(dir.path().to_path_buf());
    w
}

/// A foreign connection holds the index's write lock: the writer waits for it inside SQLite, and a transaction that still
/// meets it drops nothing. The projection and the retirement queued meanwhile go in once the lock is gone, in order: the
/// session retires clean and is not holed.
#[test]
fn an_append_that_meets_a_foreign_lock_keeps_what_is_queued() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = faulted(&dir);
    // The wait of one statement, not the outcome: the test does not hold the lock for [`LOCK_WAIT`].
    w.conn.busy_timeout(std::time::Duration::from_millis(50)).expect("timeout");
    created(&mut w, BASE, None, vec![frame(0, FrameKind::Session { base: None }), item(1)]);
    let before = cursor(&w, BASE);
    let foreign = rusqlite::Connection::open(dir.path().join("i.sqlite")).expect("the other connection");
    foreign.execute_batch("BEGIN IMMEDIATE").expect("the write lock");
    let mut projected = project(&mut w, BASE, vec![item(2)]);
    let mut retired = retire(&mut w, BASE, None, Vec::new(), end_after(2));
    w.append_answered();
    assert_eq!(reconcile_seam::commits(dir.path()).last().map(|(kind, ..)| *kind), Some("locked"), "the transaction met the lock");
    assert_eq!(w.projections.len(), 2, "what is queued stays queued");
    assert!(projected.try_recv().is_err() && retired.try_recv().is_err(), "nothing is answered while the lock is held");
    foreign.execute_batch("ROLLBACK").expect("the lock released");
    appended(&mut w);
    projected.try_recv().expect("the projection is answered").expect("in");
    retired.try_recv().expect("the retirement is answered").expect("clean");
    assert!(!dirty(&w, BASE));
    let after = cursor(&w, BASE);
    assert!(after.0 > before.0 && !after.1, "{before:?} to {after:?}");
}

/// A transaction that does not begin for a reason other than a lock is the failure of everything queued: each request is
/// answered with it and none is left to begin the same transaction again.
#[test]
fn an_append_that_cannot_begin_fails_everything_queued() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = faulted(&dir);
    created(&mut w, BASE, None, vec![frame(0, FrameKind::Session { base: None }), item(1)]);
    let before = cursor(&w, BASE);
    let mut projected = project(&mut w, BASE, vec![item(2)]);
    let mut retired = retire(&mut w, BASE, None, Vec::new(), end_after(2));
    let mut row = upsert(&mut w, OTHER);
    let marked = mark(&mut w, BASE, ACTIVATION + 1);
    reconcile_seam::fail_append(dir.path(), reconcile_seam::AppendFault::Begin);
    w.append_answered();
    for answer in [&mut projected, &mut retired, &mut row] {
        let failed = answer.try_recv().expect("answered");
        assert!(matches!(&failed, Err(DbError::Write(why)) if why.contains(reconcile_seam::INJECTED)), "{failed:?}");
    }
    drop(marked);
    assert!(!w.serving_queued() && w.retires.is_empty(), "nothing is left to fail again");
    assert_eq!(cursor(&w, BASE), before);
}

/// A transaction that fails on one session's frames loses that session's projection and nothing else: nothing of it is
/// in, and what it moved in memory for the others is put back. The retirement handed over is its projection's again, the
/// row a projection queued is not left to be written ahead of its frames, a queued row keeps the head and order it had,
/// and all of them go in with the next transaction.
#[test]
fn an_append_that_fails_on_one_sessions_frames_keeps_the_others_queued() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = faulted(&dir);
    for session in [BASE, OTHER, FAILED] {
        created(&mut w, session, None, vec![frame(0, FrameKind::Session { base: None }), item(1)]);
    }
    let before = [BASE, OTHER, FAILED].map(|session| cursor(&w, session));
    let mut row = upsert(&mut w, OTHER);
    let queued_at = w.upserts[OTHER].3;
    let mut raised = project(&mut w, OTHER, vec![item(2)]);
    let mut retired = retire(&mut w, BASE, None, vec![frame(2, FrameKind::Other)], end_after(2));
    let mut failed = project(&mut w, FAILED, vec![item(2)]);
    reconcile_seam::fail_append(dir.path(), reconcile_seam::AppendFault::Frames(FAILED.into()));
    w.append_answered();
    let lost = failed.try_recv().expect("the failing session's projection is answered");
    assert!(matches!(&lost, Err(DbError::Write(why)) if why.contains(reconcile_seam::INJECTED)), "{lost:?}");
    assert!(row.try_recv().is_err() && raised.try_recv().is_err() && retired.try_recv().is_err(), "the others are not answered with the failure");
    assert_eq!(w.projections.iter().map(|p| p.projection.session.as_str()).collect::<Vec<_>>(), [OTHER, BASE]);
    assert!(w.projections.iter().all(|p| p.next == 0 && p.ack.is_some()), "the kept projections go in from their first frame");
    assert!(w.projections[1].retire.is_some() && w.retires.is_empty(), "the retirement is its projection's again");
    assert!(!w.upserts.contains_key(BASE), "the row the failed transaction queued is not left to be written ahead of its frames");
    assert_eq!((w.upserts[OTHER].3, w.upserts[OTHER].2.len()), (queued_at, 1), "the queued row keeps its order and its waiter");
    assert_eq!([BASE, OTHER, FAILED].map(|session| cursor(&w, session)), before, "nothing of the transaction is in");
    appended(&mut w);
    for answer in [&mut row, &mut raised, &mut retired] {
        answer.try_recv().expect("answered by the next transaction").expect("in");
    }
    assert!(!dirty(&w, BASE), "the kept retirement is clean");
    for (session, before) in [BASE, OTHER].into_iter().zip(before) {
        let after = cursor(&w, session);
        assert!(after.0 > before.0 && !after.1, "{session}: {before:?} to {after:?}");
    }
    assert_eq!(cursor(&w, FAILED), before[2], "the failing session is behind its log, and not holed");
    assert!(dirty(&w, FAILED));
}

/// A transaction that fails on one session's row, after it wrote the row of another: that row is queued again with its
/// waiter, which the next transaction answers, and only the failing session's waiter gets the failure. The rows are
/// written in the map's order, so the failure is set on the second row written, whichever session's it is.
#[test]
fn an_append_that_fails_on_one_sessions_row_keeps_the_rows_written_before_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = faulted(&dir);
    let mut rows = [(OTHER, upsert(&mut w, OTHER)), (FAILED, upsert(&mut w, FAILED))];
    reconcile_seam::fail_append(dir.path(), reconcile_seam::AppendFault::RowAt(1));
    w.append_answered();
    let answers: Vec<_> = rows.iter_mut().map(|(_, row)| row.try_recv().ok()).collect();
    let failing = answers.iter().position(Option::is_some).expect("the session whose row failed is answered");
    assert!(matches!(&answers[failing], Some(Err(DbError::Write(why))) if why.contains(reconcile_seam::INJECTED)), "{answers:?}");
    let (kept, lost) = (rows[1 - failing].0, rows[failing].0);
    assert!(answers[1 - failing].is_none(), "the row written before the failing one was answered with the failure");
    assert!(w.upserts[kept].2.len() == 1 && !w.upserts.contains_key(lost), "the row written before is queued again with its waiter");
    appended(&mut w);
    rows[1 - failing].1.try_recv().expect("answered by the next transaction").expect("written");
    let written: Vec<String> =
        w.conn.prepare("SELECT id FROM sessions").expect("rows").query_map([], |r| r.get(0)).expect("rows").collect::<Result<_, _>>().expect("rows");
    assert_eq!(written, [kept]);
}

/// A transaction whose commit fails loses everything it held, and only that: each projection and row is answered with the
/// failure, nothing of them is in, and the writer goes on with what is queued after.
#[test]
fn an_append_whose_commit_fails_fails_what_it_held() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = faulted(&dir);
    for session in [BASE, FAILED] {
        created(&mut w, session, None, vec![frame(0, FrameKind::Session { base: None }), item(1)]);
    }
    let before = [BASE, FAILED].map(|session| cursor(&w, session));
    let mut projected = project(&mut w, BASE, vec![item(2)]);
    let mut retired = retire(&mut w, FAILED, None, vec![frame(2, FrameKind::Other)], end_after(2));
    let mut row = upsert(&mut w, OTHER);
    reconcile_seam::fail_append(dir.path(), reconcile_seam::AppendFault::Commit);
    w.append_answered();
    for answer in [&mut projected, &mut retired, &mut row] {
        let failed = answer.try_recv().expect("answered");
        assert!(matches!(&failed, Err(DbError::Write(why)) if why.contains(reconcile_seam::INJECTED)), "{failed:?}");
    }
    assert!(!w.serving_queued() && w.retires.is_empty());
    assert_eq!([BASE, FAILED].map(|session| cursor(&w, session)), before);
    assert!(dirty(&w, FAILED), "a retirement that failed left the mark");
    let mut again = upsert(&mut w, OTHER);
    appended(&mut w);
    again.try_recv().expect("the next transaction answers").expect("written");
}

/// A retirement alone, its frames in order: answered once its row is written, clean.
#[test]
fn a_retirement_with_its_last_frame_clears_the_mark_with_the_row() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = writer(&dir);
    created(&mut w, BASE, None, vec![frame(0, FrameKind::Session { base: None }), item(1)]);
    assert!(dirty(&w, BASE));
    let mut retired = retire(&mut w, BASE, None, vec![frame(2, FrameKind::Other)], end_after(2));
    appended(&mut w);
    retired.try_recv().expect("the retirement is answered").expect("clean");
    assert!(!dirty(&w, BASE));
}

/// A fork retired while the view its row is built from is still being computed: the row waits for the view and the
/// retirement with it; the mark goes only with the row the finished view writes.
#[test]
fn a_retirement_waits_for_the_fork_view_its_row_needs() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = writer(&dir);
    w.step_rows = 1;
    created(&mut w, BASE, None, vec![frame(0, FrameKind::Session { base: None }), item(1), item(2), item(3)]);
    // Forked below the base's end: the base is ahead of the fork point, so the view is computed by maintenance steps.
    let base = fork_base(BASE, 3);
    created(&mut w, FORK, Some(BASE), vec![frame(3, FrameKind::Session { base: Some(base) })]);
    let mut retired = retire(&mut w, FORK, Some(BASE), Vec::new(), end_after(3));
    appended(&mut w);
    assert!(retired.try_recv().is_err(), "the retirement was answered before the fork's view was computed");
    assert!(dirty(&w, FORK));
    viewed(&mut w);
    retired.try_recv().expect("the retirement is answered once the view is done").expect("clean");
    assert!(!dirty(&w, FORK));
}
