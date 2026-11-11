//! `remote-idle-state-cases`, "an idle session with a running Goal and agent job sends no state frames until content changes":
//! a phone follows an idle thread whose Goal runs and whose agent job streams; over the recorded span (29 route pulses, 2 s
//! apart) the clocks move and the phone receives nothing. Node re-read the session on each pulse and its delta encoder sent no
//! frame when nothing changed; the core publishes a section only when it changed, so the phone's connection is the compared side:
//! for each recorded read, whether the phone received a frame. Then the job's stage changes (a frame), the Goal pauses (a frame),
//! and a later read of the paused Goal sends nothing.

use std::sync::atomic::Ordering;
use std::time::Duration;

use bytes::Bytes;
use mixdog_app_protocol::v2::thread::ThreadAgents;
use mixdog_core_api::FeedSource;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_core_goal::goal::hooks::GoalViewHooks;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::testing::Rig;
use super::tests::idle;
use super::tests::start_thread;
use crate::eventually_on;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/remote-idle-state-cases/golden.json");
const CASE: &str = "an idle session with a running Goal and agent job sends no state frames until content changes";
const TICK: Duration = Duration::from_secs(2);

fn agents(stage: &str) -> ThreadAgents {
    ThreadAgents {
        agent_workers: vec![json!({ "id": "idle-churn-worker", "agent": "worker", "status": "streaming", "stage": stage })],
        agent_jobs: vec![json!({ "task_id": "task-1", "tag": "idle-churn", "status": "running", "stage": stage })],
        ..Default::default()
    }
}

/// The frames the phone received since it last looked, the snapshot's own excluded.
fn received(phone: &MockConnection, sub: &SubscriptionId) -> Vec<Value> {
    phone
        .drain_text()
        .into_iter()
        .filter_map(|text| {
            let (lane, frame) = text.split_once(':').expect("a rendered frame");
            (lane == sub.as_str()).then(|| serde_json::from_str::<Value>(frame).expect("a JSON frame"))
        })
        .filter(|frame| frame["method"] != "thread/snapshot")
        .collect()
}

/// Whether each recorded read delivered a frame, in order: the pulses after the baseline, the stage change, the pause, the
/// paused read later.
fn recorded_pattern(wire: &Exact) -> Vec<bool> {
    let delivered = |value: &Exact| *value.get("delivered") != Exact::Null;
    let mut pattern: Vec<bool> = wire.get("framesAfterBaseline").as_array().iter().map(delivered).collect();
    for read in ["stageChange", "paused", "pausedReadLater"] {
        pattern.push(delivered(wire.get(read)));
    }
    pattern
}

#[tokio::test(start_paused = true)]
async fn an_idle_thread_with_a_running_goal_and_agent_job_sends_the_phone_nothing_until_it_changes() {
    let golden = Exact::decode(&serde_json::from_str(&GOLDEN).expect("golden is JSON")).expect("golden decodes");
    let recorded = golden.get("cases").as_array().iter().find(|case| case.get("case").as_str() == CASE).expect("the case").get("observed").clone();
    let pulses = recorded.get("ticks").as_f64() as usize - 1;

    let rig = Rig::new();
    // The agent job runs: the Goal's continuation waits on it, so the thread stays idle (goal-facade-api.mjs `goalContinuation`).
    rig.work.0.store(true, Ordering::SeqCst);
    *rig.agents.status.lock().unwrap() = agents("streaming");
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    tokio::time::advance(super::actor::STATUS_SETTLE).await;
    let objective = recorded.get("goal").get("objective").as_str().to_owned();
    let limit = recorded.get("goal").get("timeLimitMs").as_f64() as u64;
    rig.goals.goal_control(&handle.id, json!({ "action": "create", "objective": objective, "timeLimitMs": limit })).await.expect("the Goal is created");
    let published = |method: &str| rig.feeds.frames(handle.id.as_str()).iter().any(|(_, m, _)| m == method);
    eventually_on!(&[&rig.feeds.published], || (published("thread/goal/updated") && published("thread/agents/updated")).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    // The phone follows the thread: its snapshot is the baseline.
    let phone = MockConnection::new(ConnectionId(7), MockLimits::default());
    let sub = SubscriptionId::from("phone");
    let source: std::sync::Arc<dyn FeedSource> = handle.clone();
    let attached = mixdog_core_api::feed::subscribe(&source, sub.clone(), Window::LastItems(50), None, &phone).expect("attach");
    phone.send_control_release(Bytes::from_static(b"{}"), attached.release).expect("release");
    let baseline = phone.drain_text_until(|texts| texts.iter().any(|text| text.contains("\"thread/snapshot\""))).await;
    let snapshot: Value = baseline
        .iter()
        .filter_map(|text| text.split_once(':').map(|(_, frame)| serde_json::from_str::<Value>(frame).expect("JSON")))
        .find(|frame| frame["method"] == "thread/snapshot")
        .expect("the snapshot");
    assert_eq!(snapshot["params"]["state"]["goal"]["status"], "active", "the baseline holds the running Goal");
    assert_eq!(snapshot["params"]["state"]["agents"]["agentJobs"][0]["status"], "running", "and the agent job");

    let mut delivered = Vec::new();
    let tick = |rig: &Rig| rig.clock.0.fetch_add(TICK.as_millis() as u64, Ordering::SeqCst);
    for _ in 0..pulses {
        tick(&rig);
        tokio::time::advance(TICK).await;
        tokio::task::yield_now().await;
        delivered.push(!received(&phone, &sub).is_empty());
    }

    tick(&rig);
    *rig.agents.status.lock().unwrap() = agents("tool_running");
    directory.agent_activity(handle.id.as_str());
    let agent_frames = published_count(&rig, &handle.id, "thread/agents/updated");
    eventually_on!(&[&rig.feeds.published], || (published_count(&rig, &handle.id, "thread/agents/updated") > agent_frames).then_some(())).await;
    let stage = received(&phone, &sub);
    delivered.push(stage.iter().any(|frame| frame["method"] == "thread/agents/updated" && frame["params"]["value"]["agentJobs"][0]["stage"] == "tool_running"));

    tick(&rig);
    let goal_frames = published_count(&rig, &handle.id, "thread/goal/updated");
    rig.goals.goal_control(&handle.id, json!({ "action": "pause" })).await.expect("the Goal pauses");
    eventually_on!(&[&rig.feeds.published], || (published_count(&rig, &handle.id, "thread/goal/updated") > goal_frames).then_some(())).await;
    let paused = received(&phone, &sub);
    delivered.push(paused.iter().any(|frame| frame["method"] == "thread/goal/updated" && frame["params"]["value"]["status"] == "paused"));

    tick(&rig);
    tokio::time::advance(TICK).await;
    tokio::task::yield_now().await;
    delivered.push(!received(&phone, &sub).is_empty());

    for wire in recorded.get("wires").as_array() {
        assert_eq!(delivered, recorded_pattern(wire), "compact: {:?}", wire.get("compact"));
    }
}

fn published_count(rig: &Rig, thread: &mixdog_core_api::ids::ThreadId, method: &str) -> usize {
    rig.feeds.frames(thread.as_str()).iter().filter(|(_, m, _)| m == method).count()
}
