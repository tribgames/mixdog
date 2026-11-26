//! The socket of the desktop leg: one at a time, its heartbeat and the redial loop. What a leg
//! announces and what its loss means for phones belongs to the caller, which receives
//! [`LegEvent`]s and sends [`Outgoing`] messages.

use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

use base64::Engine;
use futures::stream::SplitSink;
use futures::{Sink, SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::inbound::{Inbound, read_message};
use super::redial::{RETRY_MIN, Redial, STABLE_LEG};
use crate::identity::DeviceIdentity;

/// Idle NAT paths silently kill this leg; protocol pings keep it warm and detect a half-dead
/// socket. Any traffic counts as proof of life.
pub const HEARTBEAT: Duration = Duration::from_secs(10);
/// The webhook tunnel leg's heartbeat (`relay-tunnel/leg-heartbeat.mjs`).
pub const HOOK_HEARTBEAT: Duration = Duration::from_secs(25);
pub const DESKTOP_PATH: &str = "/desktop";
pub const HOOK_PATH: &str = "/hookleg";

#[derive(Debug, thiserror::Error)]
pub enum RelayUrlError {
    #[error("MIXDOG_RELAY_URL is invalid.")]
    Invalid,
    #[error("MIXDOG_RELAY_URL must use wss://; ws:// is allowed only for loopback development.")]
    Insecure,
    #[error("MIXDOG_RELAY_URL must not contain credentials.")]
    Credentials,
}

impl RelayUrlError {
    /// The text of the webhook tunnel's own check (`relay-tunnel.mjs` `resolveHookRelayUrl`): the
    /// same sentences without the closing period. `Display` is the desktop leg's text.
    pub fn hook_text(&self) -> &'static str {
        match self {
            Self::Invalid => "MIXDOG_RELAY_URL is invalid",
            Self::Insecure => "MIXDOG_RELAY_URL must use wss://; ws:// is allowed only for loopback development",
            Self::Credentials => "MIXDOG_RELAY_URL must not contain credentials",
        }
    }
}

/// `wss://`, or `ws://` for loopback development, with no credentials in the URL.
pub fn validated_relay_url(raw: &str) -> Result<Url, RelayUrlError> {
    let url = Url::parse(raw).map_err(|_| RelayUrlError::Invalid)?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if url.scheme() != "wss" && !(url.scheme() == "ws" && loopback) {
        return Err(RelayUrlError::Insecure);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(RelayUrlError::Credentials);
    }
    Ok(url)
}

/// The leg's URL (`/desktop`) and its Basic credential.
pub fn device_socket_request(relay_url: &str, identity: &DeviceIdentity) -> Result<(Url, String), RelayUrlError> {
    leg_socket_request(relay_url, DESKTOP_PATH, identity)
}

/// A leg's URL on `path` and its Basic credential.
pub fn leg_socket_request(relay_url: &str, path: &str, identity: &DeviceIdentity) -> Result<(Url, String), RelayUrlError> {
    let mut url = validated_relay_url(relay_url)?;
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    let pair = format!("{}:{}", identity.device_id, identity.device_secret);
    let header = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair));
    Ok((url, header))
}

/// The browser-facing URL of this PC: `/d/<deviceId>/` over http(s).
pub fn relay_client_url(relay_url: &str, device_id: &str) -> Result<String, RelayUrlError> {
    let mut url = Url::parse(relay_url).map_err(|_| RelayUrlError::Invalid)?;
    let scheme = if url.scheme() == "wss" { "https" } else { "http" };
    url.set_scheme(scheme).map_err(|()| RelayUrlError::Invalid)?;
    url.set_path(&format!("/d/{device_id}/"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outgoing {
    Text(String),
    Binary(Vec<u8>),
}

#[derive(Debug)]
pub enum LegEvent {
    /// Every open, including each redial.
    Open,
    Inbound(Inbound),
    /// A text message of a [`Framing::Raw`] leg, undecoded.
    Raw(String),
    /// The current leg closed while the client still runs; a redial follows.
    Lost {
        code: Option<u16>,
    },
}

/// What the leg's messages are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Framing {
    /// The desktop protocol: classified into [`Inbound`].
    Desktop,
    /// The caller's own protocol: text messages arrive as [`LegEvent::Raw`], binary is dropped.
    Raw,
}

pub struct LegConfig {
    pub relay_url: String,
    pub identity: DeviceIdentity,
    /// Transport cap for one message on this leg.
    pub max_payload: usize,
    /// The relay endpoint: [`DESKTOP_PATH`] or [`HOOK_PATH`].
    pub path: String,
    pub heartbeat: Duration,
    /// A leg that holds this long restarts the redial backoff and clears the stalled-handshake
    /// streak; `None` for a leg whose backoff restarts on every open.
    pub stable_reset: Option<Duration>,
    pub framing: Framing,
}

impl LegConfig {
    /// The phone-facing desktop leg: `/desktop`, 10 s heartbeat, 30 s stable reset.
    pub fn desktop(relay_url: String, identity: DeviceIdentity, max_payload: usize) -> Self {
        Self {
            relay_url,
            identity,
            max_payload,
            path: DESKTOP_PATH.to_owned(),
            heartbeat: HEARTBEAT,
            stable_reset: Some(STABLE_LEG),
            framing: Framing::Desktop,
        }
    }

    /// The webhook tunnel leg: `/hookleg`, 25 s heartbeat, backoff reset on open, raw frames.
    pub fn hook(relay_url: String, identity: DeviceIdentity, max_payload: usize) -> Self {
        Self { relay_url, identity, max_payload, path: HOOK_PATH.to_owned(), heartbeat: HOOK_HEARTBEAT, stable_reset: None, framing: Framing::Raw }
    }
}

/// The upgrade request of a leg on `path` as `identity`, and the socket limits for messages of `max_payload` bytes.
fn leg_request(relay_url: &str, path: &str, identity: &DeviceIdentity, max_payload: usize) -> Option<(Request, WebSocketConfig)> {
    let (url, authorization) = leg_socket_request(relay_url, path, identity).ok()?;
    let mut request = url.as_str().into_client_request().ok()?;
    request.headers_mut().insert("Authorization", HeaderValue::from_str(&authorization).ok()?);
    let mut ws_config = WebSocketConfig::default();
    ws_config.max_message_size = Some(max_payload);
    ws_config.max_frame_size = Some(max_payload);
    Some((request, ws_config))
}

/// One authenticated `revoke-device` on a desktop leg of its own (`revokeIdentity`): true once the relay confirms it deleted
/// the registration of `identity`. A dial that fails, a leg that ends first and a refusal are false.
pub async fn revoke_registration(relay_url: &str, identity: &DeviceIdentity, max_payload: usize) -> bool {
    let Some((request, ws_config)) = leg_request(relay_url, DESKTOP_PATH, identity, max_payload) else { return false };
    let Ok((mut socket, _)) = crate::dial::connect(request, Some(ws_config)).await else { return false };
    if socket.send(Message::Text(serde_json::json!({ "type": "revoke-device" }).to_string().into())).await.is_err() {
        return false;
    }
    while let Some(Ok(message)) = socket.next().await {
        let Message::Text(text) = message else { continue };
        let Ok(reply) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        if reply.get("type").and_then(Value::as_str) == Some("device-revoked") {
            let _ = socket.close(None).await;
            return reply.get("ok") != Some(&Value::Bool(false));
        }
    }
    false
}

#[derive(Debug, PartialEq, Eq)]
enum Ended {
    Cancelled,
    Closed(Option<u16>),
}

async fn serve_leg(
    config: &LegConfig,
    events: &mpsc::Sender<LegEvent>,
    outgoing: &mut mpsc::Receiver<Outgoing>,
    redial: &mut Redial,
    cancel: &CancellationToken,
) -> Result<Ended, ()> {
    let (request, ws_config) = leg_request(&config.relay_url, &config.path, &config.identity, config.max_payload).ok_or(())?;
    let connected = tokio::select! {
        () = cancel.cancelled() => return Ok(Ended::Cancelled),
        result = crate::dial::connect(request, Some(ws_config)) => result,
    };
    let (socket, _) = connected.map_err(|_| ())?;
    Ok(serve_socket(socket, config, events, outgoing, redial, cancel).await)
}

/// Drives one message through `sink` (ready, enqueue, flush) or finishes flushing bytes already queued.
/// Cancel-safe inside `tokio::select!`: `pending` is taken only when `start_send` runs synchronously,
/// and `poll_flush` resumes from the sink's internal write buffer on the next poll.
async fn drive_sink<S>(sink: &mut SplitSink<WebSocketStream<S>, Message>, pending: &mut Option<Message>) -> Result<(), tokio_tungstenite::tungstenite::Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    std::future::poll_fn(|cx| {
        let mut sink = Pin::new(&mut *sink);
        if pending.is_some() {
            match sink.as_mut().poll_ready(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(err)) => {
                    *pending = None;
                    return Poll::Ready(Err(err));
                }
                Poll::Ready(Ok(())) => {
                    if let Some(message) = pending.take()
                        && let Err(err) = sink.as_mut().start_send(message)
                    {
                        return Poll::Ready(Err(err));
                    }
                }
            }
        }
        sink.poll_flush(cx)
    })
    .await
}

/// Serves one open leg until it ends.
async fn serve_socket<S>(
    socket: WebSocketStream<S>,
    config: &LegConfig,
    events: &mpsc::Sender<LegEvent>,
    outgoing: &mut mpsc::Receiver<Outgoing>,
    redial: &mut Redial,
    cancel: &CancellationToken,
) -> Ended
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut sink, mut stream) = socket.split();
    redial.on_open();
    let stable = mixdog_rt::time::sleep(config.stable_reset.unwrap_or(Duration::MAX / 4));
    tokio::pin!(stable);
    let mut stable_done = config.stable_reset.is_none();
    if events.send(LegEvent::Open).await.is_err() {
        return Ended::Cancelled;
    }
    let mut beat = mixdog_rt::time::interval(config.heartbeat);
    beat.tick().await;
    let mut alive = true;
    // Node's `ws` keeps reading after a failed write, so a close code the relay sent first still decides the redial
    // (remote-relay-connection.ts `ws.on('close', (code) => ...)`).
    let mut write_failed = false;
    let mut pending_write: Option<Message> = None;
    let mut flushing = false;
    let mut pending_ping = false;
    loop {
        tokio::select! {
            () = cancel.cancelled() => {
                if !write_failed && !flushing {
                    // Best-effort close frame bounded by one retry step (`RETRY_MIN`) or heartbeat so a
                    // half-dead socket on suspend, resume, or shutdown cannot pin the cancelled task.
                    let _ = mixdog_rt::time::timeout(config.heartbeat.min(RETRY_MIN), sink.close()).await;
                }
                return Ended::Cancelled;
            }
            () = &mut stable, if !stable_done => {
                stable_done = true;
                redial.on_stable();
            }
            _ = beat.tick() => {
                if write_failed || !alive {
                    return Ended::Closed(None);
                }
                alive = false;
                if flushing {
                    pending_ping = true;
                } else {
                    pending_write = Some(Message::Ping(Vec::new().into()));
                    flushing = true;
                }
            }
            result = drive_sink(&mut sink, &mut pending_write), if flushing => {
                if result.is_err() {
                    write_failed = true;
                    flushing = false;
                    pending_ping = false;
                } else if pending_ping {
                    pending_ping = false;
                    pending_write = Some(Message::Ping(Vec::new().into()));
                } else {
                    flushing = false;
                }
            }
            sent = outgoing.recv(), if !write_failed && !flushing => {
                let Some(sent) = sent else { return Ended::Cancelled };
                let message = match sent {
                    Outgoing::Text(text) => Message::Text(text.into()),
                    Outgoing::Binary(bytes) => Message::Binary(bytes.into()),
                };
                pending_write = Some(message);
                flushing = true;
            }
            received = stream.next() => {
                alive = true;
                let event = match received {
                    None | Some(Err(_)) => return Ended::Closed(None),
                    Some(Ok(Message::Close(frame))) => {
                        return Ended::Closed(frame.map(|f| u16::from(f.code)));
                    }
                    Some(Ok(Message::Text(text))) => match config.framing {
                        Framing::Desktop => read_message(Some(text.as_str()), None).map(LegEvent::Inbound),
                        Framing::Raw => Some(LegEvent::Raw(text.as_str().to_owned())),
                    },
                    Some(Ok(Message::Binary(bytes))) if config.framing == Framing::Desktop => {
                        read_message(None, Some(&bytes)).map(LegEvent::Inbound)
                    }
                    Some(Ok(_)) => None,
                };
                if let Some(event) = event
                    && events.send(event).await.is_err()
                {
                    return Ended::Cancelled;
                }
            }
        }
    }
}

/// Dials, serves and redials until `cancel` fires. A relay URL that fails policy ends the loop
/// at once: there is nothing to redial.
pub async fn run_leg(config: LegConfig, events: mpsc::Sender<LegEvent>, mut outgoing: mpsc::Receiver<Outgoing>, cancel: CancellationToken) {
    let mut redial = Redial::default();
    loop {
        let ended = serve_leg(&config, &events, &mut outgoing, &mut redial, &cancel).await;
        let code = match ended {
            Ok(Ended::Cancelled) => return,
            Ok(Ended::Closed(code)) => {
                if events.send(LegEvent::Lost { code }).await.is_err() {
                    return;
                }
                code
            }
            Err(()) => None,
        };
        if validated_relay_url(&config.relay_url).is_err() {
            return;
        }
        let delay = redial.after_close(code);
        tokio::select! {
            () = cancel.cancelled() => return,
            () = mixdog_rt::time::sleep(delay) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::DuplexStream;
    use tokio::task::JoinHandle;
    use tokio_tungstenite::tungstenite::protocol::Role;
    use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;

    use super::*;
    use crate::leg::redial::DESKTOP_HANDSHAKE_STALLED_CLOSE;

    /// What the pipe between the legs holds in each direction: a frame larger than this cannot be written until the other end
    /// reads, so a write of one stays in flight.
    const PIPE_ROOM: usize = 1024;

    struct Pipe {
        /// The relay's end of the leg.
        relay: WebSocketStream<DuplexStream>,
        outgoing: mpsc::Sender<Outgoing>,
        leg: JoinHandle<Ended>,
    }

    /// A desktop leg served over an in-memory pipe, past its open.
    async fn open_leg() -> Pipe {
        open_leg_with_heartbeat(HEARTBEAT).await
    }

    fn stalled_close() -> Option<CloseFrame> {
        Some(CloseFrame { code: DESKTOP_HANDSHAKE_STALLED_CLOSE.into(), reason: "".into() })
    }

    /// The relay closes the leg with the stalled-handshake code while the desktop is inside a write that cannot finish. The write
    /// then fails because the relay is gone; the code the relay sent first still decides the redial (Node's `ws` has read the
    /// frame by then), so the next dial is immediate and not a backoff.
    #[tokio::test]
    async fn a_close_code_received_while_a_write_was_in_flight_still_classifies_the_leg() {
        let Pipe { mut relay, outgoing, leg } = open_leg().await;
        outgoing.send(Outgoing::Binary(vec![0; PIPE_ROOM * 4])).await.unwrap();
        // Completes once the leg took the first message, which it then cannot finish writing.
        outgoing.send(Outgoing::Binary(vec![0; 1])).await.unwrap();
        relay.close(stalled_close()).await.unwrap();
        drop(relay);
        let Ended::Closed(code) = leg.await.unwrap() else { panic!("the relay closed the leg") };
        assert_eq!(code, Some(DESKTOP_HANDSHAKE_STALLED_CLOSE));
        assert!(Redial::default().after_close(code).is_zero(), "the redial is immediate");
    }

    /// A write that fails with no close frame sent has no code: Node's `ws` closes with 1006, which is not the stalled code.
    #[tokio::test]
    async fn a_write_that_failed_with_no_close_frame_has_no_code() {
        let Pipe { relay, outgoing, leg } = open_leg().await;
        outgoing.send(Outgoing::Binary(vec![0; PIPE_ROOM * 4])).await.unwrap();
        outgoing.send(Outgoing::Binary(vec![0; 1])).await.unwrap();
        drop(relay);
        assert_eq!(leg.await.unwrap(), Ended::Closed(None));
    }

    /// The idle leg reads the relay's close frame and its code.
    #[tokio::test]
    async fn a_close_code_received_on_an_idle_leg_classifies_it() {
        // The sender stays alive: a closed queue would end the leg itself.
        let Pipe { mut relay, leg, outgoing: _outgoing } = open_leg().await;
        relay.close(stalled_close()).await.unwrap();
        assert_eq!(leg.await.unwrap(), Ended::Closed(Some(DESKTOP_HANDSHAKE_STALLED_CLOSE)));
    }

    async fn open_leg_with_heartbeat(heartbeat: Duration) -> Pipe {
        let (desktop_end, relay_end) = tokio::io::duplex(PIPE_ROOM);
        let desktop = WebSocketStream::from_raw_socket(desktop_end, Role::Client, None).await;
        let relay = WebSocketStream::from_raw_socket(relay_end, Role::Server, None).await;
        let (events, mut opened) = mpsc::channel(1);
        let (outgoing, mut queue) = mpsc::channel(1);
        let mut config =
            LegConfig::desktop("ws://127.0.0.1".to_owned(), DeviceIdentity { device_id: "00000000".to_owned(), device_secret: "0".repeat(16) }, PIPE_ROOM);
        config.heartbeat = heartbeat;
        let leg = tokio::spawn(async move { serve_socket(desktop, &config, &events, &mut queue, &mut Redial::default(), &CancellationToken::new()).await });
        assert!(matches!(opened.recv().await, Some(LegEvent::Open)));
        Pipe { relay, outgoing, leg }
    }

    /// A half-dead transport: reads and writes stall indefinitely with no EOF or error.
    struct BlackholeIo;

    impl AsyncRead for BlackholeIo {
        fn poll_read(self: Pin<&mut Self>, _cx: &mut std::task::Context<'_>, _buf: &mut tokio::io::ReadBuf<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }
    }

    impl AsyncWrite for BlackholeIo {
        fn poll_write(self: Pin<&mut Self>, _cx: &mut std::task::Context<'_>, _buf: &[u8]) -> Poll<std::io::Result<usize>> {
            Poll::Pending
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut std::task::Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut std::task::Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }
    }

    /// An outgoing write that stalls on a half-dead socket cannot block the heartbeat from cutting the leg.
    #[tokio::test]
    async fn a_stuck_outgoing_write_does_not_block_the_heartbeat() {
        let Pipe { relay: _relay, outgoing, leg } = open_leg_with_heartbeat(Duration::from_millis(40)).await;
        outgoing.send(Outgoing::Binary(vec![0; PIPE_ROOM * 4])).await.unwrap();
        // Proves the leg took the large message into its write path.
        outgoing.send(Outgoing::Binary(vec![0; 1])).await.unwrap();
        let ended = mixdog_rt::time::timeout(Duration::from_secs(2), leg).await.expect("heartbeat cuts the half-dead leg").unwrap();
        assert_eq!(ended, Ended::Closed(None));
    }

    /// A protocol ping that stalls on a half-dead socket cannot block the next heartbeat tick from cutting the leg.
    #[tokio::test]
    async fn a_stuck_ping_write_does_not_block_the_heartbeat() {
        let desktop = WebSocketStream::from_raw_socket(BlackholeIo, Role::Client, None).await;
        let (events, mut opened) = mpsc::channel(1);
        let (_outgoing, mut queue) = mpsc::channel(1);
        let mut config =
            LegConfig::desktop("ws://127.0.0.1".to_owned(), DeviceIdentity { device_id: "00000000".to_owned(), device_secret: "0".repeat(16) }, PIPE_ROOM);
        config.heartbeat = Duration::from_millis(40);
        let leg = tokio::spawn(async move { serve_socket(desktop, &config, &events, &mut queue, &mut Redial::default(), &CancellationToken::new()).await });
        assert!(matches!(opened.recv().await, Some(LegEvent::Open)));
        let ended = mixdog_rt::time::timeout(Duration::from_secs(2), leg).await.expect("heartbeat cuts the half-dead leg").unwrap();
        assert_eq!(ended, Ended::Closed(None));
    }
}
