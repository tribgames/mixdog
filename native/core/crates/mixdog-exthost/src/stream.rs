//! The stream a caller holds for one call.

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::mpsc::UnboundedSender;

use crate::frame;
use crate::shared::CreditRoute;
use crate::shared::Event;

pub(crate) struct CallStream {
    pub(crate) id: u32,
    pub(crate) frames: UnboundedReceiver<ExtFrame>,
    pub(crate) outstanding: Arc<AtomicU64>,
    pub(crate) route: CreditRoute,
    pub(crate) events: UnboundedSender<Event>,
    pub(crate) pending: Arc<AtomicUsize>,
    pub(crate) finished: bool,
}

#[async_trait]
impl EventSource<ExtFrame> for CallStream {
    async fn next(&mut self) -> Option<ExtFrame> {
        if self.finished {
            return None;
        }
        let frame = self.frames.recv().await.unwrap_or_else(|| {
            // The dispatcher is gone; nothing will ever answer this call.
            ExtFrame::Done(Err(ExtError::Unavailable {
                reason: "extension host stopped".to_owned(),
            }))
        });
        match &frame {
            ExtFrame::Chunk(bytes) => {
                // Taking a chunk returns its window to the worker.
                let taken = bytes.len() as u64;
                self.outstanding.fetch_sub(taken, Ordering::AcqRel);
                if let Some(worker) = self.route.get() {
                    let _ = worker.send(frame::credit(self.id, taken as u32));
                }
            }
            ExtFrame::Done(_) => self.finished = true,
        }
        Some(frame)
    }
}

impl Drop for CallStream {
    fn drop(&mut self) {
        self.pending.fetch_sub(1, Ordering::AcqRel);
        if !self.finished {
            let _ = self.events.send(Event::Dropped(self.id));
        }
    }
}
