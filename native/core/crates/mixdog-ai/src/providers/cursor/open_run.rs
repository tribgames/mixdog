//! A run that handed over a tool batch stays open for its results: the server waits on it, the client keeps its
//! heartbeat going and holds what arrives meanwhile, and the next request of the scope writes the results back on it.
//! The run lives as long as the stream that parked it: dropping that stream, or a newer run of the scope, closes it
//! and lets go of everything it held.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::Weak;
use std::time::Instant;

use bytes::Bytes;
use mixdog_rt::TaskClass;

use super::CLIENT_HEARTBEAT;
use super::decoder::CursorDecoder;
use super::request::MAX_CONNECT_FRAME_BYTES;
use super::request::ModelSelection;
use super::schema::McpToolDefinition;
use super::schema::heartbeat_message;
use crate::providers::connect::frame;
use crate::transport::http::BodyStream;
use crate::transport::http::FrameSink;

/// What a run was opened with: a request that asks for anything else starts a run of its own.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Fingerprint {
    pub selection: ModelSelection,
    pub tools: Vec<McpToolDefinition>,
    pub cloud_rule: Option<String>,
}

/// The wire of an open run.
pub(super) struct Live {
    pub body: Box<dyn BodyStream>,
    pub sink: Arc<dyn FrameSink>,
    pub decoder: CursorDecoder,
    pub heartbeat_at: Instant,
    /// The access token the run was opened with: a server error that echoes it is redacted.
    pub secret: String,
    pub fingerprint: Fingerprint,
    pub conversation_id: String,
    pub original_request_id: String,
}

/// A waiting run that is still open, with what arrived while it waited.
pub(super) type Kept = (Live, VecDeque<Bytes>);

/// A run waiting for the results of the batch it handed over.
pub(super) struct Parked {
    stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    task: Mutex<Option<tokio::task::JoinHandle<Option<Kept>>>>,
}

impl Parked {
    /// Keeps `live` open; `inbox` is what already arrived after the batch.
    pub fn start(live: Live, inbox: VecDeque<Bytes>) -> Arc<Self> {
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let task = mixdog_rt::spawn("ai.cursor.open_run", TaskClass::Work, keep(live, inbox, stopped));
        Arc::new(Self { stop: Mutex::new(Some(stop)), task: Mutex::new(Some(task)) })
    }

    /// The run and what arrived while it waited; `None` when it ended, was cut or passed the bound meanwhile, or was
    /// taken or closed already.
    pub async fn take(&self) -> Option<Kept> {
        let stop = self.stop.lock().unwrap_or_else(PoisonError::into_inner).take()?;
        let task = self.task.lock().unwrap_or_else(PoisonError::into_inner).take()?;
        let _ = stop.send(());
        task.await.ok().flatten()
    }

    /// Ends the run: its request body, its response and everything it held go.
    pub fn close(&self) {
        if let Some(task) = self.task.lock().unwrap_or_else(PoisonError::into_inner).take() {
            task.abort();
        }
    }
}

impl Drop for Parked {
    fn drop(&mut self) {
        self.close();
    }
}

/// Reads the waiting run: KV (`getBlob`/`setBlob`) and server heartbeat frames
/// are answered immediately while other frames remain queued in order, and the
/// client heartbeat goes on. A run that ends, is cut, or exceeds the buffer
/// bound while waiting is closed immediately with everything it held.
async fn keep(mut live: Live, mut inbox: VecDeque<Bytes>, mut stop: tokio::sync::oneshot::Receiver<()>) -> Option<Kept> {
    live.decoder.drain_parked_waiting().ok()?;
    for message in live.decoder.take_outbound() {
        live.sink.send(frame::encode(&message, 0)).ok()?;
    }
    while let Some(bytes) = inbox.pop_front() {
        if live.decoder.buffered_bytes() + bytes.len() > MAX_CONNECT_FRAME_BYTES {
            return None;
        }
        live.decoder.park_feed(&bytes).ok()?;
        for message in live.decoder.take_outbound() {
            live.sink.send(frame::encode(&message, 0)).ok()?;
        }
    }
    loop {
        let beat = mixdog_rt::ticker().wait_until(live.heartbeat_at);
        tokio::pin!(beat);
        tokio::select! {
            biased;
            _ = &mut stop => return Some((live, VecDeque::new())),
            chunk = live.body.next() => match chunk {
                Some(Ok(bytes)) if live.decoder.buffered_bytes() + bytes.len() <= MAX_CONNECT_FRAME_BYTES => {
                    live.decoder.park_feed(&bytes).ok()?;
                    for message in live.decoder.take_outbound() {
                        live.sink.send(frame::encode(&message, 0)).ok()?;
                    }
                }
                _ => return None,
            },
            () = &mut beat => {
                live.sink.send(frame::encode(&heartbeat_message(), 0)).ok()?;
                live.heartbeat_at += CLIENT_HEARTBEAT;
            }
        }
    }
}

/// The waiting run of each scope.
#[derive(Default)]
pub(super) struct Runs(Mutex<HashMap<String, Weak<Parked>>>);

impl Runs {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Weak<Parked>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `parked` is the scope's waiting run; one it replaces is closed.
    pub fn insert(&self, scope: &str, parked: &Arc<Parked>) {
        let prior = {
            let mut all = self.lock();
            all.retain(|_, run| run.strong_count() > 0);
            all.insert(scope.to_owned(), Arc::downgrade(parked))
        };
        if let Some(prior) = prior.and_then(|run| run.upgrade()) {
            prior.close();
        }
    }

    /// The scope's waiting run, which is no longer the scope's.
    pub fn take(&self, scope: &str) -> Option<Arc<Parked>> {
        self.lock().remove(scope).and_then(|run| run.upgrade())
    }

    /// The scope is over: its waiting run is closed.
    pub fn release(&self, scope: &str) {
        if let Some(run) = self.take(scope) {
            run.close();
        }
    }

    #[cfg(test)]
    pub fn waiting(&self) -> usize {
        self.lock().values().filter(|run| run.strong_count() > 0).count()
    }
}
