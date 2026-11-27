//! The core's end of one helper generation's pipes: a writer thread writes the core's messages in order, a reader thread
//! turns the helper's frames into events. Both report under the generation's number, so the supervisor can fence them. The
//! raw pipes are blocking (a Windows anonymous pipe has no asynchronous I/O), so each end has a thread of its own.

use std::io;
use std::io::BufReader;
use std::io::Write;
use std::sync::mpsc;

use mixdog_graph_host::frame;
use mixdog_graph_host::frame::FrameReader;
use mixdog_spawn::owned::OwnedPipes;
use tokio::sync::mpsc::UnboundedSender;

use crate::wire::FromWorker;
use crate::wire::ToWorker;

pub(crate) enum LinkEvent {
    Message(FromWorker),
    /// The helper's output ended between messages.
    Eof,
    /// The helper's output is not frames of messages, or it could not be read.
    Malformed(String),
    /// A message could not be written to the helper's input.
    WriteFailed(String),
}

pub(crate) type Events = UnboundedSender<(u64, LinkEvent)>;

/// Dropping it closes the helper's input once what was queued is written.
pub(crate) struct Link {
    outbound: mpsc::Sender<Vec<u8>>,
}

impl Link {
    /// An error means no reader thread runs: the reader is started last.
    pub(crate) fn open(generation: u64, pid: u32, pipes: OwnedPipes, events: &Events) -> io::Result<Self> {
        let OwnedPipes { input, output, errors } = pipes;
        std::thread::Builder::new().name("search-host-log".to_owned()).spawn(move || mixdog_graph_host::relay_log("search", pid, errors))?;
        let (outbound, queue) = mpsc::channel::<Vec<u8>>();
        let writer_events = events.clone();
        std::thread::Builder::new().name("search-host-write".to_owned()).spawn(move || {
            if let Err(error) = write_batches(input, &queue) {
                let _ = writer_events.send((generation, LinkEvent::WriteFailed(error.to_string())));
            }
        })?;
        let reader_events = events.clone();
        std::thread::Builder::new().name("search-host-read".to_owned()).spawn(move || {
            let mut reader = FrameReader::new(BufReader::with_capacity(64 * 1024, output));
            loop {
                let event = match reader.read::<FromWorker>() {
                    Ok(Some(message)) => LinkEvent::Message(message),
                    Ok(None) => LinkEvent::Eof,
                    Err(error) => LinkEvent::Malformed(error.to_string()),
                };
                let last = !matches!(event, LinkEvent::Message(_));
                if reader_events.send((generation, event)).is_err() || last {
                    return;
                }
            }
        })?;
        Ok(Self { outbound })
    }

    /// Queues `message` for the helper; false once the writer has ended.
    pub(crate) fn send(&self, message: &ToWorker) -> Result<bool, frame::FrameError> {
        let bytes = frame::encode(message)?;
        Ok(self.outbound.send(bytes).is_ok())
    }
}

/// Writes what `queue` holds, in order, until its senders are gone: the messages waiting when a write starts go in one
/// write, so a stream's items and the core's takes of them do not cost a write each.
pub(crate) fn write_batches(mut sink: impl Write, queue: &mpsc::Receiver<Vec<u8>>) -> io::Result<()> {
    while let Ok(mut batch) = queue.recv() {
        while let Ok(more) = queue.try_recv() {
            batch.extend_from_slice(&more);
        }
        sink.write_all(&batch)?;
        sink.flush()?;
    }
    Ok(())
}
