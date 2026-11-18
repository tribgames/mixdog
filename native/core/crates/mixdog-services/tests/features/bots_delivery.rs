//! The delivery of routine results and task reports into agent home threads: a queue file, a clock, a thread store, a live
//! surface that records wakes and can refuse them, and a retry timer the test fires by hand.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use mixdog_services::bots::delivery::env::{DeliveryConfig, HomeAgent, HomeDirectory, HomeThreads, LiveSlot, Presence, RetryTimer, RoomRelay, ThreadSnapshot, WakeFollow};
use mixdog_services::bots::delivery::home::{AgentHomeDelivery, TaskReport};
use mixdog_services::bots::delivery::queue::{Handoffs, QUEUE_CAPS, RoutineResultQueue};
use mixdog_services::bots::delivery::rows::message_id_of;
use mixdog_services::bots::live::{LiveSurface, WakeOptions, WakeTurn};
use mixdog_services::bots::state_json::StateJson;
use mixdog_services::bots::{DeliveryItem, RoutineKind};
use mixdog_services::scheduler::Clock;
use serde_json::{Value, json};
use tokio::sync::oneshot;

const T0: i64 = 1_800_000_000_000;
const CRITIC: &str = "sess_home_critic";
const LEAD: &str = "sess_home_lead";

struct FixedClock(Mutex<i64>);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(*self.0.lock().unwrap()).unwrap()
    }
}

struct NoHandoffs;
impl Handoffs for NoHandoffs {
    fn note(&self, _: &Value) {}
    fn end(&self, _: &str) {}
}

#[derive(Default)]
struct Ctl {
    busy: bool,
    refuse: u64,
    presence: BTreeMap<String, Presence>,
    home_agents: BTreeMap<String, HomeAgent>,
    mixy_exists: bool,
}

#[derive(Default)]
struct World {
    ctl: Mutex<Ctl>,
    /// Home thread id -> its messages; no entry is a thread that does not exist yet.
    threads: Mutex<BTreeMap<String, Vec<Value>>>,
    wakes: Mutex<Vec<Value>>,
    turns: Mutex<VecDeque<oneshot::Sender<String>>>,
    retries: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
    scheduled: Mutex<Vec<u64>>,
}

struct Threads(Arc<World>);
#[async_trait]
impl HomeThreads for Threads {
    async fn load(&self, id: &str) -> Result<Option<ThreadSnapshot>, String> {
        Ok(self.0.threads.lock().unwrap().get(id).map(|messages| ThreadSnapshot { closed: false, messages: messages.clone() }))
    }
    async fn append(&self, id: &str, rows: Vec<Value>, _: Option<i64>) -> Result<(), String> {
        self.0.threads.lock().unwrap().get_mut(id).ok_or("no thread")?.extend(rows);
        Ok(())
    }
    fn turn_in_flight(&self, _: &str) -> bool {
        self.0.ctl.lock().unwrap().busy
    }
    async fn session_deleted(&self, _: &str) -> bool {
        false
    }
}

struct Directory(Arc<World>);
#[async_trait]
impl HomeDirectory for Directory {
    async fn agent_presence(&self, agent_id: &str) -> Presence {
        self.0.ctl.lock().unwrap().presence.get(agent_id).copied().unwrap_or(Presence::Unknown)
    }
    async fn room_presence(&self, _: &str) -> Presence {
        Presence::Unknown
    }
    async fn home_agent(&self, agent_id: &str) -> HomeAgent {
        self.0.ctl.lock().unwrap().home_agents.get(agent_id).copied().unwrap_or(HomeAgent::Bot)
    }
    async fn mixy_exists(&self) -> bool {
        self.0.ctl.lock().unwrap().mixy_exists
    }
}

struct Live(Arc<World>);
#[async_trait]
impl LiveSurface for Live {
    fn busy(&self, _: &str) -> bool {
        false
    }
    async fn notice(&self, _: &str, _: Value) -> Result<bool, String> {
        Ok(true)
    }
    async fn wake(&self, session_id: &str, prompt: &str, options: WakeOptions) -> Result<Option<WakeTurn>, String> {
        self.0.wakes.lock().unwrap().push(json!({"session": session_id, "prompt": prompt, "id": options.id, "hop": options.hop}));
        {
            let mut ctl = self.0.ctl.lock().unwrap();
            if ctl.refuse > 0 {
                ctl.refuse -= 1;
                return Ok(None);
            }
        }
        let (settle, settled) = oneshot::channel();
        self.0.turns.lock().unwrap().push_back(settle);
        Ok(Some(WakeTurn { settled }))
    }
}

struct NoRooms;
#[async_trait]
impl RoomRelay for NoRooms {
    async fn relay(&self, session_id: &str, _: &str, _: WakeOptions, _: WakeFollow) -> Result<Option<WakeTurn>, String> {
        panic!("no room member here: {session_id}")
    }
}

struct Retries(Arc<World>);
impl RetryTimer for Retries {
    fn arm(&self, delay: Duration, fire: Box<dyn FnOnce() + Send>) {
        self.0.scheduled.lock().unwrap().push(delay.as_millis() as u64);
        self.0.retries.lock().unwrap().push(fire);
    }
}

struct Rig {
    world: Arc<World>,
    clock: Arc<FixedClock>,
    dir: tempfile::TempDir,
    delivery: Arc<AgentHomeDelivery>,
    queue: Arc<RoutineResultQueue>,
}

fn build(world: &Arc<World>, clock: &Arc<FixedClock>, dir: &std::path::Path, with_live: bool) -> (Arc<AgentHomeDelivery>, Arc<RoutineResultQueue>) {
    let state = StateJson::new(dir.join("routine-results.json"), mixdog_rt::testing::tokens().durability_io);
    let queue = Arc::new(RoutineResultQueue::new(state, 200, QUEUE_CAPS, clock.clone(), Arc::new(NoHandoffs)));
    let live = LiveSlot::new();
    if with_live {
        live.set(Some(Arc::new(Live(world.clone()))));
    }
    let delivery = AgentHomeDelivery::new(
        Arc::new(Threads(world.clone())),
        Arc::new(Directory(world.clone())),
        live,
        Arc::new(NoRooms),
        queue.clone(),
        clock.clone(),
        Arc::new(Retries(world.clone())),
        DeliveryConfig::node(),
    );
    (delivery, queue)
}

fn rig() -> Rig {
    let world = Arc::new(World::default());
    world.ctl.lock().unwrap().mixy_exists = true;
    world.threads.lock().unwrap().insert(CRITIC.to_owned(), Vec::new());
    world.threads.lock().unwrap().insert(LEAD.to_owned(), Vec::new());
    let clock = Arc::new(FixedClock(Mutex::new(T0)));
    let dir = tempfile::tempdir().unwrap();
    let (delivery, queue) = build(&world, &clock, dir.path(), true);
    Rig { world, clock, dir, delivery, queue }
}

fn result(run_id: &str) -> DeliveryItem {
    DeliveryItem { run_id: run_id.to_owned(), kind: RoutineKind::Schedule, ok: true, text: format!("output of {run_id}"), run_session_id: None, reason: None, paused: None }
}

fn report(run_id: &str, status: &str) -> TaskReport {
    TaskReport { run_id: run_id.to_owned(), task_session_id: "sess_task_1".to_owned(), title: "Task".to_owned(), status: status.to_owned(), text: "all done".to_owned(), ..TaskReport::default() }
}

impl Rig {
    /// Lets every pass the delivery started (and the ones those started) end.
    async fn quiesce(&self, home: &str) {
        for _ in 0..3 {
            for h in [CRITIC, LEAD] {
                self.delivery.drain(h).wait().await;
            }
            for _ in 0..64 {
                tokio::task::yield_now().await;
            }
        }
        let _ = home;
    }

    /// Lets what is already running finish, without starting another pass (a drain started here would retry before its timer).
    async fn let_run(&self) {
        for _ in 0..256 {
            tokio::task::yield_now().await;
        }
    }

    fn posted(&self, home: &str) -> Vec<String> {
        self.world.threads.lock().unwrap().get(home).map(|m| m.iter().filter_map(|m| m.pointer("/meta/transcript/messageId").and_then(Value::as_str).map(str::to_owned)).collect()).unwrap_or_default()
    }

    async fn queued(&self, home: &str) -> usize {
        self.queue.items(home).await.unwrap().len()
    }

    async fn owes_wake(&self, home: &str) -> bool {
        self.queue.wakes(home).await.unwrap().owes_wake()
    }

    /// Fires every armed retry timer; how many there were.
    fn fire_retries(&self) -> usize {
        let due: Vec<_> = std::mem::take(&mut *self.world.retries.lock().unwrap());
        let n = due.len();
        for fire in due {
            fire();
        }
        n
    }

    async fn settle_turn(&self, status: &str) {
        let turn = self.world.turns.lock().unwrap().pop_front().expect("a wake turn is running");
        turn.send(status.to_owned()).unwrap();
        self.quiesce(CRITIC).await;
    }

    fn wakes(&self) -> Vec<Value> {
        self.world.wakes.lock().unwrap().clone()
    }

    fn scheduled(&self) -> Vec<u64> {
        self.world.scheduled.lock().unwrap().clone()
    }
}

#[tokio::test(start_paused = true)]
async fn results_post_in_the_order_they_were_queued_and_a_replayed_run_is_never_posted_twice() {
    let r = rig();
    assert_eq!(r.delivery.enqueue("critic", "nightly", &result("r1")).await.unwrap(), CRITIC);
    r.delivery.enqueue("critic", "nightly", &result("r2")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert_eq!(r.posted(CRITIC), vec![message_id_of("r1"), message_id_of("r2")]);
    assert_eq!(r.queued(CRITIC).await, 0, "a posted result leaves the queue");
    r.delivery.enqueue("critic", "nightly", &result("r1")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert_eq!(r.posted(CRITIC).len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_result_without_a_run_id_is_refused_and_queues_nothing() {
    let r = rig();
    let refused = r.delivery.enqueue("critic", "nightly", &result("")).await;
    assert_eq!(refused.unwrap_err(), "routine result: runId required");
    assert_eq!(r.queued(CRITIC).await, 0);
}

#[tokio::test(start_paused = true)]
async fn a_busy_thread_keeps_its_results_and_one_retry_waits_a_second_for_all_of_them() {
    let r = rig();
    r.world.ctl.lock().unwrap().busy = true;
    r.delivery.enqueue("critic", "nightly", &result("r1")).await.unwrap();
    r.delivery.enqueue("critic", "nightly", &result("r2")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert!(r.posted(CRITIC).is_empty());
    assert_eq!(r.queued(CRITIC).await, 2);
    assert_eq!(r.scheduled(), vec![1_000], "one timer per home, not one per result");
    r.world.ctl.lock().unwrap().busy = false;
    assert_eq!(r.fire_retries(), 1);
    r.quiesce(CRITIC).await;
    assert_eq!(r.posted(CRITIC), vec![message_id_of("r1"), message_id_of("r2")]);
}

#[tokio::test(start_paused = true)]
async fn a_home_thread_that_does_not_exist_yet_is_waited_for_a_minute_at_a_time() {
    let r = rig();
    r.world.threads.lock().unwrap().remove(CRITIC);
    r.delivery.enqueue("critic", "nightly", &result("r1")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert_eq!((r.queued(CRITIC).await, r.scheduled()), (1, vec![60_000]));
    r.world.threads.lock().unwrap().insert(CRITIC.to_owned(), Vec::new());
    r.fire_retries();
    r.quiesce(CRITIC).await;
    assert_eq!(r.posted(CRITIC), vec![message_id_of("r1")]);
    assert_eq!(r.queued(CRITIC).await, 0);
}

#[tokio::test(start_paused = true)]
async fn the_results_of_an_agent_that_can_never_have_a_chat_are_dropped_not_retried() {
    let r = rig();
    r.world.threads.lock().unwrap().remove(CRITIC);
    r.world.ctl.lock().unwrap().home_agents.insert("critic".into(), HomeAgent::None);
    r.delivery.enqueue("critic", "nightly", &result("r1")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert_eq!((r.queued(CRITIC).await, r.scheduled()), (0, vec![]));
}

#[tokio::test(start_paused = true)]
async fn an_agent_whose_kind_cannot_be_read_keeps_its_results() {
    let r = rig();
    r.world.threads.lock().unwrap().remove(CRITIC);
    r.world.ctl.lock().unwrap().home_agents.insert("critic".into(), HomeAgent::Unknown);
    r.delivery.enqueue("critic", "nightly", &result("r1")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert_eq!((r.queued(CRITIC).await, r.scheduled()), (1, vec![60_000]));
}

#[tokio::test(start_paused = true)]
async fn the_results_of_a_deleted_agent_go_to_mixys_home() {
    let r = rig();
    r.world.ctl.lock().unwrap().presence.insert("critic".into(), Presence::Deleted);
    r.delivery.enqueue("critic", "nightly", &result("r1")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert_eq!((r.posted(CRITIC).len(), r.posted(LEAD)), (0, vec![message_id_of("r1")]));
    assert_eq!((r.queued(CRITIC).await, r.queued(LEAD).await), (0, 0));
}

#[tokio::test(start_paused = true)]
async fn mixys_own_reply_is_posted_once_she_exists_and_dropped_while_she_does_not() {
    let r = rig();
    r.world.ctl.lock().unwrap().mixy_exists = false;
    assert_eq!(r.delivery.enqueue_message("lead", "hb1", "All quiet.").await.unwrap(), LEAD);
    r.quiesce(LEAD).await;
    assert_eq!((r.posted(LEAD).len(), r.queued(LEAD).await), (0, 0), "a heartbeat report for a Mixy never created is dropped");
    r.world.ctl.lock().unwrap().mixy_exists = true;
    r.delivery.enqueue_message("lead", "hb2", "All quiet.").await.unwrap();
    r.quiesce(LEAD).await;
    assert_eq!(r.posted(LEAD), vec![message_id_of("hb2")], "and the dropped one is not posted afterwards");
}

#[tokio::test(start_paused = true)]
async fn an_agent_message_needs_a_run_id_and_text() {
    let r = rig();
    assert!(r.delivery.enqueue_message("critic", "", "text").await.is_err());
    assert!(r.delivery.enqueue_message("critic", "m1", "   ").await.is_err());
}

#[tokio::test(start_paused = true)]
async fn a_finished_task_report_posts_and_wakes_the_agent_once() {
    let r = rig();
    assert_eq!(r.delivery.enqueue_task("critic", &report("t1", "done")).await.unwrap(), CRITIC);
    r.quiesce(CRITIC).await;
    assert_eq!(r.posted(CRITIC), vec![message_id_of("t1")]);
    let wakes = r.wakes();
    assert_eq!(wakes.len(), 1);
    assert_eq!((wakes[0]["session"].as_str(), wakes[0]["hop"].as_u64()), (Some(CRITIC), Some(0)));
    assert!(wakes[0]["prompt"].as_str().is_some_and(|p| !p.is_empty()) && wakes[0]["id"].as_str().is_some_and(|id| !id.is_empty()));
    r.settle_turn("done").await;
    r.delivery.drain(CRITIC).wait().await;
    assert_eq!(r.wakes().len(), 1, "a wake that ended done is not made again");
    assert!(!r.owes_wake(CRITIC).await);
}

#[tokio::test(start_paused = true)]
async fn progress_lines_post_and_wake_nobody() {
    let r = rig();
    for (n, status) in ["started", "working", "blocked"].into_iter().enumerate() {
        r.delivery.enqueue_task("critic", &report(&format!("p{n}"), status)).await.unwrap();
    }
    r.quiesce(CRITIC).await;
    assert_eq!(r.posted(CRITIC).len(), 3);
    assert!(r.wakes().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_task_report_needs_a_run_id_and_a_task_session() {
    let r = rig();
    assert!(r.delivery.enqueue_task("critic", &report("", "done")).await.is_err());
    let mut no_session = report("t1", "done");
    no_session.task_session_id.clear();
    assert!(r.delivery.enqueue_task("critic", &no_session).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn a_refused_wake_is_tried_again_a_minute_later_and_still_owed() {
    let r = rig();
    r.world.ctl.lock().unwrap().refuse = 1;
    r.delivery.enqueue_task("critic", &report("t1", "done")).await.unwrap();
    r.let_run().await;
    assert_eq!((r.wakes().len(), r.scheduled()), (1, vec![60_000]));
    assert!(r.owes_wake(CRITIC).await, "the wake is still owed");
    r.fire_retries();
    r.let_run().await;
    assert_eq!(r.wakes().len(), 2);
    r.settle_turn("done").await;
    assert!(!r.owes_wake(CRITIC).await);
}

#[tokio::test(start_paused = true)]
async fn a_wake_refused_ten_times_is_given_up_with_a_note_in_the_thread() {
    let r = rig();
    r.world.ctl.lock().unwrap().refuse = 1_000;
    r.delivery.enqueue_task("critic", &report("t1", "done")).await.unwrap();
    r.let_run().await;
    while r.fire_retries() > 0 {
        r.let_run().await;
    }
    assert_eq!(r.wakes().len(), 10);
    assert_eq!(r.scheduled(), vec![60_000; 9]);
    assert_eq!(r.posted(CRITIC).len(), 2, "the report and the note that the agent could not be woken");
}

#[tokio::test(start_paused = true)]
async fn a_relay_turn_that_does_not_finish_is_owed_again_after_30_s_2_min_and_10_min_and_then_given_up() {
    let r = rig();
    r.delivery.enqueue_task("critic", &report("t1", "done")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert_eq!(r.wakes().len(), 1);
    for (attempt, delay) in [30_000u64, 120_000, 600_000].into_iter().enumerate() {
        r.settle_turn("failed").await;
        assert_eq!(r.scheduled().last(), Some(&delay), "try {}", attempt + 1);
        assert_eq!(r.wakes().len(), attempt + 1, "nothing is woken before its time");
        *r.clock.0.lock().unwrap() += delay as i64;
        r.fire_retries();
        r.quiesce(CRITIC).await;
        assert_eq!(r.wakes().len(), attempt + 2);
    }
    r.settle_turn("failed").await;
    assert_eq!(r.wakes().len(), 4, "no fifth wake");
    assert_eq!(r.scheduled(), vec![30_000, 120_000, 600_000]);
    assert_eq!(r.posted(CRITIC).len(), 2, "the report and the note that its relay did not finish");
}

#[tokio::test(start_paused = true)]
async fn what_an_earlier_process_left_queued_is_drained_when_the_next_one_recovers() {
    let r = rig();
    r.world.ctl.lock().unwrap().busy = true;
    r.delivery.enqueue("critic", "nightly", &result("r1")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert_eq!(r.queued(CRITIC).await, 1);
    // A restart: a new delivery over the same queue file, and a thread that is idle now.
    r.world.ctl.lock().unwrap().busy = false;
    let (next, _) = build(&r.world, &r.clock, r.dir.path(), true);
    assert_eq!(next.recover().await.unwrap(), vec![CRITIC.to_owned()]);
    next.drain(CRITIC).wait().await;
    for _ in 0..64 {
        tokio::task::yield_now().await;
    }
    assert_eq!(r.posted(CRITIC), vec![message_id_of("r1")]);
}

#[tokio::test(start_paused = true)]
async fn rows_that_wake_nobody_are_posted_before_the_next_turn_takes_its_prompt() {
    let r = rig();
    r.world.ctl.lock().unwrap().busy = true;
    r.delivery.enqueue("critic", "nightly", &result("r1")).await.unwrap();
    r.delivery.enqueue_task("critic", &report("t1", "done")).await.unwrap();
    r.quiesce(CRITIC).await;
    assert!(r.posted(CRITIC).is_empty());
    r.delivery.post_before_agent_turn(CRITIC).await;
    assert_eq!(r.posted(CRITIC), vec![message_id_of("r1")], "the routine result goes first; the report that wakes the agent waits for the drain after the turn");
    assert_eq!(r.queued(CRITIC).await, 1);
    r.delivery.post_before_agent_turn("sess_other_session").await;
    assert_eq!(r.posted("sess_other_session").len(), 0);
}
