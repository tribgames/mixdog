//! mixdog: the client-to-server leg of TURN over TCP and TLS (RFC 8656 §2.1).
//!
//! One outbound connection per offered `turn:…?transport=tcp` or `turns:` endpoint. Each is one
//! task on the runtime: it resolves, connects through the system's route, runs the TLS handshake
//! when the endpoint is secure, then moves whole TURN messages both ways. The driver never awaits
//! it. Messages reach the driver on a bounded queue of their own, which is the connection's read
//! back-pressure, and the driver's frames reach the task through bounded queues: one for requests,
//! one for relayed data, and a place for the release that ends the connection.
//!
//! Framing is TURN's own (RFC 8656 §12.5): a STUN message is 20 bytes plus its length, a
//! ChannelData message is 4 bytes plus its length rounded up to a multiple of four, back to back.
//! It is not the RFC 4571 length prefix of ICE-TCP ([`tcp_transport`](super::tcp_transport)).
//! The TURN client already pads ChannelData, so a frame is written as the client produced it.

use crate::runtime::{AsyncTcpStream, JoinHandle, Receiver, Runtime, Sender, channel, timeout};
use futures::FutureExt;
use log::{debug, trace};
use rtc::shared::turn_framing::TurnStreamDecoder;
use rustls::pki_types::ServerName;
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Longest a connection may take to resolve, connect and finish its handshake: Ti, the wait of
/// one transaction over a reliable transport (RFC 8489 §6.2.2).
const SETUP_TIMEOUT: Duration = Duration::from_millis(39_500);
const READ_BUF_LEN: usize = 16 * 1024;
/// Relayed data that may wait for the socket. A full queue drops a frame, as a full UDP send
/// buffer would.
const DATA_FRAMES: usize = 256;
/// Requests that may wait for the socket. They are few (an Allocate, a permission or a channel per
/// peer, the refreshes) and are written before data, so a full queue is a connection that carries
/// none: its owner retires it.
const REQUEST_FRAMES: usize = 32;
/// Longest the socket may take to accept one batch. The last write of a connection, its release,
/// has the same bound, so a connection whose owner is gone ends within two of these.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Messages of all of a driver's connections that may wait for the driver.
pub(crate) const STREAM_EVENTS: usize = 256;
/// Most bytes handed to the socket in one write.
const WRITE_BATCH_BYTES: usize = 64 * 1024;

static NEXT_STREAM: AtomicU64 = AtomicU64::new(1);

/// Names one connection for its whole life. `serial` is never reused in the process, so an event
/// of a connection that was retired, in this gathering or an earlier one, matches nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct TurnStreamId {
    pub(crate) generation: u64,
    pub(crate) serial: u64,
}

impl TurnStreamId {
    pub(crate) fn next(generation: u64) -> Self {
        Self {
            generation,
            serial: NEXT_STREAM.fetch_add(1, Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct TurnStreamEndpoint {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) tls: bool,
}

#[derive(Debug)]
pub(crate) enum TurnStreamEvent {
    /// The connection is up (and its handshake done), with the addresses the system gave it.
    Connected {
        id: TurnStreamId,
        local_addr: SocketAddr,
        peer_addr: SocketAddr,
    },
    /// One whole STUN or ChannelData message, padding included.
    Message { id: TurnStreamId, message: Vec<u8> },
    /// The connection is gone; nothing follows for this id.
    Closed { id: TurnStreamId, reason: String },
}

/// What a relayer needs to open connections: where their events go and how `turns:` is verified.
#[derive(Clone)]
pub(crate) struct TurnStreamIo {
    pub(crate) events: Sender<TurnStreamEvent>,
    pub(crate) tls: Option<Arc<rustls::ClientConfig>>,
}

/// The driver's end of one connection. Dropping it closes the connection, as
/// [`release`](Self::release) does after one last write.
pub(crate) struct TurnStream {
    requests: Sender<Vec<u8>>,
    data: Sender<Vec<u8>>,
    last: Sender<Vec<u8>>,
    task: Box<dyn JoinHandle>,
}

impl TurnStream {
    pub(crate) fn open(
        runtime: &Arc<dyn Runtime>,
        sink: &TurnStreamIo,
        id: TurnStreamId,
        endpoint: TurnStreamEndpoint,
    ) -> Self {
        let (requests, queued_requests) = channel(REQUEST_FRAMES);
        let (data, queued_data) = channel(DATA_FRAMES);
        let (last, queued_last) = channel(1);
        let outbound = Outbound {
            requests: queued_requests,
            data: queued_data,
            last: queued_last,
        };
        let task = runtime.spawn(Box::pin(run(
            Arc::clone(runtime),
            sink.clone(),
            id,
            endpoint,
            outbound,
        )));
        Self {
            requests,
            data,
            last,
            task,
        }
    }

    /// Queues one request; `false` when the connection has no room for it or is gone.
    pub(crate) fn send_request(&self, frame: Vec<u8>) -> bool {
        self.requests.try_send(frame).is_ok()
    }

    /// Queues one frame of relayed data, which a connection without room loses.
    pub(crate) fn send_data(&self, frame: Vec<u8>) {
        let _ = self.data.try_send(frame);
    }

    /// Ends the connection after writing `frames` (whole messages, back to back), ahead of
    /// anything still queued, which is not written: the writer takes them before any other frame,
    /// so only a write already under way comes first. The place for them is this connection's
    /// alone and used once, so a connection with no room left still takes its release. The task
    /// goes on by itself and ends within [`WRITE_TIMEOUT`] of its current write.
    pub(crate) fn release(self, frames: Vec<u8>) {
        let _ = self.last.try_send(frames);
    }

    /// Ends the connection now, with whatever was queued unwritten.
    pub(crate) fn abort(self) {
        self.task.abort();
    }
}

async fn run(
    runtime: Arc<dyn Runtime>,
    sink: TurnStreamIo,
    id: TurnStreamId,
    endpoint: TurnStreamEndpoint,
    outbound: Outbound,
) {
    let setup = timeout(
        runtime.as_ref(),
        SETUP_TIMEOUT,
        establish(runtime.as_ref(), &sink, &endpoint),
    )
    .await;
    let reason = match setup {
        Err(_) => "connection setup timed out".to_owned(),
        Ok(Err(err)) => err.to_string(),
        Ok(Ok(link)) => {
            let connected = TurnStreamEvent::Connected {
                id,
                local_addr: link.local_addr,
                peer_addr: link.peer_addr,
            };
            // overflow: park — this task alone waits; a full queue is the read back-pressure of
            // this connection.
            if sink.events.send(connected).await.is_err() {
                return;
            }
            pump(runtime.as_ref(), &sink, id, link, outbound).await
        }
    };
    debug!(
        "TURN {} connection to {}:{} ended: {}",
        if endpoint.tls { "TLS" } else { "TCP" },
        endpoint.host,
        endpoint.port,
        reason
    );
    // overflow: park — as above.
    let _ = sink
        .events
        .send(TurnStreamEvent::Closed { id, reason })
        .await;
}

/// The task's ends of what its owner writes.
struct Outbound {
    requests: Receiver<Vec<u8>>,
    data: Receiver<Vec<u8>>,
    /// The frames to end on. Closed without any when the owner dropped its end.
    last: Receiver<Vec<u8>>,
}

struct Link {
    stream: Arc<dyn AsyncTcpStream>,
    local_addr: SocketAddr,
    peer_addr: SocketAddr,
    tls: Option<rustls::ClientConnection>,
}

async fn establish(
    runtime: &dyn Runtime,
    sink: &TurnStreamIo,
    endpoint: &TurnStreamEndpoint,
) -> io::Result<Link> {
    // A `turns:` endpoint is TLS or nothing: without a verifier it fails here, before any byte
    // could leave in the clear.
    let tls = if endpoint.tls {
        let config = sink.tls.clone().ok_or_else(|| {
            io::Error::other("no TLS configuration for a turns: url".to_owned())
        })?;
        // An IP literal becomes an IP identity, which only an iPAddress name of the certificate
        // satisfies.
        let name = ServerName::try_from(endpoint.host.clone())
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
        Some(rustls::ClientConnection::new(config, name).map_err(io::Error::other)?)
    } else {
        None
    };

    let addrs = match endpoint.host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, endpoint.port)],
        Err(_) => {
            runtime
                .resolve_host(&format!("{}:{}", endpoint.host, endpoint.port))
                .await?
        }
    };
    let mut last = io::Error::new(io::ErrorKind::NotFound, "the host has no address");
    let mut connected = None;
    for addr in addrs {
        match runtime.connect_tcp(addr).await {
            Ok(stream) => {
                connected = Some(stream);
                break;
            }
            Err(err) => last = err,
        }
    }
    let Some(stream) = connected else {
        return Err(last);
    };
    let local_addr = stream.local_addr()?;
    let peer_addr = stream.peer_addr()?;

    let tls = match tls {
        Some(mut session) => {
            handshake(stream.as_ref(), &mut session).await?;
            Some(session)
        }
        None => None,
    };
    Ok(Link {
        stream,
        local_addr,
        peer_addr,
        tls,
    })
}

fn tls_error(err: rustls::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, err)
}

/// Moves every record the session wants written into `out`.
fn take_tls_records(session: &mut rustls::ClientConnection, out: &mut Vec<u8>) -> io::Result<()> {
    while session.wants_write() {
        session.write_tls(out)?;
    }
    Ok(())
}

/// Feeds bytes read from the socket to the session. On a TLS failure the alert is left in the
/// session for the caller to take.
fn feed_tls(session: &mut rustls::ClientConnection, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        if session.read_tls(&mut bytes)? == 0 {
            return Err(io::Error::other("the TLS session takes no more input"));
        }
        session.process_new_packets().map_err(tls_error)?;
    }
    Ok(())
}

async fn handshake(
    stream: &dyn AsyncTcpStream,
    session: &mut rustls::ClientConnection,
) -> io::Result<()> {
    let mut buf = vec![0u8; READ_BUF_LEN];
    let mut records = Vec::new();
    loop {
        records.clear();
        take_tls_records(session, &mut records)?;
        if !records.is_empty() {
            stream.write_all(&records).await?;
        }
        if !session.is_handshaking() {
            return Ok(());
        }
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        if let Err(err) = feed_tls(session, &buf[..n]) {
            // The alert that says why, best effort.
            records.clear();
            if take_tls_records(session, &mut records).is_ok() && !records.is_empty() {
                let _ = stream.write_all(&records).await;
            }
            return Err(err);
        }
    }
}

/// The TLS session of a connection, shared by its two directions. Records leave in the order
/// the session made them: only the writer takes them, and it takes all of them at once.
struct Tls {
    session: Mutex<rustls::ClientConnection>,
    /// Told when reading made the session want to write (a key update, an alert).
    records_ready: Sender<()>,
}

impl Tls {
    fn lock(&self) -> std::sync::MutexGuard<'_, rustls::ClientConnection> {
        self.session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

async fn pump(
    runtime: &dyn Runtime,
    sink: &TurnStreamIo,
    id: TurnStreamId,
    link: Link,
    outbound: Outbound,
) -> String {
    let Link { stream, tls, .. } = link;
    let (records_ready, wake) = channel(1);
    // Held so the wake queue of a connection without TLS stays open, and silent.
    let _records_ready = records_ready.clone();
    let tls = tls.map(|session| Tls {
        session: Mutex::new(session),
        records_ready,
    });
    let reading = read_messages(sink, id, stream.as_ref(), tls.as_ref()).fuse();
    let writing = write_frames(runtime, stream.as_ref(), tls.as_ref(), outbound, wake).fuse();
    futures::pin_mut!(reading, writing);
    // Whichever direction ends first ends the connection; the other is dropped with it.
    futures::select! {
        reason = reading => reason,
        reason = writing => reason,
    }
}

async fn read_messages(
    sink: &TurnStreamIo,
    id: TurnStreamId,
    stream: &dyn AsyncTcpStream,
    tls: Option<&Tls>,
) -> String {
    let mut buf = vec![0u8; READ_BUF_LEN];
    let mut plain = Vec::new();
    let mut decoder = TurnStreamDecoder::new();
    loop {
        let n = match stream.read(&mut buf).await {
            Ok(0) => return "closed by the server".to_owned(),
            Ok(n) => n,
            Err(err) => return format!("read failed: {err}"),
        };
        let closed = match tls {
            None => {
                decoder.extend_from_slice(&buf[..n]);
                false
            }
            Some(tls) => {
                plain.clear();
                let read = read_plain(tls, &buf[..n], &mut plain);
                // A full wake queue already holds the wake.
                let _ = tls.records_ready.try_send(());
                match read {
                    Ok(closed) => {
                        decoder.extend_from_slice(&plain);
                        closed
                    }
                    Err(err) => return format!("TLS failed: {err}"),
                }
            }
        };
        loop {
            match decoder.next_message() {
                Ok(Some(message)) => {
                    trace!("TURN stream {:?} read {} bytes", id, message.len());
                    let event = TurnStreamEvent::Message { id, message };
                    // overflow: park — read back-pressure, see `run`.
                    if sink.events.send(event).await.is_err() {
                        // The driver is gone and its end of this connection goes with it: the
                        // writer writes the release, if it was given one, and ends the task.
                        return std::future::pending().await;
                    }
                }
                Ok(None) => break,
                Err(err) => return format!("not a TURN stream: {err}"),
            }
        }
        if closed {
            return "closed by the server".to_owned();
        }
    }
}

/// Decrypts what `bytes` completes into `plain`; `true` once the server closed its side.
fn read_plain(tls: &Tls, bytes: &[u8], plain: &mut Vec<u8>) -> io::Result<bool> {
    let mut session = tls.lock();
    feed_tls(&mut session, bytes)?;
    let mut chunk = [0u8; 4096];
    loop {
        match session.reader().read(&mut chunk) {
            Ok(0) => return Ok(true),
            Ok(n) => plain.extend_from_slice(&chunk[..n]),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(err) => return Err(err),
        }
    }
}

async fn write_frames(
    runtime: &dyn Runtime,
    stream: &dyn AsyncTcpStream,
    tls: Option<&Tls>,
    mut outbound: Outbound,
    mut wake: Receiver<()>,
) -> String {
    let mut wire = Vec::new();
    loop {
        wire.clear();
        let mut batch = Vec::new();
        // `Some` once the owner is done with the connection: what to end on.
        let mut last = None;
        // In this order: a release that is waiting is taken before any other frame.
        futures::select_biased! {
            frames = outbound.last.recv().fuse() => last = Some(frames.unwrap_or_default()),
            frame = outbound.requests.recv().fuse() => match frame {
                Some(frame) => batch = frame,
                None => last = Some(outbound.last.try_recv().unwrap_or_default()),
            },
            frame = outbound.data.recv().fuse() => match frame {
                Some(frame) => batch = frame,
                None => last = Some(outbound.last.try_recv().unwrap_or_default()),
            },
            _ = wake.recv().fuse() => {}
        }
        let closing = last.is_some();
        match last {
            // Whatever else is queued belongs to an allocation that is being given up.
            Some(frames) => batch = frames,
            None => {
                // Requests first: they are few, and a transaction is waiting on each.
                while let Ok(frame) = outbound.requests.try_recv() {
                    batch.extend_from_slice(&frame);
                }
                while batch.len() < WRITE_BATCH_BYTES {
                    match outbound.data.try_recv() {
                        Ok(frame) => batch.extend_from_slice(&frame),
                        Err(_) => break,
                    }
                }
            }
        }
        match tls {
            None => wire.append(&mut batch),
            Some(tls) => {
                if let Err(err) = seal(tls, &batch, closing, &mut wire) {
                    return format!("TLS failed: {err}");
                }
            }
        }
        if !wire.is_empty() {
            match timeout(runtime, WRITE_TIMEOUT, stream.write_all(&wire)).await {
                Ok(Ok(())) => {}
                Ok(Err(err)) => return format!("write failed: {err}"),
                Err(_) => return "the socket took no more".to_owned(),
            }
        }
        if closing {
            return "closed".to_owned();
        }
    }
}

/// Encrypts `plain` and takes every record the session holds, in order, into `wire`.
fn seal(tls: &Tls, mut plain: &[u8], closing: bool, wire: &mut Vec<u8>) -> io::Result<()> {
    let mut session = tls.lock();
    while !plain.is_empty() {
        // The session buffers a bounded amount of plaintext: take its records between writes.
        let n = session.writer().write(plain)?;
        plain = &plain[n..];
        take_tls_records(&mut session, wire)?;
        if n == 0 && !plain.is_empty() {
            return Err(io::ErrorKind::WriteZero.into());
        }
    }
    if closing {
        session.send_close_notify();
    }
    take_tls_records(&mut session, wire)
}
