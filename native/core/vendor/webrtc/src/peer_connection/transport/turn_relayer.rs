//! TURN relayer for async peer connections.

use super::turn_stream::{
    TurnStream, TurnStreamEndpoint, TurnStreamEvent, TurnStreamId, TurnStreamIo,
};
use crate::runtime::Runtime;
use log::{debug, error, trace, warn};
use rtc::crypto::RTCCryptoProvider;
use rtc::ice::url::{ProtoType, SchemeType};
use rtc::peer_connection::configuration::{RTCIceServer, RTCIceTransportPolicy};
use rtc::peer_connection::state::RTCIceGatheringState;
use rtc::peer_connection::transport::{
    CandidateConfig, CandidateRelayConfig, RTCIceCandidate, RTCIceCandidateInit,
    RTCIceServerTransportProtocol,
};
use rtc::sansio::Protocol;
use rtc::shared::error::{Error, Result};
use rtc::shared::{FourTuple, TaggedBytesMut, TransportContext, TransportProtocol};
use rtc::stun::message::{
    CLASS_ERROR_RESPONSE, CLASS_INDICATION, CLASS_SUCCESS_RESPONSE, Message as StunMessage,
    TransactionId, is_stun_message,
};
use rtc::turn::client::{
    Client as TurnClient, ClientConfig as TurnClientConfig, Event as TurnEvent,
};
use rtc::turn::proto::chandata::ChannelData;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_PENDING_PACKETS_PER_PEER: usize = 64;

#[derive(Debug)]
pub(crate) enum RTCTurnRelayEventIn {
    SocketWriteFailure(FourTuple),
    /// mixdog: the driver's UDP socket at this address is gone.
    SocketLost(SocketAddr),
    /// mixdog: what a TCP or TLS connection to a TURN server reports.
    Stream(TurnStreamEvent),
}

#[derive(Debug)]
pub(crate) enum RTCTurnRelayEventOut {
    /// mixdog: with the transport the allocation behind the candidate was made over, and its
    /// relayed address.
    LocalIceCandidate(RTCIceCandidateInit, RTCIceServerTransportProtocol, SocketAddr),
    /// mixdog: the relay candidate at this relayed address has lost the client it was routed
    /// through, and with it its allocation.
    LocalIceCandidateGone(SocketAddr),
    TurnGatheringComplete,
}

#[derive(Debug)]
struct PendingPermission {
    relay_addr: SocketAddr,
    peer_addr: SocketAddr,
}

/// mixdog: what a TURN client is owned by. A UDP client shares a socket of the driver and is
/// named by its four-tuple; a stream client owns its connection and is named by it, since a TCP
/// four-tuple may equal a UDP one and is gone with the connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum ClientKey {
    Udp(FourTuple),
    Stream(TurnStreamId),
}

/// mixdog: how a client's messages leave.
enum Link {
    /// Through the driver's UDP socket.
    Udp,
    /// Through the connection this client was made for.
    Stream {
        stream: TurnStream,
        server_addr: SocketAddr,
    },
}

/// mixdog: a TCP or TLS connection that is not up yet, and what its client will be made from.
struct ConnectingStream {
    stream: TurnStream,
    endpoint: TurnStreamEndpoint,
    url: String,
    username: String,
    password: String,
}

/// mixdog: whether a frame is relayed data (ChannelData or a Send indication), which a full
/// connection may lose as a full socket would, rather than a request.
fn is_relayed_data(frame: &[u8]) -> bool {
    match frame {
        [first, ..] if first >> 6 == 0b01 => true,
        [first, second, ..] => first & 0x01 == 0 && second & 0x10 != 0,
        _ => false,
    }
}

/// mixdog: a relay candidate's priority (RFC 8445 §5.1.2.1, component 1). Its type preference is
/// 0, so relays that differ only in how the server is reached are ordered by local preference:
/// UDP, then TLS, then TCP. The UDP value is the one the candidate computes on its own.
fn relay_priority(protocol: RTCIceServerTransportProtocol) -> u32 {
    let local_preference: u32 = match protocol {
        RTCIceServerTransportProtocol::Tls => 65_534,
        RTCIceServerTransportProtocol::Tcp => 65_533,
        _ => 65_535,
    };
    (local_preference << 8) + 255
}

struct ManagedTurnClient {
    client: TurnClient,
    url: String,
    allocate_tid: rtc::stun::message::TransactionId,
    local_addr: SocketAddr,
    relay_addr: Option<SocketAddr>,
    gather_finished: bool,
    /// mixdog
    link: Link,
    /// mixdog
    protocol: RTCIceServerTransportProtocol,
    /// mixdog: the endpoint of a stream client, so one gathering opens it once.
    endpoint: Option<TurnStreamEndpoint>,
}

pub(crate) struct RTCTurnRelayer {
    local_addrs: Vec<SocketAddr>,
    ice_servers: Vec<RTCIceServer>,
    ice_gather_policy: RTCIceTransportPolicy,
    state: RTCIceGatheringState,
    /// Host runtime, used to resolve TURN server hostnames.
    runtime: Arc<dyn Runtime>,
    /// Taken from the peer connection rather than resolved here: the whole connection shares one
    /// provider, and no async-layer code selects crypto on its own.
    crypto_provider: Arc<dyn RTCCryptoProvider>,
    allocation_refresh_interval_cap: Option<Duration>,
    clients: HashMap<ClientKey, ManagedTurnClient>,
    relay_addrs: HashMap<SocketAddr, ClientKey>,
    /// mixdog: absent, only `turn:…?transport=udp` urls are gathered.
    stream_io: Option<TurnStreamIo>,
    /// mixdog
    connecting: HashMap<TurnStreamId, ConnectingStream>,
    /// mixdog: counts the gatherings of this relayer, for the ids of their connections.
    generation: u64,
    pending_permissions: HashMap<rtc::stun::message::TransactionId, PendingPermission>,
    pending_permission_pairs: HashMap<(SocketAddr, SocketAddr), rtc::stun::message::TransactionId>,
    pending_packets: HashMap<(SocketAddr, SocketAddr), VecDeque<TaggedBytesMut>>,
    /// Refresh(LIFETIME=0) requests queued while retiring a TURN client. They must survive a
    /// configuration reset (which clears `wouts`) and go out on the socket that owns the
    /// allocation, so they are kept apart and sent first.
    retirement_wouts: VecDeque<TaggedBytesMut>,
    /// mixdog: relayed addresses whose client was retired, for ICE to take their candidates back.
    /// Kept apart for the same reason: a configuration reset clears `events`, not these.
    gone: VecDeque<SocketAddr>,
    wouts: VecDeque<TaggedBytesMut>,
    routs: VecDeque<TaggedBytesMut>,
    events: VecDeque<RTCTurnRelayEventOut>,
}

impl RTCTurnRelayer {
    pub(crate) fn new(
        local_addrs: Vec<SocketAddr>,
        ice_servers: Vec<RTCIceServer>,
        ice_gather_policy: RTCIceTransportPolicy,
        allocation_refresh_interval_cap: Option<Duration>,
        runtime: Arc<dyn Runtime>,
        crypto_provider: Arc<dyn RTCCryptoProvider>,
    ) -> Self {
        Self {
            local_addrs,
            ice_servers,
            ice_gather_policy,
            state: RTCIceGatheringState::New,
            runtime,
            crypto_provider,
            allocation_refresh_interval_cap,
            clients: HashMap::new(),
            relay_addrs: HashMap::new(),
            stream_io: None,
            connecting: HashMap::new(),
            generation: 0,
            pending_permissions: HashMap::new(),
            pending_permission_pairs: HashMap::new(),
            pending_packets: HashMap::new(),
            retirement_wouts: VecDeque::new(),
            gone: VecDeque::new(),
            wouts: VecDeque::new(),
            routs: VecDeque::new(),
            events: VecDeque::new(),
        }
    }

    /// mixdog: lets this relayer gather over TCP and TLS.
    pub(crate) fn with_stream_io(mut self, stream_io: TurnStreamIo) -> Self {
        self.stream_io = Some(stream_io);
        self
    }

    pub(crate) fn state(&self) -> RTCIceGatheringState {
        self.state
    }

    pub(crate) fn update_configuration(
        &mut self,
        ice_servers: Vec<RTCIceServer>,
        ice_gather_policy: RTCIceTransportPolicy,
    ) {
        // A pure credential rotation — same servers, same policy, different username or
        // password — must NOT tear the allocations down. `local_addrs` is fixed at
        // construction (the sockets are shared with host candidates), so a teardown here
        // means the following `gather()` re-`Allocate`s on exactly the same 5-tuple. The
        // server still holds the previous allocation for it and answers **437 (Allocation
        // Mismatch)** per RFC 8656 §7.2, and the restart gathers no relay candidate at all
        // (issue #835).
        //
        // An allocation is a 5-tuple resource, independent of the credential that created
        // it, so the correct move is to re-sign the allocation we already have: update the
        // client's credential and Refresh. Allocation, permissions and channel bindings all
        // survive, so the data path is never interrupted.
        if self.is_credential_only_change(&ice_servers, ice_gather_policy) {
            self.rotate_credentials(&ice_servers);
            self.ice_servers = ice_servers;
            return;
        }

        self.retire_all();
        self.relay_addrs.clear();
        self.pending_permissions.clear();
        self.pending_permission_pairs.clear();
        self.pending_packets.clear();
        self.wouts.clear();
        self.routs.clear();
        self.events.clear();
        self.ice_servers = ice_servers;
        self.ice_gather_policy = ice_gather_policy;
        self.state = RTCIceGatheringState::New;
    }

    /// True when `ice_servers` names exactly the same TURN URLs as the running
    /// configuration under the same policy, differing only in credentials.
    ///
    /// URLs are compared after parsing, so formatting differences do not matter. Any change
    /// to the server set, their order, or the transport policy falls through to the full
    /// teardown path — those genuinely need re-gathering, and only the credential-rotation
    /// case can reuse an allocation.
    fn is_credential_only_change(
        &self,
        ice_servers: &[RTCIceServer],
        ice_gather_policy: RTCIceTransportPolicy,
    ) -> bool {
        // mixdog: a connection still coming up has no allocation to keep either.
        if ice_gather_policy != self.ice_gather_policy
            || self.clients.is_empty()
            || !self.connecting.is_empty()
        {
            return false;
        }

        // Nothing to re-sign unless every live client's allocation is established; a client
        // still mid-Allocate has no allocation to keep.
        if self
            .clients
            .values()
            .any(|managed| managed.relay_addr.is_none())
        {
            return false;
        }

        let urls_of = |servers: &[RTCIceServer]| -> Option<Vec<String>> {
            let mut out = Vec::new();
            for server in servers {
                for url in server.urls().ok()? {
                    out.push(url.to_string());
                }
            }
            Some(out)
        };

        match (urls_of(ice_servers), urls_of(&self.ice_servers)) {
            (Some(new_urls), Some(old_urls)) => !new_urls.is_empty() && new_urls == old_urls,
            _ => false,
        }
    }

    /// Re-signs every live allocation with the rotated credential and refreshes it.
    ///
    /// Best-effort per client: a client whose URL is no longer present, or whose refresh
    /// fails to encode, is left alone rather than torn down — its allocation keeps working
    /// on the old credential until it expires, which is strictly better than forcing the
    /// 437 this path exists to avoid.
    fn rotate_credentials(&mut self, ice_servers: &[RTCIceServer]) {
        // url string -> (username, credential), matching how `gather` derives them.
        let mut credentials: HashMap<String, (String, String)> = HashMap::new();
        for ice_server in ice_servers {
            let Ok(urls) = ice_server.urls() else {
                continue;
            };
            for url in urls {
                credentials.insert(
                    url.to_string(),
                    (url.username.clone(), url.password.clone()),
                );
            }
        }

        for managed in self.clients.values_mut() {
            let Some((username, password)) = credentials.get(&managed.url) else {
                continue;
            };

            let _ = managed
                .client
                .update_credentials(username.clone(), password.clone());

            if let Err(err) = managed.client.refresh_allocations(self.runtime.now()) {
                warn!(
                    "TURN credential rotation: refresh failed for {} via {}: {}",
                    managed.local_addr, managed.url, err
                );
            } else {
                debug!(
                    "TURN credentials rotated for {} via {}, allocation kept",
                    managed.local_addr, managed.url
                );
            }
        }
    }

    pub(crate) fn is_turn_message(&self, msg: &TaggedBytesMut) -> bool {
        self.matching_client_key(msg).is_some()
    }

    pub(crate) fn contains_local_addr(&self, local_addr: SocketAddr) -> bool {
        self.relay_addrs.contains_key(&local_addr)
    }

    pub(crate) async fn gather(&mut self) -> Result<()> {
        if self.state == RTCIceGatheringState::Gathering {
            return Ok(());
        }

        if self.state == RTCIceGatheringState::Complete {
            self.emit_existing_candidates()?;
            self.events
                .push_back(RTCTurnRelayEventOut::TurnGatheringComplete);
            return Ok(());
        }

        self.state = RTCIceGatheringState::Gathering;
        self.generation += 1;

        // Clone the handle up front so the per-server borrows below stay disjoint.
        let runtime = Arc::clone(&self.runtime);

        // mixdog: the stream endpoints first. Opening one only starts its task, so every
        // transport is under way before the UDP urls below are resolved.
        for ice_server in &self.ice_servers {
            // mixdog: an entry that does not parse costs only itself. The configuration was
            // validated on a sanitized copy, so one can reach here; returning on it would leave
            // this gathering started and never finished.
            let Ok(urls) = ice_server.urls() else {
                continue;
            };
            for url in urls {
                if !matches!(url.scheme, SchemeType::Turn | SchemeType::Turns)
                    || url.proto != ProtoType::Tcp
                {
                    continue;
                }
                let Some(stream_io) = &self.stream_io else {
                    warn!("Skipping unsupported non-UDP TURN url {}", url);
                    continue;
                };
                let endpoint = TurnStreamEndpoint {
                    host: url.host.clone(),
                    port: url.port,
                    tls: url.is_secure(),
                };
                let opened = self
                    .connecting
                    .values()
                    .map(|connecting| &connecting.endpoint)
                    .chain(
                        self.clients
                            .values()
                            .filter_map(|managed| managed.endpoint.as_ref()),
                    )
                    .any(|open| *open == endpoint);
                if opened {
                    continue;
                }
                let id = TurnStreamId::next(self.generation);
                debug!("TURN connection {:?} started via {}", id, url);
                self.connecting.insert(
                    id,
                    ConnectingStream {
                        stream: TurnStream::open(&runtime, stream_io, id, endpoint.clone()),
                        endpoint,
                        url: url.to_string(),
                        username: url.username.clone(),
                        password: url.password.clone(),
                    },
                );
            }
        }

        for ice_server in &self.ice_servers {
            // mixdog: as above.
            let urls = match ice_server.urls() {
                Ok(urls) => urls,
                Err(err) => {
                    warn!("Skipping an ICE server entry that does not parse: {}", err);
                    continue;
                }
            };

            for url in urls {
                if !matches!(url.scheme, SchemeType::Turn | SchemeType::Turns) {
                    continue;
                }

                // mixdog: gathered above.
                if url.proto == ProtoType::Tcp {
                    continue;
                }

                // TURN over DTLS.
                if url.is_secure() {
                    warn!("Skipping unsupported secure TURN url {}", url);
                    continue;
                }

                let turn_server_addr = format!("{}:{}", url.host, url.port);
                let resolved_addrs = match runtime.resolve_host(&turn_server_addr).await {
                    Ok(addrs) => addrs,
                    Err(err) => {
                        error!(
                            "Failed to resolve TURN server {}: {}",
                            turn_server_addr, err
                        );
                        continue;
                    }
                };

                for local_addr in &self.local_addrs {
                    let Some(peer_addr) = resolved_addrs
                        .iter()
                        .copied()
                        .find(|addr| addr.is_ipv4() == local_addr.is_ipv4())
                    else {
                        continue;
                    };

                    let four_tuple = FourTuple {
                        local_addr: *local_addr,
                        peer_addr,
                    };
                    let four_tuple = ClientKey::Udp(four_tuple);
                    if self.clients.contains_key(&four_tuple) {
                        continue;
                    }

                    let mut client = TurnClient::new(
                        TurnClientConfig {
                            stun_serv_addr: peer_addr.to_string(),
                            turn_serv_addr: peer_addr.to_string(),
                            local_addr: *local_addr,
                            transport_protocol: TransportProtocol::UDP,
                            username: url.username.clone(),
                            password: url.password.clone(),
                            realm: String::new(),
                            software: String::new(),
                            rto_in_ms: 0,
                            allocation_refresh_interval_cap: self.allocation_refresh_interval_cap,
                        },
                        Arc::clone(&self.crypto_provider),
                    )?;

                    let allocate_tid = client.allocate(self.runtime.now())?;
                    debug!(
                        "TURN allocation started from {} to {} via {}",
                        local_addr, peer_addr, url
                    );

                    self.clients.insert(
                        four_tuple,
                        ManagedTurnClient {
                            client,
                            url: url.to_string(),
                            allocate_tid,
                            local_addr: *local_addr,
                            relay_addr: None,
                            gather_finished: false,
                            link: Link::Udp,
                            protocol: RTCIceServerTransportProtocol::Udp,
                            endpoint: None,
                        },
                    );
                }
            }
        }

        if self.clients.is_empty() && self.connecting.is_empty() {
            self.state = RTCIceGatheringState::Complete;
            self.events
                .push_back(RTCTurnRelayEventOut::TurnGatheringComplete);
        }

        Ok(())
    }

    fn emit_existing_candidates(&mut self) -> Result<()> {
        for managed_client in self.clients.values() {
            if let Some(relay_addr) = managed_client.relay_addr {
                self.events
                    .push_back(RTCTurnRelayEventOut::LocalIceCandidate(
                        Self::build_local_candidate(
                            relay_addr,
                            managed_client.local_addr,
                            &managed_client.url,
                            managed_client.protocol,
                        )?,
                        managed_client.protocol,
                        relay_addr,
                    ));
            }
        }

        Ok(())
    }

    /// mixdog: the candidate is the relayed address, so its transport is UDP whatever reaches
    /// the server; `protocol` only orders it among relays.
    fn build_local_candidate(
        relay_addr: SocketAddr,
        local_addr: SocketAddr,
        url: &str,
        protocol: RTCIceServerTransportProtocol,
    ) -> Result<RTCIceCandidateInit> {
        let candidate = CandidateRelayConfig {
            base_config: CandidateConfig {
                network: "udp".to_owned(),
                address: relay_addr.ip().to_string(),
                port: relay_addr.port(),
                component: 1,
                priority: relay_priority(protocol),
                ..Default::default()
            },
            rel_addr: local_addr.ip().to_string(),
            rel_port: local_addr.port(),
            url: Some(url.to_owned()),
        }
        .new_candidate_relay()?;

        let mut candidate_init = RTCIceCandidate::from(&candidate).to_json()?;
        candidate_init.url = Some(url.to_owned());
        Ok(candidate_init)
    }

    fn maybe_emit_gathering_complete(&mut self) {
        if self.state == RTCIceGatheringState::Gathering
            && self.connecting.is_empty()
            && self.clients.values().all(|client| client.gather_finished)
        {
            self.state = RTCIceGatheringState::Complete;
            self.events
                .push_back(RTCTurnRelayEventOut::TurnGatheringComplete);
        }
    }

    /// Which TURN client, if any, this inbound packet belongs to.
    ///
    /// These sockets are shared with [`RTCStunGatherer`](super::stun_gatherer::RTCStunGatherer),
    /// and when the configuration points `stun:` and `turn:` URLs at one `host:port` — the standard
    /// single-listener coturn deployment — the four-tuple is *identical* for both users. So the
    /// message is inspected before the four-tuple is trusted, because in that deployment an address
    /// match cannot say whose the packet is: a response is matched by transaction id, and only the
    /// framings that carry none fall back to addresses. See [webrtc#890].
    ///
    /// [webrtc#890]: https://github.com/webrtc-rs/webrtc/issues/890
    fn matching_client_key(&self, msg: &TaggedBytesMut) -> Option<ClientKey> {
        // ChannelData is not STUN-framed and carries no transaction id, so addresses are all there
        // is — and they suffice, because the gatherer neither sends nor receives it.
        if ChannelData::is_channel_data(&msg.message) {
            return self.match_by_local_addr(msg);
        }

        if !is_stun_message(&msg.message) {
            return None;
        }

        let mut stun_message = StunMessage::new();
        stun_message.raw = msg.message.to_vec();
        if stun_message.decode().is_err() {
            return None;
        }

        match stun_message.typ.class {
            // Data and Send indications are not transaction-matched, so they route by address for
            // the same reason ChannelData does.
            CLASS_INDICATION => self.match_by_local_addr(msg),

            // RFC 5389 section 7.3.3: a response belongs to whoever sent the request, identified by
            // transaction id and by nothing else. Every TURN request registers one, so a response
            // no client is waiting on is not ours — most often a Binding response for the gatherer,
            // arriving from the address we share with it.
            CLASS_SUCCESS_RESPONSE | CLASS_ERROR_RESPONSE => {
                self.match_by_transaction(&stun_message.transaction_id)
            }

            // An inbound request on these sockets is an ICE connectivity check, which belongs to
            // neither this relayer nor the gatherer.
            _ => None,
        }
    }

    /// The client waiting on `transaction_id`.
    ///
    /// Searches every client rather than the one whose four-tuple matches, because a multi-homed
    /// server may answer from an address other than the one we sent to — the case
    /// [`match_same_local_client`](Self::match_same_local_client) exists for. A transaction id
    /// identifies the client outright, so that heuristic is not needed here.
    fn match_by_transaction(&self, transaction_id: &TransactionId) -> Option<ClientKey> {
        // mixdog: a datagram is never a stream client's, whose messages arrive as stream events.
        self.clients
            .iter()
            .find(|(key, managed)| {
                matches!(key, ClientKey::Udp(_)) && managed.client.has_transaction(transaction_id)
            })
            .map(|(four_tuple, _)| *four_tuple)
    }

    /// The client on this packet's local socket, disambiguated by peer address.
    ///
    /// For the framings that carry no transaction id. Prefers an exact four-tuple, then falls back
    /// to clients sharing the local socket.
    fn match_by_local_addr(&self, msg: &TaggedBytesMut) -> Option<ClientKey> {
        let exact = FourTuple::from(&msg.transport);
        if self.clients.contains_key(&ClientKey::Udp(exact)) {
            return Some(ClientKey::Udp(exact));
        }

        let same_local: Vec<FourTuple> = self
            .clients
            .keys()
            .filter_map(|key| match key {
                ClientKey::Udp(four_tuple) => Some(*four_tuple),
                ClientKey::Stream(_) => None,
            })
            .filter(|four_tuple| four_tuple.local_addr == msg.transport.local_addr)
            .collect();

        Self::match_same_local_client(&same_local, msg.transport.peer_addr).map(ClientKey::Udp)
    }

    fn match_same_local_client(
        candidates: &[FourTuple],
        peer_addr: SocketAddr,
    ) -> Option<FourTuple> {
        if candidates.len() == 1 {
            return Some(candidates[0]);
        }

        if let Some(exact) = candidates
            .iter()
            .copied()
            .find(|four_tuple| four_tuple.peer_addr == peer_addr)
        {
            return Some(exact);
        }

        let mut matching_port = candidates
            .iter()
            .copied()
            .filter(|four_tuple| four_tuple.peer_addr.port() == peer_addr.port());
        let first = matching_port.next()?;
        if matching_port.next().is_none() {
            Some(first)
        } else {
            None
        }
    }

    /// mixdog: the one way a TURN client leaves, whatever makes it leave: its connection or its
    /// socket is lost, a request ran out, the configuration changed, the peer connection closes
    /// or is dropped. It always does the same things:
    ///
    /// - what the client had queued is dropped: its own pending messages and, for a UDP client,
    ///   those already handed to the driver's queue;
    /// - with `transport_alive`, a live allocation is released (RFC 8656 §7: a Refresh with
    ///   LIFETIME 0) on the transport that owns it and ahead of anything else: first out of the
    ///   driver's socket, or in the place its connection keeps for it. A transport that is gone
    ///   carries no release: the server reclaims the allocation with the connection or at the end
    ///   of its lifetime;
    /// - its routes, pending permissions and buffered packets go;
    /// - ICE is told that the candidate at its relayed address is gone ([`Self::poll_gone`]).
    fn retire(&mut self, key: ClientKey, transport_alive: bool) {
        let Some(mut managed_client) = self.clients.remove(&key) else {
            return;
        };
        // `Client::close` clears transaction state and leaves what was queued to send: relayed
        // data, requests. None of it goes out for a client that is leaving.
        let _ = managed_client.client.close();
        while managed_client.client.poll_write().is_some() {}
        if let ClientKey::Udp(four_tuple) = key {
            self.wouts
                .retain(|msg| FourTuple::from(&msg.transport) != four_tuple);
        }

        // The release is `Relay::close`, which queues an authenticated Refresh(LIFETIME=0): the
        // only thing the client holds now.
        let mut release = Vec::new();
        if transport_alive && let Some(relay_addr) = managed_client.relay_addr {
            if let Ok(mut relay) = managed_client.client.relay(relay_addr) {
                let _ = relay.close(self.runtime.now());
            }
            while let Some(msg) = managed_client.client.poll_write() {
                release.push(msg);
            }
        }
        match std::mem::replace(&mut managed_client.link, Link::Udp) {
            // `retirement_wouts` is sent before `wouts`.
            Link::Udp => self.retirement_wouts.extend(release),
            Link::Stream { stream, .. } if transport_alive => {
                let frames: Vec<u8> = release
                    .iter()
                    .flat_map(|msg| msg.message.iter().copied())
                    .collect();
                // Without an allocation there is no frame, and this only closes the connection.
                stream.release(frames);
            }
            Link::Stream { stream, .. } => stream.abort(),
        }

        if let Some(relay_addr) = managed_client.relay_addr.take() {
            self.relay_addrs.remove(&relay_addr);
            self.pending_packets
                .retain(|(addr, _), _| *addr != relay_addr);
            self.pending_permissions
                .retain(|_, pending| pending.relay_addr != relay_addr);
            self.pending_permission_pairs
                .retain(|(addr, _), _| *addr != relay_addr);
            // An announcement of the candidate that has not been read yet is not delivered:
            // read after the removal below, it would put the candidate back without a route.
            self.events.retain(|event| {
                !matches!(event, RTCTurnRelayEventOut::LocalIceCandidate(_, _, announced) if *announced == relay_addr)
            });
            self.gone.push_back(relay_addr);
        }
        // A gathering this client was the last unfinished part of ends with it.
        self.maybe_emit_gathering_complete();
    }

    /// mixdog: the next relayed address whose candidate ICE must take back. Also the first thing
    /// [`poll_event`](Protocol::poll_event) reports; asked for directly by a driver that is
    /// about to replace this relayer.
    pub(crate) fn poll_gone(&mut self) -> Option<SocketAddr> {
        self.gone.pop_front()
    }

    /// mixdog: whether this relayer has a client or a connection to end.
    pub(crate) fn has_clients(&self) -> bool {
        !self.clients.is_empty() || !self.connecting.is_empty()
    }

    /// mixdog: whether a TCP or TLS connection is up or coming up. Such a connection is a
    /// transport of the driver's as much as a socket is.
    pub(crate) fn has_streams(&self) -> bool {
        !self.connecting.is_empty()
            || self
                .clients
                .keys()
                .any(|key| matches!(key, ClientKey::Stream(_)))
    }

    /// Releases every allocation and ends every connection.
    fn retire_all(&mut self) {
        let keys: Vec<ClientKey> = self.clients.keys().copied().collect();
        for key in keys {
            self.retire(key, true);
        }
        for (_, connecting) in self.connecting.drain() {
            connecting.stream.abort();
        }
    }

    /// mixdog: one report of a TCP or TLS connection. An id that names no live connection is one
    /// that was retired, and its report changes nothing.
    fn handle_stream_event(&mut self, event: TurnStreamEvent) {
        match event {
            TurnStreamEvent::Connected {
                id,
                local_addr,
                peer_addr,
            } => {
                let Some(connecting) = self.connecting.remove(&id) else {
                    return;
                };
                let ConnectingStream {
                    stream,
                    endpoint,
                    url,
                    username,
                    password,
                } = connecting;
                let protocol = if endpoint.tls {
                    RTCIceServerTransportProtocol::Tls
                } else {
                    RTCIceServerTransportProtocol::Tcp
                };
                // The addresses are the connection's own, so the allocation's five-tuple and the
                // candidate's related address are the real ones.
                let started = TurnClient::new(
                    TurnClientConfig {
                        stun_serv_addr: peer_addr.to_string(),
                        turn_serv_addr: peer_addr.to_string(),
                        local_addr,
                        transport_protocol: TransportProtocol::TCP,
                        username,
                        password,
                        realm: String::new(),
                        software: String::new(),
                        rto_in_ms: 0,
                        allocation_refresh_interval_cap: self.allocation_refresh_interval_cap,
                    },
                    Arc::clone(&self.crypto_provider),
                )
                .and_then(|mut client| {
                    let allocate_tid = client.allocate(self.runtime.now())?;
                    Ok((client, allocate_tid))
                });
                match started {
                    Ok((client, allocate_tid)) => {
                        debug!(
                            "TURN allocation started from {} to {} over {:?}",
                            local_addr, peer_addr, protocol
                        );
                        self.clients.insert(
                            ClientKey::Stream(id),
                            ManagedTurnClient {
                                client,
                                url,
                                allocate_tid,
                                local_addr,
                                relay_addr: None,
                                gather_finished: false,
                                link: Link::Stream {
                                    stream,
                                    server_addr: peer_addr,
                                },
                                protocol,
                                endpoint: Some(endpoint),
                            },
                        );
                    }
                    Err(err) => {
                        error!("TURN client over {:?} failed to start: {}", protocol, err);
                        stream.abort();
                        self.maybe_emit_gathering_complete();
                    }
                }
            }
            TurnStreamEvent::Message { id, message } => {
                let Some(managed_client) = self.clients.get_mut(&ClientKey::Stream(id)) else {
                    return;
                };
                let Link::Stream { server_addr, .. } = &managed_client.link else {
                    return;
                };
                let msg = TaggedBytesMut {
                    now: self.runtime.now(),
                    transport: TransportContext {
                        local_addr: managed_client.local_addr,
                        peer_addr: *server_addr,
                        ecn: None,
                        transport_protocol: TransportProtocol::TCP,
                    },
                    message: bytes::BytesMut::from(&message[..]),
                };
                // One message the client refuses does not end the connection: the stream is
                // still framed.
                if let Err(err) = managed_client.client.handle_read(msg) {
                    debug!("TURN message over {:?} refused: {}", managed_client.protocol, err);
                }
            }
            TurnStreamEvent::Closed { id, reason } => {
                if let Some(connecting) = self.connecting.remove(&id) {
                    warn!(
                        "TURN connection over {} failed: {}",
                        if connecting.endpoint.tls { "TLS" } else { "TCP" },
                        reason
                    );
                } else if let Some(managed_client) = self.clients.get(&ClientKey::Stream(id)) {
                    warn!(
                        "TURN connection over {:?} from {} lost: {}",
                        managed_client.protocol, managed_client.local_addr, reason
                    );
                    // Its allocation goes with it: routes, pending permissions and buffered
                    // packets. Nothing reconnects behind the candidate it produced, which is
                    // taken back.
                    self.retire(ClientKey::Stream(id), false);
                    return;
                } else {
                    return;
                }
                self.maybe_emit_gathering_complete();
            }
        }
    }

    fn buffer_packet(
        &mut self,
        relay_addr: SocketAddr,
        peer_addr: SocketAddr,
        packet: TaggedBytesMut,
    ) {
        let queue = self
            .pending_packets
            .entry((relay_addr, peer_addr))
            .or_default();
        if queue.len() >= MAX_PENDING_PACKETS_PER_PEER {
            let _ = queue.pop_front();
        }
        queue.push_back(packet);
    }

    fn flush_pending_packets(&mut self, relay_addr: SocketAddr, peer_addr: SocketAddr) {
        let Some(four_tuple) = self.relay_addrs.get(&relay_addr).copied() else {
            return;
        };
        let Some(mut packets) = self.pending_packets.remove(&(relay_addr, peer_addr)) else {
            return;
        };
        let Some(managed_client) = self.clients.get_mut(&four_tuple) else {
            return;
        };

        while let Some(packet) = packets.pop_front() {
            match managed_client
                .client
                .relay(relay_addr)
                .and_then(|mut relay| relay.send_to(packet.now, &packet.message, peer_addr))
            {
                Ok(()) => {}
                Err(Error::ErrNoPermission) => {
                    self.pending_packets
                        .entry((relay_addr, peer_addr))
                        .or_default()
                        .push_front(packet);
                    break;
                }
                Err(err) => {
                    error!(
                        "Failed to flush buffered relay packet to {} via {}: {}",
                        peer_addr, relay_addr, err
                    );
                }
            }
        }
    }
}

impl Protocol<TaggedBytesMut, TaggedBytesMut, RTCTurnRelayEventIn> for RTCTurnRelayer {
    type Rout = TaggedBytesMut;
    type Wout = TaggedBytesMut;
    type Eout = RTCTurnRelayEventOut;
    type Error = Error;
    type Time = Instant;

    fn handle_read(&mut self, msg: TaggedBytesMut) -> Result<()> {
        if let Some(client_key) = self.matching_client_key(&msg)
            && let Some(managed_client) = self.clients.get_mut(&client_key)
        {
            managed_client.client.handle_read(msg)?;
        }
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.routs.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedBytesMut) -> Result<()> {
        let relay_addr = msg.transport.local_addr;
        let peer_addr = msg.transport.peer_addr;

        let Some(four_tuple) = self.relay_addrs.get(&relay_addr).copied() else {
            return Err(Error::Other(format!(
                "unknown relay local address {} for outbound packet",
                relay_addr
            )));
        };
        let Some(managed_client) = self.clients.get_mut(&four_tuple) else {
            return Err(Error::Other(format!(
                "missing TURN client for relay local address {}",
                relay_addr
            )));
        };

        match managed_client
            .client
            .relay(relay_addr)
            .and_then(|mut relay| relay.send_to(msg.now, &msg.message, peer_addr))
        {
            Ok(()) => Ok(()),
            Err(Error::ErrNoPermission) => {
                if !self
                    .pending_permission_pairs
                    .contains_key(&(relay_addr, peer_addr))
                    && let Some(tid) = managed_client
                        .client
                        .relay(relay_addr)?
                        .create_permission(msg.now, peer_addr)?
                {
                    self.pending_permissions.insert(
                        tid,
                        PendingPermission {
                            relay_addr,
                            peer_addr,
                        },
                    );
                    self.pending_permission_pairs
                        .insert((relay_addr, peer_addr), tid);
                }

                self.buffer_packet(relay_addr, peer_addr, msg);
                Ok(())
            }
            Err(err) => Err(err),
        }
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        if let Some(msg) = self.retirement_wouts.pop_front() {
            return Some(msg);
        }
        // mixdog: stream clients whose connection took no request.
        let mut unable: Vec<ClientKey> = Vec::new();
        for (key, managed_client) in self.clients.iter_mut() {
            // mixdog: a stream client's messages go to its own connection, never to a socket
            // of the driver, and never wait for it: the connection's task does the writing.
            // Nothing is kept here for a connection without room. Relayed data is lost, as on
            // a full socket; a request is sent once over a reliable transport, so a connection
            // that cannot take one carries no allocation any longer.
            if let Link::Stream { stream, .. } = &managed_client.link {
                while let Some(msg) = managed_client.client.poll_write() {
                    let frame = msg.message.to_vec();
                    if is_relayed_data(&frame) {
                        stream.send_data(frame);
                    } else if !stream.send_request(frame) {
                        unable.push(*key);
                        break;
                    }
                }
                continue;
            }
            while let Some(msg) = managed_client.client.poll_write() {
                self.wouts.push_back(msg);
            }
        }
        for key in unable {
            warn!("TURN connection {:?} takes no more requests", key);
            self.retire(key, false);
        }
        self.wouts.pop_front()
    }

    fn handle_event(&mut self, evt: RTCTurnRelayEventIn) -> Result<()> {
        match evt {
            RTCTurnRelayEventIn::SocketWriteFailure(four_tuple) => {
                // The socket is already unusable, so a Refresh(0) could not be delivered; the
                // server reclaims this allocation when its lifetime expires.
                self.retire(ClientKey::Udp(four_tuple), false);
            }
            RTCTurnRelayEventIn::SocketLost(local_addr) => {
                // mixdog: every allocation made from that socket went with it, and no later
                // gathering allocates from it.
                self.local_addrs.retain(|addr| *addr != local_addr);
                let lost: Vec<ClientKey> = self
                    .clients
                    .keys()
                    .copied()
                    .filter(|key| {
                        matches!(key, ClientKey::Udp(four_tuple) if four_tuple.local_addr == local_addr)
                    })
                    .collect();
                for key in lost {
                    self.retire(key, false);
                }
            }
            RTCTurnRelayEventIn::Stream(event) => self.handle_stream_event(event),
        }
        Ok(())
    }

    fn poll_event(&mut self) -> Option<Self::Eout> {
        // mixdog: before anything a later gathering reports.
        if let Some(relay_addr) = self.poll_gone() {
            return Some(RTCTurnRelayEventOut::LocalIceCandidateGone(relay_addr));
        }
        let keys: Vec<ClientKey> = self.clients.keys().copied().collect();
        for four_tuple in keys {
            let mut gathered_complete = false;
            // mixdog: a stream client whose Allocate failed, or whose request ran out.
            let mut retire = false;
            let mut local_candidate = None;
            let mut pending_flush: Vec<(SocketAddr, SocketAddr)> = vec![];
            let mut pending_drop: Vec<(SocketAddr, SocketAddr)> = vec![];
            let mut read_msgs: Vec<TaggedBytesMut> = vec![];

            if let Some(managed_client) = self.clients.get_mut(&four_tuple) {
                while let Some(event) = managed_client.client.poll_event() {
                    match event {
                        TurnEvent::AllocateResponse(tid, relay_addr)
                            if tid == managed_client.allocate_tid =>
                        {
                            managed_client.relay_addr = Some(relay_addr);
                            managed_client.gather_finished = true;
                            self.relay_addrs.insert(relay_addr, four_tuple);
                            local_candidate = Some((
                                Self::build_local_candidate(
                                    relay_addr,
                                    managed_client.local_addr,
                                    &managed_client.url,
                                    managed_client.protocol,
                                ),
                                managed_client.protocol,
                                relay_addr,
                            ));
                            gathered_complete = true;
                        }
                        TurnEvent::AllocateError(tid, err)
                            if tid == managed_client.allocate_tid =>
                        {
                            error!(
                                "TURN allocation failed from {} over {:?}: {}",
                                managed_client.local_addr, managed_client.protocol, err
                            );
                            managed_client.gather_finished = true;
                            gathered_complete = true;
                            retire = matches!(managed_client.link, Link::Stream { .. });
                        }
                        TurnEvent::CreatePermissionResponse(tid, peer_addr) => {
                            if let Some(pending) = self.pending_permissions.remove(&tid) {
                                self.pending_permission_pairs
                                    .remove(&(pending.relay_addr, pending.peer_addr));
                                pending_flush.push((pending.relay_addr, peer_addr));
                            }
                        }
                        TurnEvent::CreatePermissionError(tid, err) => {
                            error!("TURN permission request failed: {}", err);
                            if let Some(pending) = self.pending_permissions.remove(&tid) {
                                self.pending_permission_pairs
                                    .remove(&(pending.relay_addr, pending.peer_addr));
                                pending_drop.push((pending.relay_addr, pending.peer_addr));
                            }
                        }
                        TurnEvent::DataIndicationOrChannelData(_, peer_addr, data) => {
                            if let Some(relay_addr) = managed_client.relay_addr {
                                read_msgs.push(TaggedBytesMut {
                                    now: self.runtime.now(),
                                    transport: TransportContext {
                                        local_addr: relay_addr,
                                        peer_addr,
                                        ecn: None,
                                        transport_protocol: TransportProtocol::UDP,
                                    },
                                    message: data,
                                });
                            }
                        }
                        TurnEvent::TransactionTimeout(tid) => {
                            error!("TURN transaction timed out: {:?}", tid);
                            if let Some(pending) = self.pending_permissions.remove(&tid) {
                                self.pending_permission_pairs
                                    .remove(&(pending.relay_addr, pending.peer_addr));
                                pending_drop.push((pending.relay_addr, pending.peer_addr));
                            } else if tid == managed_client.allocate_tid {
                                managed_client.gather_finished = true;
                                gathered_complete = true;
                            }
                            // mixdog: over a connection a request is sent once and waited for
                            // as long as a transaction may take. One that ran out means the
                            // connection carries no more requests, and its frame, if the
                            // connection still holds it, must not go out late: the connection
                            // ends with the client.
                            if matches!(managed_client.link, Link::Stream { .. }) {
                                retire = true;
                            }
                        }
                        TurnEvent::BindingResponse(_, _) | TurnEvent::BindingError(_, _) => {}
                        _ => {
                            warn!("Ignoring unknown TurnEvent variant");
                        }
                    }
                }
            }

            for (relay_addr, peer_addr) in pending_flush {
                self.flush_pending_packets(relay_addr, peer_addr);
            }
            for (relay_addr, peer_addr) in pending_drop {
                self.pending_packets.remove(&(relay_addr, peer_addr));
            }
            for msg in read_msgs {
                self.routs.push_back(msg);
            }
            if let Some((candidate_result, protocol, relay_addr)) = local_candidate {
                match candidate_result {
                    Ok(candidate) => {
                        trace!("LocalRelayCandidate {:?}", candidate);
                        self.events
                            .push_back(RTCTurnRelayEventOut::LocalIceCandidate(
                                candidate, protocol, relay_addr,
                            ));
                    }
                    Err(err) => {
                        error!("failed to build relay candidate after allocation: {}", err);
                    }
                }
            }
            if retire {
                self.retire(four_tuple, false);
            }
            if gathered_complete {
                self.maybe_emit_gathering_complete();
            }
        }

        self.events.pop_front()
    }

    fn handle_timeout(&mut self, now: Self::Time) -> Result<()> {
        for managed_client in self.clients.values_mut() {
            managed_client.client.handle_timeout(now)?;
        }
        Ok(())
    }

    fn poll_timeout(&mut self) -> Option<Self::Time> {
        let mut eto = None;
        for managed_client in self.clients.values_mut() {
            if let Some(next) = managed_client.client.poll_timeout() {
                eto = Some(eto.map_or(next, |current| std::cmp::min(current, next)));
            }
        }
        eto
    }

    fn close(&mut self) -> Result<()> {
        self.retire_all();
        Ok(())
    }
}

// A built-in provider is required: these construct real peer connections, and construction
// resolves a provider. The no-built-in configuration is exercised by the provider tests in
// `tests/`, which supply their own.
#[cfg(all(test, any(feature = "crypto-ring", feature = "crypto-aws-lc-rs")))]
mod tests {
    use super::*;
    use bytes::BytesMut;
    use rtc::peer_connection::configuration::RTCIceServer;
    use rtc::stun::attributes::{ATTR_NONCE, ATTR_REALM};
    use rtc::stun::error_code::CODE_UNAUTHORIZED;
    use rtc::stun::message::{
        CLASS_ERROR_RESPONSE, CLASS_SUCCESS_RESPONSE, MessageType, TransactionId,
    };
    use rtc::stun::textattrs::{Nonce, Realm};
    use rtc::stun::xoraddr::XorMappedAddress;
    use std::net::{IpAddr, Ipv4Addr};

    fn build_binding_success(transaction_id: TransactionId) -> StunMessage {
        let mut msg = StunMessage::new();
        msg.build(&[
            Box::new(transaction_id),
            Box::new(MessageType::new(
                rtc::stun::message::METHOD_BINDING,
                CLASS_SUCCESS_RESPONSE,
            )),
            Box::new(XorMappedAddress {
                ip: IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)),
                port: 51234,
            }),
        ])
        .expect("failed to build Binding success response");
        msg
    }

    fn tagged(local_addr: SocketAddr, peer_addr: SocketAddr, raw: &[u8]) -> TaggedBytesMut {
        TaggedBytesMut {
            now: Instant::now(), // Exemption: usage in #test code
            transport: TransportContext {
                local_addr,
                peer_addr,
                ecn: None,
                transport_protocol: TransportProtocol::UDP,
            },
            message: BytesMut::from(raw),
        }
    }

    fn build_turn_allocate_unauthorized(transaction_id: TransactionId) -> StunMessage {
        let mut msg = StunMessage::new();
        msg.build(&[
            Box::new(transaction_id),
            Box::new(MessageType::new(
                rtc::stun::message::METHOD_ALLOCATE,
                CLASS_ERROR_RESPONSE,
            )),
            Box::new(CODE_UNAUTHORIZED),
            Box::new(Realm::new(ATTR_REALM, "webrtc.rs".to_owned())),
            Box::new(Nonce::new(ATTR_NONCE, "nonce".to_owned())),
        ])
        .expect("failed to build TURN unauthorized response");
        msg
    }

    #[test]
    fn routes_turn_allocate_response_by_local_addr_and_port() {
        futures::executor::block_on(async {
            let local_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 50000);
            let turn_peer_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3478);
            let mut relayer = RTCTurnRelayer::new(
                vec![local_addr],
                vec![RTCIceServer {
                    urls: vec![format!("turn:{}?transport=udp", turn_peer_addr)],
                    username: "user".to_owned(),
                    credential: "pass".to_owned(),
                }],
                RTCIceTransportPolicy::Relay,
                None,
                crate::runtime::default_runtime().expect("test requires a runtime feature"),
                rtc::crypto::default_provider().expect("a built-in crypto provider for tests"),
            );

            relayer.gather().await.expect("TURN gather should start");
            let initial_request = relayer.poll_write().expect("initial Allocate request");
            assert_eq!(initial_request.transport.peer_addr, turn_peer_addr);

            let mut initial_request_msg = StunMessage::new();
            initial_request_msg.raw = initial_request.message.to_vec();
            initial_request_msg
                .decode()
                .expect("decode initial Allocate request");

            let response = build_turn_allocate_unauthorized(initial_request_msg.transaction_id);
            let msg = TaggedBytesMut {
                now: Instant::now(), // Exemption: usage in #test code
                transport: TransportContext {
                    local_addr,
                    peer_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)), 3478),
                    ecn: None,
                    transport_protocol: TransportProtocol::UDP,
                },
                message: BytesMut::from(&response.raw[..]),
            };

            assert!(
                relayer.is_turn_message(&msg),
                "TURN error response on the same local socket and TURN port should route to the relayer"
            );

            relayer
                .handle_read(msg)
                .expect("relayer should accept TURN unauthorized response");

            let retry_request = relayer
                .poll_write()
                .expect("authenticated Allocate retry after unauthorized response");
            assert_eq!(retry_request.transport.peer_addr.port(), 3478);
            assert!(
                retry_request.message.len() > initial_request.message.len(),
                "authenticated retry should be larger than the unauthenticated Allocate request"
            );
        });
    }

    /// webrtc#890: with `stun:` and `turn:` on one address, the Binding response the gatherer is
    /// waiting for arrives on the TURN client's exact four-tuple. Claimed here, it is discarded for
    /// having no matching transaction and no server-reflexive candidate is ever gathered.
    #[test]
    fn binding_response_from_turn_server_addr_is_not_turn_traffic() {
        futures::executor::block_on(async {
            let local_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 50000);
            let shared_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3478);
            let mut relayer = RTCTurnRelayer::new(
                vec![local_addr],
                vec![RTCIceServer {
                    urls: vec![format!("turn:{}?transport=udp", shared_addr)],
                    username: "user".to_owned(),
                    credential: "pass".to_owned(),
                }],
                RTCIceTransportPolicy::Relay,
                None,
                crate::runtime::default_runtime().expect("test requires a runtime feature"),
                rtc::crypto::default_provider().expect("a built-in crypto provider for tests"),
            );

            relayer.gather().await.expect("TURN gather should start");
            relayer.poll_write().expect("initial Allocate request");

            // The gatherer's transaction, not the relayer's, on the shared four-tuple.
            let response = build_binding_success(TransactionId::new());
            let msg = tagged(local_addr, shared_addr, &response.raw);

            assert!(
                !relayer.is_turn_message(&msg),
                "a Binding response is the STUN gatherer's even on the TURN client's four-tuple"
            );
        });
    }

    /// The guard must not cost the relayer its own traffic on the same four-tuple.
    #[test]
    fn allocate_response_on_exact_four_tuple_still_routes_to_turn() {
        futures::executor::block_on(async {
            let local_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 50000);
            let shared_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3478);
            let mut relayer = RTCTurnRelayer::new(
                vec![local_addr],
                vec![RTCIceServer {
                    urls: vec![format!("turn:{}?transport=udp", shared_addr)],
                    username: "user".to_owned(),
                    credential: "pass".to_owned(),
                }],
                RTCIceTransportPolicy::Relay,
                None,
                crate::runtime::default_runtime().expect("test requires a runtime feature"),
                rtc::crypto::default_provider().expect("a built-in crypto provider for tests"),
            );

            relayer.gather().await.expect("TURN gather should start");
            let request = relayer.poll_write().expect("initial Allocate request");
            let mut request_msg = StunMessage::new();
            request_msg.raw = request.message.to_vec();
            request_msg.decode().expect("decode Allocate request");

            let response = build_turn_allocate_unauthorized(request_msg.transaction_id);
            let msg = tagged(local_addr, shared_addr, &response.raw);

            assert!(
                relayer.is_turn_message(&msg),
                "an Allocate response on the TURN client's four-tuple is TURN traffic"
            );
        });
    }

    /// The property a method-based guard could not have. A Binding response *is* TURN traffic when
    /// this client sent the request — as it would if the relayer ever gained STUN keepalives or
    /// consent freshness. Ownership follows the transaction id, so that stays correct without
    /// anyone remembering to revisit this function.
    #[test]
    fn binding_response_matching_an_outstanding_turn_transaction_routes_to_turn() {
        futures::executor::block_on(async {
            let local_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 50000);
            let shared_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3478);
            let mut relayer = RTCTurnRelayer::new(
                vec![local_addr],
                vec![RTCIceServer {
                    urls: vec![format!("turn:{}?transport=udp", shared_addr)],
                    username: "user".to_owned(),
                    credential: "pass".to_owned(),
                }],
                RTCIceTransportPolicy::Relay,
                None,
                crate::runtime::default_runtime().expect("test requires a runtime feature"),
                rtc::crypto::default_provider().expect("a built-in crypto provider for tests"),
            );

            relayer.gather().await.expect("TURN gather should start");
            relayer.poll_write().expect("initial Allocate request");

            let four_tuple = *relayer.clients.keys().next().expect("one TURN client");
            let tid = relayer
                .clients
                .get_mut(&four_tuple)
                .expect("the TURN client")
                .client
                .send_binding_request_to(
                    Instant::now(), // Exemption: usage in #test code
                    shared_addr,
                )
                .expect("TURN client sends its own Binding request");

            let response = build_binding_success(tid);
            let msg = tagged(local_addr, shared_addr, &response.raw);

            assert!(
                relayer.is_turn_message(&msg),
                "a Binding response the TURN client is waiting on is its own"
            );
        });
    }

    /// ChannelData carries no transaction id, so it must still be claimed on addresses alone.
    #[test]
    fn channel_data_on_exact_four_tuple_still_routes_to_turn() {
        futures::executor::block_on(async {
            let local_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 50000);
            let shared_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3478);
            let mut relayer = RTCTurnRelayer::new(
                vec![local_addr],
                vec![RTCIceServer {
                    urls: vec![format!("turn:{}?transport=udp", shared_addr)],
                    username: "user".to_owned(),
                    credential: "pass".to_owned(),
                }],
                RTCIceTransportPolicy::Relay,
                None,
                crate::runtime::default_runtime().expect("test requires a runtime feature"),
                rtc::crypto::default_provider().expect("a built-in crypto provider for tests"),
            );

            relayer.gather().await.expect("TURN gather should start");
            relayer.poll_write().expect("initial Allocate request");

            // Channel 0x4000, four payload bytes, padded to a 4-byte boundary.
            let channel_data = [0x40u8, 0x00, 0x00, 0x04, 0xde, 0xad, 0xbe, 0xef];
            assert!(
                ChannelData::is_channel_data(&channel_data),
                "test fixture must be valid ChannelData"
            );
            let msg = tagged(local_addr, shared_addr, &channel_data);

            assert!(
                relayer.is_turn_message(&msg),
                "ChannelData has no transaction id and must route by address"
            );
        });
    }
}
