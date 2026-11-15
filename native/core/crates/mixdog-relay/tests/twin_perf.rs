//! Performance comparison of the two relays: the Node relay (`tests/twin/node/relay-host.mjs`) and the Rust relay
//! (`relay_twin_host`) are started one after the other on this machine with the same knobs, plain HTTP on 127.0.0.1, and
//! driven by the same load (`tests/twin_perf/load.rs`). Every scenario runs three times per runtime, the runs alternating
//! between the two, and the medians are compared: the test fails when the Rust relay's latency p50 or p99, delivery time or
//! request rate is more than 5 % worse than Node's, or its peak resident memory is higher than Node's (or past the 800 MiB the
//! deployment's `MemoryMax` allows). The table of both runtimes is printed and written to `$CARGO_TARGET_TMPDIR`.
//!
//! The tests are `#[ignore]`d: a shared runner makes timings meaningless. `README.md` beside the load says how to run them.

#[allow(
    dead_code,
    reason = "the process harness is shared with the twin suite through #[path]; this suite uses part of it and the file stays unedited"
)]
#[path = "twin/proc.rs"]
mod proc;

// The crate root resolves `mod load;` beside itself (tests/load.rs): the load lives in tests/twin_perf/.
#[path = "twin_perf/load.rs"]
mod load;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use load::{Rig, StreamSpec, connect_fleet, percentile};
use mixdog_testkit as testkit;
use proc::{Relay, Runtime};
use serde_json::json;
use tempfile::TempDir;
use tokio::task::JoinSet;

const RUNS: usize = 3;
/// A difference the run cannot resolve is no difference: timing figures under this many microseconds apart are equal.
const RESOLUTION_US: f64 = 50.0;
/// Worse by more than this fraction fails.
const TOLERANCE: f64 = 0.05;
/// `MemoryMax=800M` of `deploy/mixdog-relay.service`.
const MEMORY_ENVELOPE: f64 = 800.0 * 1024.0 * 1024.0;
const WAIT: Duration = Duration::from_secs(120);
const MIB: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Microseconds, lower is better, gated.
    Latency,
    /// Per second, higher is better, gated.
    Rate,
    /// Bytes of the peak resident set, gated against Node's and the deployment envelope.
    Peak,
    /// Printed, not gated.
    Info,
}

#[derive(Debug, Clone)]
struct Figure {
    name: String,
    unit: &'static str,
    kind: Kind,
    value: f64,
}

fn figure(name: impl Into<String>, unit: &'static str, kind: Kind, value: f64) -> Figure {
    Figure { name: name.into(), unit, kind, value }
}

/// p50 and p99 (gated) and the maximum (printed) of a set of latencies in microseconds.
fn latencies(prefix: &str, mut samples: Vec<u64>) -> Vec<Figure> {
    assert!(!samples.is_empty(), "{prefix}: no frame was measured");
    samples.sort_unstable();
    vec![
        figure(format!("{prefix} p50"), "us", Kind::Latency, percentile(&samples, 50.0) as f64),
        figure(format!("{prefix} p99"), "us", Kind::Latency, percentile(&samples, 99.0) as f64),
        figure(format!("{prefix} max"), "us", Kind::Info, percentile(&samples, 100.0) as f64),
    ]
}

struct Setup {
    port: u16,
    pid: u32,
    fleet: load::Fleet,
}

/// One run of one runtime: a fresh data directory holding the paired fleet, the relay started with it, `body` driving the
/// load on a tokio runtime, and the relay's peak resident memory read before it is stopped.
fn with_relay(
    runtime: Runtime,
    phones: &[usize],
    renderer: bool,
    body: impl FnOnce(&Setup, &tokio::runtime::Runtime) -> Vec<Figure>,
) -> Vec<Figure> {
    let dir = TempDir::new().expect("a scratch directory");
    let data = dir.path().join("data");
    let fleet = load::Fleet::new(phones);
    fleet.write_store(&data);
    let mut knobs = json!({ "dataDir": data.to_string_lossy() });
    if renderer {
        let tree = dir.path().join("renderer");
        load::write_renderer(&tree);
        knobs["rendererDir"] = json!(tree.to_string_lossy());
    }
    let relay = Relay::start(runtime, &knobs).unwrap_or_else(|error| panic!("{error}"));
    let pid = load::listener_pid(relay.port).unwrap_or_else(|error| panic!("{error}"));
    let tokio_runtime =
        tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().expect("a tokio runtime");
    let setup = Setup { port: relay.port, pid, fleet };
    let mut figures = body(&setup, &tokio_runtime);
    tokio_runtime.shutdown_timeout(Duration::from_secs(5));
    let after = load::process_figures(pid).unwrap_or_else(|error| panic!("{error}"));
    figures.push(figure("peak resident memory", "B", Kind::Peak, after.peak_rss as f64));
    relay.stop().unwrap_or_else(|error| panic!("{error}"));
    figures
}

fn figures_of(pid: u32) -> load::ProcessFigures {
    load::process_figures(pid).unwrap_or_else(|error| panic!("{error}"))
}

// ---- (1) latency of frames of three sizes, binary and text, one desktop and 32 phones --------------------------------

/// Every phone sends one frame at once; when the desktop has them all it sends one to every phone.
async fn exchange(rig: &Rig, binary: bool, size: usize) {
    let desktop = &rig.desktops[0];
    let (up, down) = (desktop.state.up.count(), rig.shared.down.count());
    for phone in &rig.phones {
        phone.send(binary, size);
    }
    load::until(WAIT, "the phones' frames at the desktop", || desktop.state.up.count() >= up + rig.phones.len())
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    desktop.each(binary, size);
    load::until(WAIT, "the desktop's frames at the phones", || rig.shared.down.count() >= down + rig.phones.len())
        .await
        .unwrap_or_else(|error| panic!("{error}"));
}

fn frame_latency(runtime: Runtime) -> Vec<Figure> {
    with_relay(runtime, &[32], false, |setup, tokio_runtime| {
        tokio_runtime.block_on(async {
            let rig = connect_fleet(setup.port, &setup.fleet, 8).await.unwrap_or_else(|error| panic!("{error}"));
            let mut figures = Vec::new();
            for binary in [true, false] {
                for (label, size, rounds) in [("1 KiB", 1024, 40), ("64 KiB", 64 * 1024, 20), ("1 MiB", MIB, 5)] {
                    for round in 0..=rounds {
                        if round == 1 {
                            // The first round warms the connections and is not measured.
                            rig.shared.down.take();
                            rig.desktops[0].state.up.take();
                        }
                        exchange(&rig, binary, size).await;
                    }
                    let kind = if binary { "binary" } else { "text" };
                    figures.extend(latencies(&format!("{kind} {label} phone->desktop"), rig.desktops[0].state.up.take()));
                    figures.extend(latencies(&format!("{kind} {label} desktop->phone"), rig.shared.down.take()));
                }
            }
            assert_eq!(rig.shared.lost.load(std::sync::atomic::Ordering::SeqCst), 0, "a phone leg was lost");
            figures
        })
    })
}

// ---- (2) 64 MiB frames and a sustained 16 MiB/s stream ---------------------------------------------------------------

fn bulk(runtime: Runtime) -> Vec<Figure> {
    with_relay(runtime, &[1], false, |setup, tokio_runtime| {
        tokio_runtime.block_on(async {
            let rig = connect_fleet(setup.port, &setup.fleet, 1).await.unwrap_or_else(|error| panic!("{error}"));
            let (desktop, phone) = (&rig.desktops[0], &rig.phones[0]);
            let baseline = figures_of(setup.pid).rss;
            let mut figures = Vec::new();

            // The largest frame the 64 MiB policy admits, each way (the desktop's frame carries its 42-byte envelope).
            phone.send(true, 64 * MIB);
            load::until(WAIT, "the 64 MiB frame at the desktop", || desktop.state.up.count() >= 1)
                .await
                .unwrap_or_else(|error| panic!("{error}"));
            figures.push(figure(
                "64 MiB frame phone->desktop time to deliver",
                "us",
                Kind::Latency,
                desktop.state.up.take()[0] as f64,
            ));
            desktop.each(true, 64 * MIB - 64);
            load::until(WAIT, "the 64 MiB frame at the phone", || rig.shared.down.count() >= 1)
                .await
                .unwrap_or_else(|error| panic!("{error}"));
            figures.push(figure(
                "64 MiB frame desktop->phone time to deliver",
                "us",
                Kind::Latency,
                rig.shared.down.take()[0] as f64,
            ));

            // 16 MiB/s for 8 s: 512 frames of 256 KiB, one every 15.625 ms.
            let spec = StreamSpec { binary: true, size: 256 * 1024, frames: 512, period: Duration::from_micros(15_625) };
            let started = Instant::now();
            phone.stream(spec);
            load::until(WAIT, "the stream at the desktop", || desktop.state.up.count() >= spec.frames)
                .await
                .unwrap_or_else(|error| panic!("{error}"));
            figures.push(figure(
                "16 MiB/s stream phone->desktop time to deliver",
                "us",
                Kind::Latency,
                started.elapsed().as_micros() as f64,
            ));
            figures.extend(latencies("16 MiB/s stream phone->desktop frame", desktop.state.up.take()));
            let started = Instant::now();
            desktop.stream(spec);
            load::until(WAIT, "the stream at the phone", || rig.shared.down.count() >= spec.frames)
                .await
                .unwrap_or_else(|error| panic!("{error}"));
            figures.push(figure(
                "16 MiB/s stream desktop->phone time to deliver",
                "us",
                Kind::Latency,
                started.elapsed().as_micros() as f64,
            ));
            figures.extend(latencies("16 MiB/s stream desktop->phone frame", rig.shared.down.take()));

            assert_eq!(rig.shared.lost.load(std::sync::atomic::Ordering::SeqCst), 0, "the phone leg was lost");
            // What the relay held for these frames: the growth of its resident set over the idle one.
            let grown = figures_of(setup.pid).peak_rss.saturating_sub(baseline);
            figures.push(figure("bytes buffered on the relay (peak growth)", "B", Kind::Info, grown as f64));
            figures
        })
    })
}

// ---- (3) 2000 idle phone legs across 64 desktops for 60 s ------------------------------------------------------------

fn idle_fleet(runtime: Runtime) -> Vec<Figure> {
    // 31 or 32 phones per desktop: the relay admits 32 phone legs per desktop.
    let phones: Vec<usize> = (0..64).map(|d| 2000 / 64 + usize::from(d < 2000 % 64)).collect();
    assert_eq!(phones.iter().sum::<usize>(), 2000);
    with_relay(runtime, &phones, false, |setup, tokio_runtime| {
        tokio_runtime.block_on(async {
            let rig = connect_fleet(setup.port, &setup.fleet, 64).await.unwrap_or_else(|error| panic!("{error}"));
            let before = figures_of(setup.pid);
            mixdog_rt::time::sleep(Duration::from_secs(60)).await;
            let after = figures_of(setup.pid);
            assert_eq!(rig.shared.lost.load(std::sync::atomic::Ordering::SeqCst), 0, "a phone leg was lost while idle");
            assert!(
                rig.desktops.iter().all(|desktop| !desktop.state.lost.load(std::sync::atomic::Ordering::SeqCst)),
                "a desktop leg was lost while idle"
            );
            vec![
                figure("resident memory with 2000 legs connected", "B", Kind::Info, before.rss as f64),
                figure("processor time over 60 s idle (heartbeat and sweep)", "ms", Kind::Info, (after.cpu_ms - before.cpu_ms) as f64),
            ]
        })
    })
}

// ---- (4) static serving ------------------------------------------------------------------------------------------------

fn static_serving(runtime: Runtime) -> Vec<Figure> {
    with_relay(runtime, &[1], true, |setup, tokio_runtime| {
        tokio_runtime.block_on(async {
            let (port, id) = (setup.port, setup.fleet.devices[0].id.clone());
            let mut figures = Vec::new();
            for (label, path, least) in [
                ("index.html (br)", format!("/d/{id}/index.html"), 1000),
                ("2 MiB hashed asset (br sibling)", format!("/d/{id}/assets/app-0123456789ab.js"), 600 * 1024),
                ("300 KiB file (gzip live)", format!("/d/{id}/data.json"), 1024),
            ] {
                let job = move |_: usize| {
                    let path = path.clone();
                    async move {
                        let (status, bytes) = load::http_get(port, &path).await?;
                        if status == 200 && bytes >= least {
                            Ok(())
                        } else {
                            Err(format!("GET {path}: status {status}, {bytes} bytes"))
                        }
                    }
                };
                load::pool(50, 8, job.clone()).await.unwrap_or_else(|error| panic!("{error}"));
                let (took, mut times) = load::pool(1000, 16, job).await.unwrap_or_else(|error| panic!("{error}"));
                figures.push(figure(format!("{label} requests per second"), "/s", Kind::Rate, 1000.0 / took.as_secs_f64()));
                times.sort_unstable();
                figures.push(figure(format!("{label} p50"), "us", Kind::Latency, percentile(&times, 50.0) as f64));
                figures.push(figure(format!("{label} p99"), "us", Kind::Latency, percentile(&times, 99.0) as f64));
                figures.push(figure(format!("{label} max"), "us", Kind::Info, percentile(&times, 100.0) as f64));
            }
            figures
        })
    })
}

// ---- (5) /ws upgrades refused with 4005, /hook round trips -----------------------------------------------------------

fn refusals_and_hooks(runtime: Runtime) -> Vec<Figure> {
    with_relay(runtime, &[1], false, |setup, tokio_runtime| {
        tokio_runtime.block_on(async {
            let (port, device) = (setup.port, &setup.fleet.devices[0]);
            let mut figures = Vec::new();

            // The verify-release path: an unpaired /ws upgrade with the relay's own origin completes and is closed 4005.
            // 10 a second for 4 s, under the 60 a minute the relay allows a caller.
            let started = Instant::now();
            let mut attempts = JoinSet::new();
            for attempt in 0..40_u64 {
                mixdog_rt::time::sleep((started + Duration::from_millis(100 * attempt)).saturating_duration_since(Instant::now())).await;
                attempts.spawn(async move {
                    let begun = Instant::now();
                    let code = load::refused_upgrade(port).await?;
                    Ok::<_, String>((code, begun.elapsed().as_micros() as u64))
                });
            }
            let mut refusals = Vec::new();
            while let Some(done) = attempts.join_next().await {
                let (code, micros) = done.expect("a refusal task").unwrap_or_else(|error| panic!("{error}"));
                assert_eq!(code, 4005, "an unpaired /ws upgrade was not closed 4005");
                refusals.push(micros);
            }
            figures.extend(latencies("/ws refused with 4005", refusals));

            // A hook round trip through a hook leg: 100 requests one after another, under the 120 a minute the relay allows.
            let _leg = load::connect_hook(port, device).await.unwrap_or_else(|error| panic!("{error}"));
            let path = format!("/hook/{}/ping", device.id);
            let mut attached = false;
            for _ in 0..40 {
                if load::http_get(port, &path).await.is_ok_and(|(status, _)| status == 200) {
                    attached = true;
                    break;
                }
                mixdog_rt::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(attached, "the hook leg never answered");
            let job = {
                let path = path.clone();
                move |_: usize| {
                    let path = path.clone();
                    async move {
                        match load::http_get(port, &path).await? {
                            (200, _) => Ok(()),
                            (status, _) => Err(format!("GET {path}: status {status}")),
                        }
                    }
                }
            };
            let (took, mut times) = load::pool(100, 1, job).await.unwrap_or_else(|error| panic!("{error}"));
            figures.push(figure("/hook round trips per second", "/s", Kind::Rate, 100.0 / took.as_secs_f64()));
            times.sort_unstable();
            figures.push(figure("/hook round trip p50", "us", Kind::Latency, percentile(&times, 50.0) as f64));
            figures.push(figure("/hook round trip p99", "us", Kind::Latency, percentile(&times, 99.0) as f64));
            figures.push(figure("/hook round trip max", "us", Kind::Info, percentile(&times, 100.0) as f64));
            figures
        })
    })
}

// ---- the comparison --------------------------------------------------------------------------------------------------

struct Row {
    name: String,
    unit: &'static str,
    kind: Kind,
    node: Vec<f64>,
    rust: Vec<f64>,
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 { sorted[middle] } else { (sorted[middle - 1] + sorted[middle]) / 2.0 }
}

/// Why the Rust figure fails against Node's, or `None` when it does not.
fn failure(kind: Kind, node: f64, rust: f64) -> Option<String> {
    match kind {
        Kind::Latency if rust > node * (1.0 + TOLERANCE) && rust - node > RESOLUTION_US => {
            Some(format!("{:.1} % slower", (rust / node - 1.0) * 100.0))
        }
        Kind::Rate if rust < node * (1.0 - TOLERANCE) => Some(format!("{:.1} % lower", (1.0 - rust / node) * 100.0)),
        Kind::Peak if rust > node => Some("more memory than node".to_owned()),
        Kind::Peak if rust > MEMORY_ENVELOPE => Some("past the 800 MiB MemoryMax".to_owned()),
        _ => None,
    }
}

fn shown(unit: &str, value: f64) -> String {
    match unit {
        "us" if value >= 1000.0 => format!("{:.2} ms", value / 1000.0),
        "us" => format!("{value:.0} us"),
        "B" => format!("{:.1} MiB", value / MIB as f64),
        "ms" => format!("{value:.0} ms"),
        _ => format!("{value:.1} {unit}"),
    }
}

/// Runs `run` three times for each runtime, alternating, and compares the medians. Prints the table and fails on a figure
/// that is worse than Node's by more than the tolerance.
fn compare(scenario: &str, run: fn(Runtime) -> Vec<Figure>) {
    let mut rows: Vec<Row> = Vec::new();
    for _ in 0..RUNS {
        for runtime in [Runtime::Node, Runtime::Rust] {
            for (index, figure) in run(runtime).into_iter().enumerate() {
                if rows.len() == index {
                    rows.push(Row { name: figure.name.clone(), unit: figure.unit, kind: figure.kind, node: vec![], rust: vec![] });
                }
                assert_eq!(rows[index].name, figure.name, "{} reported its figures in another order", runtime.name());
                match runtime {
                    Runtime::Node => rows[index].node.push(figure.value),
                    Runtime::Rust => rows[index].rust.push(figure.value),
                }
            }
        }
    }
    let mut table = format!("{scenario} (median of {RUNS} runs)\n{:<62} {:>14} {:>14} {:>9}  verdict\n", "figure", "node", "rust", "rust/node");
    let mut failures = Vec::new();
    for row in &rows {
        let (node, rust) = (median(&row.node), median(&row.rust));
        let verdict = failure(row.kind, node, rust);
        let ratio = if node > 0.0 { format!("{:.2}", rust / node) } else { "-".to_owned() };
        table.push_str(&format!(
            "{:<62} {:>14} {:>14} {:>9}  {}\n",
            row.name,
            shown(row.unit, node),
            shown(row.unit, rust),
            ratio,
            verdict.as_deref().unwrap_or(if row.kind == Kind::Info { "" } else { "ok" })
        ));
        if let Some(reason) = verdict {
            failures.push(format!("{}: {reason}", row.name));
        }
    }
    eprintln!("{table}");
    let out: PathBuf = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("twin_perf-{}.txt", scenario.replace(' ', "-")));
    testkit::create_dir_all(Path::new(env!("CARGO_TARGET_TMPDIR")));
    testkit::write(&out, &table);
    assert!(failures.is_empty(), "the Rust relay is slower or larger than the Node relay:\n{}", failures.join("\n"));
}

#[test]
#[ignore = "slow: performance comparison"]
fn frame_latency_of_one_desktop_and_32_phones() {
    compare("frame latency", frame_latency);
}

#[test]
#[ignore = "slow: performance comparison"]
fn bulk_frames_and_a_sustained_stream() {
    compare("bulk frames", bulk);
}

#[test]
#[ignore = "slow: performance comparison"]
fn idle_phone_legs_across_64_desktops() {
    compare("idle fleet", idle_fleet);
}

#[test]
#[ignore = "slow: performance comparison"]
fn static_serving_of_br_siblings_and_live_gzip() {
    compare("static serving", static_serving);
}

#[test]
#[ignore = "slow: performance comparison"]
fn refused_upgrades_and_hook_round_trips() {
    compare("refusals and hooks", refusals_and_hooks);
}

#[test]
fn the_verdict_is_five_percent_for_timings_and_rates_and_strict_for_memory() {
    assert_eq!(failure(Kind::Latency, 1000.0, 1049.0), None);
    assert!(failure(Kind::Latency, 1000.0, 1051.0).is_some());
    assert_eq!(failure(Kind::Latency, 20.0, 60.0), None, "under the resolution of the measurement");
    assert_eq!(failure(Kind::Rate, 1000.0, 951.0), None);
    assert!(failure(Kind::Rate, 1000.0, 949.0).is_some());
    assert_eq!(failure(Kind::Peak, 100.0, 100.0), None);
    assert!(failure(Kind::Peak, 100.0, 101.0).is_some());
    assert!(failure(Kind::Peak, MEMORY_ENVELOPE + 1.0, MEMORY_ENVELOPE + 1.0).is_some());
    assert_eq!(failure(Kind::Info, 1.0, 100.0), None);
}

#[test]
fn medians_of_odd_and_even_counts() {
    assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
    assert_eq!(median(&[4.0, 1.0, 2.0, 3.0]), 2.5);
}
