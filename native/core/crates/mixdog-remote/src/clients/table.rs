//! The phone legs the relay announced: challenge, hello and the encrypted channel of each. A
//! client is a plain value; its session never waits on another client's (DS-REM-5).

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::e2ee::{Challenge, Channel, E2eeError, PairingMaterial, Sealed, ServerIdentity, Wire, accept_client_hello, is_hello};
use super::foreground::{Foreground, Report};
use crate::leg::frame::Payload;

pub const MAX_CLIENTS: usize = 64;
const HOST_NAME_MAX: usize = 80;

struct Client {
    credential_id: String,
    challenge: Challenge,
    channel: Option<Channel>,
    foreground: Foreground,
}

/// What one frame from a phone amounts to.
#[derive(Debug, PartialEq, Eq)]
pub enum Received {
    /// Traffic of the previous leg, or an unrelated hello: dropped, never acted on.
    Dropped,
    /// The handshake completed; send these sealed frames in order, the first being `e2ee-ready`.
    Ready(Vec<Sealed>),
    /// A decrypted application frame: handed to the core byte for byte, text or binary.
    Plain { bytes: Vec<u8>, binary: bool },
    /// The client must be closed for this reason.
    Close(&'static str),
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
        self.clients.get(client_id).is_some_and(|c| c.channel.is_some())
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
            Client { credential_id: credential_id.to_owned(), challenge, channel: None, foreground: Foreground::default() },
        );
        Some(text)
    }

    /// Records what an attached phone reported about its screen.
    pub fn report(&mut self, client_id: &str, report: Report) {
        if let Some(client) = self.clients.get_mut(client_id).filter(|c| c.channel.is_some()) {
            client.foreground.apply(report);
        }
    }

    /// Whether any attached leg of the paired credential shows `thread_id`.
    pub fn credential_shows(&self, credential_id: &str, thread_id: &str) -> bool {
        self.shown_by(|c| c.credential_id == credential_id, thread_id)
    }

    /// Whether any attached leg that reported `browser_id` shows `thread_id`.
    pub fn browser_shows(&self, browser_id: &str, thread_id: &str) -> bool {
        self.shown_by(|c| c.foreground.browser_id() == browser_id, thread_id)
    }

    fn shown_by(&self, which: impl Fn(&Client) -> bool, thread_id: &str) -> bool {
        self.clients.values().any(|c| c.channel.is_some() && which(c) && c.foreground.shows(thread_id))
    }

    pub fn close(&mut self, client_id: &str) -> bool {
        self.clients.remove(client_id).is_some()
    }

    pub fn close_all(&mut self) -> Vec<String> {
        self.clients.drain().map(|(id, _)| id).collect()
    }

    pub fn credential_of(&self, client_id: &str) -> Option<&str> {
        self.clients.get(client_id).map(|c| c.credential_id.as_str())
    }

    /// Removes every client attached with `credential_id` (a revoked pairing); returns their ids.
    pub fn revoke(&mut self, credential_id: &str) -> Vec<String> {
        let ids: Vec<String> = self
            .clients
            .iter()
            .filter(|(_, c)| !credential_id.is_empty() && c.credential_id == credential_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            self.clients.remove(id);
        }
        ids
    }

    /// The media key of the attached session whose challenge is `sid`.
    pub fn media_key(&self, sid: &str) -> Option<[u8; 32]> {
        self.clients
            .values()
            .find(|c| c.challenge.challenge() == sid)
            .and_then(|c| c.channel.as_ref())
            .and_then(|channel| channel.media_key().copied())
    }

    /// The paired device of the authenticated session whose challenge is `sid`.
    pub fn media_device(&self, sid: &str) -> Option<&str> {
        self.clients
            .values()
            .find(|c| c.challenge.challenge() == sid && c.channel.is_some())
            .map(|c| c.credential_id.as_str())
    }

    pub fn receive(
        &mut self,
        identity: &ServerIdentity,
        client_id: &str,
        payload: &Payload,
        ready: &ReadyContext<'_>,
    ) -> Received {
        let Some(client) = self.clients.get_mut(client_id) else { return Received::Dropped };
        let Some(channel) = client.channel.as_mut() else {
            return match payload {
                Payload::Text(text) => handshake(identity, client, text, ready),
                Payload::Binary(_) => Received::Dropped,
            };
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
        let channel = self
            .clients
            .get_mut(client_id)
            .and_then(|c| c.channel.as_mut())
            .ok_or(E2eeError::Unconfirmed)?;
        channel.seal(plaintext, binary)
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
    match channel.seal(bytes.as_bytes(), false) {
        Ok(sealed) => {
            client.channel = Some(channel);
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
