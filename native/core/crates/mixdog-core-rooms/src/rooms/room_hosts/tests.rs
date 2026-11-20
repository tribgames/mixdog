use std::sync::atomic::Ordering;


use super::*;
use crate::rooms::calls::tests::{Fake, status};
use crate::rooms::room_relay::tests::{options, relay_over};
use mixdog_services::bots::delivery::env::FollowRecord;

struct NoRecord;

#[async_trait]
impl FollowRecord for NoRecord {
    async fn record(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

fn follow() -> WakeFollow {
    WakeFollow::new(Arc::new(NoRecord))
}




#[tokio::test]
async fn the_attached_core_relays_in_its_room_and_a_detached_one_refuses_with_nodes_text() {
    let runner = Arc::new(Fake::default());
    let (member_relay, _) = relay_over(&runner).await;
    let session = mixdog_core_base::rooms::ids::room_member_session_id("room01", "bench").unwrap();
    let registry = Arc::new(RoomHostRegistry::default());

    // Nothing attached yet: the relay throws before it reaches any room.
    let before = registry.relay(&session, "REPORT: done", options("awake_1", 2), follow()).await;
    assert_eq!(before.err().as_deref(), Some("group rooms run in the desktop app, and no desktop app is attached to this runtime"));

    let attached = registry.register(Arc::new(member_relay));
    let turn = registry.relay(&session, "REPORT: done", options("awake_2", 2), follow()).await.unwrap().expect("a turn");
    assert_eq!(status(turn.settled).await, "done");
    assert_eq!(*runner.seen.lock().unwrap(), vec![(vec!["bench".to_string()], true, 1)]);
    assert_eq!(runner.cut_offs.load(Ordering::SeqCst), 0);

    // The host's own refusals come through the registry unchanged.
    let plain = registry.relay("sess_home_bench", "REPORT", options("awake_3", 0), follow()).await;
    assert_eq!(plain.err().as_deref(), Some("Not a group-room member session."));

    // Detached again: the next relay refuses and reaches no room.
    attached.unregister();
    runner.seen.lock().unwrap().clear();
    let after = registry.relay(&session, "REPORT: done", options("awake_4", 2), follow()).await;
    assert_eq!(after.err().as_deref(), Some(NO_HOST));
    assert!(runner.seen.lock().unwrap().is_empty());
}


