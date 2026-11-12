//! The socket of the desktop leg: one at a time, its heartbeat and the redial loop. What a leg
//! announces and what its loss means for phones belongs to the caller, which receives
//! [`LegEvent`]s and sends [`Outgoing`] messages.

use std::time::Duration;

use base64::Engine;
use futures::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::inbound::{Inbound, read_message};
use super::redial::{Redial, STABLE_LEG};
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
pub fn leg_socket_request(
    relay_url: &str,
    path: &str,
    identity: &DeviceIdentity,
) -> Result<(Url, String), RelayUrlError> {
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
    Lost { code: Option<u16> },
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
        Self {
            relay_url,
            identity,
            max_payload,
            path: HOOK_PATH.to_owned(),
            heartbeat: HOOK_HEARTBEAT,
            stable_reset: None,
            framing: Framing::Raw,
        }
    }
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
    let (url, authorization) = leg_socket_request(&config.relay_url, &config.path, &config.identity).map_err(|_| ())?;
    let mut request = url.as_str().into_client_request().map_err(|_| ())?;
    request
        .headers_mut()
        .insert("Authorization", HeaderValue::from_str(&authorization).map_err(|_| ())?);
    let mut ws_config = WebSocketConfig::default();
    ws_config.max_message_size = Some(config.max_payload);
    ws_config.max_frame_size = Some(config.max_payload);
    let connected = tokio::select! {
        () = cancel.cancelled() => return Ok(Ended::Cancelled),
        result = crate::dial::connect(request, Some(ws_config)) => result,
    };
    let (socket, _) = connected.map_err(|_| ())?;
    Ok(serve_socket(socket, config, events, outgoing, redial, cancel).await)
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
    // A write that fails does not end the leg on the spot. Node's `ws` reads the socket whatever the
    // writes do, so a close frame the relay sent before the write failed still gives the leg its code
    // (remote-relay-connection.ts `ws.on('close', (code) => ...)`): the code decides an immediate redial. A
    // write error means the transport is gone, so the read side ends right after what it already holds.
    let mut write_failed = false;
    loop {
        tokio::select! {
            () = cancel.cancelled() => {
                let _ = sink.close().await;
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
                write_failed = sink.send(Message::Ping(Vec::new().into())).await.is_err();
            }
            sent = outgoing.recv(), if !write_failed => {
                let Some(sent) = sent else { return Ended::Cancelled };
                let message = match sent {
                    Outgoing::Text(text) => Message::Text(text.into()),
                    Outgoing::Binary(bytes) => Message::Binary(bytes.into()),
                };
                write_failed = sink.send(message).await.is_err();
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
pub async fn run_leg(
    config: LegConfig,
    events: mpsc::Sender<LegEvent>,
    mut outgoing: mpsc::Receiver<Outgoing>,
    cancel: CancellationToken,
) {
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
        let (desktop_end, relay_end) = tokio::io::duplex(PIPE_ROOM);
        let desktop = WebSocketStream::from_raw_socket(desktop_end, Role::Client, None).await;
        let relay = WebSocketStream::from_raw_socket(relay_end, Role::Server, None).await;
        let (events, mut opened) = mpsc::channel(1);
        // One slot: a send that completes proves the leg has taken the previous message.
        let (outgoing, mut queue) = mpsc::channel(1);
        let config = LegConfig::desktop(
            "ws://127.0.0.1".to_owned(),
            DeviceIdentity { device_id: "00000000".to_owned(), device_secret: "0".repeat(16) },
            PIPE_ROOM,
        );
        let leg = tokio::spawn(async move {
            serve_socket(desktop, &config, &events, &mut queue, &mut Redial::default(), &CancellationToken::new()).await
        });
        assert!(matches!(opened.recv().await, Some(LegEvent::Open)));
        Pipe { relay, outgoing, leg }
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
}