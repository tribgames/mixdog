//! A user's message into a room (`LiveRooms::send`): the row lands in the room's log and the room remembers who spoke last,
//! a submission id accepted before is acknowledged without a second post, only a hosted room takes a message, and the room
//! keeps no more than the newest 64 submission ids.

use super::*;
use crate::rooms::calls::tests::Fake;
use crate::rooms::user_send::UserMessage;

fn message(session: &str, text: &str, submission: &str) -> UserMessage {
    UserMessage { session_id: session.into(), prompt: json!(text), submission_id: submission.into(), pasted_images: None, pasted_texts: None }
}

async fn stored(rig: &Rig) -> crate::rooms::records::RoomRecord {
    rig.rooms.list().await.expect("the rooms").into_iter().find(|room| room.id == "room01").expect("the room")
}

#[tokio::test]
async fn a_message_is_posted_once_and_the_room_remembers_the_user_spoke_last() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let calls = RoomCalls::new(Arc::new(Fake::default()), Arc::new(|_: &str| {}));
    assert!(rig.live.send(&rig.rooms, &calls, &message("sess_room_room01", "hello", "")).await.expect("accepted"));
    assert_eq!(rig.daemon.appended.lock().unwrap().len(), 1);
    let room = stored(&rig).await;
    assert_eq!(room.last_speaker.as_deref(), Some("user"));
    assert!(room.submissions.is_empty(), "a message without a submission id records none");
}

#[tokio::test]
async fn a_submission_accepted_before_is_acknowledged_and_posts_nothing_more() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let calls = RoomCalls::new(Arc::new(Fake::default()), Arc::new(|_: &str| {}));
    let first = message("sess_room_room01", "hello", "sub-1");
    assert!(rig.live.send(&rig.rooms, &calls, &first).await.expect("accepted"));
    assert_eq!(stored(&rig).await.submissions, ["sub-1"]);
    assert!(!rig.live.send(&rig.rooms, &calls, &first).await.expect("acknowledged"), "the retry is told it was accepted, not that it posted");
    assert_eq!(rig.daemon.appended.lock().unwrap().len(), 1, "nothing was posted twice");
    assert_eq!(stored(&rig).await.submissions, ["sub-1"]);
}

#[tokio::test]
async fn a_message_to_a_room_that_is_not_hosted_is_refused() {
    let rig = rig(&["a", "b"]).await;
    let calls = RoomCalls::new(Arc::new(Fake::default()), Arc::new(|_: &str| {}));
    let error = rig.live.send(&rig.rooms, &calls, &message("sess_room_nothere", "hello", "")).await.expect_err("refused");
    assert_eq!(error, RoomError::Refused("This room no longer exists.".into()));
    assert!(rig.daemon.appended.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_room_keeps_only_the_newest_sixty_four_submission_ids() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let calls = RoomCalls::new(Arc::new(Fake::default()), Arc::new(|_: &str| {}));
    for n in 0..66 {
        rig.live.send(&rig.rooms, &calls, &message("sess_room_room01", "hi", &format!("sub-{n}"))).await.expect("accepted");
    }
    let kept = stored(&rig).await.submissions;
    assert_eq!((kept.len(), kept.first().map(String::as_str), kept.last().map(String::as_str)), (64, Some("sub-2"), Some("sub-65")));
}
