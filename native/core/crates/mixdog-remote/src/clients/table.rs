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

/// How a phone's frames travel once it is authenticated.
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
    credential_id: String,
    /// Refused the screen for its lifetime (live at an unpair, or admitted while one was in force); it keeps its credential.
    screen_revoked: bool,
    challenge: Challenge,
    link: Link,
    /// Its media key, once authenticated.
    media_key: Option<[u8; 32]>,
}

/// What one frame from a phone amounts to.
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
    /// of one id replaces the first (the relay re-announced the leg). None past the cap.
    pub fn open(&mut self, client_id: &str, credential_id: &str, flags: &[&str]) -> Option<String> {
        if !self.clients.contains_key(client_id) && self.clients.len() >= MAX_CLIENTS {
            return None;
        }
        let challenge = Challenge::create(flags);
        let text = challenge.to_json_string();
        self.clients.insert(
            client_id.to_owned(),
            Client { credential_id: credential_id.to_owned(), screen_revoked: false, challenge, link: Link::Pending, media_key: None },
        );
        Some(text)
    }

    pub fn close(&mut self, client_id: &str) -> bool {
        match self.clients.remove(client_id) {
            Some(client) => {
                client.end(EndReason::SessionEnded);
                true
            }
            None => false,
        }
    }

    pub fn close_all(&mut self) -> Vec<String> {
        self.clients
            .drain()
            .map(|(id, client)| {
                client.end(EndReason::SessionEnded);
                id
            })
            .collect()
    }

    pub fn credential_of(&self, client_id: &str) -> Option<&str> {
        self.clients.get(client_id).map(|c| c.credential_id.as_str())
    }

    /// Marks every client attached with `credential_id` (a revoked pairing) screen-revoked for its lifetime. They stay attached under
    /// the credential, as Node leaves them (it closes none itself: the relay does, once it removed the pairing). Returns their ids.
    pub fn revoke(&mut self, credential_id: &str) -> Vec<String> {
        let mut ids = Vec::new();
        for (id, client) in &mut self.clients {
            if !credential_id.is_empty() && client.credential_id == credential_id {
                client.screen_revoked = true;
                ids.push(id.clone());
            }
        }
        ids
    }

    /// A client admitted while its credential's unpair is in force is revoked from the start.
    pub fn revoke_client(&mut self, client_id: &str) {
        if let Some(client) = self.clients.get_mut(client_id) {
            client.screen_revoked = true;
        }
    }

    pub fn screen_revoked(&self, client_id: &str) -> bool {
        self.clients.get(client_id).is_some_and(|c| c.screen_revoked)
    }
    /// The media key of the attached session whose challenge is `sid`.
    pub fn media_key(&self, sid: &str) -> Option<[u8; 32]> {
        self.clients
            .values()
            .find(|c| c.challenge.challenge() == sid)
            .and_then(|c| c.media_key)
    }

    /// The paired device of the authenticated session whose challenge is `sid`, named as the RPC
    /// lane names a download requester: the relay credential, else this connection.
    pub fn media_device(&self, sid: &str) -> Option<String> {
        self.clients.iter().find(|(_, c)| c.challenge.challenge() == sid).and_then(|(id, c)| {
            (!matches!(c.link, Link::Pending)).then(|| if c.credential_id.is_empty() { format!("connection:{id}") } else { c.credential_id.clone() })
        })
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
    pub fn transport(&self, client_id: &str) -> Option<Arc<TransportSession>> {
        match &self.clients.get(client_id)?.link {
            Link::Transport(session) => Some(session.clone()),
            _ => None,
        }
    }

    /// The handshake's transport session is running: the client's frames travel through it. A
    /// client closed in the meantime takes its session down with it.
    pub fn attach_transport(&mut self, client_id: &str, session: Arc<TransportSession>) {
        match self.clients.get_mut(client_id) {
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
    pub fn seal(&mut self, client_id: &str, plaintext: &[u8], binary: bool) -> Result<Sealed, E2eeError> {
        match self.clients.get_mut(client_id).map(|c| &mut c.link) {
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

    /// Node keeps `credentialId` on a client whose pairing was revoked and marks it screen-revoked apart
    /// (`remote-relay-clients.ts:274`, `screen-access-publisher.ts:138,151`): what acts as the device, a native push
    /// registration or a download lease, keeps naming it.
    #[test]
    fn a_revoked_client_keeps_the_device_it_acts_as_and_is_marked_apart() {
        let mut table = ClientTable::default();
        table.open("c1", "cred-a", &[]).unwrap();
        table.open("c2", "cred-b", &[]).unwrap();
        assert_eq!(table.revoke("cred-a"), vec!["c1".to_owned()]);
        assert!(table.screen_revoked("c1") && !table.screen_revoked("c2"));
        assert_eq!(table.credential_of("c1"), Some("cred-a"));
        assert_eq!(table.media_device_of("c1").as_deref(), Some("cred-a"));
        assert_eq!(table.media_device_of("c2").as_deref(), Some("cred-b"));
    }
}