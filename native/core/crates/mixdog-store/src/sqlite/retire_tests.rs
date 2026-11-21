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
    Arc::new(CatalogHead { session: session.into(), log_id: LOG_ID.into(), base_session: base.map(str::to_owned), header })
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
        w.append_transaction();
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
    let base: crate::schema::record::Base = serde_json::from_value(json!({"session": BASE, "log_id": LOG_ID, "end_ordinal_exclusive": 5})).expect("base");
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
    let base: crate::schema::record::Base = serde_json::from_value(json!({"session": BASE, "log_id": LOG_ID, "end_ordinal_exclusive": 3})).expect("base");
    created(&mut w, FORK, Some(BASE), vec![frame(3, FrameKind::Session { base: Some(base) })]);
    let parent: crate::schema::record::Base = serde_json::from_value(json!({"session": FORK, "log_id": LOG_ID, "end_ordinal_exclusive": 4})).expect("base");
    created(&mut w, GRANDCHILD, Some(FORK), vec![frame(4, FrameKind::Session { base: Some(parent) })]);
    let pending: i64 = w.conn.query_row("SELECT count(*) FROM message_views WHERE state = 'pending'", [], |r| r.get(0)).expect("views");
    assert_eq!(pending, 2, "the fork's view and its own fork's are both still to be computed");
    let mut retired = retire(&mut w, GRANDCHILD, Some(FORK), Vec::new(), end_after(4));
    appended(&mut w);
    assert!(retired.try_recv().is_err(), "the retirement was answered while its parent's view was being computed");
    assert!(dirty(&w, GRANDCHILD));
    for _ in 0..1000 {
        if w.retires.is_empty() {
            break;
        }
        w.views = true;
        w.view_step();
        w.append_transaction();
    }
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
    let base: crate::schema::record::Base = serde_json::from_value(json!({"session": BASE, "log_id": LOG_ID, "end_ordinal_exclusive": 3})).expect("base");
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
    let base: crate::schema::record::Base = serde_json::from_value(json!({"session": BASE, "log_id": LOG_ID, "end_ordinal_exclusive": 3})).expect("base");
    created(&mut w, FORK, Some(BASE), vec![frame(3, FrameKind::Session { base: Some(base) })]);
    let mut retired = retire(&mut w, FORK, Some(BASE), Vec::new(), end_after(3));
    appended(&mut w);
    assert!(retired.try_recv().is_err(), "the retirement was answered before the fork's view was computed");
    assert!(dirty(&w, FORK));
    for _ in 0..1000 {
        if w.retires.is_empty() {
            break;
        }
        w.views = true;
        w.view_step();
        w.append_transaction();
    }
    retired.try_recv().expect("the retirement is answered once the view is done").expect("clean");
    assert!(!dirty(&w, FORK));
}
