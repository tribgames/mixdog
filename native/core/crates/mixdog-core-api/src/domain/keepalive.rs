//! Transport keepalive: the only mechanism that turns a half-open provider
//! connection into a failure (SPEC §4.9). It is transport configuration, not
//! a content timer: pings and provider keepalive events never count as
//! progress or death, and no schedule here measures time between content.

use std::time::Duration;

use super::provider::TransportFault;

/// OS TCP keepalive (`SO_KEEPALIVE` with idle/interval/count).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TcpKeepalive {
    pub idle: Duration,
    pub interval: Duration,
    pub count: u32,
}

/// Protocol PING keepalive (HTTP/2 PING, WebSocket PING).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PingKeepalive {
    pub interval: Duration,
    /// Time allowed for the matching PONG/ACK before the link is dead.
    pub timeout: Duration,
    /// Pings are sent while no stream is open, too.
    pub while_idle: bool,
}

/// The one keepalive configuration, applied to every provider connection.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct KeepaliveSchedule {
    pub tcp: TcpKeepalive,
    pub h2: PingKeepalive,
    pub ws: PingKeepalive,
    /// A pooled WebSocket is not reused for a new response once its age
    /// reaches the provider's documented connection limit.
    pub ws_max_age: Option<Duration>,
}

impl KeepaliveSchedule {
    /// SPEC §4.9 table.
    pub const SPEC: Self = Self {
        tcp: TcpKeepalive {
            idle: Duration::from_secs(60),
            interval: Duration::from_secs(60),
            count: 5,
        },
        h2: PingKeepalive {
            interval: Duration::from_secs(30),
            timeout: Duration::from_secs(10),
            while_idle: true,
        },
        ws: PingKeepalive {
            interval: Duration::from_secs(30),
            timeout: Duration::from_secs(10),
            while_idle: true,
        },
        ws_max_age: None,
    };

    /// OpenAI Responses WS documents a 60-minute connection limit.
    pub const fn with_ws_max_age(mut self, age: Duration) -> Self {
        self.ws_max_age = Some(age);
        self
    }

    /// Longest time a half-open TCP connection stays undetected.
    pub fn tcp_detection_bound(&self) -> Duration {
        self.tcp.idle + self.tcp.interval * self.tcp.count
    }
}

/// Wire family of a provider connection; selects which keepalive applies
/// (TCP keepalive always; h2 PING or WS PING in addition).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum TransportKind {
    /// HTTP/1.1 request with an SSE or chunked body.
    Http1,
    /// HTTP/2 (gRPC-style and Connect providers).
    Http2,
    /// WebSocket (OpenAI Responses WS, xAI WS).
    WebSocket,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum LinkLiveness {
    Alive,
    /// A fact ended the link: socket error, RST/FIN, TLS close, GOAWAY,
    /// close frame, or a keepalive probe that went unanswered.
    Dead(TransportFault),
}

/// Implemented by each live provider connection.
pub trait TransportKeepalive: Send + Sync {
    fn kind(&self) -> TransportKind;
    /// Applies the schedule before the first request byte is written.
    fn arm(&self, schedule: &KeepaliveSchedule) -> Result<(), TransportFault>;
    fn liveness(&self) -> LinkLiveness;
    /// Whether a new response may start on this connection (WS age limit).
    fn may_start_response(&self) -> bool;
}
