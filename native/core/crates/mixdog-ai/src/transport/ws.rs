//! WebSocket connections with protocol PING keepalive.
//!
//! One connection is two tasks that never wait on each other or on any other
//! connection: a reader that owns the probe schedule, and a writer that
//! forwards queued frames. The reader pings after `interval` without any
//! inbound frame and declares the link dead when nothing at all arrives within
//! `timeout` of the ping. Any inbound frame (data, ping or pong) proves the
//! link alive, so a busy stream is never probed. Probe failure is a
//! [`TransportFault::KeepaliveExpired`]; it is the only timer here and it never
//! looks at message content.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Instant;

use futures::SinkExt;
use futures::StreamExt;
use futures::stream::SplitSink;
use futures::stream::SplitStream;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::LinkLiveness;
use mixdog_core_api::domain::keepalive::PingKeepalive;
use mixdog_core_api::domain::keepalive::TransportKeepalive;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_rt::TaskClass;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::Response;

use super::fault::fault_from_io;
use super::fault::fault_from_ws_error;
use super::tcp;

pub use tokio_tungstenite::tungstenite::Message;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Frames queued toward the socket and the consumer.
const QUEUE: usize = 64;

/// Why [`connect`] did not produce a connection.
#[derive(Debug)]
pub enum ConnectError {
    /// Nothing reached the server: `NotSent` delivery.
    Transport(TransportFault),
    /// The server answered the upgrade with a non-101 response: `Accepted`.
    Rejected(Response<Option<Vec<u8>>>),
}

/// Liveness and age of one WebSocket connection, shared with its tasks.
pub struct WsLink {
    opened: Instant,
    schedule: Mutex<KeepaliveSchedule>,
    dead: Mutex<Option<TransportFault>>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl WsLink {
    fn new(schedule: KeepaliveSchedule) -> Self {
        Self {
            opened: Instant::now(),
            schedule: Mutex::new(schedule),
            dead: Mutex::new(None),
        }
    }

    fn ping(&self) -> PingKeepalive {
        locked(&self.schedule).ws
    }

    /// The first fact that ended the link wins.
    fn mark_dead(&self, fault: TransportFault) {
        locked(&self.dead).get_or_insert(fault);
    }

    pub fn fault(&self) -> Option<TransportFault> {
        locked(&self.dead).clone()
    }
}

impl TransportKeepalive for WsLink {
    fn kind(&self) -> TransportKind {
        TransportKind::WebSocket
    }

    /// Replaces the schedule the connection's tasks read. [`connect`] has
    /// already armed the schedule it was given.
    fn arm(&self, schedule: &KeepaliveSchedule) -> Result<(), TransportFault> {
        *locked(&self.schedule) = *schedule;
        Ok(())
    }

    fn liveness(&self) -> LinkLiveness {
        match self.fault() {
            Some(fault) => LinkLiveness::Dead(fault),
            None => LinkLiveness::Alive,
        }
    }

    fn may_start_response(&self) -> bool {
        let max_age = locked(&self.schedule).ws_max_age;
        max_age.is_none_or(|max| self.opened.elapsed() < max)
    }
}

struct AbortOnDrop([AbortHandle; 2]);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        for handle in &self.0 {
            handle.abort();
        }
    }
}

/// An open WebSocket. Dropping it closes the socket.
pub struct WsConnection {
    out: mpsc::Sender<Message>,
    inbound: mpsc::Receiver<Result<Message, TransportFault>>,
    link: Arc<WsLink>,
    ended: bool,
    _tasks: AbortOnDrop,
}

/// Connects with `SO_KEEPALIVE` set before the first byte and PING keepalive
/// running from the first frame. Returns the upgrade response so callers can
/// read its headers.
pub async fn connect(
    request: impl IntoClientRequest,
    schedule: &KeepaliveSchedule,
) -> Result<(WsConnection, Response<Option<Vec<u8>>>), ConnectError> {
    let request = request
        .into_client_request()
        .map_err(|err| ConnectError::Transport(fault_from_ws_error(&err)))?;
    let uri = request.uri();
    let host = uri
        .host()
        .ok_or(ConnectError::Transport(TransportFault::Dns))?
        .to_owned();
    let port = uri.port_u16().unwrap_or(match uri.scheme_str() {
        Some("wss") => 443,
        _ => 80,
    });
    let addrs = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| ConnectError::Transport(TransportFault::Dns))?;
    let mut failure = TransportFault::Dns;
    let mut connected = None;
    for addr in addrs {
        match tcp::connect(addr, &schedule.tcp).await {
            Ok(stream) => {
                connected = Some(stream);
                break;
            }
            Err(err) => failure = fault_from_io(&err, true),
        }
    }
    let stream = connected.ok_or(ConnectError::Transport(failure))?;
    let (socket, response) = tokio_tungstenite::client_async_tls_with_config(
        request, stream, None, None,
    )
    .await
    .map_err(|err| match err {
        tungstenite::Error::Http(response) => ConnectError::Rejected(response.map(|body| body)),
        other => ConnectError::Transport(fault_from_ws_error(&other)),
    })?;
    let link = Arc::new(WsLink::new(*schedule));
    let (sink, stream) = socket.split();
    let (out_tx, out_rx) = mpsc::channel(QUEUE);
    let (in_tx, in_rx) = mpsc::channel(QUEUE);
    let writer = mixdog_rt::spawn(
        "ai.ws.writer",
        TaskClass::Work,
        write_loop(sink, out_rx, in_tx.clone(), link.clone()),
    );
    let reader = mixdog_rt::spawn(
        "ai.ws.reader",
        TaskClass::Work,
        read_loop(stream, out_tx.clone(), in_tx, link.clone(), writer.abort_handle()),
    );
    let connection = WsConnection {
        out: out_tx,
        inbound: in_rx,
        link,
        ended: false,
        _tasks: AbortOnDrop([writer.abort_handle(), reader.abort_handle()]),
    };
    Ok((connection, response.map(|body| body)))
}

impl WsConnection {
    pub fn link(&self) -> Arc<WsLink> {
        self.link.clone()
    }

    /// Queues a frame. Waits only for room in this connection's own queue.
    pub async fn send(&self, message: Message) -> Result<(), TransportFault> {
        self.out
            .send(message)
            .await
            .map_err(|_| self.link.fault().unwrap_or(TransportFault::Closed))
    }

    /// The next data frame, or the one fault that ended the link, then `None`.
    /// Pings, pongs and the close handshake are handled here, never shown.
    pub async fn recv(&mut self) -> Option<Result<Message, TransportFault>> {
        if self.ended {
            return None;
        }
        let item = self.inbound.recv().await;
        if !matches!(item, Some(Ok(_))) {
            self.ended = true;
        }
        item
    }
}

async fn read_loop(
    mut stream: SplitStream<Socket>,
    to_writer: mpsc::Sender<Message>,
    inbound: mpsc::Sender<Result<Message, TransportFault>>,
    link: Arc<WsLink>,
    writer: AbortHandle,
) {
    let end = |fault: TransportFault| {
        link.mark_dead(fault.clone());
        writer.abort();
        fault
    };
    let mut quiet_since = Instant::now();
    let mut pong_deadline: Option<Instant> = None;
    loop {
        let ping = link.ping();
        let wake = pong_deadline.unwrap_or(quiet_since + ping.interval);
        tokio::select! {
            biased;
            item = stream.next() => {
                quiet_since = Instant::now();
                pong_deadline = None;
                let fault = match item {
                    None => TransportFault::Closed,
                    Some(Err(err)) => fault_from_ws_error(&err),
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = to_writer.try_send(Message::Pong(payload));
                        continue;
                    }
                    Some(Ok(Message::Pong(_) | Message::Frame(_))) => continue,
                    Some(Ok(Message::Close(frame))) => TransportFault::WsClose {
                        code: frame.map(|frame| u16::from(frame.code)),
                    },
                    Some(Ok(data)) => {
                        if inbound.send(Ok(data)).await.is_err() {
                            writer.abort();
                            return;
                        }
                        continue;
                    }
                };
                let _ = inbound.send(Err(end(fault))).await;
                return;
            }
            _ = tokio::time::sleep_until(wake.into()) => {
                if pong_deadline.is_some() {
                    let fault = end(TransportFault::KeepaliveExpired {
                        transport: TransportKind::WebSocket,
                    });
                    let _ = inbound.send(Err(fault)).await;
                    return;
                }
                // A full writer queue does not stop the probe clock: the
                // deadline below still ends a peer that stopped reading.
                let _ = to_writer.try_send(Message::Ping(Default::default()));
                pong_deadline = Some(Instant::now() + ping.timeout);
            }
        }
    }
}

async fn write_loop(
    mut sink: SplitSink<Socket, Message>,
    mut queued: mpsc::Receiver<Message>,
    inbound: mpsc::Sender<Result<Message, TransportFault>>,
    link: Arc<WsLink>,
) {
    while let Some(message) = queued.recv().await {
        if let Err(err) = sink.send(message).await {
            let fault = fault_from_ws_error(&err);
            link.mark_dead(fault.clone());
            let _ = inbound.send(Err(fault)).await;
            return;
        }
    }
    let _ = sink.close().await;
}