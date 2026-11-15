//! The web push subscription registry (`createWebPushRegistry` of `lib/web-push.mjs`): the associations
//! `endpoint -> {(deviceId, clientId) -> sealed}`, persisted as `<DATA_DIR>/webpush-subscriptions.json`.
//!
//! Each association was made by the browser with THAT PC's credential, and each is removed on its own: unregistering or revoking
//! one PC never touches another's. They are persisted because a browser registers once while its PCs come and go. The file is
//! rewritten whole and owner-only; a store that fails leaves memory as it was (`store-failed`), so memory and disk stay one state.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::endpoint::valid_endpoint;
use super::write_owner_only;
use crate::rate_limit::now_ms;
use crate::{js, logline};

pub const SUBSCRIPTIONS_FILE: &str = "webpush-subscriptions.json";
/// A browser paired with many PCs holds one association per PC credential.
pub const MAX_ASSOCIATIONS_PER_ENDPOINT: usize = 32;
pub const MAX_ASSOCIATIONS_PER_DEVICE: usize = 64;
pub const MAX_ENDPOINTS: usize = 100_000;

/// `^[A-Za-z0-9_-]{n,m}$` for a length in `accepted`.
fn base64url_len(value: &str, accepted: RangeInclusive<usize>) -> bool {
    accepted.contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `^[A-Za-z0-9_-]{1,128}$`.
pub fn is_device_id(value: &str) -> bool {
    base64url_len(value, 1..=128)
}

/// The browser's p256dh/auth sealed to ONE desktop's E2EE identity (`sealRelayWebPushKeys`). Opaque here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sealed {
    pub ephemeral_public_key: String,
    pub nonce: String,
    pub ciphertext: String,
}

impl Sealed {
    /// `validSealedKeys`: `version` 1 with a 87-char ephemeral key, a 16-char nonce and a 22..=512-char ciphertext, all
    /// base64url.
    pub fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if object.get("version").and_then(Value::as_f64) != Some(1.0) {
            return None;
        }
        let field = |name: &str, accepted: RangeInclusive<usize>| {
            object.get(name)?.as_str().filter(|text| base64url_len(text, accepted)).map(str::to_owned)
        };
        Some(Self {
            ephemeral_public_key: field("ephemeralPublicKey", 87..=87)?,
            nonce: field("nonce", 16..=16)?,
            ciphertext: field("ciphertext", 22..=512)?,
        })
    }

    pub fn to_value(&self) -> Value {
        json!({
            "version": 1,
            "ephemeralPublicKey": self.ephemeral_public_key,
            "nonce": self.nonce,
            "ciphertext": self.ciphertext,
        })
    }
}

#[derive(Clone, Debug)]
struct Association {
    device_id: String,
    client_id: String,
    sealed: Sealed,
    /// A JavaScript number: `Number(createdAt)` of the file, or `Date.now()`.
    created_at: f64,
}

impl Association {
    fn is(&self, device_id: &str, client_id: &str) -> bool {
        self.device_id == device_id && self.client_id == client_id
    }

    fn to_value(&self) -> Value {
        let created_at = if self.created_at.fract() == 0.0 && self.created_at.abs() < 9.0e15 {
            json!(self.created_at as i64)
        } else {
            serde_json::Number::from_f64(self.created_at).map_or(Value::Null, Value::Number)
        };
        json!({ "deviceId": self.device_id, "clientId": self.client_id, "sealed": self.sealed.to_value(), "createdAt": created_at })
    }
}

/// One endpoint's associations in the order they were made (a `Map`'s insertion order), and the position of the endpoint among
/// the endpoints.
struct Entry {
    seq: u64,
    associations: Vec<Association>,
}

struct Removed {
    endpoint: String,
    association: Association,
}

/// What `bind` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bind {
    Ok,
    Unchanged,
    Quota,
    StoreFailed,
}

impl Bind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Unchanged => "unchanged",
            Self::Quota => "quota",
            Self::StoreFailed => "store-failed",
        }
    }
}

/// What `unbind` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unbind {
    Removed,
    Absent,
    StoreFailed,
}

impl Unbind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Removed => "removed",
            Self::Absent => "absent",
            Self::StoreFailed => "store-failed",
        }
    }
}

/// What `mark_capable` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capable {
    Ok,
    Unchanged,
    StoreFailed,
}

impl Capable {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Unchanged => "unchanged",
            Self::StoreFailed => "store-failed",
        }
    }
}

/// One row of the per-holder view: what a PC may deliver to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub endpoint: String,
    pub client_id: String,
    pub sealed: Sealed,
}

impl Subscription {
    /// `{ endpoint, clientId, sealed }`.
    pub fn to_value(&self) -> Value {
        json!({ "endpoint": self.endpoint, "clientId": self.client_id, "sealed": self.sealed.to_value() })
    }
}

/// `Number(value) || Date.now()` for a stored `createdAt`.
fn created_at_of(value: Option<&Value>) -> f64 {
    let number = match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => mixdog_js::string_to_number(text),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    };
    if number == 0.0 || number.is_nan() { now_ms() as f64 } else { number }
}

pub struct Registry {
    path: PathBuf,
    next_seq: u64,
    endpoints: HashMap<String, Entry>,
    /// The PCs that said they deliver through the relay (`webpush-ready`), in the order they said so. Kept on disk, since a
    /// browser registers while its PCs are offline; an older PC never says so and keeps its own registration.
    capable: Vec<String>,
}

impl Registry {
    /// Loads `<data_dir>/webpush-subscriptions.json` tolerantly: a file that cannot be read or parsed is logged and the
    /// registry starts empty (browsers re-register on their next launch: a corrupt file costs a gap, never a crash).
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join(SUBSCRIPTIONS_FILE);
        let mut registry = Self { path, next_seq: 0, endpoints: HashMap::new(), capable: Vec::new() };
        let bytes = match mixdog_fsio::read(&mixdog_fsio::Unlaned, &registry.path) {
            Ok(bytes) => bytes,
            Err(error) => {
                if error.kind() != ErrorKind::NotFound {
                    logline::emit(&logline::web_push_subscriptions_unreadable(&error.to_string()));
                }
                return registry;
            }
        };
        match js::parse_bytes(&bytes) {
            Ok(parsed) => registry.load(&parsed),
            Err(error) => logline::emit(&logline::web_push_subscriptions_unusable(&error.to_string())),
        }
        registry
    }

    fn load(&mut self, parsed: &Value) {
        for device in parsed.get("devices").and_then(Value::as_array).into_iter().flatten() {
            if let Some(device_id) = device.as_str().filter(|id| is_device_id(id))
                && !self.is_capable(device_id)
            {
                self.capable.push(device_id.to_owned());
            }
        }
        for row in parsed.get("subscriptions").and_then(Value::as_array).into_iter().flatten() {
            let Some(endpoint) = row.get("endpoint").and_then(Value::as_str).and_then(valid_endpoint) else { continue };
            let Some(rows) = row.get("associations").and_then(Value::as_array) else { continue };
            let mut associations: Vec<Association> = Vec::new();
            for association in rows {
                let Some(sealed) = association.get("sealed").and_then(Sealed::from_value) else { continue };
                let (Some(device_id), Some(client_id)) =
                    (association.get("deviceId").and_then(Value::as_str), association.get("clientId").and_then(Value::as_str))
                else {
                    continue;
                };
                let made = Association {
                    device_id: device_id.to_owned(),
                    client_id: client_id.to_owned(),
                    sealed,
                    created_at: created_at_of(association.get("createdAt")),
                };
                match associations.iter_mut().find(|held| held.is(device_id, client_id)) {
                    Some(held) => *held = made,
                    None => associations.push(made),
                }
            }
            if associations.is_empty() {
                continue;
            }
            match self.endpoints.get_mut(&endpoint) {
                Some(entry) => entry.associations = associations,
                None => {
                    let seq = self.take_seq();
                    self.endpoints.insert(endpoint, Entry { seq, associations });
                }
            }
        }
    }

    fn take_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }

    /// The endpoints in the order they were first made.
    fn in_order(&self) -> Vec<(&String, &Entry)> {
        let mut ordered: Vec<(&String, &Entry)> = self.endpoints.iter().collect();
        ordered.sort_by_key(|(_, entry)| entry.seq);
        ordered
    }

    /// Rewrites the file whole; `false` (logged) when it could not be stored.
    fn persist(&self) -> bool {
        let subscriptions: Vec<Value> = self
            .in_order()
            .into_iter()
            .map(|(endpoint, entry)| {
                let associations: Vec<Value> = entry.associations.iter().map(Association::to_value).collect();
                json!({ "endpoint": endpoint, "associations": associations })
            })
            .collect();
        let mut file = Map::new();
        file.insert("version".to_owned(), json!(1));
        file.insert("devices".to_owned(), json!(self.capable));
        file.insert("subscriptions".to_owned(), Value::Array(subscriptions));
        match write_owner_only(&self.path, &js::wire(&Value::Object(file))) {
            Ok(()) => true,
            Err(error) => {
                logline::emit(&logline::web_push_subscriptions_not_stored(&error.to_string()));
                false
            }
        }
    }

    fn count_for(&self, device_id: &str) -> usize {
        self.endpoints.values().flat_map(|entry| &entry.associations).filter(|held| held.device_id == device_id).count()
    }

    /// Removes the matching associations (of one endpoint, or of all); returns what went, so it can be put back.
    fn remove(&mut self, matches: impl Fn(&Association) -> bool, only: Option<&str>) -> Vec<Removed> {
        let names: Vec<String> = match only {
            Some(endpoint) => vec![endpoint.to_owned()],
            None => self.in_order().into_iter().map(|(endpoint, _)| endpoint.clone()).collect(),
        };
        let mut removed = Vec::new();
        for endpoint in names {
            let Some(entry) = self.endpoints.get_mut(&endpoint) else { continue };
            let (gone, kept): (Vec<Association>, Vec<Association>) =
                std::mem::take(&mut entry.associations).into_iter().partition(&matches);
            entry.associations = kept;
            let emptied = entry.associations.is_empty();
            removed.extend(gone.into_iter().map(|association| Removed { endpoint: endpoint.clone(), association }));
            if emptied {
                self.endpoints.remove(&endpoint);
            }
        }
        removed
    }

    fn restore(&mut self, removed: Vec<Removed>) {
        for Removed { endpoint, association } in removed {
            if !self.endpoints.contains_key(&endpoint) {
                let seq = self.take_seq();
                self.endpoints.insert(endpoint.clone(), Entry { seq, associations: Vec::new() });
            }
            if let Some(entry) = self.endpoints.get_mut(&endpoint) {
                entry.associations.push(association);
            }
        }
    }

    /// Binds one browser client of one PC to an endpoint. Re-binding with a new box refreshes it; re-binding with the same one
    /// writes nothing.
    pub fn bind(&mut self, device_id: &str, client_id: &str, endpoint: &str, sealed: &Sealed) -> Bind {
        let existing = self.endpoints.get(endpoint);
        let previous = existing.and_then(|entry| entry.associations.iter().find(|held| held.is(device_id, client_id))).cloned();
        if previous.as_ref().is_some_and(|held| held.sealed == *sealed) {
            return Bind::Unchanged;
        }
        if previous.is_none() {
            match existing {
                None if self.endpoints.len() >= MAX_ENDPOINTS => return Bind::Quota,
                Some(entry) if entry.associations.len() >= MAX_ASSOCIATIONS_PER_ENDPOINT => return Bind::Quota,
                _ => {}
            }
            if self.count_for(device_id) >= MAX_ASSOCIATIONS_PER_DEVICE {
                return Bind::Quota;
            }
        }
        let created_at = previous.as_ref().map_or_else(|| now_ms() as f64, |held| held.created_at);
        let made = Association { device_id: device_id.to_owned(), client_id: client_id.to_owned(), sealed: sealed.clone(), created_at };
        if !self.endpoints.contains_key(endpoint) {
            let seq = self.take_seq();
            self.endpoints.insert(endpoint.to_owned(), Entry { seq, associations: Vec::new() });
        }
        if let Some(entry) = self.endpoints.get_mut(endpoint) {
            match entry.associations.iter_mut().find(|held| held.is(device_id, client_id)) {
                Some(held) => *held = made,
                None => entry.associations.push(made),
            }
        }
        if self.persist() {
            return Bind::Ok;
        }
        // Memory and disk stay one state: an association that would vanish on restart is not reported as made.
        if let Some(entry) = self.endpoints.get_mut(endpoint) {
            match previous {
                Some(held) => {
                    if let Some(slot) = entry.associations.iter_mut().find(|row| row.is(device_id, client_id)) {
                        *slot = held;
                    }
                }
                None => entry.associations.retain(|row| !row.is(device_id, client_id)),
            }
            if entry.associations.is_empty() {
                self.endpoints.remove(endpoint);
            }
        }
        Bind::StoreFailed
    }

    /// Like `bind`, a removal that would come back on restart is undone and reported as failed.
    pub fn unbind(&mut self, device_id: &str, client_id: &str, endpoint: &str) -> Unbind {
        let removed = self.remove(|held| held.is(device_id, client_id), Some(endpoint));
        if removed.is_empty() {
            return Unbind::Absent;
        }
        if self.persist() {
            return Unbind::Removed;
        }
        self.restore(removed);
        Unbind::StoreFailed
    }

    /// The PC delivers through the relay.
    pub fn mark_capable(&mut self, device_id: &str) -> Capable {
        if !is_device_id(device_id) {
            return Capable::StoreFailed;
        }
        if self.is_capable(device_id) {
            return Capable::Unchanged;
        }
        self.capable.push(device_id.to_owned());
        if self.persist() {
            return Capable::Ok;
        }
        self.capable.retain(|known| known != device_id);
        Capable::StoreFailed
    }

    pub fn is_capable(&self, device_id: &str) -> bool {
        self.capable.iter().any(|known| known == device_id)
    }

    pub fn has(&self, device_id: &str, client_id: &str, endpoint: &str) -> bool {
        self.endpoints.get(endpoint).is_some_and(|entry| entry.associations.iter().any(|held| held.is(device_id, client_id)))
    }

    /// Every association one PC holds: what that PC may deliver to.
    pub fn list_for(&self, device_id: &str) -> Vec<Subscription> {
        self.in_order()
            .into_iter()
            .flat_map(|(endpoint, entry)| {
                entry.associations.iter().filter(|held| held.device_id == device_id).map(move |held| Subscription {
                    endpoint: endpoint.clone(),
                    client_id: held.client_id.clone(),
                    sealed: held.sealed.clone(),
                })
            })
            .collect()
    }

    /// The push service retired the subscription (404/410): it is gone for every PC. Returns the PCs that held it, so each can
    /// be told.
    pub fn drop_endpoint(&mut self, endpoint: &str) -> Vec<String> {
        let Some(entry) = self.endpoints.remove(endpoint) else { return Vec::new() };
        let mut devices: Vec<String> = Vec::new();
        for held in entry.associations {
            if !devices.contains(&held.device_id) {
                devices.push(held.device_id);
            }
        }
        self.persist();
        devices
    }

    /// A revoked client (or, without `client_id`, a revoked device). True when an association went.
    pub fn drop_client(&mut self, device_id: &str, client_id: Option<&str>) -> bool {
        let removed = self.remove(|held| held.device_id == device_id && client_id.is_none_or(|id| held.client_id == id), None);
        let forgotten = client_id.is_none() && self.is_capable(device_id);
        if forgotten {
            self.capable.retain(|known| known != device_id);
        }
        if !removed.is_empty() || forgotten {
            self.persist();
        }
        !removed.is_empty()
    }
}
