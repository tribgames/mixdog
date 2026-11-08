use std::sync::atomic::AtomicUsize;

use tokio::sync::Notify;

use super::*;

/// An exchange that records what it was asked and settles the calls it answered. The first
/// `holds` runs wait for `release` once they begin.
#[derive(Default)]
pub(crate) struct Fake {
    pub seen: Mutex<Vec<(Vec<String>, bool, usize)>>,
    pub cut_offs: AtomicUsize,
    pub holds: AtomicUsize,
    pub fail: AtomicBool,
    pub entered: Notify,
    pub release: Notify,
}

#[async_trait]
impl CallRunner for Fake {
    async fn run(&self, _: &str, request: &Request, run: &Arc<Run>) -> Result<(), String> {
        self.seen.lock().unwrap().push((request.to.clone(), request.only, run.calls().len()));
        self.entered.notify_one();
        if self.holds.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() {
            self.release.notified().await;
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err("the room could not be saved".into());
        }
        if run.interrupted() {
            return Ok(());
        }
        let status = if run.stopped() { "cancelled" } else { "done" };
        for call in run.calls() {
            call.settle(status);
        }
        Ok(())
    }

    async fn cut_off(&self, _: &str) {
        self.cut_offs.fetch_add(1, Ordering::SeqCst);
    }
}

pub(crate) fn scheduler(runner: &Arc<Fake>) -> Arc<RoomCalls<Fake>> {
    // The scheduler spawns through mixdog_rt, which needs its backend installed.
    mixdog_rt::testing::tokens();
    RoomCalls::new(runner.clone(), Arc::new(|_| {}))
}

pub(crate) async fn status(receiver: oneshot::Receiver<String>) -> String {
    receiver.await.unwrap()
}

fn relay(agent: &str, id: &str) -> (RoomCall, oneshot::Receiver<String>) {
    RoomCall::relay(agent, "REPORT", id, 0, None)
}

#[tokio::test]
async fn a_relay_in_an_idle_room_is_one_exchange_for_that_member_alone() {
    let runner = Arc::new(Fake::default());
    let calls = scheduler(&runner);
    let (call, settled) = relay("bench", "awake_1");
    calls.relay_when_idle("room01", call);
    assert_eq!(status(settled).await, "done");
    assert_eq!(*runner.seen.lock().unwrap(), vec![(vec!["bench".to_string()], true, 1)]);
    assert_eq!(runner.cut_offs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn relays_held_while_the_room_talks_run_after_it_as_one_exchange_each_member_once() {
    let runner = Arc::new(Fake::default());
    runner.holds.store(1, Ordering::SeqCst);
    let calls = scheduler(&runner);
    let (first, first_settled) = relay("bench", "awake_1");
    calls.relay_when_idle("room01", first);
    runner.entered.notified().await;
    let (second, second_settled) = relay("lead", "awake_2");
    let (third, third_settled) = relay("bench", "awake_3");
    calls.relay_when_idle("room01", second);
    calls.relay_when_idle("room01", third);
    assert!(calls.is_running("room01"));
    assert_eq!(runner.cut_offs.load(Ordering::SeqCst), 0, "a relay never cuts a member off");
    runner.release.notify_one();
    assert_eq!(status(first_settled).await, "done");
    assert_eq!(status(second_settled).await, "done");
    assert_eq!(status(third_settled).await, "done");
    assert_eq!(
        *runner.seen.lock().unwrap(),
        vec![(vec!["bench".to_string()], true, 1), (vec!["lead".to_string(), "bench".to_string()], true, 2)]
    );
}

#[tokio::test]
async fn a_request_routed_into_a_running_room_merges_cuts_off_and_carries_the_unsettled_calls() {
    let runner = Arc::new(Fake::default());
    runner.holds.store(1, Ordering::SeqCst);
    let calls = scheduler(&runner);
    let (first, first_settled) = relay("bench", "awake_1");
    calls.relay_when_idle("room01", first);
    runner.entered.notified().await;
    let (a, a_settled) = RoomCall::relay("lead", "ask", "ask_1", 0, None);
    let (b, b_settled) = RoomCall::relay("bench", "ask", "ask_2", 0, None);
    calls.route("room01", Request { to: vec!["lead".into()], waiting: true, everyone: false, only: true, calls: vec![a] });
    calls.route("room01", Request { to: vec!["lead".into(), "bench".into()], waiting: false, everyone: true, only: false, calls: vec![b] });
    runner.release.notify_one();
    assert_eq!(status(first_settled).await, "done");
    assert_eq!(status(a_settled).await, "done");
    assert_eq!(status(b_settled).await, "done");
    // One exchange for the merged request: members in the order named, `only` lost to the second.
    let seen = runner.seen.lock().unwrap().clone();
    assert_eq!(seen[1], (vec!["lead".to_string(), "bench".to_string()], false, 3), "the interrupted turn's call rides on");
    assert!(runner.cut_offs.load(Ordering::SeqCst) >= 1, "the speaking member is cut off");
}

#[tokio::test]
async fn stop_cancels_the_held_relays_the_next_request_and_leaves_the_running_turn_to_the_exchange() {
    let runner = Arc::new(Fake::default());
    runner.holds.store(1, Ordering::SeqCst);
    let calls = scheduler(&runner);
    let (running, running_settled) = relay("bench", "awake_1");
    calls.relay_when_idle("room01", running);
    runner.entered.notified().await;
    let (held, held_settled) = relay("lead", "awake_2");
    calls.relay_when_idle("room01", held);
    let (next, next_settled) = RoomCall::relay("lead", "ask", "ask_1", 0, None);
    calls.route("room01", Request { to: vec!["lead".into()], only: true, calls: vec![next], ..Request::default() });
    assert!(calls.stop("room01"));
    assert_eq!(status(held_settled).await, "cancelled");
    assert_eq!(status(next_settled).await, "cancelled");
    let (late, late_settled) = relay("lead", "awake_3");
    calls.relay_when_idle("room01", late);
    assert_eq!(status(late_settled).await, "cancelled", "a stopping room takes no relay");
    runner.release.notify_one();
    assert_eq!(status(running_settled).await, "cancelled");
    assert_eq!(runner.seen.lock().unwrap().len(), 1, "no one else got a turn");
    assert!(!calls.stop("room01"), "nothing left to stop");
}

#[tokio::test]
async fn relays_held_back_when_a_save_fails_end_failed_with_the_error_and_the_running_turn_goes_on() {
    let runner = Arc::new(Fake::default());
    runner.holds.store(1, Ordering::SeqCst);
    let calls = scheduler(&runner);
    let (running, running_settled) = relay("bench", "awake_1");
    calls.relay_when_idle("room01", running);
    runner.entered.notified().await;
    let (held, held_settled) = relay("lead", "awake_2");
    let seen = held.clone();
    calls.relay_when_idle("room01", held);
    calls.fail_relays("room02", "elsewhere");
    assert!(!seen.is_settled(), "another room's failure touches nothing");
    calls.fail_relays("room01", "disk full");
    assert_eq!(status(held_settled).await, "failed");
    assert_eq!(seen.detail().and_then(|detail| detail.error).as_deref(), Some("disk full"));
    runner.release.notify_one();
    assert_eq!(status(running_settled).await, "done");
    assert_eq!(runner.seen.lock().unwrap().len(), 1, "the failed relay never ran");
}

#[tokio::test]
async fn a_member_that_left_has_what_is_owed_to_it_cancelled() {
    let runner = Arc::new(Fake::default());
    runner.holds.store(1, Ordering::SeqCst);
    let calls = scheduler(&runner);
    let (running, running_settled) = relay("gone", "awake_1");
    calls.relay_when_idle("room01", running);
    runner.entered.notified().await;
    let (held_gone, held_gone_settled) = relay("gone", "awake_2");
    let (held_stays, held_stays_settled) = relay("stays", "awake_3");
    calls.relay_when_idle("room01", held_gone);
    calls.relay_when_idle("room01", held_stays);
    calls.cancel_owed_to("room01", &HashSet::from(["gone".to_string()]));
    assert_eq!(status(held_gone_settled).await, "cancelled");
    assert_eq!(status(running_settled).await, "cancelled");
    runner.release.notify_one();
    assert_eq!(status(held_stays_settled).await, "done");
    assert_eq!(runner.seen.lock().unwrap()[1].0, vec!["stays".to_string()]);
}

#[tokio::test]
async fn an_exchange_that_fails_ends_its_calls_failed_and_the_room_is_free_again() {
    let runner = Arc::new(Fake::default());
    runner.fail.store(true, Ordering::SeqCst);
    let calls = scheduler(&runner);
    let (call, settled) = relay("bench", "awake_1");
    calls.relay_when_idle("room01", call);
    assert_eq!(status(settled).await, "failed");
    runner.fail.store(false, Ordering::SeqCst);
    let (again, again_settled) = relay("bench", "awake_2");
    calls.relay_when_idle("room01", again);
    assert_eq!(status(again_settled).await, "done");
    assert!(!calls.is_running("room01"));
}

#[tokio::test]
async fn a_failed_exchange_is_logged_with_nodes_text_and_ends_so_the_room_runs_again() {
    // Node `start`: `log(`room ${roomId} exchange failed: ${message}`)`, the calls fail, the room is free.
    mixdog_rt::testing::tokens();
    let runner = Arc::new(Fake::default());
    runner.fail.store(true, Ordering::SeqCst);
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = lines.clone();
    let calls = RoomCalls::new(runner.clone(), Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_owned())));
    let (call, settled) = relay("bench", "awake_1");
    calls.relay_when_idle("room01", call);
    assert_eq!(status(settled).await, "failed");
    assert_eq!(*lines.lock().unwrap(), ["room room01 exchange failed: the room could not be saved"]);
    assert!(!calls.is_running("room01"));
    runner.fail.store(false, Ordering::SeqCst);
    let (again, again_settled) = relay("bench", "awake_2");
    calls.relay_when_idle("room01", again);
    assert_eq!(status(again_settled).await, "done");
    assert_eq!(lines.lock().unwrap().len(), 1, "a good exchange logs nothing");
}

#[test]
fn a_call_settles_once() {
    let (call, mut settled) = relay("bench", "awake_1");
    assert!(!call.is_settled());
    call.settle("done");
    call.settle("failed");
    assert!(call.is_settled());
    assert_eq!(settled.try_recv().unwrap(), "done");
}
