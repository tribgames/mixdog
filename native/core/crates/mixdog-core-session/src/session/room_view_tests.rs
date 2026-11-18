//! A room log's rows and the room view that goes with them: one update of the log, one notification, and the same revision in
//! every snapshot taken at that point (`thread/roomRows/commit` with a `roomView`, `thread/roomView/set`).

use std::sync::Arc;

use mixdog_app_protocol::v2::thread::ThreadRoomView;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::room_log::SessionRoomLog;
use super::testing::Rig;
use crate::eventually_on;

fn typing(speaker: &str) -> ThreadRoomView {
    ThreadRoomView {
        busy: true,
        typing: Some(json!({ "kind": "notice", "id": "t1", "tone": "info", "text": "…", "room": { "kind": "typing", "speaker": speaker, "name": speaker } })),
        ..ThreadRoomView::default()
    }
}

fn deciding() -> ThreadRoomView {
    ThreadRoomView {
        busy: true,
        deciding: Some(true),
        typing: Some(json!({ "kind": "notice", "id": "room-deciding", "tone": "info", "text": "…", "room": { "kind": "typing", "speaker": "", "name": "" } })),
        ..ThreadRoomView::default()
    }
}

fn message(id: &str) -> Value {
    json!({ "role": "user", "content": id, "meta": { "source": "room", "room": { "id": "r1", "speaker": "alice" }, "transcript": { "at": 5, "messageId": id } } })
}

/// What the thread feed told of rows and room view, in order: a row with its view (`row+view`), a row alone, a view alone.
fn told(rig: &Rig, thread: &ThreadId) -> Vec<String> {
    rig.feeds
        .frames(thread.as_str())
        .into_iter()
        .filter_map(|(_, method, params)| match method.as_str() {
            "item/completed" => Some(if params.get("roomView").is_some() { "row+view" } else { "row" }.to_owned()),
            "thread/roomView/updated" => Some("view".to_owned()),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rows_post_and_the_view_it_goes_with_are_one_notification_and_one_snapshot() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let thread = ThreadId::from("sess_room_room09".to_owned());
    let mut header = Header::new();
    header.insert("createdAt".into(), json!(1));
    header.insert("updatedAt".into(), json!(1));
    directory.create_with_id(thread.clone(), header, json!({})).await.expect("room log");
    let handle = directory.handle(&thread).expect("loaded");
    let log = SessionRoomLog::new(directory.clone());
    let snapshot = || {
        let view = handle.cell.view.load_full();
        (view.items.len(), view.state.room_view.clone())
    };

    // A speaker types, then its words land with the end of its typing: the room is deciding.
    log.set_view(thread.as_str(), Some(typing("a"))).await.expect("view");
    log.append_rows_with_view(thread.as_str(), vec![message("m1")], Some(deciding())).await.expect("post");
    eventually_on!(&[&handle.cell.stepped], || (snapshot() == (1, Some(deciding()))).then_some(())).await;
    assert_eq!(told(&rig, &thread), ["view", "row+view"], "the words and the retirement of the typing are one notification");

    // The same view with the next row is no view of its own. A send that lands after the exchange was untracked and before its
    // final publication carries the clear with its row: `roomView: null`, one notification, one snapshot.
    log.append_rows_with_view(thread.as_str(), vec![message("m2")], Some(deciding())).await.expect("post");
    log.append_rows_with_view(thread.as_str(), vec![message("m3")], None).await.expect("post");
    eventually_on!(&[&handle.cell.stepped], || (snapshot() == (3, None)).then_some(())).await;
    assert_eq!(told(&rig, &thread), ["view", "row+view", "row", "row+view"]);
    let cleared = rig.feeds.frames(thread.as_str()).into_iter().filter(|(_, method, _)| method == "item/completed").last().expect("the last row");
    assert_eq!(cleared.2.get("roomView"), Some(&Value::Null), "the clear is a value, not an absent field");
    // The publication that follows finds nothing to change.
    log.set_view(thread.as_str(), None).await.expect("cleared");
    log.append_rows_with_view(thread.as_str(), vec![message("m4")], None).await.expect("post");
    eventually_on!(&[&handle.cell.stepped], || (snapshot() == (4, None)).then_some(())).await;
    assert_eq!(told(&rig, &thread), ["view", "row+view", "row", "row+view", "row"]);

    // A view-only set queues behind the posts before it: the older view never lands after the newer.
    log.set_view(thread.as_str(), Some(typing("b"))).await.expect("view");
    log.set_view(thread.as_str(), Some(deciding())).await.expect("view");
    eventually_on!(&[&handle.cell.stepped], || (snapshot() == (4, Some(deciding()))).then_some(())).await;
}
