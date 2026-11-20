//! The credential rows and the two digest indexes over them (`lib/device-store-auth.mjs`, `buildTokenIndexes`).
//!
//! A row is kept as the JSON object Node holds, key order and unknown keys included, so a `devices.json` written by Node loads
//! and is rewritten byte for byte. The operations here are plain mutations of a [`Devices`] value; which of them become
//! visible is decided by the store, after the write that makes them durable.

use std::collections::HashMap;

use serde_json::{Map, Number, Value};

use super::auth::{self, MAX_PAIRED_CLIENTS_PER_DEVICE, ProfileInput, clip_field};
use super::version::{self, DeviceVersion};
use crate::ids::is_routing_id;

/// What a mutation did to the rows.
pub(super) enum Change<R> {
    /// Nothing to persist; the result stands.
    Keep(R),
    /// The rows changed; the result stands once they are on disk.
    Write(R),
}

/// `{ deviceId, clientId }` of a per-browser token; the pairing token names no client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientAccess {
    pub device_id: String,
    pub client_id: Option<String>,
}

/// A browser credential as `registerClient` returns it: `{ id, ...client }`.
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserClient {
    pub id: String,
    pub token_hash: String,
    pub name: String,
    pub platform: String,
    pub browser: String,
    pub created_at: f64,
    pub last_seen_at: f64,
}

/// A paired browser as `listClients` reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedClient {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub browser: String,
    pub created_at: f64,
    pub last_seen_at: f64,
    pub online: bool,
}

/// The rows of `devices.json` and the digest indexes (`sha256(token)` hex to its owner) that keep phone authentication, on the
/// hot path of every `/ws` upgrade and static GET, from scanning the fleet.
#[derive(Clone, Default)]
pub(super) struct Devices {
    rows: Map<String, Value>,
    token_index: HashMap<String, String>,
    client_token_index: HashMap<String, (String, String)>,
}

pub(super) fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

pub(super) fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { Value::Number(Number::from(n as i64)) } else { Number::from_f64(n).map_or(Value::Null, Value::Number) }
}

fn text(map: &Map<String, Value>, key: &str) -> String {
    map.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn clients_of(row: &Map<String, Value>) -> Option<&Map<String, Value>> {
    row.get("clients").and_then(Value::as_object)
}

fn clients_mut(row: &mut Map<String, Value>) -> &mut Map<String, Value> {
    if !row.get("clients").is_some_and(Value::is_object) {
        row.insert("clients".to_owned(), Value::Object(Map::new()));
    }
    row.get_mut("clients").and_then(Value::as_object_mut).expect("clients was just made an object")
}

fn view(id: &str, client: &Map<String, Value>) -> BrowserClient {
    let number = |key: &str| client.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
    BrowserClient {
        id: id.to_owned(),
        token_hash: text(client, "tokenHash"),
        name: text(client, "name"),
        platform: text(client, "platform"),
        browser: text(client, "browser"),
        created_at: number("createdAt"),
        last_seen_at: number("lastSeenAt"),
    }
}

impl Devices {
    /// `buildTokenIndexes` over loaded rows: a later row or client with the same digest takes the entry, as in Node's Map.
    pub(super) fn from_rows(rows: Map<String, Value>) -> Self {
        let mut devices = Self { rows, token_index: HashMap::new(), client_token_index: HashMap::new() };
        for (id, row) in &devices.rows {
            let Some(row) = row.as_object() else { continue };
            let pairing = text(row, "clientTokenHash");
            if !pairing.is_empty() {
                devices.token_index.insert(pairing, id.clone());
            }
            if let Some(clients) = clients_of(row) {
                for client_id in mixdog_js::js_object_keys(clients) {
                    if let Some(client) = clients.get(client_id).and_then(Value::as_object) {
                        devices.client_token_index.insert(text(client, "tokenHash"), (id.clone(), client_id.clone()));
                    }
                }
            }
        }
        devices
    }

    pub(super) fn rows(&self) -> &Map<String, Value> {
        &self.rows
    }

    pub(super) fn row(&self, device_id: &str) -> Option<&Map<String, Value>> {
        self.rows.get(device_id).and_then(Value::as_object)
    }

    fn row_mut(&mut self, device_id: &str) -> Option<&mut Map<String, Value>> {
        self.rows.get_mut(device_id).and_then(Value::as_object_mut)
    }

    pub(super) fn is_known(&self, device_id: &str) -> bool {
        self.rows.contains_key(device_id)
    }

    /// `authenticate` of a known device: the secret against the stored digest.
    pub(super) fn secret_matches(&self, device_id: &str, secret: &str) -> bool {
        self.row(device_id).is_some_and(|row| auth::hashes_match(&text(row, "secretHash"), secret))
    }

    /// A first-use registration: the row of an id nobody holds yet, bound to the digest of the secret that came first.
    pub(super) fn register_device(&mut self, device_id: &str, secret_hash: &str) -> Change<bool> {
        if self.is_known(device_id) {
            return Change::Keep(false);
        }
        let mut row = Map::new();
        row.insert("secretHash".to_owned(), Value::String(secret_hash.to_owned()));
        row.insert("clientTokenHash".to_owned(), Value::String(String::new()));
        row.insert("clients".to_owned(), Value::Object(Map::new()));
        self.rows.insert(device_id.to_owned(), Value::Object(row));
        Change::Write(true)
    }

    /// `setClientToken` once the token is hashed: an unchanged digest writes nothing.
    pub(super) fn set_client_token(&mut self, device_id: &str, hash: &str) -> Change<bool> {
        let Some(row) = self.row_mut(device_id) else { return Change::Keep(false) };
        let previous = text(row, "clientTokenHash");
        if previous == hash {
            return Change::Keep(true);
        }
        row.insert("clientTokenHash".to_owned(), Value::String(hash.to_owned()));
        if !previous.is_empty() {
            self.token_index.remove(&previous);
        }
        self.token_index.insert(hash.to_owned(), device_id.to_owned());
        Change::Write(true)
    }

    /// `revokeDevice`: the row, its pairing token and every browser token of it are gone.
    pub(super) fn revoke_device(&mut self, device_id: &str) -> Change<bool> {
        let Some(Value::Object(row)) = self.rows.shift_remove(device_id) else { return Change::Keep(false) };
        let pairing = text(&row, "clientTokenHash");
        if !pairing.is_empty() {
            self.token_index.remove(&pairing);
        }
        if let Some(clients) = clients_of(&row) {
            for client in clients.values().filter_map(Value::as_object) {
                self.client_token_index.remove(&text(client, "tokenHash"));
            }
        }
        Change::Write(true)
    }

    /// `clientAccessForToken` of a token already hashed: the pairing token wins over a browser token.
    pub(super) fn access_for_hash(&self, hash: &str) -> Option<ClientAccess> {
        if let Some(device_id) = self.token_index.get(hash) {
            return Some(ClientAccess { device_id: device_id.clone(), client_id: None });
        }
        self.client_token_index.get(hash).map(|(device_id, client_id)| ClientAccess { device_id: device_id.clone(), client_id: Some(client_id.clone()) })
    }

    pub(super) fn has_client(&self, device_id: &str, client_id: &str) -> bool {
        self.row(device_id).and_then(clients_of).is_some_and(|clients| clients.contains_key(client_id))
    }

    /// `registerClient` with the token, its digest and the time already drawn: a browser of a known device under a routing id,
    /// at most [`MAX_PAIRED_CLIENTS_PER_DEVICE`] of them, replacing the credential of the same id.
    pub(super) fn register_client(
        &mut self,
        device_id: &str,
        client_id: &str,
        profile: &ProfileInput,
        token_hash: &str,
        now: i64,
    ) -> Change<Option<BrowserClient>> {
        if !self.is_known(device_id) || !is_routing_id(client_id) {
            return Change::Keep(None);
        }
        let Some(row) = self.rows.get_mut(device_id).and_then(Value::as_object_mut) else { return Change::Keep(None) };
        let clients = clients_mut(row);
        if !clients.contains_key(client_id) && clients.len() >= MAX_PAIRED_CLIENTS_PER_DEVICE {
            return Change::Keep(None);
        }
        let previous = clients.get(client_id).and_then(Value::as_object);
        let previous_hash = previous.map(|client| text(client, "tokenHash")).unwrap_or_default();
        let previous_created = previous.and_then(|client| client.get("createdAt")).and_then(Value::as_f64).filter(|n| *n != 0.0 && !n.is_nan());
        let profile = auth::client_profile(profile, auth::DEFAULT_CLIENT_NAME);
        let created_at = previous_created.unwrap_or(now as f64);
        let mut client = Map::new();
        client.insert("tokenHash".to_owned(), Value::String(token_hash.to_owned()));
        client.insert("name".to_owned(), Value::String(profile.name.clone()));
        client.insert("platform".to_owned(), Value::String(profile.platform.clone()));
        client.insert("browser".to_owned(), Value::String(profile.browser.clone()));
        client.insert("createdAt".to_owned(), number_value(created_at));
        client.insert("lastSeenAt".to_owned(), Value::Number(Number::from(now)));
        let registered = view(client_id, &client);
        clients.insert(client_id.to_owned(), Value::Object(client));
        if !previous_hash.is_empty() {
            self.client_token_index.remove(&previous_hash);
        }
        self.client_token_index.insert(token_hash.to_owned(), (device_id.to_owned(), client_id.to_owned()));
        Change::Write(Some(registered))
    }

    /// `touchClient`: the browser was seen now, and a profile field that is set replaces the stored one. In memory only: the
    /// store persists it on its debounced beat.
    pub(super) fn touch_client(&mut self, device_id: &str, client_id: &str, profile: &ProfileInput, now: i64) -> bool {
        let Some(client) = self
            .row_mut(device_id)
            .and_then(|row| row.get_mut("clients"))
            .and_then(Value::as_object_mut)
            .and_then(|clients| clients.get_mut(client_id))
            .and_then(Value::as_object_mut)
        else {
            return false;
        };
        client.insert("lastSeenAt".to_owned(), Value::Number(Number::from(now)));
        for (key, value) in [("name", &profile.name), ("platform", &profile.platform), ("browser", &profile.browser)] {
            if auth::truthy(value) {
                client.insert(key.to_owned(), Value::String(clip_field(Some(value), "")));
            }
        }
        true
    }

    /// `listClients`: newest `lastSeenAt` first, equal ones in the order of the file.
    pub(super) fn list_clients(&self, device_id: &str, online: &dyn Fn(&str) -> bool) -> Vec<ListedClient> {
        let Some(clients) = self.row(device_id).and_then(clients_of) else { return Vec::new() };
        let mut listed: Vec<ListedClient> = mixdog_js::js_object_keys(clients)
            .into_iter()
            .filter_map(|id| {
                let client = view(id, clients.get(id)?.as_object()?);
                Some(ListedClient {
                    online: online(id),
                    id: client.id,
                    name: client.name,
                    platform: client.platform,
                    browser: client.browser,
                    created_at: client.created_at,
                    last_seen_at: client.last_seen_at,
                })
            })
            .collect();
        listed.sort_by(|left, right| right.last_seen_at.total_cmp(&left.last_seen_at));
        listed
    }

    /// `revokeClient`.
    pub(super) fn revoke_client(&mut self, device_id: &str, client_id: &str) -> Change<bool> {
        let removed =
            self.row_mut(device_id).and_then(|row| row.get_mut("clients")).and_then(Value::as_object_mut).and_then(|clients| clients.shift_remove(client_id));
        match removed {
            Some(Value::Object(client)) => {
                self.client_token_index.remove(&text(&client, "tokenHash"));
                Change::Write(true)
            }
            Some(_) | None => Change::Keep(false),
        }
    }

    pub(super) fn version(&self, device_id: &str) -> DeviceVersion {
        self.row(device_id).map(version::row_version).unwrap_or_default()
    }

    /// `recordDesktopVersion`: `None` for an unusable report; `Some(changed)` otherwise.
    pub(super) fn record_version(&mut self, device_id: &str, report: &DeviceVersion, now: i64) -> Option<bool> {
        let row = self.row_mut(device_id)?;
        version::record_version(row, report, now)
    }
}
