//! The append transaction's answers when it holds several projections of a session at once (the index projector queues
//! every barrier's projection without waiting for the commits before it): a projection is answered once its session's
//! catalog row is written, never with only its frames in, so a list fenced behind it finds the row it made.
#![allow(clippy::disallowed_types, reason = "test-only check of the index writer")]

use serde_json::json;

use super::*;
use crate::message_state::MessageRow;

const SESSION: &str = "sess_plain_1";
const LOG_ID: &str = "4f1c2a9e0b7d3c5a6e8f9012";

fn head(model: &str) -> CatalogHead {
    let mut header = serde_json::Map::new();
    header.insert("model".into(), json!(model));
    header.insert("updatedAt".into(), json!(1000.0));
    header.insert("createdAt".into(), json!(500.0));
    CatalogHead { session: SESSION.into(), log_id: LOG_ID.into(), base_session: None, header }
}

fn frame(ordinal: u64, kind: FrameKind) -> ProjectedFrame {
    ProjectedFrame {
        pos: FramePos { ordinal, file_no: 0, offset: ordinal * 10 },
        frame_len: 10,
        kind,
        op: None,
        history_rev: ordinal,
        rows: ordinal,
        visible_rows: ordinal,
    }
}

/// A model message row: three index rows.
fn item(ordinal: u64) -> ProjectedFrame {
    let item = frame(
        ordinal,
        FrameKind::Item {
            iid: format!("i{ordinal}"),
            turn: None,
            form: Form::Message,
            model: true,
            visible: true,
            refs: Vec::new(),
            prompt: None,
            msg: Some(MessageRow::of(&json!({"role": "user", "content": format!("text {ordinal}")}))),
            facets: None,
            aliases: Vec::new(),
        },
    );
    assert_eq!(item.rows(), 3, "the bounds below count three rows per item");
    item
}

fn project(w: &mut Writer, frames: Vec<ProjectedFrame>, model: &str) -> oneshot::Receiver<Result<(), DbError>> {
    let (ack, answer) = oneshot::channel();
    w.take(Command::Project {
        projection: Projection { session: SESSION.into(), frames, head: head(model), pins: Vec::new() },
        ack: Some(ack),
    });
    answer
}

/// The `model` of the session's list row.
fn listed_model(w: &Writer) -> serde_json::Value {
    let summary: String =
        w.conn.query_row("SELECT summary FROM sessions WHERE id = ?1", [SESSION], |r| r.get(0)).expect("the row");
    serde_json::from_str::<serde_json::Value>(&summary).expect("json")["model"].clone()
}

/// A writer whose session has its row (`model` "zero") and its first frame in, taking `append_rows` rows per append
/// transaction from then on.
fn writer(dir: &tempfile::TempDir, append_rows: usize) -> Writer {
    let mut w = Writer::start(&dir.path().join("i.sqlite")).expect("writer");
    w.conn.pragma_update(None, "synchronous", "OFF").expect("pragma");
    w.take(Command::Upsert { head: Box::new(head("zero")), dirty: DirtyMark::Set, ack: None });
    let mut started = project(&mut w, vec![frame(0, FrameKind::Session { base: None })], "zero");
    for _ in 0..10 {
        if w.projections.is_empty() && w.upserts.is_empty() {
            break;
        }
        w.append_transaction();
    }
    started.try_recv().expect("the session's first projection is answered").expect("committed");
    assert_eq!(listed_model(&w), json!("zero"));
    w.append_rows = append_rows;
    w
}

/// Two projections of one session queued together, the first filling the transaction but for its row: the row is
/// written with the first, which is answered with it, while the second still waits (a later projection of the session
/// does not hold the row back).
#[test]
fn a_projection_is_answered_with_its_row_while_a_later_one_of_its_session_is_still_queued() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = writer(&dir, 4);
    let mut one = project(&mut w, vec![item(1)], "one");
    let mut two = project(&mut w, vec![item(2)], "two");
    w.append_transaction();
    one.try_recv().expect("the first projection is answered").expect("committed");
    assert_eq!(listed_model(&w), json!("one"), "the first projection was answered before its row was written");
    assert!(two.try_recv().is_err(), "the second projection was answered before its frame went in");
    w.append_transaction();
    two.try_recv().expect("the second projection is answered").expect("committed");
    assert_eq!(listed_model(&w), json!("two"));
}

/// Each projection's frame takes a whole transaction, so neither row fits beside it: the frames go in, the projections are
/// not answered, and the transaction that writes the row (from the newer head) answers both.
#[test]
fn a_projection_whose_row_did_not_fit_is_answered_by_the_transaction_that_writes_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut w = writer(&dir, 3);
    let mut one = project(&mut w, vec![item(1)], "one");
    let mut two = project(&mut w, vec![item(2)], "two");
    w.append_transaction();
    w.append_transaction();
    assert!(w.projections.is_empty(), "both frames are in");
    assert!(one.try_recv().is_err(), "the first projection was answered before its row was written");
    assert!(two.try_recv().is_err(), "the second projection was answered before its row was written");
    assert_eq!(listed_model(&w), json!("zero"));
    w.append_transaction();
    one.try_recv().expect("the first projection is answered").expect("committed");
    two.try_recv().expect("the second projection is answered").expect("committed");
    assert_eq!(listed_model(&w), json!("two"));
}
