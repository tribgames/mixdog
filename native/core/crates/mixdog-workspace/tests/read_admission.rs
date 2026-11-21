//! A file read asked of an interactive lane that holds its far bound of jobs. Own test binary: it fills a lane of the
//! process-wide executors.
#![allow(clippy::disallowed_methods, reason = "test setup")]

use std::sync::mpsc;
use std::task::Poll;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_rt::Backend;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::PoolParams;
use mixdog_rt::exec::RtConfig;
use mixdog_workspace::localfs::LocalFileService;
use mixdog_workspace::pathguard::canonical;

const WAIT: Duration = Duration::from_secs(60);

/// A read waits its turn behind a lane at its far bound and answers once the lane moves, where a plain submission made
/// at the same moment is refused.
#[test]
fn a_read_waits_its_turn_on_a_lane_that_holds_its_far_bound() {
    let mut config = RtConfig::for_cores(8);
    config.interactive_io = PoolParams { threads: 1, max_threads: 1, room: 1, queue: 2 };
    let (executors, tokens) = mixdog_rt::exec::boot(config).expect("boot");
    let rt = executors.handle(TaskClass::Work);
    let lane = tokens.interactive_io;
    let never = CancellationToken::new();
    let dir = tempfile::tempdir().unwrap();
    let file = canonical(dir.path()).unwrap().join("a.txt");
    std::fs::write(&file, "x").unwrap();
    let file = AbsPath::new(file).unwrap();

    // The lane's one thread is held and two jobs behind it fill the queue.
    let (release, held) = mpsc::channel::<()>();
    let (began, running) = mpsc::channel();
    let first = lane.submit(&never, move |_| {
        began.send(()).unwrap();
        let _ = held.recv();
    });
    assert!(first.is_ok());
    running.recv_timeout(WAIT).unwrap();
    let queued: Vec<_> = (0..2).map(|_| lane.submit(&never, |_| ())).collect();
    assert!(queued.iter().all(Result::is_ok), "the queue takes jobs up to its bound");
    assert!(lane.submit(&never, |_| ()).is_err(), "a plain submission is refused at the bound");

    let files = LocalFileService::new();
    let mut stat = files.stat(lane, file);
    let polled = rt.block_on(std::future::poll_fn(|cx| Poll::Ready(stat.as_mut().poll(cx))));
    assert!(polled.is_pending(), "the read waits for the lane: {polled:?}");
    release.send(()).unwrap();
    let answered = rt.block_on(async { tokio::time::timeout(WAIT, stat).await });
    assert_eq!(answered.expect("the read answers once the lane moves").expect("the file is read").len, 1);
}
