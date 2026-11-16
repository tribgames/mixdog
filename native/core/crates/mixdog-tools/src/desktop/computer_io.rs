//! Filesystem jobs of the Computer Use backend. Production receives the lane token
//! from composition; jobs are awaited and do not inherit action cancellation so an
//! already-started cleanup or diagnostic write finishes before its caller proceeds.
use mixdog_rt::{InteractiveIo, LaneToken};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) async fn run<R: Send + 'static>(io: Option<InteractiveIo>, work: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    // Unit fixtures call the same synchronous file helpers without installing a
    // process-global executor. No production constructor can omit its token.
    #[cfg(test)]
    if io.is_none() { return Ok(work()); }
    let io = io.expect("production computer filesystem work requires its injected IO lane");
    let cancel = CancellationToken::new();
    let job = io.submit_wait(&cancel, move |_| work()).await.map_err(|error| error.to_string())?;
    job.await.map_err(|error| error.to_string())
}

/// Shares a frame with a file job without copying its pixels on the normal path.
/// Cancellation restores the original reply buffer too; only an abandoned future
/// racing an unfinished writer may need a copy to restore its caller's buffer.
pub(super) struct FrameBytes<'a> {
    target: &'a mut Vec<u8>,
    bytes: Option<Arc<Vec<u8>>>,
}
impl<'a> FrameBytes<'a> {
    pub(super) fn new(target: &'a mut Vec<u8>) -> Self {
        let bytes = Some(Arc::new(std::mem::take(target)));
        Self { target, bytes }
    }
    pub(super) fn share(&self) -> Arc<Vec<u8>> { self.bytes.as_ref().expect("frame bytes owned until drop").clone() }
}
impl Drop for FrameBytes<'_> {
    fn drop(&mut self) {
        if let Some(bytes) = self.bytes.take() {
            *self.target = Arc::try_unwrap(bytes).unwrap_or_else(|bytes| (*bytes).clone());
        }
    }
}
