//! The helper's side of the wire: [`serve`] runs each walk and text search the core sends on this process's engine
//! (`mixdog_workspace::localfs`, [`served_walk`], [`served_search`]) and streams its items back as they are found.
//!
//! A thread reads the input and a thread writes the output. Each stream is handed on by a task of its own on the caller's
//! thread: it sends an item as the engine gives it, gives the item's room in the engine's queue back when the core says its
//! consumer took it, and closes or lets go of the stream when the core says so; the engine's producers run on threads of
//! their own, admitted by its one scheduler, as they would in the core. At the input's end every stream is let go of and
//! the helper exits. Nothing else may write to the output: a byte outside a frame ends the helper's generation.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::collections::hash_map::Entry;
use std::future::Future;
use std::io;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::sync::mpsc;
use std::time::Instant;

use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::SearchMatch;
use mixdog_graph_host::frame;
use mixdog_graph_host::frame::FrameReader;
use mixdog_spawn::owned::hold_to_parent;
use mixdog_workspace::localfs::Room;
use mixdog_workspace::localfs::Served;
use mixdog_workspace::localfs::served_search;
use mixdog_workspace::localfs::served_walk;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::mpsc::unbounded_channel;

use crate::link::write_batches;
use crate::wire::Failure;
use crate::wire::FromWorker;
use crate::wire::Item;
use crate::wire::PROTOCOL_VERSION;
use crate::wire::Ready;
use crate::wire::StreamId;
use crate::wire::ToWorker;

/// The core closed the helper's input.
pub const EXIT_DONE: i32 = 0;
/// The helper could not start its runtime or a thread.
pub const EXIT_FAILED: i32 = 1;
/// The input was not a frame of a message, or a message named a stream it could not.
pub const EXIT_MALFORMED: i32 = 2;
/// The helper could not hold to its owner ([`hold_to_parent`]), so it never served.
pub const EXIT_UNCONTAINED: i32 = 3;

/// The helper process: holds to its owner, then serves over the standard pipes. Answers the process's exit code.
pub fn serve_stdio() -> i32 {
    if hold_to_parent().is_err() {
        return EXIT_UNCONTAINED;
    }
    mixdog_graph_host::worker::log_to_stderr();
    serve(io::stdin(), io::stdout())
}

/// Announces [`Ready`] on `output`, then serves the streams `input` asks for until the input ends. Answers the exit code.
/// A producer still in a call nothing could cancel is the process's to end.
pub fn serve(input: impl Read + Send + 'static, output: impl Write + Send + 'static) -> i32 {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_time().build() else { return EXIT_FAILED };
    let (outbound, queue) = mpsc::channel::<Vec<u8>>();
    let out = Output(outbound);
    out.send(&FromWorker::Ready { ready: Ready { version: PROTOCOL_VERSION, pid: std::process::id() } });
    // A write that fails ends the writer: the core is gone, and its end of the input follows.
    let writer = std::thread::Builder::new().name("search-worker-write".to_owned()).spawn(move || write_batches(output, &queue));
    let (inbound, received) = unbounded_channel();
    let reader = std::thread::Builder::new().name("search-worker-read".to_owned()).spawn(move || read(input, &inbound));
    if writer.is_err() || reader.is_err() {
        return EXIT_FAILED;
    }
    let code = runtime.block_on(dispatch(received, out));
    // Every stream's task is dropped with the runtime, and its producer let go of with it.
    runtime.shutdown_background();
    code
}

#[allow(clippy::large_enum_variant, reason = "one frame decoded and matched at once")]
enum Inbound {
    Message(ToWorker),
    Malformed,
}

fn read(input: impl Read, inbound: &UnboundedSender<Inbound>) {
    let mut reader = FrameReader::new(BufReader::with_capacity(64 * 1024, input));
    loop {
        let message = match reader.read::<ToWorker>() {
            Ok(Some(message)) => Inbound::Message(message),
            Ok(None) => return,
            Err(_) => Inbound::Malformed,
        };
        let last = matches!(message, Inbound::Malformed);
        if inbound.send(message).is_err() || last {
            return;
        }
    }
}

/// What the core says of a stream, to its task.
enum Said {
    Taken(u32),
    Close,
}

async fn dispatch(mut inbound: UnboundedReceiver<Inbound>, out: Output) -> i32 {
    // A stream's entry goes at its close or release: dropping its sender lets go of the stream.
    let mut streams: HashMap<StreamId, UnboundedSender<Said>> = HashMap::new();
    while let Some(message) = inbound.recv().await {
        let message = match message {
            Inbound::Message(message) => message,
            Inbound::Malformed => return EXIT_MALFORMED,
        };
        match message {
            ToWorker::Walk { id, walk } => {
                let Ok(request) = walk.request() else { return EXIT_MALFORMED };
                let Entry::Vacant(slot) = streams.entry(id) else { return EXIT_MALFORMED };
                slot.insert(start(id, served_walk(&request), &out));
            }
            ToWorker::Search { id, search, summary } => {
                let Ok(request) = search.request(Instant::now()) else { return EXIT_MALFORMED };
                let Entry::Vacant(slot) = streams.entry(id) else { return EXIT_MALFORMED };
                slot.insert(start(id, served_search(&request, summary), &out));
            }
            ToWorker::Taken { id, items } => {
                if let Some(said) = streams.get(&id) {
                    let _ = said.send(Said::Taken(items));
                }
            }
            ToWorker::Close { id } => {
                if let Some(said) = streams.remove(&id) {
                    let _ = said.send(Said::Close);
                }
            }
            ToWorker::Release { id } => drop(streams.remove(&id)),
        }
    }
    EXIT_DONE
}

fn start<S: Source>(id: StreamId, source: S, out: &Output) -> UnboundedSender<Said> {
    let (said, hears) = unbounded_channel();
    drop(tokio::spawn(forward(id, source, hears, out.clone())));
    said
}

/// A served stream, its items as they cross.
trait Source: Send + 'static {
    fn pull(&mut self) -> impl Future<Output = Option<(Item, Option<usize>)>> + Send;
    fn room(&self) -> Room;
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}

impl Source for Served<DirEntry> {
    async fn pull(&mut self) -> Option<(Item, Option<usize>)> {
        self.next().await.map(|(item, weight)| (Item::entry(item), weight))
    }

    fn room(&self) -> Room {
        Served::room(self)
    }

    async fn close(&mut self) {
        Served::<DirEntry>::close(self).await;
    }
}

impl Source for Served<SearchMatch> {
    async fn pull(&mut self) -> Option<(Item, Option<usize>)> {
        self.next().await.map(|(item, weight)| (Item::found(item), weight))
    }

    fn room(&self) -> Room {
        Served::room(self)
    }

    async fn close(&mut self) {
        Served::<SearchMatch>::close(self).await;
    }
}

/// Hands `source`'s items on until the core closes it, lets go of it, or the helper ends.
async fn forward<S: Source>(id: StreamId, mut source: S, mut hears: UnboundedReceiver<Said>, out: Output) {
    let room = source.room();
    // The items handed on whose take the core has not told, oldest first: each one's weight when it holds room.
    let mut held: VecDeque<Option<usize>> = VecDeque::new();
    let mut ended = false;
    loop {
        tokio::select! {
            biased;
            said = hears.recv() => match said {
                Some(Said::Taken(items)) => {
                    for _ in 0..items {
                        if let Some(Some(weight)) = held.pop_front() {
                            room.taken(weight);
                        }
                    }
                }
                Some(Said::Close) => {
                    source.close().await;
                    out.send(&FromWorker::Closed { id });
                    return;
                }
                // Let go of: dropping the stream stops its producer.
                None => return,
            },
            next = source.pull(), if !ended => {
                let sent = match next {
                    Some((item, weight)) => {
                        held.push_back(weight);
                        out.item(id, item)
                    }
                    None => {
                        ended = true;
                        out.send(&FromWorker::End { id })
                    }
                };
                if !sent {
                    return;
                }
            }
        }
    }
}

/// The writer thread's queue.
#[derive(Clone)]
struct Output(mpsc::Sender<Vec<u8>>);

impl Output {
    /// Queues `message`; false once the writer has ended.
    fn send(&self, message: &FromWorker) -> bool {
        frame::encode(message).is_ok_and(|bytes| self.0.send(bytes).is_ok())
    }

    /// An item too large for a message crosses as the failure of a read instead.
    fn item(&self, id: StreamId, item: Item) -> bool {
        match frame::encode(&FromWorker::Item { id, item }) {
            Ok(bytes) => self.0.send(bytes).is_ok(),
            Err(_) => {
                let failure = Failure::of(&FsError::new(FsErrorKind::Io { os_code: None }, None));
                self.send(&FromWorker::Item { id, item: Item::Failure { failure } })
            }
        }
    }
}
