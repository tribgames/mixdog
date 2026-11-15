//! The socket diagnostics line and the scheduling-lag probe: the four cases of `lib/relay-diagnostics.test.mjs`, on tokio's
//! paused clock (the watch tick is armed through `mixdog_rt::time`, which is tokio's own timer without a replay's clock),
//! and the probe's own window.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use mixdog_relay::diagnostics::{
    DesktopSockets, LagProbe, LagWindow, LoopDelayProbe, PhoneSocket, SOCKET_REPORT_INTERVAL, Snapshot, SocketDiagnostics,
    collect_sockets, start_socket_diagnostics_with, watch_interval,
};
use mixdog_relay::logline::{self, LoopDelay, Stream};

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Clone, Default)]
struct Calls(Arc<Mutex<Vec<&'static str>>>);

struct FakeProbe(Calls);

impl LoopDelayProbe for FakeProbe {
    fn start(&mut self) {
        lock(&(self.0).0).push("start");
    }
    fn stop(&mut self) {
        lock(&(self.0).0).push("stop");
    }
    fn take(&mut self) -> LoopDelay {
        lock(&(self.0).0).push("take");
        LoopDelay { p50: 1.0, p99: 4.25, max: 12.0 }
    }
}

type Live = Arc<Mutex<Vec<DesktopSockets>>>;
type Lines = Arc<Mutex<Vec<String>>>;

fn desktop(id: &str, socket: Option<u64>, phones: &[u64]) -> DesktopSockets {
    DesktopSockets {
        device_id: id.to_owned(),
        socket_attached: socket.is_some(),
        socket_buffered: socket.unwrap_or(0),
        phones: phones
            .iter()
            .enumerate()
            .map(|(index, buffered)| PhoneSocket { client_id: format!("phone-{index}-xxxxxxxx"), buffered: *buffered })
            .collect(),
    }
}

fn desktops(phones: &[u64], desktop_buffered: u64) -> Vec<DesktopSockets> {
    vec![desktop("desktop-id-1", Some(desktop_buffered), phones), desktop("idle-desktop", Some(99), &[])]
}

fn running(live: &Live, calls: &Calls) -> (SocketDiagnostics, Lines) {
    let lines: Lines = Arc::default();
    let sink = Arc::clone(&lines);
    let source = Arc::clone(live);
    let snapshot: Snapshot = Arc::new(move || lock(&source).clone());
    let diagnostics = start_socket_diagnostics_with(
        snapshot,
        SOCKET_REPORT_INTERVAL,
        Box::new(move |line| {
            assert_eq!(line.stream, Stream::Out);
            lock(&sink).push(line.text.clone());
        }),
        Box::new(FakeProbe(calls.clone())),
    );
    (diagnostics, lines)
}

async fn settle() {
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
}

/// `count` watch ticks: each moves the clock 5 s and lets the report task run.
async fn watch_ticks(count: usize) {
    for _ in 0..count {
        tokio::time::advance(Duration::from_secs(5)).await;
        settle().await;
    }
}

fn calls_of(calls: &Calls) -> Vec<&'static str> {
    lock(&calls.0).clone()
}

#[tokio::test(start_paused = true)]
async fn logs_every_interval_while_a_phone_is_connected_with_each_socket_buffer_and_the_loop_delay() {
    let live: Live = Arc::new(Mutex::new(desktops(&[0, 2048], 10)));
    let calls = Calls::default();
    let (_diagnostics, lines) = running(&live, &calls);
    assert_eq!(watch_interval(SOCKET_REPORT_INTERVAL), Duration::from_secs(5), "a cheap watch tick, six of which make one 30s report");
    watch_ticks(5).await;
    assert!(lock(&lines).is_empty(), "nothing is written before the first interval");
    watch_ticks(1).await;
    assert_eq!(lock(&lines).len(), 1);
    watch_ticks(6).await;
    let lines = lock(&lines).clone();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].starts_with("[relay] sockets 30s phones=2 buffered "), "{}", lines[0]);
    assert!(lines[0].contains("phone:phone-1-=2.0KB"), "{}", lines[0]);
    assert!(lines[0].contains("desktop:desktop-=10B"), "{}", lines[0]);
    assert!(lines[0].ends_with("loop-p50=1.0ms loop-p99=4.3ms loop-max=12.0ms"), "{}", lines[0]);
    assert!(!lines[0].contains("idle-des"), "a desktop with no phone is not listed");
}

#[tokio::test(start_paused = true)]
async fn the_lag_probe_runs_only_while_a_pc_or_phone_is_connected() {
    let live: Live = Arc::default();
    let calls = Calls::default();
    let (diagnostics, lines) = running(&live, &calls);
    assert!(calls_of(&calls).is_empty(), "an idle relay starts no probe");
    watch_ticks(20).await;
    assert!(calls_of(&calls).is_empty());
    // A desktop alone is a connection: sampled, but nothing is logged without a phone.
    *lock(&live) = vec![desktop("desktop-id-1", Some(0), &[])];
    watch_ticks(6).await;
    assert_eq!(calls_of(&calls), ["start", "take"]);
    assert!(lock(&lines).is_empty());
    lock(&live)[0].phones.push(PhoneSocket { client_id: "late-phone".into(), buffered: 5 });
    watch_ticks(6).await;
    assert_eq!(lock(&lines).len(), 1);
    assert!(lock(&lines)[0].contains("phones=1 "));
    // The last connection leaves: the probe stops at the next watch tick.
    lock(&live).clear();
    watch_ticks(1).await;
    assert_eq!(calls_of(&calls).last(), Some(&"stop"));
    let stopped = calls_of(&calls).len();
    watch_ticks(20).await;
    assert_eq!(calls_of(&calls).len(), stopped);
    // And starts again for the next one.
    *lock(&live) = vec![desktop("desktop-id-2", Some(0), &[])];
    watch_ticks(1).await;
    assert_eq!(calls_of(&calls).last(), Some(&"start"));
    diagnostics.stop();
    assert_eq!(calls_of(&calls).last(), Some(&"stop"));
}

#[tokio::test(start_paused = true)]
async fn stop_ends_the_watch_tick_and_the_probe() {
    let live: Live = Arc::new(Mutex::new(desktops(&[0], 0)));
    let calls = Calls::default();
    let (diagnostics, lines) = running(&live, &calls);
    watch_ticks(1).await;
    assert_eq!(calls_of(&calls), ["start"]);
    diagnostics.stop();
    assert_eq!(calls_of(&calls).last(), Some(&"stop"));
    let stopped = calls_of(&calls).len();
    watch_ticks(12).await;
    assert_eq!(calls_of(&calls).len(), stopped, "no tick runs after stop");
    assert!(lock(&lines).is_empty());
}

#[test]
fn a_long_socket_list_names_the_largest_and_sums_the_rest() {
    let buffers: Vec<u64> = (0..20).map(|index| index * 100).collect();
    let (phones, sockets) = collect_sockets(&desktops(&buffers, 0));
    assert_eq!(phones, 20);
    let line = logline::sockets_report(phones, &sockets, &LoopDelay { p50: 0.0, p99: 0.0, max: 0.0 }, 30_000).text;
    assert!(line.contains("+9 more="), "{line}");
    assert_eq!(line.split(' ').filter(|part| part.starts_with("phone:")).count(), 12);
    assert!(line.contains("phone:phone-19=1.9KB"), "{line}");
}

#[test]
fn an_id_is_named_by_its_first_eight_utf16_units() {
    let (phones, sockets) = collect_sockets(&[desktop("\u{1F600}\u{1F600}\u{1F600}\u{1F600}x", None, &[7])]);
    assert_eq!(phones, 1);
    assert_eq!(sockets.len(), 2);
    assert_eq!(sockets[0].name, "desktop:\u{1F600}\u{1F600}\u{1F600}\u{1F600}");
    assert_eq!(sockets[0].buffered_bytes, 0.0, "a leg without a socket buffers nothing");
    assert_eq!(sockets[1].name, "phone:phone-0-");
}

#[test]
fn a_window_reports_nearest_rank_percentiles_and_opens_a_fresh_one() {
    let mut window = LagWindow::default();
    assert_eq!(window.take().max, 0.0, "an empty window is zeros");
    for value in (1..=100).rev() {
        window.record(f64::from(value));
    }
    let taken = window.take();
    assert_eq!((taken.p50, taken.p99, taken.max), (50.0, 99.0, 100.0));
    let again = window.take();
    assert_eq!((again.p50, again.p99, again.max), (0.0, 0.0, 0.0));
}

#[tokio::test(start_paused = true)]
async fn the_probe_records_how_late_its_tick_ran() {
    let mut probe = LagProbe::new();
    probe.start();
    probe.start();
    // The 20 ms tick is not served for 50 ms: it runs 30 ms after its due time.
    tokio::time::advance(Duration::from_millis(50)).await;
    settle().await;
    let late = probe.take();
    assert_eq!((late.p50, late.max), (30.0, 30.0));
    probe.stop();
    tokio::time::advance(Duration::from_millis(200)).await;
    settle().await;
    assert_eq!(probe.take().max, 0.0, "a stopped probe records nothing");
}
