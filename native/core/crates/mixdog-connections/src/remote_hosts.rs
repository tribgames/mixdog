//! "Connect to another PC": the hosts this machine has saved, the pairing link that names one, the redeeming of a
//! pairing code at the relay, and the presence of the saved hosts. The windows of the hosts are not here.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::DurabilityIo;
use mixdog_statefile::Invalid;
use serde::Serialize;
use serde_json::Number;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::Mutex;
use tokio::sync::watch;
use url::Url;

use crate::paths::ConnectionsPaths;
use crate::paths::StoreError;
use crate::paths::finite_number;
use crate::paths::js_number;
use crate::paths::js_number_text;
use crate::paths::js_trim;
use crate::paths::now_ms;
use crate::paths::read_state;
use crate::paths::slice_utf16;
use crate::paths::write_state;

const MAX_SAVED_HOSTS: usize = 32;
const MAX_NAME_LENGTH: usize = 80;
const REDEEM_TIMEOUT: Duration = Duration::from_secs(10);
const PRESENCE_TIMEOUT: Duration = Duration::from_secs(4);
/// The ids one presence question carries.
const PRESENCE_IDS: usize = 16;

/// The host a pasted pairing link names. The link carries a route, never a credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedRemoteHostLink {
    /// Canonical link: origin + device route, no query or fragment.
    pub url: String,
    pub device_id: String,
}

/// The relay route `relayClientUrl` builds: a device id that is a uuid or long hex.
fn device_id_of(segment: &str) -> Option<String> {
    let hex = |text: &str| text.chars().all(|c| c.is_ascii_hexdigit());
    let uuid_shaped = {
        let parts: Vec<&str> = segment.split('-').collect();
        parts.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(len, part)| part.len() == *len && hex(part))
    };
    ((uuid_shaped) || ((32..=64).contains(&segment.len()) && hex(segment))).then(|| segment.to_ascii_lowercase())
}

/// The host a pasted pairing link names, or `None` when it is not one. Plain http is only for a loopback relay.
pub fn parse_remote_host_link(text: &str) -> Option<ParsedRemoteHostLink> {
    let url = Url::parse(js_trim(text)).ok()?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback)) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let route = url.path().strip_prefix("/d/")?;
    let device_id = device_id_of(route.strip_suffix('/').unwrap_or(route))?;
    Some(ParsedRemoteHostLink { url: format!("{}/d/{device_id}/", url.origin().ascii_serialization()), device_id })
}

/// The six digits in what a person typed (`482·917`, `482 917`), or `None`.
pub fn parse_pair_code_input(text: &str) -> Option<String> {
    let digits: String = text.chars().filter(|c| !(c.is_whitespace() || matches!(c, '\u{feff}' | '·' | '.' | '-'))).collect();
    (digits.len() == 6 && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

/// `wss://host` to `https://host` (`ws://` to `http://`): the relay's HTTP origin.
pub fn relay_http_origin(relay_url: &str) -> Result<String, StoreError> {
    let url = Url::parse(relay_url).map_err(|error| StoreError::new(format!("Invalid URL: {error}")))?;
    let host = url.host_str().ok_or_else(|| StoreError::new("Invalid URL: no host"))?;
    let port = url.port().map(|port| format!(":{port}")).unwrap_or_default();
    Ok(format!("{}://{host}{port}", if url.scheme() == "wss" { "https" } else { "http" }))
}

/// The id of a saved host: the first 16 hex digits of the SHA-256 of its canonical link.
pub fn remote_host_id(canonical_url: &str) -> String {
    Sha256::digest(canonical_url.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// What the relay answered to a code it redeemed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedeemedPairCode {
    pub device_id: String,
    /// The host's own name for itself (empty when it did not say).
    pub name: String,
    /// One-time proof the relay redeemed a code; rides the first claim.
    pub ticket: String,
}

/// Why a code was not redeemed. The relay answers a right code once and rate-limits wrong ones, so these messages
/// (in English; the key of each is its text) are all a person needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairRedeemError {
    TooManyAttempts { retry_after_seconds: String },
    WrongOrExpired,
    /// An older relay: it answers without the fields of a redeemed code.
    NotAvailable,
    /// The relay could not be asked.
    Request(String),
}

impl std::fmt::Display for PairRedeemError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooManyAttempts { retry_after_seconds } => write!(f, "Too many attempts. Try again in {retry_after_seconds} seconds."),
            Self::WrongOrExpired => f.write_str("The code is wrong or has expired."),
            Self::NotAvailable => f.write_str("Codes are not available on this connection server yet. Use the QR code."),
            Self::Request(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for PairRedeemError {}

/// Redeems a 6-digit code at the relay (`POST /pair-code/resolve`). An answer that is not JSON, as an older relay
/// gives, is read as an answer without fields.
pub async fn redeem_pair_code(relay_origin: &str, code: &str) -> Result<RedeemedPairCode, PairRedeemError> {
    let request = reqwest::Client::new()
        .post(format!("{relay_origin}/pair-code/resolve"))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "code": code }).to_string())
        .timeout(REDEEM_TIMEOUT);
    let response = request.send().await.map_err(|error| PairRedeemError::Request(error.to_string()))?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await.unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    redeemed_from(status, &body)
}

fn redeemed_from(status: u16, body: &Value) -> Result<RedeemedPairCode, PairRedeemError> {
    let text = |name: &str| body.get(name).and_then(Value::as_str);
    if status == 200 {
        if let (Some(device_id), Some(ticket)) = (text("deviceId"), text("ticket")) {
            return Ok(RedeemedPairCode {
                device_id: device_id.to_string(),
                ticket: ticket.to_string(),
                name: slice_utf16(text("name").unwrap_or(""), MAX_NAME_LENGTH),
            });
        }
    }
    if status == 429 {
        let wait = body.get("retryAfter").map_or(0.0, js_number);
        let retry_after_seconds = if wait != 0.0 && !wait.is_nan() { js_number_text(wait) } else { "60".to_string() };
        return Err(PairRedeemError::TooManyAttempts { retry_after_seconds });
    }
    if status == 404 && text("status") == Some("invalid-code") {
        return Err(PairRedeemError::WrongOrExpired);
    }
    Err(PairRedeemError::NotAvailable)
}

/// A saved host asked about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresenceQuery {
    pub id: String,
    pub url: String,
}

/// Which of these hosts are connected to their relay right now. A host on a relay that cannot answer is absent.
pub async fn fetch_host_presence(hosts: &[PresenceQuery]) -> HashSet<String> {
    let mut by_origin: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for host in hosts {
        let Some(link) = parse_remote_host_link(&host.url) else { continue };
        let Some(origin) = Url::parse(&link.url).ok().map(|url| url.origin().ascii_serialization()) else { continue };
        match by_origin.iter_mut().find(|(known, _)| *known == origin) {
            Some((_, group)) => group.push((host.id.clone(), link.device_id)),
            None => by_origin.push((origin, vec![(host.id.clone(), link.device_id)])),
        }
    }
    let client = reqwest::Client::new();
    let mut asks = tokio::task::JoinSet::new();
    for (origin, group) in by_origin {
        let client = client.clone();
        asks.spawn(async move { ask_presence(&client, &origin, group).await });
    }
    let mut online = HashSet::new();
    while let Some(answer) = asks.join_next().await {
        online.extend(answer.unwrap_or_default());
    }
    online
}

/// The hosts of one relay that it reports online; none when it cannot answer.
async fn ask_presence(client: &reqwest::Client, origin: &str, group: Vec<(String, String)>) -> Vec<String> {
    let ids: Vec<&str> = group.iter().map(|(_, device_id)| device_id.as_str()).take(PRESENCE_IDS).collect();
    let response = client
        .post(format!("{origin}/pair-code/presence"))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "ids": ids }).to_string())
        .timeout(PRESENCE_TIMEOUT)
        .send()
        .await;
    let Ok(response) = response else { return Vec::new() };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(bytes) = response.bytes().await else { return Vec::new() };
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let Some(reported) = body.get("online").and_then(Value::as_object) else { return Vec::new() };
    group.into_iter().filter(|(_, device_id)| reported.get(device_id) == Some(&Value::Bool(true))).map(|(id, _)| id).collect()
}

/// A saved host as the list reports it: the user's alias, when there is one, is the name.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub url: String,
    pub added_at: Number,
    pub last_connected_at: Option<Number>,
}

/// A host as the file keeps it. `name` is what the host announced (or the default label); the user's alias lives in
/// `alias` and is what the list reports as the name.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredHost {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
    url: String,
    added_at: Number,
    last_connected_at: Option<Number>,
}

impl StoredHost {
    fn view(&self) -> RemoteHost {
        RemoteHost {
            id: self.id.clone(),
            name: self.alias.clone().unwrap_or_else(|| self.name.clone()),
            url: self.url.clone(),
            added_at: self.added_at.clone(),
            last_connected_at: self.last_connected_at.clone(),
        }
    }
}

fn hosts_document(value: &Value) -> Result<(), Invalid> {
    if value.get("hosts").is_some_and(Value::is_array) { Ok(()) } else { Err(Invalid::Damaged("Missing hosts list.".to_string())) }
}

fn stored_hosts(value: &Value) -> Vec<StoredHost> {
    let Some(rows) = value.get("hosts").and_then(Value::as_array) else { return Vec::new() };
    let mut hosts = Vec::new();
    for row in rows {
        let Some(link) = row.get("url").and_then(Value::as_str).and_then(parse_remote_host_link) else { continue };
        let Some(name) = row.get("name").and_then(Value::as_str) else { continue };
        let alias = row.get("alias").and_then(Value::as_str).map(|alias| slice_utf16(js_trim(alias), MAX_NAME_LENGTH)).filter(|alias| !alias.is_empty());
        hosts.push(StoredHost {
            id: remote_host_id(&link.url),
            name: slice_utf16(name, MAX_NAME_LENGTH),
            alias,
            url: link.url,
            added_at: finite_number(row.get("addedAt")).unwrap_or_else(|| Number::from(now_ms())),
            last_connected_at: finite_number(row.get("lastConnectedAt")),
        });
    }
    hosts
}

type Hosts = Arc<Vec<RemoteHost>>;

struct Inner {
    io: DurabilityIo,
    file: PathBuf,
    /// The hosts as the file keeps them; held across a change from its edit to the end of its write.
    stored: Mutex<Vec<StoredHost>>,
    published: watch::Sender<Hosts>,
}

/// The saved computers; clones share one list.
#[derive(Clone)]
pub struct RemoteHostStore {
    inner: Arc<Inner>,
}

impl RemoteHostStore {
    /// Loads the list. A damaged file is kept aside and the last good copy restored; a file that cannot be read at
    /// all leaves the list empty in memory.
    pub async fn load(paths: &ConnectionsPaths, io: DurabilityIo) -> Self {
        let file = paths.remote_hosts();
        let stored = match read_state(io, file.clone(), Some(hosts_document)).await {
            Ok(document) => document.as_ref().map(stored_hosts).unwrap_or_default(),
            Err(error) => {
                tracing::warn!("[remote-hosts] {} could not be read: {error}", file.display());
                Vec::new()
            }
        };
        let (published, _) = watch::channel(Arc::new(stored.iter().map(StoredHost::view).collect()));
        Self { inner: Arc::new(Inner { io, file, stored: Mutex::new(stored), published }) }
    }

    pub fn list(&self) -> Vec<RemoteHost> {
        self.inner.published.borrow().as_ref().clone()
    }

    pub fn get(&self, id: &str) -> Option<RemoteHost> {
        self.inner.published.borrow().iter().find(|host| host.id == id).cloned()
    }

    /// The list now and after every change.
    pub fn subscribe(&self) -> watch::Receiver<Hosts> {
        self.inner.published.subscribe()
    }

    /// Adds the host, or updates the name of one already saved (an empty name keeps the saved one).
    pub async fn add(&self, link: &ParsedRemoteHostLink, name: &str) -> Result<RemoteHost, StoreError> {
        let id = remote_host_id(&link.url);
        let announced = js_trim(name);
        let label = if announced.is_empty() { default_remote_host_name(link) } else { slice_utf16(announced, MAX_NAME_LENGTH) };
        let mut stored = self.inner.stored.lock().await;
        if let Some(existing) = stored.iter_mut().find(|host| host.id == id) {
            if !announced.is_empty() {
                existing.name = label;
            }
            let view = existing.view();
            self.commit(&stored).await?;
            return Ok(view);
        }
        if stored.len() >= MAX_SAVED_HOSTS {
            return Err(StoreError::new("Too many saved computers. Forget one first."));
        }
        let created = StoredHost { id, name: label, alias: None, url: link.url.clone(), added_at: Number::from(now_ms()), last_connected_at: None };
        let view = created.view();
        stored.push(created);
        self.commit(&stored).await?;
        Ok(view)
    }

    /// The user's own name for a saved PC; an empty one resets it to the name the PC announced.
    pub async fn rename(&self, id: &str, alias: &str) -> Result<(), StoreError> {
        let mut stored = self.inner.stored.lock().await;
        let Some(host) = stored.iter_mut().find(|host| host.id == id) else { return Ok(()) };
        let label = slice_utf16(js_trim(alias), MAX_NAME_LENGTH);
        host.alias = (!label.is_empty()).then_some(label);
        self.commit(&stored).await
    }

    /// The host was connected to just now.
    pub async fn touch(&self, id: &str) -> Result<(), StoreError> {
        let mut stored = self.inner.stored.lock().await;
        let Some(host) = stored.iter_mut().find(|host| host.id == id) else { return Ok(()) };
        host.last_connected_at = Some(Number::from(now_ms()));
        self.commit(&stored).await
    }

    /// Forgets the host.
    pub async fn forget(&self, id: &str) -> Result<(), StoreError> {
        let mut stored = self.inner.stored.lock().await;
        stored.retain(|host| host.id != id);
        self.commit(&stored).await
    }

    /// Publishes the list, then writes it (keeping the replaced file as `.bak`). The caller holds the lock.
    async fn commit(&self, stored: &[StoredHost]) -> Result<(), StoreError> {
        self.inner.published.send_replace(Arc::new(stored.iter().map(StoredHost::view).collect()));
        write_state(self.inner.io, self.inner.file.clone(), serde_json::json!({ "version": 1, "hosts": stored }), true).await
    }
}

fn default_remote_host_name(link: &ParsedRemoteHostLink) -> String {
    let host = Url::parse(&link.url).ok().map(|url| {
        let port = url.port().map(|port| format!(":{port}")).unwrap_or_default();
        format!("{}{port}", url.host_str().unwrap_or(""))
    });
    format!("{} \u{b7} {}", host.unwrap_or_default(), &link.device_id[..8])
}
