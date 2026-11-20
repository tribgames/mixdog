//! What a user of the Goal runtime observes: the `/goal` command, the duration rules, the time cap,
//! the turn lifecycle, the continuation decision and what survives a restart.
#![allow(clippy::disallowed_methods, reason = "test harness: it lays out and reads back the temp record files outside any lane")]

use std::sync::{Arc, Mutex};

use mixdog_core_goal::goal::session_title::compact_session_title;
use mixdog_core_goal::goal::state::{parse_goal_duration, parse_user_command};
use mixdog_core_goal::goal::text::duration_label;
use mixdog_core_goal::goal::{ContinuationInput, GoalClock, GoalConfig, GoalEnv, GoalRuntime, GoalTimers, Timer, TimerKind};
use serde_json::{Value, json};

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;

fn duration_error(input: Value) -> String {
    parse_goal_duration(&input).unwrap_err().message
}

#[test]
fn durations_accept_units_and_numbers() {
    assert_eq!(parse_goal_duration(&json!("30m")).unwrap(), 30.0 * MINUTE);
    assert_eq!(parse_goal_duration(&json!(" 1H 30M ")).unwrap(), 90.0 * MINUTE);
    assert_eq!(parse_goal_duration(&json!("1.5h")).unwrap(), 90.0 * MINUTE);
    assert_eq!(parse_goal_duration(&json!("2d")).unwrap(), 48.0 * HOUR);
    assert_eq!(parse_goal_duration(&json!(90_000)).unwrap(), 90_000.0);
}

#[test]
fn durations_refuse_what_is_too_short_too_long_or_malformed() {
    assert_eq!(duration_error(json!(0)), "goal duration must be positive");
    assert_eq!(duration_error(json!(-5)), "goal duration must be positive");
    assert_eq!(duration_error(json!("")), "goal duration is required");
    assert!(duration_error(json!("30s")).starts_with("goal duration must be at least 1 minute"));
    assert!(duration_error(json!("soon")).starts_with("goal duration must be at least 1 minute"));
    assert_eq!(duration_error(json!("x30m")), "invalid goal duration: x30m");
    assert_eq!(duration_error(json!("8d")), "goal duration exceeds 7 days");
    assert_eq!(parse_goal_duration(&json!("7d")).unwrap(), 168.0 * HOUR);
}

#[test]
fn a_duration_is_labelled_in_whole_minutes_rounded_up() {
    assert_eq!(duration_label(0.0), "0m");
    assert_eq!(duration_label(1.0), "1m");
    assert_eq!(duration_label(61_000.0), "2m");
    assert_eq!(duration_label(2.0 * HOUR), "2h");
    assert_eq!(duration_label(90.0 * MINUTE), "1h 30m");
    assert_eq!(duration_label(25.0 * HOUR + MINUTE), "1d 1h 1m");
}

#[test]
fn the_goal_command_parses_actions_objective_time_and_replace() {
    let parsed = |text: &str| Value::Object(parse_user_command(text));
    assert_eq!(parsed(""), json!({ "action": "get" }));
    assert_eq!(parsed("Status"), json!({ "action": "get" }));
    assert_eq!(parsed("pause"), json!({ "action": "pause" }));
    assert_eq!(parsed("resume"), json!({ "action": "resume", "duration": null }));
    assert_eq!(parsed("resume 30m"), json!({ "action": "resume", "duration": "30m" }));
    assert_eq!(parsed("edit new words"), json!({ "action": "edit", "objective": "new words" }));
    assert_eq!(parsed("time 2h"), json!({ "action": "time", "duration": "2h" }));
    assert_eq!(parsed("ship the release"), json!({ "action": "create", "objective": "ship the release", "duration": null }));
    assert_eq!(parsed("ship it --time 2h"), json!({ "action": "create", "objective": "ship it", "duration": "2h" }));
    assert_eq!(parsed("--time=45m ship it"), json!({ "action": "create", "objective": "ship it", "duration": "45m" }));
    assert_eq!(
        parsed("--replace=abc123 start over"),
        json!({ "action": "create", "objective": "start over", "duration": null, "replace": true, "expectedGoalId": "abc123" })
    );
}

#[test]
fn a_session_title_is_one_clean_line_clipped_at_a_word() {
    assert_eq!(compact_session_title("  \"Fix the login redirect\".  "), "Fix the login redirect");
    assert_eq!(compact_session_title("<think>planning</think>\nFix login"), "Fix login");
    assert_eq!(compact_session_title(""), "");
    assert_eq!(compact_session_title("Implement the new billing dashboard for enterprise customers"), "Implement the new billing…");
}

struct World {
    now: Mutex<f64>,
    timers: Mutex<Vec<(TimerKind, f64, Option<Box<dyn FnOnce() + Send>>)>>,
}

struct Clock(Arc<World>);

impl GoalClock for Clock {
    fn now(&self) -> f64 {
        *self.0.now.lock().unwrap()
    }
    fn monotonic(&self) -> Option<f64> {
        None
    }
}

struct Timers(Arc<World>);

impl GoalTimers for Timers {
    fn after(&self, kind: TimerKind, delay_ms: f64, callback: Box<dyn FnOnce() + Send>) -> Timer {
        self.0.timers.lock().unwrap().push((kind, delay_ms, Some(callback)));
        Timer::new(|| {})
    }
}

struct Rig {
    world: Arc<World>,
    dir: tempfile::TempDir,
    runtime: GoalRuntime,
}

impl Rig {
    fn new() -> Self {
        let world = Arc::new(World { now: Mutex::new(1_800_000_000_000.0), timers: Mutex::default() });
        let dir = tempfile::tempdir().unwrap();
        let runtime = Self::open(&world, &dir);
        Self { world, dir, runtime }
    }

    fn open(world: &Arc<World>, dir: &tempfile::TempDir) -> GoalRuntime {
        let mut config = GoalConfig::new(dir.path().to_string_lossy().into_owned());
        config.suspend_detectable = false;
        let env = GoalEnv {
            clock: Arc::new(Clock(world.clone())),
            timers: Arc::new(Timers(world.clone())),
            titles: None,
            on_storage_error: Arc::new(|error| panic!("storage error: {}", error.message)),
            lane: mixdog_rt::testing::tokens().durability_io,
        };
        GoalRuntime::new(config, env)
    }

    fn pass(&self, ms: f64) {
        *self.world.now.lock().unwrap() += ms;
    }

    async fn say(&self, request: &str) -> Value {
        let answer = self.runtime.control("s1", json!(request)).await.unwrap();
        self.runtime.settled().await;
        answer
    }

    async fn status(&self) -> String {
        let goal = self.runtime.snapshot("s1").await.unwrap().expect("a goal");
        goal["status"].as_str().unwrap().to_owned()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn creating_a_goal_makes_it_active_with_its_cap_and_reports_the_remaining_time() {
    let rig = Rig::new();
    let answer = rig.say("ship the release --time 2h").await;
    assert_eq!(answer["ok"], json!(true));
    assert_eq!(answer["action"], json!("create"));
    assert_eq!(answer["message"], json!("Goal active · ship the release · 2h remaining"));
    assert_eq!(answer["goal"]["status"], json!("active"));
    assert_eq!(answer["goal"]["timeLimitMs"], json!((2.0 * HOUR) as i64));
    let open_ended = Rig::new().say("tidy up").await;
    assert_eq!(open_ended["message"], json!("Goal active · tidy up · 0m elapsed"));
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pause_stops_the_clock_and_resume_restarts_it() {
    let rig = Rig::new();
    rig.say("write the docs").await;
    rig.pass(10.0 * MINUTE);
    let paused = rig.say("pause").await;
    assert_eq!(paused["message"], json!("Goal paused · write the docs"));
    assert_eq!(paused["goal"]["status"], json!("paused"));
    assert_eq!(paused["goal"]["pauseReason"], json!("user"));
    assert_eq!(paused["goal"]["timeUsedMs"], json!((10.0 * MINUTE) as i64));
    rig.pass(5.0 * HOUR);
    let resumed = rig.say("resume").await;
    assert_eq!(resumed["goal"]["status"], json!("active"));
    assert_eq!(resumed["goal"]["timeUsedMs"], json!((10.0 * MINUTE) as i64), "paused time is not spent");
    rig.pass(5.0 * MINUTE);
    let done = rig.say("complete").await;
    assert_eq!(done["message"], json!("Goal complete · write the docs · 15m elapsed"));
    assert_eq!(done["goal"]["status"], json!("complete"));
    let refused = rig.runtime.control("s1", json!("pause")).await.unwrap_err();
    assert_eq!(refused.message, "a completed Goal cannot be paused; edit it or create a new Goal");
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_naming_another_goal_is_refused_as_stale() {
    let rig = Rig::new();
    rig.say("first").await;
    let stale = rig.runtime.control("s1", json!({ "action": "pause", "expectedGoalId": "no-such-goal" })).await.unwrap_err();
    assert_eq!(stale.message, "stale Goal update rejected because the active Goal changed");
    assert_eq!(rig.status().await, "active");
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_goal_cannot_change_and_clear_removes_the_goal() {
    let rig = Rig::new();
    rig.say("first").await;
    let stopped = rig.say("stop").await;
    assert_eq!(stopped["message"], json!("Goal stopped · first"));
    let refused = rig.runtime.control("s1", json!("resume")).await.unwrap_err();
    assert_eq!(refused.message, "a stopped Goal cannot be changed; create a new Goal");
    let cleared = rig.say("clear").await;
    assert_eq!(cleared["message"], json!("Goal cleared"));
    assert_eq!(rig.say("status").await["message"], json!("No visible Goal for this session"));
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn creating_over_a_stalled_goal_asks_for_a_replace_naming_it() {
    let rig = Rig::new();
    let first = rig.say("first").await;
    let id = first["goal"]["id"].as_str().unwrap().to_owned();
    rig.say("pause").await;
    let asked = rig.say("second").await;
    assert_eq!(asked["ok"], json!(false));
    assert_eq!(asked["code"], json!("goal-replace-required"));
    assert!(asked["message"].as_str().unwrap().contains(&format!("/goal --replace={id}")));
    let replaced = rig.say(&format!("--replace={id} second")).await;
    assert_eq!(replaced["ok"], json!(true));
    assert_eq!(replaced["goal"]["objective"], json!("second"));
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_time_cap_ends_the_goal_when_its_deadline_fires() {
    let rig = Rig::new();
    rig.say("finish quickly --time 1h").await;
    let deadline = {
        let mut timers = rig.world.timers.lock().unwrap();
        let armed = timers.iter_mut().find(|(kind, ..)| *kind == TimerKind::Deadline).expect("a deadline is armed");
        assert_eq!(armed.1, HOUR);
        armed.2.take().unwrap()
    };
    rig.pass(HOUR);
    deadline();
    rig.runtime.settled().await;
    assert_eq!(rig.status().await, "duration_reached");
    let capped = rig.runtime.snapshot("s1").await.unwrap().unwrap();
    assert_eq!(capped["timeUsedMs"], json!((HOUR) as i64));
    let refused = rig.runtime.control("s1", json!("resume")).await.unwrap_err();
    assert!(refused.message.starts_with("Goal time budget is exhausted"), "{}", refused.message);
    let extended = rig.say("resume 30m").await;
    assert_eq!(extended["goal"]["status"], json!("active"));
    assert_eq!(extended["goal"]["timeLimitMs"], json!((HOUR + 30.0 * MINUTE) as i64));
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_settled_turn_moves_the_goal_by_how_it_ended() {
    let rig = Rig::new();
    rig.say("long job").await;

    let started = rig.runtime.start_turn("s1").await.unwrap().unwrap();
    assert_eq!(started["turnCount"], json!(1));

    let cancelled = rig.runtime.settle_turn("s1", json!({ "status": "cancelled" })).await.unwrap().unwrap();
    assert_eq!((cancelled["status"].as_str(), cancelled["pauseReason"].as_str()), (Some("paused"), Some("cancelled")));
    rig.say("resume").await;

    rig.runtime.start_turn("s1").await.unwrap();
    let failed = rig.runtime.settle_turn("s1", json!({ "status": "failed", "error": "disk full" })).await.unwrap().unwrap();
    assert_eq!((failed["status"].as_str(), failed["blocker"].as_str()), (Some("blocked"), Some("disk full")));
    rig.say("resume").await;

    rig.runtime.start_turn("s1").await.unwrap();
    let limited = rig.runtime.settle_turn("s1", json!({ "status": "failed", "usageLimited": true })).await.unwrap().unwrap();
    assert_eq!((limited["status"].as_str(), limited["blocker"].as_str()), (Some("usage_limited"), Some("Provider usage limit reached")));
    let id = limited["id"].as_str().unwrap().to_owned();

    let revived = rig.runtime.reactivate_usage_limited("s1", &id, Default::default()).await.unwrap().unwrap();
    assert_eq!(revived["status"], json!("active"));
    let again = rig.runtime.reactivate_usage_limited("s1", &id, Default::default()).await.unwrap();
    assert!(again.is_none(), "only a goal still waiting on the limit is revived");
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_session_continues_an_active_goal_and_repeats_the_rules_only_after_a_reset() {
    let rig = Rig::new();
    let wait = |awaiting_work| ContinuationInput { awaiting_work, todo: String::new() };

    let none = rig.runtime.continuation("s1", wait(false)).await.unwrap();
    assert_eq!((none.run, none.reason.as_str()), (false, "missing"));

    rig.say("ship it").await;
    let first = rig.runtime.continuation("s1", wait(false)).await.unwrap();
    assert_eq!((first.run, first.reason.as_str()), (true, "idle"));
    let first_prompt = first.prompt.unwrap();
    assert!(first_prompt.contains("ship it") && first_prompt.contains("Rules:"));

    let second = rig.runtime.continuation("s1", wait(false)).await.unwrap().prompt.unwrap();
    assert!(!second.contains("Rules:"), "the rules are delivered once per goal");
    rig.runtime.reset_continuation_rules("s1").unwrap();
    assert!(rig.runtime.continuation("s1", wait(false)).await.unwrap().prompt.unwrap().contains("Rules:"));

    let waiting = rig.runtime.continuation("s1", wait(true)).await.unwrap();
    assert_eq!((waiting.run, waiting.reason.as_str()), (false, "awaiting-work"));

    rig.say("pause").await;
    let paused = rig.runtime.continuation("s1", wait(false)).await.unwrap();
    assert_eq!((paused.run, paused.reason.as_str()), (false, "paused"));
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_automatic_turn_without_a_tool_call_waits_for_the_user() {
    let rig = Rig::new();
    rig.say("ship it").await;
    rig.runtime.start_turn("s1").await.unwrap();
    rig.runtime.settle_turn("s1", json!({ "automatic": true, "toolCalls": 0 })).await.unwrap();
    let held = rig.runtime.continuation("s1", ContinuationInput::default()).await.unwrap();
    assert_eq!((held.run, held.reason.as_str()), (false, "no-progress-wait"));
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_next_user_prompt_retires_a_completed_goal() {
    let rig = Rig::new();
    rig.say("ship it").await;
    rig.say("complete").await;
    assert_eq!(rig.status().await, "complete");
    assert!(rig.runtime.archive_completed_on_user_input("s1").await.unwrap().is_none());
    assert!(rig.runtime.snapshot("s1").await.unwrap().is_none());
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_survives_a_restart_with_the_time_it_had_used() {
    let rig = Rig::new();
    rig.say("ship it --time 2h").await;
    rig.pass(20.0 * MINUTE);
    rig.say("pause").await;
    rig.runtime.close().await;

    let reopened = Rig::open(&rig.world, &rig.dir);
    let goal = reopened.snapshot("s1").await.unwrap().expect("the goal is still there");
    assert_eq!(goal["objective"], json!("ship it"));
    assert_eq!(goal["status"], json!("paused"));
    assert_eq!(goal["timeUsedMs"], json!((20.0 * MINUTE) as i64));
    reopened.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cached_goal_follows_an_on_disk_replacement_and_removal() {
    let rig = Rig::new();
    rig.say("ship it").await;
    assert_eq!(rig.runtime.snapshot("s1").await.unwrap().unwrap()["objective"], json!("ship it"));
    let path = rig.dir.path().join("goals").join("s1.json");
    let mut doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    doc["goal"]["objective"] = json!("swapped by another process");
    std::fs::write(&path, doc.to_string()).unwrap();
    assert_eq!(rig.runtime.snapshot("s1").await.unwrap().unwrap()["objective"], json!("swapped by another process"));
    std::fs::remove_file(&path).unwrap();
    assert_eq!(rig.runtime.snapshot("s1").await.unwrap(), None);
    rig.runtime.close().await;
}

fn on_lane<R: Send + 'static>(job: impl FnOnce(&mixdog_rt::InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> impl std::future::Future<Output = R> {
    use mixdog_rt::LaneToken;
    let done = mixdog_rt::testing::tokens().durability_io.submit(&mixdog_rt::CancellationToken::new(), job).unwrap();
    async move { done.await.unwrap() }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expiry_cleanup_deletes_only_the_record_it_observed() {
    use mixdog_core_goal::goal::storage;
    let rig = Rig::new();
    rig.say("ship it").await;
    let root = rig.dir.path().join("goals");
    let path = root.join("s1.json");
    let observed = storage::file_stamp(&mixdog_fsio::Unlaned, &path).unwrap();
    let delete = |observed: Option<String>| {
        let root = root.clone();
        on_lane(move |lane| storage::delete_if_unchanged(lane, &root, "s1", &observed).unwrap())
    };
    // An active Goal committed in the record's place after the read stays, and so does one that is itself completed and
    // expired: neither is the record that was observed.
    let mut doc: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    doc["goal"]["objective"] = json!("replaced while the cleanup waited");
    std::fs::write(&path, doc.to_string()).unwrap();
    assert!(!delete(observed.clone()).await);
    assert!(path.exists());
    doc["goal"]["status"] = json!("complete");
    doc["goal"]["completedAt"] = json!(1);
    std::fs::write(&path, doc.to_string()).unwrap();
    assert!(!delete(observed).await);
    assert!(path.exists());
    // The record that was observed is the one removed.
    assert!(delete(storage::file_stamp(&mixdog_fsio::Unlaned, &path).unwrap()).await);
    assert!(!path.exists());
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_same_length_replacement_with_the_old_times_changes_the_generation() {
    use mixdog_core_goal::goal::storage;
    let rig = Rig::new();
    rig.say("ship it").await;
    let path = rig.dir.path().join("goals").join("s1.json");
    let before = storage::file_stamp(&mixdog_fsio::Unlaned, &path).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let swap = path.with_extension("swap");
    std::fs::write(&swap, std::fs::read(&path).unwrap()).unwrap();
    std::fs::File::options().write(true).open(&swap).unwrap().set_modified(modified).unwrap();
    std::fs::rename(&swap, &path).unwrap();
    assert_ne!(storage::file_stamp(&mixdog_fsio::Unlaned, &path).unwrap(), before, "identity and change time tell an atomic replacement");
    rig.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_runtime_less_snapshot_removes_an_expired_record_it_read() {
    use mixdog_core_goal::goal::storage;
    let rig = Rig::new();
    rig.say("ship it").await;
    rig.say("complete").await;
    let root = rig.dir.path().join("goals");
    let at = *rig.world.now.lock().unwrap() + 10.0 * HOUR;
    let shown = on_lane({
        let root = root.clone();
        move |lane| storage::stored_goal_snapshot_under(lane, &root, "s1", at, 1.0)
    })
    .await;
    assert_eq!(shown, None);
    assert!(!root.join("s1.json").exists());
    rig.runtime.close().await;
}
