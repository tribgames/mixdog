//! RL G5 against the mock core: 50 clients on 10 threads drop at once and reconnect with
//! mixed resume positions while an abort is issued mid-storm.
//!
//! What the server owes the storm is checked here: one `open` per resume, one attach and one
//! response per client, replay and snapshot chosen by the resume position, no snapshot encode
//! for a client that replays, every subscription live in time, and a prompt abort reply.
//! The bounds that need the real core (snapshot cache and cold-load single-flight counts,
//! p95 latencies, poll times, RSS) are measured by WP-BENCH.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use bytes::Bytes;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Feed;
use mixdog_core_api::FeedSource;
use mixdog_core_api::FeedView;
use mixdog_core_api::Reply;
use mixdog_core_api::Subscribe;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::mock::EchoView;
use mixdog_core_api::mock::MockThread;
use mixdog_core_api::mock::epoch;
use mixdog_core_api::mock::event;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use serde_json::Value;
use serde_json::json;

use super::Client;
use super::Rig;
use super::settle;
use super::subscriptions::lanes;

const THREADS: usize = 10;
const CLIENTS: u64 = 50;
/// Events every thread has published when the clients first connect.
const HISTORY: u64 = 8;
/// Events published while the clients are away.
const MISSED: u64 = 4;
const HEAD: u64 = HISTORY + MISSED;

const SUBSCRIPTIONS_LIVE_WITHIN: Duration = Duration::from_secs(2);
const ABORT_REPLY_WITHIN: Duration = Duration::from_millis(50);

/// The echo view, counting the snapshots it is asked to encode.
struct CountingView {
    encodes: Arc<AtomicUsize>,
}

impl FeedView for CountingView {
    fn encode_snapshot(
        &self,
        lane: &InLane<CpuInteractive>,
        at: FeedPosition,
        window: &Window,
    ) -> Bytes {
        self.encodes.fetch_add(1, Ordering::AcqRel);
        EchoView.encode_snapshot(lane, at, window)
    }
}

fn window() -> Value {
    json!({ "lastItems": 10 })
}

/// How a client of `class` resumes, and what the core must answer (`thread/resume` of a thread
/// whose feed is at `HEAD`):
///
/// 0. exactly current: replays nothing;
/// 1. stale, inside the ring: replays what it missed;
/// 2. older, still inside the ring: replays more;
/// 3. a position of another epoch: snapshot;
/// 4. a position ahead of the feed: snapshot.
struct Resume {
    from: Value,
    mode: &'static str,
    start_seq: u64,
    lane_frames: Vec<String>,
}

fn resume(class: usize) -> Resume {
    let position = |epoch: &str, seq: u64| json!({ "epoch": epoch, "seq": seq, "window": window() });
    let current = epoch(2).to_string();
    let replay = |seq: u64| Resume {
        from: position(&current, seq),
        mode: "replay",
        start_seq: seq + 1,
        lane_frames: (seq + 1..=HEAD).map(|n| format!("evt@{n}")).collect(),
    };
    let snapshot = |from: Value| Resume {
        from,
        mode: "snapshot",
        start_seq: HEAD + 1,
        lane_frames: vec![format!("snapshot@{HEAD}")],
    };
    match class {
        0 => replay(HEAD),
        1 => replay(HISTORY),
        2 => replay(3),
        3 => snapshot(position(&epoch(99).to_string(), HISTORY)),
        _ => snapshot(position(&current, HEAD + 28)),
    }
}

/// One client reconnecting: it resumes `thread` from the position of its `class` and checks the
/// answer. Returns the live connection.
async fn reconnect(
    rig: Arc<Rig>,
    n: u64,
    thread: usize,
    class: usize,
    connected: Arc<AtomicUsize>,
) -> Client {
    let client = rig.ready(1_000 + n, json!({}));
    connected.fetch_add(1, Ordering::AcqRel);
    let expected = resume(class);
    client.request(
        1,
        "thread/resume",
        json!({ "threadId": format!("t{thread}"), "window": window(), "resumeFrom": expected.from }),
    );
    let frames = client.frames(1 + expected.lane_frames.len()).await;
    let subscription = &frames[0].body["result"]["subscription"];
    assert_eq!(subscription["mode"], json!(expected.mode), "client {n} class {class}");
    assert_eq!(subscription["startSeq"], json!(expected.start_seq), "client {n} class {class}");
    let mut wanted = vec!["response".to_owned()];
    wanted.extend(expected.lane_frames);
    assert_eq!(lanes(&frames), wanted, "client {n} class {class}");
    client
}

#[tokio::test(start_paused = true)]
async fn g5_reconnect_storm_replays_by_position_loads_once_and_keeps_its_bounds() {
    let rig = Arc::new(Rig::new());
    let mut threads: Vec<Arc<MockThread>> = Vec::new();
    let mut encodes: Vec<Arc<AtomicUsize>> = Vec::new();
    for n in 0..THREADS {
        let id = format!("t{n}");
        let thread = rig.core.mock.directory().insert(ThreadId::from(id.as_str()));
        let feed: Arc<dyn FeedSource> = thread.feed().clone();
        // The thread answers a resume with its feed and the position the client stated.
        thread.set_handler(Arc::new(move |req: &CoreRequest| {
            let resume_from = req.params.get("resumeFrom").map(|position| ResumeFrom {
                position: serde_json::from_value(position.clone()).expect("a feed position"),
                window: Window::LastItems(10),
            });
            Ok(Reply::Subscribe(Subscribe {
                result: json!({}),
                feed: feed.clone(),
                window: Window::LastItems(10),
                resume_from,
            }))
        }));
        let counter = Arc::new(AtomicUsize::new(0));
        let history: Vec<_> = (1..=HISTORY).map(event).collect();
        thread
            .feed()
            .publish(
                &history,
                Some(Arc::new(CountingView {
                    encodes: counter.clone(),
                })),
            )
            .unwrap();
        let handle: Arc<dyn ThreadHandle> = thread.clone();
        rig.core.cold(&id, move || handle.clone());
        threads.push(thread);
        encodes.push(counter);
    }
    threads[0].set_active_turn(Some(TurnId::from("turn1")));

    // First connection: 50 clients, five per thread, no position: each gets a snapshot.
    let mut first = Vec::new();
    for n in 0..CLIENTS {
        let client = rig.ready(n + 1, json!({}));
        client.request(
            1,
            "thread/resume",
            json!({ "threadId": format!("t{}", n as usize % THREADS), "window": window() }),
        );
        first.push(client);
    }
    for client in &first {
        let frames = client.frames(2).await;
        assert_eq!(lanes(&frames), ["response", &format!("snapshot@{HISTORY}")]);
    }
    assert_eq!(rig.core.opens(), CLIENTS as usize, "one open per resume");
    assert_eq!(rig.core.loads(), THREADS, "each thread loaded once");

    // They all drop at once; the threads go on.
    drop(first);
    for thread in &threads {
        assert_eq!(thread.feed().subscribers(), 0, "a dropped connection detaches");
        let missed: Vec<_> = (HISTORY + 1..=HEAD).map(event).collect();
        thread.feed().publish(&missed, None).unwrap();
    }
    assert!(encodes.iter().all(|c| c.load(Ordering::Acquire) == 5));

    // They reconnect at once, each with a position of its class, and an abort lands mid-storm.
    let aborter = rig.ready(9_999, json!({}));
    let connected = Arc::new(AtomicUsize::new(0));
    let storm = Instant::now();
    let tasks: Vec<_> = (0..CLIENTS)
        .map(|n| {
            let (rig, connected) = (rig.clone(), connected.clone());
            let (thread, class) = (n as usize % THREADS, (n as usize / THREADS) % 5);
            tokio::spawn(reconnect(rig, n, thread, class, connected))
        })
        .collect();
    while connected.load(Ordering::Acquire) < CLIENTS as usize / 2 {
        tokio::task::yield_now().await;
    }
    let asked = Instant::now();
    aborter.request(7, "turn/interrupt", json!({ "threadId": "t0", "turnId": "turn1" }));
    let reply = aborter.response(7).await;
    let abort_took = asked.elapsed();
    assert_eq!(reply["result"], json!({ "cancelRequested": true, "turnId": "turn1" }));
    assert!(
        abort_took <= ABORT_REPLY_WITHIN,
        "the abort reply took {abort_took:?} during the storm"
    );

    let mut again = Vec::new();
    for task in tasks {
        again.push(task.await.unwrap());
    }

    // Each client reconnected exactly once and nothing else was sent to it.
    settle().await;
    for client in &again {
        assert!(client.drain().is_empty(), "no duplicate response or frame");
    }
    assert_eq!(rig.core.opens(), 2 * CLIENTS as usize, "one open per resume, still");
    assert_eq!(rig.core.loads(), THREADS, "no thread was loaded twice");
    for (thread, encoded) in threads.iter().zip(&encodes) {
        assert_eq!(thread.feed().subscribers(), 5, "one subscription per client");
        // Five snapshots at the first connection, and only the two clients per thread whose
        // position could not replay needed another.
        assert_eq!(encoded.load(Ordering::Acquire), 5 + 2);
    }

    // Every subscription is live: the next event reaches each client of its thread.
    for thread in &threads {
        thread.feed().publish(&[event(HEAD + 1)], None).unwrap();
    }
    for client in &again {
        assert_eq!(lanes(&client.drain()), [format!("evt@{}", HEAD + 1)]);
    }
    let live_after = storm.elapsed();
    assert!(
        live_after <= SUBSCRIPTIONS_LIVE_WITHIN,
        "subscriptions were live after {live_after:?}"
    );
}
