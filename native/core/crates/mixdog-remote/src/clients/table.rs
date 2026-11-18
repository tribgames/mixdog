//! The phone legs the relay announced: challenge, hello and the encrypted channel of each. A
//! client is a plain value; its session never waits on another client's (DS-REM-5).

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use std::sync::Arc;

use crate::e2ee::{Challenge, Channel, E2eeError, PairingMaterial, Sealed, ServerIdentity, Wire, accept_client_hello, is_hello};
use crate::leg::frame::Payload;
use crate::transport::coordinator::EndReason;
use crate::transport::session::TransportSession;

pub const MAX_CLIENTS: usize = 64;
const HOST_NAME_MAX: usize = 80;

/// The capability of an authenticated phone to be sent media, owned by the client table: once an unpair (or an admission under one)
/// sets it, it never clears, and every holder sees it. A media request and a direct-transport stream take it together with the
/// media key and the device, before they spawn or wait, so a task delayed past the unpair holds the revoked one and cannot obtain a
/// fresh one.
///
/// Guarantee: no new delivery is committed after [`revoke`](Self::revoke) returns; bytes already committed to a transport may
/// still arrive. [`commit`](Self::commit) is the one step that tests the state and runs the delivery, serialized against `revoke`.
#[derive(Clone, Default)]
pub struct Revocation(Arc<RevocationState>);

#[derive(Default)]
struct RevocationState {
    revoked: std::sync::Mutex<bool>,
    /// The end, published as a persistent terminal event: it stays cancelled, so a waiter that subscribes after the end, or between
    /// its subscription and its check, is released like one that was waiting. Every wait made under this authority selects on it.
    ended: tokio_util::sync::CancellationToken,
}

impl Revocation {
    fn state(&self) -> std::sync::MutexGuard<'_, bool> {
        self.0.revoked.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn is_revoked(&self) -> bool {
        *self.state()
    }

    /// Ends the authority: the state is set and the terminal event published, in one step with a commit (see [`commit`](Self::commit)).
    pub fn revoke(&self) {
        let mut revoked = self.state();
        *revoked = true;
        self.0.ended.cancel();
    }

    /// The terminal event: resolves once the authority has ended, at once if it already had.
    pub fn ended(&self) -> tokio_util::sync::CancellationToken {
        self.0.ended.clone()
    }

    /// Runs `write` only while not revoked, in one step with the test: a revoke that races it either waits for the write (the commit
    /// came first and is allowed) or is seen by it (the revoke came first and the write is refused). `write` must not wait.
    pub fn commit(&self, write: &mut dyn FnMut()) -> bool {
        let revoked = self.state();
        if *revoked {
            return false;
        }
        write();
        true
    }
}

/// What a media request names, obtained as one: the session's media key and device, and its revocation capability.
pub struct MediaGrant {
    pub key: Option<[u8; 32]>,
    pub device: Option<String>,
    pub revocation: Revocation,
}

/// How a phone's frames travel once it is authenticated.
#[allow(clippy::large_enum_variant, reason = "Keep the single-owned fixed channel and replay state inline without an additional legacy connection allocation")]
enum Link {
    /// The handshake has not completed.
    Pending,
    /// One sealed frame per relay frame.
    Legacy(Channel),
    /// The MXT stream: relay frames carry transport messages, a direct peer may carry them too.
    Transport(Arc<TransportSession>),
}

impl Client {
    fn end(self, reason: EndReason) {
        if let Link::Transport(session) = self.link {
            session.close(reason);
        }
    }
}

struct Client {
    /// The open this client is: ids are reused when the relay re-announces one, so everything that ends or removes what belongs to a
    /// client names the generation it was made for (see [`ClientTable::close_in`]).
    generation: u64,
    credential_id: String,
    /// Refused the screen and media for its lifetime (live at an unpair, or admitted while one was in force); it keeps its credential.
    revocation: Revocation,
    challenge: Challenge,
    link: Link,
    /// Its media key, once authenticated.
    media_key: Option<[u8; 32]>,
}

/// What one frame from a phone amounts to.
#[allow(clippy::large_enum_variant, reason = "Preserve the public handshake result that moves Channel directly into its transport session without boxing its payload")]
pub enum Received {
    /// Traffic of the previous leg, or an unrelated hello: dropped, never acted on.
    Dropped,
    /// The handshake completed; send these sealed frames in order, the first being `e2ee-ready`.
    Ready(Vec<Sealed>),
    /// A decrypted application frame: handed to the core byte for byte, text or binary.
    Plain { bytes: Vec<u8>, binary: bool },
    /// A transport message from the relay carrier of an established transport session.
    Transport { session: Arc<TransportSession>, message: Vec<u8> },
    /// The handshake completed and negotiated the transport: the channel moves into a transport
    /// session, whose first message is the e2ee-ready text in `ready`.
    TransportReady { channel: Channel, ready: Vec<u8> },
    /// The client must be closed for this reason.
    Close(&'static str),
}

impl std::fmt::Debug for Received {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Dropped => "Dropped",
            Self::Ready(_) => "Ready",
            Self::Plain { .. } => "Plain",
            Self::Transport { .. } => "Transport",
            Self::TransportReady { .. } => "TransportReady",
            Self::Close(reason) => return write!(f, "Close({reason})"),
        })
    }
}

/// What the relay told this connection that a phone is handed in `e2ee-ready`.
pub struct ReadyContext<'a> {
    pub host_name: &'a str,
    /// Routing ceilings, merged into the ready message.
    pub routing: &'a Map<String, Value>,
}

#[derive(Default)]
pub struct ClientTable {
    clients: HashMap<String, Client>,
    next_generation: u64,
}

impl ClientTable {
    pub fn len(&self) -> usize {
        self.clients.len()
    }

    pub fn is_empty(&self) -> bool {
        self.clients.is_empty()
    }

    pub fn contains(&self, client_id: &str) -> bool {
        self.clients.contains_key(client_id)
    }

    pub fn established(&self, client_id: &str) -> bool {
        self.clients.get(client_id).is_some_and(|c| !matches!(c.link, Link::Pending))
    }

    /// Opens a client for a `client-open`; returns the challenge text to send it. A second open
    /// of one id replaces the first (the relay re-announced the leg) and ends the first's transport, as Node's
    /// `registry.open` removes the id first (`remote-relay-clients.ts:285`). None past the cap.
    pub fn open(&mut self, client_id: &str, credential_id: &str, flags: &[&str]) -> Option<String> {
        if !self.clients.contains_key(client_id) && self.clients.len() >= MAX_CLIENTS {
            return None;
        }
        let challenge = Challenge::create(flags);
        let text = challenge.to_json_string();
        let generation = self.next_generation;
        self.next_generation += 1;
        let replaced = self.clients.insert(
            client_id.to_owned(),
            Client { generation, credential_id: credential_id.to_owned(), revocation: Revocation::default(), challenge, link: Link::Pending, media_key: None },
        );
        if let Some(old) = replaced {
            old.end(EndReason::SessionEnded);
        }
        Some(text)
    }

    /// Closes `client_id` only while it is still the client opened with `challenge` and its handshake has not finished: the 10 s
    /// deadline of Node's `E2EE_HANDSHAKE_TIMEOUT_MS`. A client that completed, was closed, or was replaced by a newer open is left alone.
    /// The generation closed, if it was.
    pub fn close_if_pending(&mut self, client_id: &str, challenge: &str) -> Option<u64> {
        let generation = self.clients.get(client_id).filter(|c| matches!(c.link, Link::Pending) && c.challenge.challenge() == challenge)?.generation;
        self.close_in(client_id, generation).then_some(generation)
    }

    /// The generation of the client now holding `client_id`.
    pub fn generation_of(&self, client_id: &str) -> Option<u64> {
        self.clients.get(client_id).map(|c| c.generation)
    }

    /// Closes `client_id` only while it is still the open `generation` made: a close that belongs to an earlier open of the id (its
    /// bridged socket failing late, a deadline armed for it) finds the replacement and does nothing. Decided with the removal.
    pub fn close_in(&mut self, client_id: &str, generation: u64) -> bool {
        if self.clients.get(client_id).is_none_or(|c| c.generation != generation) {
            return false;
        }
        match self.clients.remove(client_id) {
            Some(client) => {
                client.end(EndReason::SessionEnded);
                true
            }
            None => false,
        }
    }

    /// Every client, with the generation it was: the whole table goes (the relay leg was lost).
    pub fn close_all(&mut self) -> Vec<(String, u64)> {
        self.clients
            .drain()
            .map(|(id, client)| {
                let generation = client.generation;
                client.end(EndReason::SessionEnded);
                (id, generation)
            })
            .collect()
    }

    pub fn credential_of(&self, client_id: &str) -> Option<&str> {
        self.clients.get(client_id).map(|c| c.credential_id.as_str())
    }

    /// Marks every client attached with `credential_id` (a revoked pairing) screen-revoked for its lifetime. They stay attached under
    /// the credential, as Node leaves them (it closes none itself: the relay does, once it removed the pairing). Returns their ids.
    pub fn revoke(&mut self, credential_id: &str) -> Vec<(String, u64)> {
        let mut ids = Vec::new();
        for (id, client) in &mut self.clients {
            if !credential_id.is_empty() && client.credential_id == credential_id {
                client.revocation.revoke();
                ids.push((id.clone(), client.generation));
            }
        }
        ids
    }

    /// A client admitted while its credential's unpair is in force is revoked from the start.
    pub fn revoke_client(&mut self, client_id: &str) {
        if let Some(client) = self.clients.get(client_id) {
            client.revocation.revoke();
        }
    }

    pub fn screen_revoked(&self, client_id: &str) -> bool {
        self.clients.get(client_id).is_some_and(|c| c.revocation.is_revoked())
    }

    /// The media key, the device and the revocation capability of the attached session whose challenge is `sid`, taken as one; none
    /// for an unknown session and for one whose credential was revoked (no authority to be sent media). The device is named as the
    /// RPC lane names a download requester (the relay credential, else this connection) and only once the session is established.
    pub fn media_grant(&self, sid: &str) -> Option<MediaGrant> {
        let (id, client) = self.clients.iter().find(|(_, c)| c.challenge.challenge() == sid)?;
        if client.revocation.is_revoked() {
            return None;
        }
        let device = (!matches!(client.link, Link::Pending))
            .then(|| if client.credential_id.is_empty() { format!("connection:{id}") } else { client.credential_id.clone() });
        Some(MediaGrant { key: client.media_key, device, revocation: client.revocation.clone() })
    }

    /// The revocation capability of a client (already set when its credential was revoked): what its transport session streams under.
    pub fn revocation_of(&self, client_id: &str) -> Option<Revocation> {
        self.clients.get(client_id).map(|c| c.revocation.clone())
    }

    /// The device a client's downloads are leased to: the relay credential, else this connection.
    pub fn media_device_of(&self, client_id: &str) -> Option<String> {
        let client = self.clients.get(client_id)?;
        Some(if client.credential_id.is_empty() { format!("connection:{client_id}") } else { client.credential_id.clone() })
    }

    /// The challenge (the session id the relay and the media lanes name it by) of a client.
    pub fn challenge_of(&self, client_id: &str) -> Option<String> {
        self.clients.get(client_id).map(|c| c.challenge.challenge().to_owned())
    }

    /// The transport session of an established client, if it negotiated one.
    pub fn transport(&self, client_id: &str, generation: u64) -> Option<Arc<TransportSession>> {
        let client = self.clients.get(client_id).filter(|c| c.generation == generation)?;
        match &client.link {
            Link::Transport(session) => Some(session.clone()),
            _ => None,
        }
    }

    /// The handshake's transport session is running: the client's frames travel through it. A
    /// client closed in the meantime takes its session down with it.
    pub fn attach_transport(&mut self, client_id: &str, generation: u64, session: Arc<TransportSession>) {
        match self.clients.get_mut(client_id).filter(|c| c.generation == generation) {
            Some(client) => client.link = Link::Transport(session),
            None => session.close(EndReason::SessionEnded),
        }
    }

    pub fn receive(
        &mut self,
        identity: &ServerIdentity,
        client_id: &str,
        payload: &Payload,
        ready: &ReadyContext<'_>,
    ) -> Received {
        let Some(client) = self.clients.get_mut(client_id) else { return Received::Dropped };
        let channel = match &mut client.link {
            Link::Pending => {
                return match payload {
                    Payload::Text(text) => handshake(identity, client, text, ready),
                    Payload::Binary(_) => Received::Dropped,
                };
            }
            Link::Transport(session) => {
                return match payload {
                    Payload::Binary(message) => Received::Transport { session: session.clone(), message: message.clone() },
                    Payload::Text(_) => Received::Dropped,
                };
            }
            Link::Legacy(channel) => channel,
        };
        let wire = match payload {
            Payload::Text(text) => Wire::Text(text),
            Payload::Binary(bytes) => Wire::Binary(bytes),
        };
        match channel.open(wire) {
            Ok(bytes) => Received::Plain { bytes, binary: matches!(payload, Payload::Binary(_)) },
            Err(_) => Received::Close("relay encryption authentication failed"),
        }
    }

    /// Seals one application frame for a phone; `binary` selects the carrier form.
    ///
    /// Only the open `generation`: the generation check and the choice of the channel that seals are one step, so a frame of an old open
    /// is never sealed for a replacement that authenticated meanwhile.
    pub fn seal(&mut self, client_id: &str, generation: u64, plaintext: &[u8], binary: bool) -> Result<Sealed, E2eeError> {
        match self.clients.get_mut(client_id).filter(|c| c.generation == generation).map(|c| &mut c.link) {
            Some(Link::Legacy(channel)) => channel.seal(plaintext, binary),
            _ => Err(E2eeError::Unconfirmed),
        }
    }
}

fn handshake(identity: &ServerIdentity, client: &mut Client, text: &str, ready: &ReadyContext<'_>) -> Received {
    let Ok(hello) = serde_json::from_str::<Value>(text) else { return Received::Dropped };
    if !is_hello(&hello) || hello["challenge"] != client.challenge.challenge() {
        // A hello for a challenge this leg never sent answers the previous leg's: a race, not a
        // failed authentication.
        return Received::Dropped;
    }
    let Ok(mut channel) = accept_client_hello(identity, &client.challenge, &hello) else {
        return Received::Close("relay encryption authentication failed");
    };
    let mut message = Map::new();
    message.insert("type".into(), json!("e2ee-ready"));
    message.insert("version".into(), json!(1));
    if let Some(transcript) = channel.handshake_confirmation() {
        message.insert("transcript".into(), json!(transcript));
    }
    // Pairing approval is the trust: this host serves every paired client.
    message.insert("remoteOpenAccess".into(), json!(1));
    message.insert("hostName".into(), json!(mixdog_js::slice_utf16(ready.host_name, HOST_NAME_MAX)));
    message.extend(ready.routing.clone());
    let bytes = Value::Object(message).to_string();
    client.media_key = channel.media_key().copied();
    if channel.transport_enabled() {
        // Its first message is `e2ee-ready`, sent as record 1 once the session runs.
        return Received::TransportReady { channel, ready: bytes.into_bytes() };
    }
    match channel.seal(bytes.as_bytes(), false) {
        Ok(sealed) => {
            client.link = Link::Legacy(channel);
            Received::Ready(vec![sealed])
        }
        Err(_) => Received::Close("relay encryption authentication failed"),
    }
}

/// The approval material of this PC, sealed to a claimant's key.
pub fn seal_approval(material: &PairingMaterial, public_key: &str) -> Option<Value> {
    let sealed = crate::e2ee::seal_pairing(material, public_key).ok()?;
    serde_json::to_value(sealed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The capability is taken with the key and the device, and an unpair sets the very one that was handed out: a request that took
    /// its grant before holds it revoked, one after gets none, a client admitted under an unpair in force gets none, and another
    /// credential's capability is untouched.
    #[test]
    fn an_unpair_revokes_the_capability_already_taken_and_refuses_a_new_grant() {
        let mut table = ClientTable::default();
        let challenges: Vec<String> = [("c1", "cred-a"), ("c2", "cred-b"), ("c3", "cred-a")]
            .iter()
            .map(|(client, credential)| {
                table.open(client, credential, &[]).unwrap();
                table.challenge_of(client).unwrap()
            })
            .collect();
        for client in table.clients.values_mut() {
            client.media_key = Some([9; 32]);
        }
        let before = table.media_grant(&challenges[0]).expect("a live credential is granted");
        assert_eq!((before.key, before.device.as_deref()), (Some([9; 32]), None), "pending: no device yet");
        let other = table.media_grant(&challenges[1]).unwrap();
        assert!(!before.revocation.is_revoked() && !other.revocation.is_revoked());
        let ended = before.revocation.ended();
        assert!(!ended.is_cancelled());
        table.revoke("cred-a");
        assert!(before.revocation.is_revoked(), "the capability taken before the unpair is the one revoked");
        assert!(ended.is_cancelled(), "the unpair published the terminal event to the one already waiting");
        assert!(table.revocation_of("c3").unwrap().ended().is_cancelled(), "and a subscriber that arrives after it sees it too");
        assert!(!other.revocation.ended().is_cancelled());
        assert!(table.media_grant(&challenges[0]).is_none() && table.media_grant(&challenges[2]).is_none(), "no fresh grant after it");
        assert!(table.revocation_of("c1").unwrap().is_revoked());
        assert!(!other.revocation.is_revoked() && table.media_grant(&challenges[1]).is_some(), "another credential is untouched");
        // A client admitted while the unpair is in force is revoked from the start.
        let late = table.open("c4", "cred-a", &[]).map(|_| table.challenge_of("c4").unwrap()).unwrap();
        table.clients.get_mut("c4").unwrap().media_key = Some([9; 32]);
        table.revoke_client("c4");
        assert!(table.media_grant(&late).is_none());
        assert!(table.media_grant("no-such-session").is_none());
    }

    /// The handshake deadline closes a client that is still the pending one it was armed for, and nothing else: not one a newer open
    /// replaced (the old timer still fires), not one already closed.
    #[test]
    fn the_handshake_deadline_closes_only_the_pending_client_it_was_armed_for() {
        let mut table = ClientTable::default();
        table.open("c1", "cred-a", &[]).unwrap();
        let first = table.challenge_of("c1").unwrap();
        table.open("c1", "cred-a", &[]).unwrap();
        let second = table.challenge_of("c1").unwrap();
        assert_ne!(first, second, "a second open is a new client");
        assert!(table.close_if_pending("c1", &first).is_none(), "the replaced client's timer finds another client");
        assert!(table.contains("c1"));
        assert!(table.close_if_pending("c1", &second).is_some(), "the pending client is closed");
        assert!(!table.contains("c1"));
        assert!(table.close_if_pending("c1", &second).is_none(), "a closed client is not closed twice");
    }

    /// Node keeps `credentialId` on a client whose pairing was revoked and marks it screen-revoked apart
    /// (`remote-relay-clients.ts:274`, `screen-access-publisher.ts:138,151`): what acts as the device, a native push
    /// registration or a download lease, keeps naming it.
    #[test]
    fn a_revoked_client_keeps_the_device_it_acts_as_and_is_marked_apart() {
        let mut table = ClientTable::default();
        table.open("c1", "cred-a", &[]).unwrap();
        table.open("c2", "cred-b", &[]).unwrap();
        assert_eq!(table.revoke("cred-a").into_iter().map(|(id, _)| id).collect::<Vec<_>>(), vec!["c1".to_owned()]);
        assert!(table.screen_revoked("c1") && !table.screen_revoked("c2"));
        assert_eq!(table.credential_of("c1"), Some("cred-a"));
        assert_eq!(table.media_device_of("c1").as_deref(), Some("cred-a"));
        assert_eq!(table.media_device_of("c2").as_deref(), Some("cred-b"));
    }

    /// A close, a transport and a revoke that belong to an earlier open of an id find the replacement and leave it alone.
    #[test]
    fn what_belongs_to_an_earlier_open_of_an_id_never_touches_its_replacement() {
        let mut table = ClientTable::default();
        table.open("c1", "cred-a", &[]).unwrap();
        let first = table.generation_of("c1").unwrap();
        table.open("c1", "cred-a", &[]).unwrap();
        let second = table.generation_of("c1").unwrap();
        assert_ne!(first, second);
        assert!(!table.close_in("c1", first), "the replaced open's close is a no-op");
        assert!(table.contains("c1") && table.generation_of("c1") == Some(second));
        assert!(table.close_in("c1", second));
        assert!(!table.contains("c1"));
    }


    /// The commit and a revoke race in both orders: a commit that began first is allowed and the revoke waits for it; a revoke that
    /// came first refuses it and nothing is written.
    #[test]
    fn a_revoke_racing_a_commit_is_ordered_by_the_capability() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;
        let revocation = Revocation::default();
        let (entered, inside) = mpsc::channel();
        let (release, held) = mpsc::channel::<()>();
        let committing = std::thread::spawn({
            let revocation = revocation.clone();
            move || {
                let mut wrote = false;
                let allowed = revocation.commit(&mut || {
                    wrote = true;
                    entered.send(()).unwrap();
                    held.recv().unwrap();
                });
                (allowed, wrote)
            }
        });
        inside.recv().unwrap();
        let revoked = Arc::new(AtomicBool::new(false));
        let revoking = std::thread::spawn({
            let (revocation, revoked) = (revocation.clone(), revoked.clone());
            move || {
                revocation.revoke();
                revoked.store(true, Ordering::SeqCst);
            }
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!revoked.load(Ordering::SeqCst), "the revoke waits for the commit in progress");
        release.send(()).unwrap();
        assert_eq!(committing.join().unwrap(), (true, true), "commit first is allowed");
        revoking.join().unwrap();
        let mut wrote = false;
        assert!(!revocation.commit(&mut || wrote = true) && !wrote, "revoke first is refused and writes nothing");
        assert!(revocation.is_revoked());
        let other = Revocation::default();
        assert!(other.commit(&mut || {}), "another credential's capability is unaffected");
    }
}