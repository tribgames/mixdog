//! The core's end of one helper generation's pipes: a writer thread takes encoded requests in order, a reader thread
//! turns the helper's frames into events. Both report under the generation's number, so the supervisor can fence them.
//! The raw pipes are blocking (a Windows anonymous pipe has no asynchronous I/O), so each end has a thread of its own and
//! a build in the helper never holds up a write notice or the observation of its exit.

use std::io;
use std::io::BufReader;
use std::io::Write;
use std::sync::mpsc;

use mixdog_spawn::owned::OwnedPipes;
use tokio::sync::mpsc::UnboundedSender;

use crate::frame::FrameReader;
use crate::wire::FromWorker;

pub(crate) enum LinkEvent {
    Message(FromWorker),
    /// The helper's output ended between messages.
    Eof,
    /// The helper's output is not frames of messages, or it could not be read.
    Malformed(String),
    /// A request could not be written to the helper's input.
    WriteFailed(String),
}

pub(crate) type Events = UnboundedSender<(u64, LinkEvent)>;

pub(crate) struct Client {
    outbound: mpsc::Sender<Vec<u8>>,
}

impl Client {
    /// An error means no reader thread runs: the reader is started last.
    pub(crate) fn open(generation: u64, pipes: OwnedPipes, events: &Events) -> io::Result<Self> {
        let OwnedPipes { mut input, output } = pipes;
        let (outbound, requests) = mpsc::channel::<Vec<u8>>();
        let writer_events = events.clone();
        std::thread::Builder::new().name("graph-host-write".to_owned()).spawn(move || {
            for bytes in requests {
                if let Err(error) = input.write_all(&bytes).and_then(|()| input.flush()) {
                    let _ = writer_events.send((generation, LinkEvent::WriteFailed(error.to_string())));
                    return;
                }
            }
        })?;
        let reader_events = events.clone();
        std::thread::Builder::new().name("graph-host-read".to_owned()).spawn(move || {
            let mut reader = FrameReader::new(BufReader::with_capacity(64 * 1024, output));
            loop {
                let event = match reader.read::<FromWorker>() {
                    Ok(Some(message)) => {
                        #[cfg(feature = "test-support")]
                        crate::testing::reader_window();
                        LinkEvent::Message(message)
                    }
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

    /// Queues `bytes` for the helper's input; false once the writer has ended.
    pub(crate) fn send(&self, bytes: Vec<u8>) -> bool {
        self.outbound.send(bytes).is_ok()
    }
}
