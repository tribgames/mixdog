//! A credential read that meets a full io-interactive lane waits for room and reads the file: a busy lane is never
//! answered as an unreadable file. Own test binary: it boots the process-wide executors with a small lane.
#![allow(clippy::disallowed_methods, reason = "test setup: writes the fixture file")]

use std::future::Future;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_ai::oauth::CredentialFile;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::Probe;
use mixdog_rt::Backend;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::PoolParams;
use mixdog_rt::exec::RtConfig;

/// Only detects a hung test.
const WAIT: Duration = Duration::from_secs(60);

fn poll_once<F: Future + Unpin>(rt: &tokio::runtime::Handle, fut: &mut F) -> std::task::Poll<F::Output> {
    rt.block_on(std::future::poll_fn(|cx| std::task::Poll::Ready(std::pin::Pin::new(&mut *fut).poll(cx))))
}

#[test]
fn a_credential_read_waits_out_a_full_lane_and_reads_the_file() {
    let mut config = RtConfig::for_cores(8);
    config.interactive_io = PoolParams::fixed(1, 1, 2);
    let (executors, tokens) = mixdog_rt::exec::boot(config).expect("boot");
    let rt = executors.handle(TaskClass::Work);
    let lane = tokens.interactive_io;
    let never = CancellationToken::new();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("anthropic-oauth-credentials.json");
    std::fs::write(&path, br#"{"claudeAiOauth":{"accessToken":"fixture-token"}}"#).unwrap();
    let file = CredentialFile::new(path, CredentialIo { read: lane, write: tokens.durability_io });

    // The only worker is held and the queue is filled to its bound.
    let (started_tx, started) = mpsc::channel::<()>();
    let (release, gate) = mpsc::channel::<()>();
    let held = lane
        .submit(&never, move |_| {
            started_tx.send(()).unwrap();
            let _ = gate.recv_timeout(WAIT);
        })
        .unwrap();
    started.recv_timeout(WAIT).expect("the held job starts");
    let queued: Vec<_> = (0..2).map(|_| lane.submit(&never, |_| ()).expect("room in the queue")).collect();
    assert!(lane.submit(&never, |_| ()).is_err(), "the lane refuses a plain submission: it is full");

    let mut read = Box::pin(file.load_document());
    assert!(poll_once(&rt, &mut read).is_pending(), "the read waits for room");
    drop(release);
    match rt.block_on(read) {
        Probe::Present(document) => assert!(document.contains_key("claudeAiOauth")),
        other => panic!("a full lane read as {other:?}"),
    }
    rt.block_on(async {
        held.await.unwrap();
        for job in queued {
            job.await.unwrap();
        }
    });
}
