//! The scenarios of the desktop's `connections/link.test.mjs` that cover the machine, on a paused clock: `advance` sleeps on the
//! runtime's clock, which runs every timer that falls inside the span at its own time.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::*;

struct Rig {
    calls: Mutex<Vec<String>>,
    probes: Mutex<Vec<u64>>,
    probe_with: Mutex<Box<dyn FnMut(usize) -> Option<u64> + Send>>,
    stopped: Mutex<Option<LinkFailure>>,
}

impl Rig {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn probes(&self) -> Vec<u64> {
        self.probes.lock().unwrap().clone()
    }

    fn note(&self, call: &str) {
        self.calls.lock().unwrap().push(call.to_string());
    }
}

#[async_trait::async_trait]
impl LinkActions for Rig {
    async fn probe(&self, timeout_ms: u64) -> Option<u64> {
        let count = {
            let mut probes = self.probes.lock().unwrap();
            probes.push(timeout_ms);
            probes.len()
        };
        let mut probe_with = self.probe_with.lock().unwrap();
        probe_with(count)
    }

    fn reset_tunnel(&self) {
        self.note("resetTunnel");
    }

    fn revive_tunnel(&self) {
        self.note("reviveTunnel");
    }

    fn retry_service(&self) {
        self.note("retryService");
    }

    fn stopped_by(&self) -> Option<LinkFailure> {
        self.stopped.lock().unwrap().clone()
    }

    fn hold(&self) {
        self.note("hold");
    }

    fn release(&self) {
        self.note("release");
    }
}

fn fixture(
    grace_ms: u64,
    auto_reconnect: bool,
    probe_with: impl FnMut(usize) -> Option<u64> + Send + 'static,
) -> (LinkMachine, Arc<Rig>) {
    mixdog_rt::testing::tokens();
    let rig = Arc::new(Rig {
        calls: Mutex::default(),
        probes: Mutex::default(),
        probe_with: Mutex::new(Box::new(probe_with)),
        stopped: Mutex::default(),
    });
    let mut options = LinkOptions::new("srv-1", rig.clone(), grace_ms);
    options.auto_reconnect = auto_reconnect;
    (LinkMachine::new(options), rig)
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64) {
    mixdog_rt::time::sleep(Duration::from_millis(ms)).await;
    settle().await;
}

fn view_of(machine: &LinkMachine) -> LinkViewState {
    machine.view().borrow().clone()
}

fn state_of(machine: &LinkMachine) -> LinkState {
    view_of(machine).state
}

/// The attempt and the countdown's end of a reconnecting state.
fn reconnecting(machine: &LinkMachine) -> (u32, Option<u64>) {
    match state_of(machine) {
        LinkState::Reconnecting { attempt, next_retry_at_ms, .. } => (attempt, next_retry_at_ms),
        other => panic!("not reconnecting: {other:?}"),
    }
}

fn lost(terminal: bool, code: &str, message: &str, settings_required: bool) -> LinkState {
    LinkState::Lost { terminal, code: code.into(), message: message.into(), settings_required }
}

fn never(_: usize) -> Option<u64> {
    None
}

#[tokio::test(start_paused = true)]
async fn the_link_state_machine_connected_reconnecting_with_attempt_and_countdown_connected() {
    let (link, rig) = fixture(REMOTE_CLIENT_GRACE_DEFAULT_MS, true, never);
    link.start();
    assert_eq!(state_of(&link), LinkState::Connected);
    link.service_lost();
    let (attempt, next) = reconnecting(&link);
    assert_eq!(attempt, 1);
    assert_eq!(next, Some(link.now_ms() + 1_000), "the first retry is one second out");
    // The attempt runs on time: the probe fails, a dead tunnel child is revived, and the next attempt is scheduled further out.
    advance(1_000).await;
    assert_eq!(rig.calls(), ["reviveTunnel"]);
    let (attempt, next) = reconnecting(&link);
    assert_eq!(attempt, 2);
    assert_eq!(next, Some(link.now_ms() + 2_000));
    // The service re-attaches on its own: connected, nothing pending.
    link.service_restored();
    assert_eq!(state_of(&link), LinkState::Connected);
    assert!(link.inner.lock().attempt_timer.is_none());
    // A terminal failure is lost for good; nothing is attempted.
    link.terminal(LinkFailure { code: "auth".into(), message: "Permission denied".into(), settings_required: true });
    assert_eq!(state_of(&link), lost(true, "auth", "Permission denied", true));
    advance(120_000).await;
    assert!(matches!(state_of(&link), LinkState::Lost { .. }));
    // Reopened (the user's Reconnect): reconnecting again, then attached.
    link.reopening();
    assert_eq!(state_of(&link), LinkState::Reconnecting { attempt: 1, next_retry_at_ms: None, countdown_ms: None });
    link.service_restored();
    assert_eq!(state_of(&link), LinkState::Connected);
}

#[tokio::test(start_paused = true)]
async fn reconnect_now_runs_the_waiting_attempt_at_once_and_keeps_the_backoff_ladder() {
    let (link, rig) = fixture(REMOTE_CLIENT_GRACE_DEFAULT_MS, true, never);
    link.start();
    link.service_lost();
    advance(1_000).await;
    let (attempt, skipped_at) = reconnecting(&link);
    assert_eq!(attempt, 2);
    advance(500).await;
    let probes_before = rig.probes().len();
    link.retry_now();
    settle().await;
    assert_eq!(rig.probes().len(), probes_before + 1, "the attempt ran now");
    assert_eq!(rig.calls(), ["reviveTunnel", "reviveTunnel"]);
    // The ladder moved one step (attempt 3, 4 s) instead of starting over.
    let (attempt, next) = reconnecting(&link);
    assert_eq!(attempt, 3);
    assert_eq!(next, Some(link.now_ms() + 4_000));
    // The skipped countdown never fires on its own.
    advance(skipped_at.unwrap() - link.now_ms()).await;
    assert_eq!(rig.probes().len(), probes_before + 1);

    // Nothing to skip: connected, or lost.
    link.service_restored();
    link.retry_now();
    settle().await;
    assert_eq!(state_of(&link), LinkState::Connected);
    link.terminal(LinkFailure { code: "auth".into(), message: "Permission denied".into(), settings_required: false });
    link.retry_now();
    settle().await;
    assert!(matches!(state_of(&link), LinkState::Lost { .. }));
    assert_eq!(rig.probes().len(), probes_before + 1);
}

#[tokio::test(start_paused = true)]
async fn reconnect_now_keeps_the_outage_start_past_the_server_grace_the_link_is_lost() {
    let grace_ms = 20_000;
    let (link, _rig) = fixture(grace_ms, true, never);
    link.start();
    let lost_at = link.now_ms();
    link.service_lost();
    // Let attempts fail on time until the grace has passed with one countdown still waiting (scheduled before the grace ran out).
    loop {
        let (_, next) = reconnecting(&link);
        let next = next.expect("a countdown is waiting");
        if next > lost_at + grace_ms {
            advance(lost_at + grace_ms - link.now_ms()).await;
            break;
        }
        advance(next - link.now_ms()).await;
    }
    assert!(matches!(state_of(&link), LinkState::Reconnecting { .. }));
    link.retry_now();
    settle().await;
    match state_of(&link) {
        LinkState::Lost { code, .. } => assert_eq!(code, "unreachable"),
        other => panic!("not lost: {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn a_tunnel_stopped_for_good_refused_login_turns_the_attempt_into_a_terminal_loss() {
    let (link, rig) = fixture(REMOTE_CLIENT_GRACE_DEFAULT_MS, true, never);
    link.start();
    link.service_lost();
    advance(1_000).await;
    assert!(matches!(state_of(&link), LinkState::Reconnecting { .. }));
    *rig.stopped.lock().unwrap() = Some(LinkFailure {
        code: "auth".into(),
        message: "Permission denied (publickey).".into(),
        settings_required: true,
    });
    advance(2_000).await;
    assert_eq!(state_of(&link), lost(true, "auth", "Permission denied (publickey).", true));
    assert_eq!(rig.calls(), ["reviveTunnel"], "nothing is dialed after the refusal");
}

#[tokio::test(start_paused = true)]
async fn with_automatic_reconnection_off_a_drop_is_lost_at_once_only_reconnect_dials() {
    let reachable = Arc::new(AtomicBool::new(false));
    let probe_reachable = reachable.clone();
    let (link, rig) = fixture(REMOTE_CLIENT_GRACE_DEFAULT_MS, false, move |_| probe_reachable.load(Ordering::SeqCst).then_some(6));
    link.start();
    link.service_lost();
    assert_eq!(
        state_of(&link),
        lost(false, "auto-reconnect-off", "Automatic reconnection is off for this server.", false)
    );
    assert_eq!(rig.calls(), ["hold"], "dials are refused until the user reconnects");
    advance(5 * 60_000).await;
    assert_eq!(rig.calls(), ["hold"], "nothing is attempted on its own");
    // The user's Reconnect: dials allowed, the tunnel and service try once.
    reachable.store(false, Ordering::SeqCst);
    link.retry();
    settle().await;
    assert_eq!(rig.calls(), ["hold", "release", "reviveTunnel", "retryService"]);
    assert!(matches!(state_of(&link), LinkState::Reconnecting { .. }));
    link.service_restored();
    assert_eq!(state_of(&link), LinkState::Connected);
    // Health failures do not replace the tunnel either.
    advance(HEALTH_INTERVAL_MS * FAILURES_TO_REPLACE as u64).await;
    assert!(!rig.calls().iter().any(|call| call == "resetTunnel"));
    assert!(matches!(state_of(&link), LinkState::Lost { .. }));
}

#[tokio::test(start_paused = true)]
async fn a_reachable_daemon_behind_a_dropped_service_makes_the_client_retry_now() {
    let (link, rig) = fixture(REMOTE_CLIENT_GRACE_DEFAULT_MS, true, |_| Some(12));
    link.start();
    link.service_lost();
    advance(1_000).await;
    assert_eq!(rig.calls(), ["retryService"]);
    assert_eq!(view_of(&link).rtt_ms, Some(12));
    assert!(matches!(state_of(&link), LinkState::Reconnecting { .. }), "connected only once the service is back");
}

#[tokio::test(start_paused = true)]
async fn backoff_is_capped_inside_the_server_grace_window_and_starts_over_after_60_s_healthy() {
    assert_eq!(remote_client_grace_ms(Some("")), REMOTE_CLIENT_GRACE_DEFAULT_MS);
    assert_eq!(remote_client_grace_ms(None), REMOTE_CLIENT_GRACE_DEFAULT_MS);
    assert_eq!(remote_client_grace_ms(Some("400")), 400);
    assert_eq!(host_grace_ms(Some(2.5)), Some(150_000));
    assert_eq!(host_grace_ms(Some(0.0)), None);
    assert_eq!(host_grace_ms(None), None);
    assert_eq!(reconnect_delay_cap_ms(REMOTE_CLIENT_GRACE_DEFAULT_MS), RECONNECT_MAX_DELAY_MS);
    // A short grace still fits several attempts.
    assert_eq!(reconnect_delay_cap_ms(60_000), 10_000);
    assert!(reconnect_delay_cap_ms(60_000) * 6 <= 60_000);

    let mut ladder = ReconnectLadder::new(reconnect_delay_cap_ms(REMOTE_CLIENT_GRACE_DEFAULT_MS));
    let delays: Vec<u64> = (0..10).map(|_| ladder.next(0).1).collect();
    assert_eq!(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
    // Flapping (healthy less than 60 s) keeps climbing; a stable link resets.
    ladder.mark_healthy(100_000);
    assert_eq!(ladder.next(100_000 + STABLE_RESET_MS - 1).0, 11);
    ladder.mark_healthy(200_000);
    assert_eq!(ladder.next(200_000 + STABLE_RESET_MS), (1, 1_000));

    // Past the grace the link is lost (not terminal): the countdown stops.
    let (link, _rig) = fixture(20_000, true, never);
    link.start();
    link.service_lost();
    advance(25_000).await;
    match state_of(&link) {
        LinkState::Lost { terminal, code, .. } => {
            assert!(!terminal);
            assert_eq!(code, "unreachable");
        }
        other => panic!("not lost: {other:?}"),
    }
    // The user's Reconnect starts counting again.
    link.retry();
    settle().await;
    assert!(matches!(state_of(&link), LinkState::Reconnecting { .. }));
}

#[tokio::test(start_paused = true)]
async fn sleep_pauses_the_link_resume_probes_twice_before_touching_the_tunnel() {
    // A live link after sleep: two probes at most, nothing restarted.
    let mut answers = VecDeque::from([None, Some(9)]);
    let (link, rig) = fixture(REMOTE_CLIENT_GRACE_DEFAULT_MS, true, move |_| answers.pop_front().unwrap_or(Some(9)));
    link.start();
    link.suspend();
    assert_eq!(state_of(&link), LinkState::Paused);
    advance(5 * HEALTH_INTERVAL_MS).await;
    assert!(rig.probes().is_empty(), "no probes while asleep");
    link.resume().await;
    assert_eq!(rig.probes(), [HEALTH_TIMEOUT_MS, HEALTH_TIMEOUT_MS]);
    assert!(rig.calls().is_empty(), "a live link is never torn down");
    assert_eq!(state_of(&link), LinkState::Connected);
    assert_eq!(view_of(&link).rtt_ms, Some(9));

    // A dead link after sleep: the ssh child is replaced, the backoff starts over.
    let (dead, rig) = fixture(REMOTE_CLIENT_GRACE_DEFAULT_MS, true, never);
    dead.start();
    dead.service_lost();
    advance(1_000 + 2_000 + 4_000).await;
    assert_eq!(reconnecting(&dead).0, 4);
    dead.suspend();
    assert_eq!(state_of(&dead), LinkState::Paused);
    rig.calls.lock().unwrap().clear();
    dead.resume().await;
    assert_eq!(rig.calls(), ["resetTunnel"]);
    assert_eq!(reconnecting(&dead).0, 1, "backoff reset");
}

#[tokio::test(start_paused = true)]
async fn health_probe_every_15_s_three_failures_inside_60_s_reset_the_tunnel() {
    let healthy = Arc::new(AtomicBool::new(true));
    let probe_healthy = healthy.clone();
    let (link, rig) = fixture(REMOTE_CLIENT_GRACE_DEFAULT_MS, true, move |_| probe_healthy.load(Ordering::SeqCst).then_some(7));
    link.start();
    advance(HEALTH_INTERVAL_MS).await;
    assert_eq!(rig.probes().len(), 1);
    assert_eq!(view_of(&link).rtt_ms, Some(7), "the round trip reaches the window");
    healthy.store(false, Ordering::SeqCst);
    advance(HEALTH_INTERVAL_MS * (FAILURES_TO_REPLACE as u64 - 1)).await;
    assert!(rig.calls().is_empty(), "two failures are tolerated");
    assert_eq!(state_of(&link), LinkState::Connected);
    advance(HEALTH_INTERVAL_MS).await;
    assert_eq!(rig.calls(), ["resetTunnel"]);
    assert!(matches!(state_of(&link), LinkState::Reconnecting { .. }));
    // Probes recover: connected (the service never dropped).
    healthy.store(true, Ordering::SeqCst);
    advance(1_000).await;
    assert_eq!(state_of(&link), LinkState::Connected);

    // Failures spread wider than 60 s never add up.
    let (spread, rig) = fixture(REMOTE_CLIENT_GRACE_DEFAULT_MS, true, |count| if count % 3 == 0 { None } else { Some(5) });
    spread.start();
    advance(HEALTH_INTERVAL_MS * 12).await;
    assert!(rig.calls().is_empty());
}
