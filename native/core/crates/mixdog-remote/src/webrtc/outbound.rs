//! The one way a data channel is written: a writer task per channel behind a bounded queue.
//!
//! `DataChannel::send` waits while the peer does not read. Awaited from a connection's event
//! loop it would freeze that loop, and with it every peer failure event. A connection therefore
//! only [`Outbound::push`]es; the writer task alone awaits the channel. The queue is bounded in
//! bytes, and a push past the bound is refused ([`Overflow`]) for the caller to close the
//! connection on.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use bytes::BytesMut;
use mixdog_rt::TaskClass;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use webrtc::data_channel::DataChannel;

pub(crate) enum Frame {
    Binary(BytesMut),
    Text(String),
}

impl Frame {
    fn len(&self) -> usize {
        match self {
            Self::Binary(data) => data.len(),
            Self::Text(text) => text.len(),
        }
    }
}

/// What a writer task writes to. The data channel in production; a stalled peer in tests
/// (`DataChannel` is sealed).
#[async_trait::async_trait]
pub(crate) trait Outlet: Send + Sync + 'static {
    async fn put(&self, frame: Frame) -> Result<(), String>;
    /// Bytes the channel itself still holds.
    async fn pending(&self) -> usize;
}

#[async_trait::async_trait]
impl Outlet for Arc<dyn DataChannel> {
    async fn put(&self, frame: Frame) -> Result<(), String> {
        match frame {
            Frame::Binary(data) => self.send(data).await,
            Frame::Text(text) => self.send_text(&text).await,
        }
        .map_err(|error| error.to_string())
    }

    async fn pending(&self) -> usize {
        self.outstanding_bytes().await.unwrap_or(0)
    }
}

/// The queue is full: the peer is not reading.
#[derive(Debug)]
pub(crate) struct Overflow;

pub(crate) struct Outbound {
    outlet: Arc<dyn Outlet>,
    queue: mpsc::UnboundedSender<Frame>,
    /// Bytes pushed and not yet written, the writer's in-flight frame included.
    queued: Arc<AtomicUsize>,
    cap: usize,
    writer: JoinHandle<()>,
}

impl Outbound {
    /// `failed` runs once, with the error, when a write fails; the writer ends there.
    pub(crate) fn new(
        name: &'static str,
        outlet: Arc<dyn Outlet>,
        cap: usize,
        failed: impl FnOnce(String) + Send + 'static,
    ) -> Self {
        let (queue, mut frames) = mpsc::unbounded_channel::<Frame>();
        let queued = Arc::new(AtomicUsize::new(0));
        let writer = {
            let outlet = Arc::clone(&outlet);
            let queued = Arc::clone(&queued);
            mixdog_rt::spawn(name, TaskClass::Work, async move {
                while let Some(frame) = frames.recv().await {
                    let len = frame.len();
                    let written = outlet.put(frame).await;
                    queued.fetch_sub(len, Ordering::Relaxed);
                    if let Err(error) = written {
                        failed(error);
                        return;
                    }
                }
            })
        };
        Self {
            outlet,
            queue,
            queued,
            cap,
            writer,
        }
    }

    /// Never waits. A frame after the writer ended is dropped: the failure was already reported.
    pub(crate) fn push(&self, frame: Frame) -> Result<(), Overflow> {
        let len = frame.len();
        if self.queued.load(Ordering::Relaxed) + len > self.cap {
            return Err(Overflow);
        }
        self.queued.fetch_add(len, Ordering::Relaxed);
        let _ = self.queue.send(frame);
        Ok(())
    }

    /// The channel's own buffer plus what still waits in the queue.
    pub(crate) async fn buffered(&self) -> usize {
        self.outlet.pending().await + self.queued.load(Ordering::Relaxed)
    }
}

impl Drop for Outbound {
    fn drop(&mut self) {
        self.writer.abort();
    }
}

#[cfg(test)]
pub(crate) mod fakes {
    use super::*;

    /// A peer that never reads: every write waits for ever.
    pub(crate) struct Stalled;

    #[async_trait::async_trait]
    impl Outlet for Stalled {
        async fn put(&self, _frame: Frame) -> Result<(), String> {
            std::future::pending().await
        }

        async fn pending(&self) -> usize {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    use super::fakes::Stalled;
    use super::*;

    fn frame(len: usize) -> Frame {
        Frame::Binary(BytesMut::from(vec![0u8; len].as_slice()))
    }

    #[tokio::test(start_paused = true)]
    async fn a_peer_that_never_reads_cannot_block_the_pusher() {
        mixdog_rt::testing::tokens();
        let outbound = Outbound::new("test-writer", Arc::new(Stalled), 100, |_| {});
        for _ in 0..10 {
            outbound.push(frame(10)).expect("within the bound");
        }
        // Let the writer take its first frame and stall inside the write.
        mixdog_rt::time::sleep(Duration::from_millis(1)).await;
        assert!(outbound.push(frame(1)).is_err(), "past the bound is refused, not waited on");
        assert_eq!(outbound.buffered().await, 100);
    }

    struct Failing;

    #[async_trait::async_trait]
    impl Outlet for Failing {
        async fn put(&self, _frame: Frame) -> Result<(), String> {
            Err("channel closed".to_owned())
        }

        async fn pending(&self) -> usize {
            0
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_write_is_reported_once_and_ends_the_writer() {
        mixdog_rt::testing::tokens();
        let (tx, mut reports) = mpsc::unbounded_channel();
        let outbound = Outbound::new("test-writer", Arc::new(Failing), 100, move |error| {
            let _ = tx.send(error);
        });
        outbound.push(frame(5)).unwrap();
        outbound.push(frame(5)).unwrap();
        assert_eq!(reports.recv().await.as_deref(), Some("channel closed"));
        assert_eq!(reports.recv().await, None, "reported once; the writer's end closes the report");
        assert_eq!(outbound.buffered().await, 5, "the unwritten second frame is still counted");
    }

    struct Held(Arc<AtomicBool>);

    impl Drop for Held {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    struct Pinned {
        entered: Arc<AtomicBool>,
        released: Arc<AtomicBool>,
    }

    #[async_trait::async_trait]
    impl Outlet for Pinned {
        async fn put(&self, _frame: Frame) -> Result<(), String> {
            let _held = Held(Arc::clone(&self.released));
            self.entered.store(true, Ordering::Relaxed);
            std::future::pending().await
        }

        async fn pending(&self) -> usize {
            0
        }
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_outbound_ends_a_writer_stuck_in_a_write() {
        mixdog_rt::testing::tokens();
        let entered = Arc::new(AtomicBool::new(false));
        let released = Arc::new(AtomicBool::new(false));
        let outlet = Pinned {
            entered: Arc::clone(&entered),
            released: Arc::clone(&released),
        };
        let outbound = Outbound::new("test-writer", Arc::new(outlet), 100, |_| {});
        outbound.push(frame(1)).unwrap();
        mixdog_rt::time::sleep(Duration::from_millis(1)).await;
        assert!(entered.load(Ordering::Relaxed));
        assert!(!released.load(Ordering::Relaxed));
        drop(outbound);
        mixdog_rt::time::sleep(Duration::from_millis(1)).await;
        assert!(released.load(Ordering::Relaxed), "the stuck write was dropped");
    }
}
