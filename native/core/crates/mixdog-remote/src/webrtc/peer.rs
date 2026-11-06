//! One `RTCPeerConnection` and its event stream, shared by the carrier and the live view.
//!
//! The connection runs on the `webrtc` crate's driver (ICE with consent freshness, DTLS, SCTP,
//! SRTP). Path death is decided by that stack only: a `Failed` connection state (consent
//! expiry, DTLS or SCTP close) ends the connection; no stall timer watches an established path.
//! What is bounded here is the connection's own work: every awaited step of a connection runs
//! under its [`PeerBudget`], and coming up has [`SETUP_BUDGET`].

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use mixdog_rt::Scope;
use mixdog_rt::Scoped;
use rtc::peer_connection::configuration::RTCOfferOptions;
use rtc::peer_connection::transport::RTCIceServerTransportProtocol;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use webrtc::peer_connection::MediaEngine;
use webrtc::peer_connection::PeerConnection;
use webrtc::peer_connection::PeerConnectionBuilder;
use webrtc::peer_connection::PeerConnectionEventHandler;
use webrtc::peer_connection::RTCBundlePolicy;
use webrtc::peer_connection::RTCConfigurationBuilder;
use webrtc::peer_connection::RTCIceCandidateType;
use webrtc::peer_connection::RTCIceConnectionState;
use webrtc::peer_connection::RTCIceServer;
use webrtc::peer_connection::RTCIceTransportPolicy;
use webrtc::peer_connection::RTCPeerConnectionIceEvent;
use webrtc::peer_connection::RTCPeerConnectionState;
use webrtc::peer_connection::RTCSessionDescription;
use webrtc::peer_connection::Registry;
use webrtc::peer_connection::SettingEngineBuilder;
use webrtc::peer_connection::StatsSelector;
use webrtc::peer_connection::RTCStatsReport;
use webrtc::peer_connection::RTCStatsReportEntry;

use super::config::Candidate;
use super::config::CandidatePair;
use super::config::CandidateType;
use super::config::PeerConfig;
use super::config::PeerFailure;
use super::config::PeerFault;
use super::config::RelayProtocol;
use super::config::RemoteCertificate;
use super::config::TransportProtocol;

/// Longest one step of a connection may take: the pong timeout of the keepalive schedule
/// (SPEC §4.9, H3). Each step is local work, so a step that long is a dead driver.
pub(crate) const STEP_BUDGET: Duration = Duration::from_secs(10);
/// Longest a connection may take to come up: the keepalive interval plus the pong timeout
/// (SPEC §4.9, H3).
pub(crate) const SETUP_BUDGET: Duration = Duration::from_secs(40);

/// The one bound on a connection's awaits: its owner dropping the handle (`close`) or
/// [`STEP_BUDGET`], whichever comes first.
#[derive(Clone, Default)]
pub(crate) struct PeerBudget {
    cancel: CancellationToken,
}

impl PeerBudget {
    /// Ends every step under this budget, and the helper tasks watching [`Self::token`].
    pub(crate) fn close(&self) {
        self.cancel.cancel();
    }

    pub(crate) fn token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    /// Runs `work`; when it outlasts the budget or the connection was closed, drops it and
    /// reports a fault naming `what`.
    pub(crate) async fn step<T>(&self, what: &'static str, work: impl Future<Output = T>) -> Result<T, PeerFault> {
        // The tokio clock, so a paused test clock moves the deadline too.
        let deadline = (tokio::time::Instant::now() + STEP_BUDGET).into_std();
        match Scope::new().cancel(&self.cancel).deadline(Some(deadline)).run(work).await {
            Scoped::Done(out) => Ok(out),
            Scoped::Cancelled => Err(PeerFault::new(PeerFailure::PeerHostUnavailable, "connection closed")),
            Scoped::DeadlineExceeded => {
                Err(PeerFault::new(PeerFailure::PeerHostUnavailable, format!("{what} timed out")))
            }
        }
    }
}

/// Closes the connection. A budget of its own: the connection's is closed by the time this runs.
pub(crate) async fn close(pc: &Arc<dyn PeerConnection>) {
    let _ = PeerBudget::default().step("close", pc.close()).await;
}

/// What a connection reports while it is set up and while it lives.
#[derive(Debug)]
pub(crate) enum PeerEvent {
    /// A local candidate; `None` ends the gathering. `url` is set for relay candidates.
    Candidate {
        candidate: Option<Candidate>,
        relay_protocol: Option<RelayProtocol>,
        url: Option<String>,
    },
    /// DTLS is up. `remote_certificate` is what the transport negotiated.
    Connected {
        remote_certificate: Option<RemoteCertificate>,
    },
    Failed(PeerFault),
}

pub(crate) enum Raw {
    Candidate {
        candidate: Option<Candidate>,
        relay_protocol: Option<RelayProtocol>,
        url: Option<String>,
    },
    State(RTCPeerConnectionState),
}

struct Handler {
    tx: mpsc::UnboundedSender<Raw>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        let Ok(init) = event.candidate.to_json() else {
            return;
        };
        let relay = event.candidate.typ == RTCIceCandidateType::Relay;
        let relay_protocol = relay.then(|| match event.candidate.relay_protocol {
            RTCIceServerTransportProtocol::Tcp => Some(RelayProtocol::Tcp),
            RTCIceServerTransportProtocol::Tls => Some(RelayProtocol::Tls),
            RTCIceServerTransportProtocol::Udp => Some(RelayProtocol::Udp),
            _ => None,
        });
        let url = relay
            .then(|| {
                Some(event.url.clone())
                    .filter(|url| !url.is_empty())
                    .or(event.candidate.url.clone())
            })
            .flatten();
        let _ = self.tx.send(Raw::Candidate {
            candidate: Some(Candidate::from_init(init)),
            relay_protocol: relay_protocol.flatten(),
            url,
        });
    }

    async fn on_ice_gathering_state_change(&self, state: webrtc::peer_connection::RTCIceGatheringState) {
        if state == webrtc::peer_connection::RTCIceGatheringState::Complete {
            let _ = self.tx.send(Raw::Candidate {
                candidate: None,
                relay_protocol: None,
                url: None,
            });
        }
    }

    async fn on_ice_connection_state_change(&self, _state: RTCIceConnectionState) {}

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.tx.send(Raw::State(state));
    }
}

/// The connection and the stream of its events.
pub(crate) struct Opened {
    pub pc: Arc<dyn PeerConnection>,
    pub events: PeerEvents,
}

pub(crate) struct PeerEvents {
    rx: mpsc::UnboundedReceiver<Raw>,
    pc: Arc<dyn PeerConnection>,
}

impl PeerEvents {
    /// The next raw event; `None` once the connection is gone. Cancel-safe, so it can sit in a
    /// `select!`; [`Self::resolve`] then runs in the branch body.
    pub(crate) async fn recv(&mut self) -> Option<Raw> {
        self.rx.recv().await
    }

    /// The reportable event of a raw one (`None` for states nobody reports).
    pub(crate) async fn resolve(&self, raw: Raw) -> Option<PeerEvent> {
        match raw {
            Raw::Candidate {
                candidate,
                relay_protocol,
                url,
            } => Some(PeerEvent::Candidate {
                candidate,
                relay_protocol,
                url,
            }),
            Raw::State(RTCPeerConnectionState::Connected) => Some(PeerEvent::Connected {
                remote_certificate: remote_certificate(self.pc.as_ref()).await,
            }),
            Raw::State(RTCPeerConnectionState::Failed) => {
                let reason = if dtls_failed(self.pc.as_ref()).await {
                    PeerFailure::DtlsFailed
                } else {
                    PeerFailure::IceFailed
                };
                Some(PeerEvent::Failed(PeerFault::bare(reason)))
            }
            Raw::State(_) => None,
        }
    }
}

/// Media negotiation inputs of a live-view connection.
pub(crate) struct MediaSetup {
    pub engine: MediaEngine,
    pub registry: Registry,
}

pub(crate) async fn open(
    config: &PeerConfig,
    media: Option<MediaSetup>,
) -> Result<Opened, PeerFault> {
    config.validate()?;
    let ice_servers = config
        .ice_servers
        .iter()
        .map(|server| RTCIceServer {
            urls: server.urls.clone(),
            username: server.username.clone().unwrap_or_default(),
            credential: server.credential.clone().unwrap_or_default(),
        })
        .collect();
    let rtc_config = RTCConfigurationBuilder::new()
        .with_ice_servers(ice_servers)
        .with_ice_transport_policy(RTCIceTransportPolicy::All)
        .with_bundle_policy(RTCBundlePolicy::MaxBundle)
        .build();
    let settings = SettingEngineBuilder::new()
        .with_include_loopback_candidate(config.include_loopback)
        .build();
    let (tx, rx) = mpsc::unbounded_channel();
    let mut builder = PeerConnectionBuilder::new()
        .with_configuration(rtc_config)
        .with_setting_engine(settings)
        .with_handler(Arc::new(Handler { tx }))
        .with_udp_addrs(config.udp_bind.clone());
    if let Some(media) = media {
        builder = builder
            .with_media_engine(media.engine)
            .with_interceptor_registry(media.registry);
    }
    let pc: Arc<dyn PeerConnection> = Arc::new(
        builder
            .build()
            .await
            .map_err(|e| PeerFault::new(PeerFailure::PeerHostUnavailable, e.to_string()))?,
    );
    Ok(Opened {
        events: PeerEvents {
            rx,
            pc: Arc::clone(&pc),
        },
        pc,
    })
}

/// The first offer, or an ICE restart on the same connection. Returns the local SDP.
pub(crate) async fn make_offer(pc: &dyn PeerConnection, ice_restart: bool) -> Result<String, PeerFault> {
    let options = ice_restart.then_some(RTCOfferOptions { ice_restart: true });
    let protocol = |e: webrtc::error::Error| PeerFault::new(PeerFailure::ProtocolError, e.to_string());
    let offer = pc.create_offer(options).await.map_err(protocol)?;
    pc.set_local_description(offer.clone()).await.map_err(protocol)?;
    let local = pc.local_description().await;
    Ok(local.map_or(offer.sdp, |description| description.sdp))
}

pub(crate) async fn apply_answer(pc: &dyn PeerConnection, sdp: String) -> Result<(), PeerFault> {
    let protocol = |e: webrtc::error::Error| PeerFault::new(PeerFailure::ProtocolError, e.to_string());
    let answer = RTCSessionDescription::answer(sdp).map_err(protocol)?;
    pc.set_remote_description(answer).await.map_err(protocol)
}

/// A candidate the connection refuses (one of an earlier ICE generation) changes nothing; the
/// connection stands. `None` is the peer's end of candidates.
pub(crate) async fn add_candidate(pc: &dyn PeerConnection, candidate: Option<Candidate>) {
    if let Some(candidate) = candidate {
        let _ = pc.add_ice_candidate(candidate.into_init()).await;
    }
}

async fn report(pc: &dyn PeerConnection) -> RTCStatsReport {
    pc.get_stats(Instant::now(), StatsSelector::None).await
}

async fn dtls_failed(pc: &dyn PeerConnection) -> bool {
    use rtc::peer_connection::transport::RTCDtlsTransportState;
    report(pc)
        .await
        .transport()
        .is_some_and(|t| t.dtls_state == RTCDtlsTransportState::Failed)
}

pub(crate) async fn remote_certificate(pc: &dyn PeerConnection) -> Option<RemoteCertificate> {
    let report = report(pc).await;
    let transport = report.transport()?;
    match report.get(&transport.remote_certificate_id)? {
        RTCStatsReportEntry::Certificate(c) => Some(RemoteCertificate {
            fingerprint: c.fingerprint.clone(),
            fingerprint_algorithm: c.fingerprint_algorithm.clone(),
        }),
        _ => None,
    }
}

/// The selected candidate pair, only when both candidate types are known.
pub(crate) async fn selected_pair(pc: &dyn PeerConnection) -> Option<CandidatePair> {
    let report = report(pc).await;
    let transport = report.transport()?;
    let RTCStatsReportEntry::IceCandidatePair(pair) =
        report.get(&transport.selected_candidate_pair_id)?
    else {
        return None;
    };
    let candidate_type = |t: RTCIceCandidateType| match t {
        RTCIceCandidateType::Host => Some(CandidateType::Host),
        RTCIceCandidateType::Srflx => Some(CandidateType::Srflx),
        RTCIceCandidateType::Prflx => Some(CandidateType::Prflx),
        RTCIceCandidateType::Relay => Some(CandidateType::Relay),
        _ => None,
    };
    let RTCStatsReportEntry::LocalCandidate(local) = report.get(&format!("RTCLocalIceCandidate_{}", pair.local_candidate_id))? else {
        return None;
    };
    // A remote candidate the peer never signalled is absent from the report: the connectivity
    // check itself discovered it, which is a peer-reflexive candidate.
    let remote_type = match report.get(&format!("RTCRemoteIceCandidate_{}", pair.remote_candidate_id)) {
        Some(RTCStatsReportEntry::RemoteCandidate(remote)) => candidate_type(remote.candidate_type)?,
        None => CandidateType::Prflx,
        Some(_) => return None,
    };
    let local_type = candidate_type(local.candidate_type)?;
    Some(CandidatePair {
        local_type,
        remote_type,
        protocol: if local.protocol.eq_ignore_ascii_case("tcp") {
            TransportProtocol::Tcp
        } else {
            TransportProtocol::Udp
        },
        relay_protocol: (local_type == CandidateType::Relay)
            .then(|| match local.relay_protocol {
                RTCIceServerTransportProtocol::Tcp => Some(RelayProtocol::Tcp),
                RTCIceServerTransportProtocol::Tls => Some(RelayProtocol::Tls),
                RTCIceServerTransportProtocol::Udp => Some(RelayProtocol::Udp),
                _ => None,
            })
            .flatten(),
        current_round_trip_time_ms: (pair.current_round_trip_time > 0.0)
            .then_some(pair.current_round_trip_time * 1_000.0),
        available_outgoing_bitrate: (pair.available_outgoing_bitrate > 0.0)
            .then_some(pair.available_outgoing_bitrate),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_step_that_never_finishes_ends_at_the_budget() {
        let started = tokio::time::Instant::now();
        let fault = PeerBudget::default()
            .step("create offer", std::future::pending::<()>())
            .await
            .unwrap_err();
        assert_eq!(started.elapsed(), STEP_BUDGET);
        assert_eq!(fault.reason, PeerFailure::PeerHostUnavailable);
        assert_eq!(fault.detail.as_deref(), Some("create offer timed out"));
    }

    #[tokio::test(start_paused = true)]
    async fn closing_the_budget_ends_a_pending_step_at_once() {
        let budget = PeerBudget::default();
        budget.close();
        let started = tokio::time::Instant::now();
        let fault = budget.step("apply answer", std::future::pending::<()>()).await.unwrap_err();
        assert_eq!(started.elapsed(), Duration::ZERO);
        assert_eq!(fault.detail.as_deref(), Some("connection closed"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_step_that_finishes_returns_its_value() {
        assert_eq!(PeerBudget::default().step("stats", async { 7 }).await.unwrap(), 7);
    }
}
