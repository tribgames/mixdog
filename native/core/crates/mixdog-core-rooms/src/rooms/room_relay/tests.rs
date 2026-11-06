use std::sync::Mutex;
use std::sync::atomic::Ordering;

use super::*;
use crate::rooms::RoomError;
use crate::rooms::calls::tests::{Fake, scheduler, status};
use crate::rooms::config::RoomConfigInput;
use crate::rooms::records::RoomDoc;
use mixdog_services::bots::delivery::env::FollowRecord;

struct Mem(Mutex<RoomDoc>);

#[async_trait]
impl RoomStore for Mem {
    async fn load(&self) -> Result<RoomDoc, RoomError> {
        Ok(self.0.lock().unwrap().clone())
    }
    async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError> {
        *self.0.lock().unwrap() = doc.clone();
        Ok(())
    }
}

#[derive(Default)]
struct Recorded(Mutex<Vec<String>>);

#[async_trait]
impl FollowRecord for Recorded {
    async fn record(&self, submission_id: &str) -> Result<(), String> {
        self.0.lock().unwrap().push(submission_id.to_owned());
        Ok(())
    }
}

async fn relay_over(runner: &Arc<Fake>) -> (MemberRelay<Mem, Fake>, Arc<Recorded>) {
    let rooms = Arc::new(Rooms::new(Mem(Default::default())));
    let input = RoomConfigInput { name: "Plan".into(), members: vec!["lead".into(), "bench".into()], ..Default::default() };
    rooms.create(&input, "room01", 1).await.unwrap();
    (MemberRelay::new(rooms, scheduler(runner)), Arc::default())
}

fn options(id: &str, hop: u32) -> WakeOptions {
    WakeOptions { id: id.into(), hop }
}

#[tokio::test]
async fn a_member_session_relays_in_its_room_and_settled_carries_the_turn_end() {
    let runner = Arc::new(Fake::default());
    let (relay, recorded) = relay_over(&runner).await;
    let session = mixdog_core_base::rooms::ids::room_member_session_id("room01", "bench").unwrap();
    let follow = WakeFollow::new(recorded.clone());
    let turn = relay.relay(&session, "REPORT: done", options("awake_1", 2), follow).await.unwrap().expect("a turn");
    assert_eq!(status(turn.settled).await, "done");
    assert_eq!(*runner.seen.lock().unwrap(), vec![(vec!["bench".to_string()], true, 1)]);
    assert_eq!(runner.cut_offs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_session_that_is_no_member_session_or_no_longer_a_member_is_refused_with_node_s_message() {
    let runner = Arc::new(Fake::default());
    let (relay, recorded) = relay_over(&runner).await;
    let follow = || WakeFollow::new(recorded.clone());
    let plain = relay.relay("sess_home_bench", "REPORT", options("awake_1", 0), follow()).await;
    assert_eq!(plain.err().as_deref(), Some("Not a group-room member session."));
    let outsider = mixdog_core_base::rooms::ids::room_member_session_id("room01", "reviewer").unwrap();
    let left = relay.relay(&outsider, "REPORT", options("awake_2", 0), follow()).await;
    assert_eq!(left.err().as_deref(), Some("That agent is no longer a member of the room."));
    let elsewhere = mixdog_core_base::rooms::ids::room_member_session_id("room99", "bench").unwrap();
    assert!(relay.relay(&elsewhere, "REPORT", options("awake_3", 0), follow()).await.is_err(), "a room that does not exist");
    assert!(runner.seen.lock().unwrap().is_empty());
}
