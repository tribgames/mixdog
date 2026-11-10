//! Values shared by the carrier and live-view peers: channel labels, buffer marks, ICE servers,
//! signalled candidates and the failure vocabulary reported to the owner of a connection.

use rtc::peer_connection::transport::RTCIceCandidateInit;

/// Reliable ordered channel carrying MXT kinds 1 and 2.
pub const TRANSPORT_CHANNEL_LABEL: &str = "mixdog-transport";
/// Reliable ordered channel on its own SCTP stream carrying MXT kind 3.
pub const TRANSPORT_CONTROL_CHANNEL_LABEL: &str = "mixdog-transport-control";
/// Phone → desktop live-view input channel (text messages).
pub const INPUT_CHANNEL_LABEL: &str = "mixdog-input";
/// A carrier drain to this many buffered bytes is reported as `Buffered`.
pub const BUFFER_LOW_BYTES: u32 = 1024 * 1024;
/// Messages that arrive before `Open` are held up to this many bytes; the receiver repairs
/// anything beyond it.
pub const BUFFER_HIGH_BYTES: usize = 8 * 1024 * 1024;
/// Longest failure detail forwarded to the owner.
pub const MAX_DETAIL_CHARS: usize = 200;
pub const MAX_ICE_SERVERS: usize = 16;
pub const MAX_ICE_URLS: usize = 16;

/// One STUN/TURN server as signalled to both ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

/// Everything a peer connection needs besides its role. Both ends gather and try host, srflx,
/// prflx and relay candidates; ICE's pair priorities choose direct before TURN.
#[derive(Clone, Debug)]
pub struct PeerConfig {
    pub ice_servers: Vec<IceServer>,
    /// Local UDP bind addresses; a wildcard binds one socket per usable interface.
    pub udp_bind: Vec<String>,
    /// Gather loopback host candidates (same-machine peers).
    pub include_loopback: bool,
    #[cfg(test)]
    pub(crate) hooks: PeerHooks,
}

/// What a test puts in place of the machine, and what it reads back.
#[cfg(test)]
#[derive(Clone, Debug, Default)]
pub(crate) struct PeerHooks {
    /// The runtime the connection's driver runs on; `None` is the crate's Tokio runtime.
    pub runtime: Option<std::sync::Arc<dyn webrtc::runtime::Runtime>>,
    /// Opens and joins the mDNS socket in place of the machine (`peer::open_mdns_socket`).
    pub mdns_socket: Option<fn() -> std::io::Result<std::net::UdpSocket>>,
    /// The mDNS mode of every build, in order.
    pub builds: std::sync::Arc<std::sync::Mutex<Vec<rtc::ice::mdns::MulticastDnsMode>>>,
}

impl PeerConfig {
    pub fn new(ice_servers: Vec<IceServer>) -> Self {
        Self {
            ice_servers,
            udp_bind: vec!["0.0.0.0:0".to_owned()],
            include_loopback: false,
            #[cfg(test)]
            hooks: PeerHooks::default(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), PeerFault> {
        if self.ice_servers.len() > MAX_ICE_SERVERS {
            return Err(PeerFault::new(
                PeerFailure::ProtocolError,
                "too many ice servers",
            ));
        }
        for server in &self.ice_servers {
            if server.urls.is_empty() || server.urls.len() > MAX_ICE_URLS {
                return Err(PeerFault::new(
                    PeerFailure::ProtocolError,
                    "ice server url count",
                ));
            }
        }
        Ok(())
    }
}

/// `RTCIceCandidateInit` as it travels; `candidate == ""` is never produced, the end of
/// candidates is `Option::None` at the event level.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_mline_index: Option<u16>,
    pub username_fragment: Option<String>,
}

impl Candidate {
    pub(crate) fn from_init(init: RTCIceCandidateInit) -> Self {
        Self {
            candidate: init.candidate,
            sdp_mid: init.sdp_mid,
            sdp_mline_index: init.sdp_mline_index,
            username_fragment: init.username_fragment,
        }
    }

    pub(crate) fn into_init(self) -> RTCIceCandidateInit {
        RTCIceCandidateInit {
            candidate: self.candidate,
            sdp_mid: self.sdp_mid,
            sdp_mline_index: self.sdp_mline_index,
            username_fragment: self.username_fragment,
            ..Default::default()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateType {
    Host,
    Srflx,
    Prflx,
    Relay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayProtocol {
    Udp,
    Tcp,
    Tls,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportProtocol {
    Udp,
    Tcp,
}

/// Which path the selected pair settled on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidatePath {
    Direct,
    Relay,
}

/// The selected candidate pair. Reported only with both types known: a guessed type would
/// misstate the path.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CandidatePair {
    pub local_type: CandidateType,
    pub remote_type: CandidateType,
    pub protocol: TransportProtocol,
    pub relay_protocol: Option<RelayProtocol>,
    pub current_round_trip_time_ms: Option<f64>,
    pub available_outgoing_bitrate: Option<f64>,
}

impl CandidatePair {
    /// `Relay` when either end is a TURN relay candidate, `Direct` otherwise.
    pub fn path(&self) -> CandidatePath {
        if self.local_type == CandidateType::Relay || self.remote_type == CandidateType::Relay {
            CandidatePath::Relay
        } else {
            CandidatePath::Direct
        }
    }
}

/// The DTLS certificate the transport negotiated; the owner compares it with the signalled
/// fingerprints before it trusts a byte from the peer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteCertificate {
    pub fingerprint: String,
    pub fingerprint_algorithm: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerFailure {
    IceFailed,
    DtlsFailed,
    ChannelFailed,
    ProtocolError,
    PeerHostUnavailable,
    /// The live view has no codec the phone can receive.
    Unsupported,
}

impl PeerFailure {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::IceFailed => "ice-failed",
            Self::DtlsFailed => "dtls-failed",
            Self::ChannelFailed => "channel-failed",
            Self::ProtocolError => "protocol-error",
            Self::PeerHostUnavailable => "peer-host-unavailable",
            Self::Unsupported => "unsupported",
        }
    }
}

/// A connection ended: the reason and a bounded human detail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerFault {
    pub reason: PeerFailure,
    pub detail: Option<String>,
}

impl PeerFault {
    pub fn new(reason: PeerFailure, detail: impl AsRef<str>) -> Self {
        let detail: String = detail.as_ref().chars().take(MAX_DETAIL_CHARS).collect();
        Self {
            reason,
            detail: (!detail.is_empty()).then_some(detail),
        }
    }

    pub fn bare(reason: PeerFailure) -> Self {
        Self {
            reason,
            detail: None,
        }
    }
}

impl std::fmt::Display for PeerFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason.wire_name())?;
        if let Some(detail) = &self.detail {
            write!(f, ": {detail}")?;
        }
        Ok(())
    }
}

impl std::error::Error for PeerFault {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_is_relay_when_either_end_is_relayed() {
        let mut pair = CandidatePair {
            local_type: CandidateType::Host,
            remote_type: CandidateType::Srflx,
            protocol: TransportProtocol::Udp,
            relay_protocol: None,
            current_round_trip_time_ms: None,
            available_outgoing_bitrate: None,
        };
        assert_eq!(pair.path(), CandidatePath::Direct);
        pair.remote_type = CandidateType::Relay;
        assert_eq!(pair.path(), CandidatePath::Relay);
    }

    #[test]
    fn fault_detail_is_bounded() {
        let fault = PeerFault::new(PeerFailure::ChannelFailed, "x".repeat(500));
        assert_eq!(fault.detail.unwrap().chars().count(), MAX_DETAIL_CHARS);
    }

    #[test]
    fn ice_server_bounds() {
        let server = IceServer {
            urls: vec!["stun:a".into()],
            username: None,
            credential: None,
        };
        assert!(PeerConfig::new(vec![server.clone(); 16]).validate().is_ok());
        assert!(PeerConfig::new(vec![server.clone(); 17]).validate().is_err());
        let empty = IceServer {
            urls: vec![],
            ..server
        };
        assert!(PeerConfig::new(vec![empty]).validate().is_err());
    }
}
