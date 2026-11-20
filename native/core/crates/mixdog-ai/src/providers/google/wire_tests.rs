//! The Gemini API's whole request sequence against Node's recording (`fixtures/wire-anthropic-gemini/gemini.json`,
//! recorded by `benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs` from `GeminiProvider.send` with the
//! network replaced by a recorder and time by a virtual queue, at `b6f10295a`): per model family a first turn, a
//! tool-result turn, long, resumed and compacted threads, expired and forked caches, a prefix below the cache floor,
//! and the dated model redirect. Each send's requests (the cache create, the generate call, the delete a superseded
//! cache schedules) are compared with what `GoogleAdapter::attempt` puts on the wire when the recorded answers come
//! back, with the session state the send leaves behind.











/// How long a step of the test may take in real time before it is a failure (nothing here waits on the network).
const STEP: std::time::Duration = std::time::Duration::from_secs(30);


/// The wait's answer, or the failure that names it once the deadline has passed.
async fn answered<T>(what: &str, wait: impl std::future::Future<Output = T>) -> Result<T, String> {
    mixdog_rt::time::timeout(STEP, wait).await.map_err(|_| format!("{what}: no answer within {STEP:?}"))
}

/// A wait nobody answers is still pending 1 ms before its deadline and has failed at it, naming what it waited for.
/// The paused clock moves only by the explicit `advance` here, and the wait is polled by hand.
#[tokio::test(start_paused = true)]
async fn a_wait_nobody_answers_fails_at_its_deadline_naming_it() {
    let mut waiting = Box::pin(answered("the awaited answer", std::future::pending::<()>()));
    assert!(futures::poll!(waiting.as_mut()).is_pending());
    tokio::time::advance(STEP - std::time::Duration::from_millis(1)).await;
    assert!(futures::poll!(waiting.as_mut()).is_pending(), "failed before its deadline");
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    let failure = futures::poll!(waiting.as_mut());
    assert_eq!(failure, std::task::Poll::Ready(Err(format!("the awaited answer: no answer within {STEP:?}"))));
}










