//! The SSH servers this machine has connected to: a small JSON list in the data directory. Only the entry is
//! stored here, never a key, password or token. The list is kept in memory and published on every change;
//! `allowed_providers` answers from that copy without touching the file.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_rt::DurabilityIo;
use mixdog_statefile::Invalid;
use serde::Serialize;
use serde_json::Number;
use serde_json::Value;
use tokio::sync::Mutex;
use tokio::sync::watch;

use crate::paths::ConnectionsPaths;
use crate::paths::StoreError;
use crate::paths::finite_number;
use crate::paths::js_number;
use crate::paths::js_string;
use crate::paths::js_trim;
use crate::paths::read_state;
use crate::paths::slice_utf16;
use crate::paths::utf16_len;
use crate::paths::write_state;

const MAX_SAVED_HOSTS: usize = 64;
const MAX_NAME_LENGTH: usize = 80;
const MAX_PATH_LENGTH: usize = 512;
const MIN_GRACE_MINUTES: f64 = 1.0;
const MAX_GRACE_MINUTES: f64 = 10_080.0;
const MAX_PROVIDER_ID_LENGTH: usize = 64;
const MAX_ALLOWED_PROVIDERS: usize = 64;

/// The model login of a server: only the opt-in is stored, absent is this PC's logins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelLogin {
    Server,
}

/// What a saved server remembers besides its name and address, in the order the file keeps the fields.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostSettings {
    /// Server folder the session opens in: `~`, `~/x` or an absolute server path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_cwd: Option<String>,
    /// Private key file on this PC (passed to ssh with `-i`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// Re-dial the tunnel when it drops; on unless false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_reconnect: Option<bool>,
    /// Minutes the server keeps its work after the connection drops (1 to 10080, default 30).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_minutes: Option<u32>,
    /// Model providers this server may use through this PC; absent: every provider enabled on this PC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_providers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_login: Option<ModelLogin>,
}

impl SshHostSettings {
    /// No field is set (an empty settings object is not stored).
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// How long the server keeps its work after the connection drops (daemon client grace and the reconnect backoff cap).
pub const DEFAULT_GRACE_MINUTES: u32 = 30;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostRecord {
    pub id: String,
    pub name: String,
    /// `alias`, `host`, `user@host` or `user@host:port`, as `parse_ssh_target` accepts it.
    pub target: String,
    pub last_connected_at: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<SshHostSettings>,
}

fn clean_name(name: &str) -> String {
    slice_utf16(js_trim(name), MAX_NAME_LENGTH)
}

fn is_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// The per-server settings as saved: trimmed, empty fields dropped. Errs when a value cannot be used.
pub fn parse_host_settings(raw: &Value) -> Result<SshHostSettings, StoreError> {
    let field = |name: &str| raw.get(name).unwrap_or(&Value::Null);
    let text = |value: &Value, what: &str| -> Result<String, StoreError> {
        let trimmed = js_trim(&js_string(value)).to_string();
        if utf16_len(&trimmed) > MAX_PATH_LENGTH || trimmed.chars().any(is_control) {
            return Err(StoreError::new(format!("{what} is not valid.")));
        }
        Ok(trimmed)
    };
    let mut settings = SshHostSettings::default();
    let remote_cwd = text(field("remoteCwd"), "The server folder")?;
    if !remote_cwd.is_empty() {
        if remote_cwd != "~" && !remote_cwd.starts_with("~/") && !remote_cwd.starts_with('/') {
            return Err(StoreError::new("The server folder must be an absolute server path or start with ~."));
        }
        settings.remote_cwd = Some(remote_cwd);
    }
    let identity_file = text(field("identityFile"), "The key file")?;
    if !identity_file.is_empty() {
        if identity_file.starts_with('-') {
            return Err(StoreError::new("The key file must not start with \"-\"."));
        }
        settings.identity_file = Some(identity_file);
    }
    if let Value::Bool(flag) = field("autoReconnect") {
        settings.auto_reconnect = Some(*flag);
    }
    let grace = field("graceMinutes");
    if !matches!(grace, Value::Null) && grace != &Value::String(String::new()) {
        let minutes = js_number(grace);
        if minutes.fract() != 0.0 || !(MIN_GRACE_MINUTES..=MAX_GRACE_MINUTES).contains(&minutes) {
            return Err(StoreError::new(
                "The time to keep the server\u{2019}s work must be a whole number of minutes from 1 to 10080.",
            ));
        }
        settings.grace_minutes = Some(minutes as u32);
    }
    if let Value::Array(entries) = field("allowedProviders") {
        let mut ids: Vec<String> = Vec::new();
        for entry in entries {
            let id = entry.as_str().map_or("", js_trim);
            if id.is_empty() || utf16_len(id) > MAX_PROVIDER_ID_LENGTH || id.chars().any(is_control) {
                return Err(StoreError::new("A provider id is not valid."));
            }
            if !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
        if ids.len() > MAX_ALLOWED_PROVIDERS {
            return Err(StoreError::new("Too many providers."));
        }
        settings.allowed_providers = Some(ids);
    }
    match field("modelLogin") {
        Value::Null => {}
        Value::String(login) if login == "pc" => {}
        Value::String(login) if login == "server" => settings.model_login = Some(ModelLogin::Server),
        _ => return Err(StoreError::new("The model login is not valid.")),
    }
    Ok(settings)
}

/// A target as the list keeps it: what ssh is shown, what makes two saved servers the same one (the user and port as
/// typed, the host name without regard to case), and the default name.
struct TargetId {
    display: String,
    key: String,
    label: String,
}

fn target_id(target: &str) -> Result<TargetId, StoreError> {
    let parsed = mixdog_ssh::command::parse_ssh_target(target).map_err(|error| StoreError::new(error.to_string()))?;
    Ok(TargetId { key: parsed.key(), label: parsed.label().to_string(), display: parsed.display })
}

fn hosts_document(value: &Value) -> Result<(), Invalid> {
    if value.get("hosts").is_some_and(Value::is_array) { Ok(()) } else { Err(Invalid::Damaged("Missing hosts list.".to_string())) }
}

/// The valid entries of a saved list, in order, without the duplicates and past the limit.
fn stored_hosts(value: &Value) -> Vec<SshHostRecord> {
    let Some(rows) = value.get("hosts").and_then(Value::as_array) else { return Vec::new() };
    let mut hosts: Vec<SshHostRecord> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for row in rows {
        let (Some(id), Some(target)) = (row.get("id").and_then(Value::as_str), row.get("target").and_then(Value::as_str)) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let Ok(target) = target_id(target) else { continue };
        let name = clean_name(row.get("name").and_then(Value::as_str).unwrap_or(""));
        if name.is_empty() || hosts.iter().any(|host| host.id == id) || keys.contains(&target.key) {
            continue;
        }
        let settings = row.get("settings").and_then(|raw| parse_host_settings(raw).ok()).filter(|parsed| !parsed.is_empty());
        keys.push(target.key);
        hosts.push(SshHostRecord {
            id: id.to_string(),
            name,
            target: target.display,
            last_connected_at: finite_number(row.get("lastConnectedAt")),
            settings,
        });
    }
    hosts.truncate(MAX_SAVED_HOSTS);
    hosts
}

type Hosts = Arc<Vec<SshHostRecord>>;

struct Inner {
    io: DurabilityIo,
    file: PathBuf,
    state: watch::Sender<Hosts>,
    /// One change at a time, from the edit of the list to the end of its write.
    gate: Mutex<()>,
}

/// The saved SSH servers; clones share one list.
#[derive(Clone)]
pub struct SshHostStore {
    inner: Arc<Inner>,
}

impl SshHostStore {
    /// Loads the list. A damaged file is kept aside and the last good copy restored; a file that cannot be read at
    /// all leaves the list empty in memory.
    pub async fn load(paths: &ConnectionsPaths, io: DurabilityIo) -> Self {
        let file = paths.ssh_hosts();
        let hosts = match read_state(io, file.clone(), Some(hosts_document)).await {
            Ok(document) => document.as_ref().map(stored_hosts).unwrap_or_default(),
            Err(error) => {
                tracing::warn!("[ssh-hosts] {} could not be read: {error}", file.display());
                Vec::new()
            }
        };
        let (state, _) = watch::channel(Arc::new(hosts));
        Self { inner: Arc::new(Inner { io, file, state, gate: Mutex::new(()) }) }
    }

    /// The saved servers, newest first.
    pub fn list(&self) -> Vec<SshHostRecord> {
        self.inner.state.borrow().as_ref().clone()
    }

    pub fn get(&self, id: &str) -> Option<SshHostRecord> {
        self.inner.state.borrow().iter().find(|host| host.id == id).cloned()
    }

    /// The saved server with this target (the host name compared without regard to case).
    pub fn find_by_target(&self, target: &str) -> Option<SshHostRecord> {
        let key = target_id(target).ok()?.key;
        self.inner.state.borrow().iter().find(|host| target_id(&host.target).is_ok_and(|saved| saved.key == key)).cloned()
    }

    /// The server of this target: the saved one, else a record for it that is not saved yet (a fresh id, `name` or
    /// the host part of the target as its name). [`save`](Self::save) stores it once the connection is up.
    pub fn ensure_for_target(&self, target: &str, name: &str) -> Result<SshHostRecord, StoreError> {
        let parsed = target_id(target)?;
        if let Some(saved) = self.find_by_target(&parsed.display) {
            return Ok(saved);
        }
        let name = clean_name(name);
        Ok(SshHostRecord {
            id: uuid::Uuid::new_v4().to_string(),
            name: if name.is_empty() { parsed.label } else { name },
            target: parsed.display,
            last_connected_at: None,
            settings: None,
        })
    }

    /// The model providers this server may use: `None` for every provider enabled on this PC, a list for those the
    /// user allowed, an empty list for a server that is not saved. Answered from memory.
    pub fn allowed_providers(&self, id: &str) -> Option<Vec<String>> {
        match self.inner.state.borrow().iter().find(|host| host.id == id) {
            None => Some(Vec::new()),
            Some(host) => host.settings.as_ref().and_then(|settings| settings.allowed_providers.clone()),
        }
    }

    /// The list now and after every change.
    pub fn subscribe(&self) -> watch::Receiver<Hosts> {
        self.inner.state.subscribe()
    }

    /// Adds the server, or replaces the one with the same id (or the same target under another spelling of its
    /// host name); the settings of the entry it replaces stay when the record carries none. It goes first.
    pub async fn save(&self, record: SshHostRecord) -> Result<SshHostRecord, StoreError> {
        let target = target_id(&record.target)?;
        let _gate = self.inner.gate.lock().await;
        let mut hosts = self.list();
        let settings = record.settings.or_else(|| hosts.iter().find(|host| host.id == record.id).and_then(|host| host.settings.clone()));
        let name = clean_name(&record.name);
        let saved = SshHostRecord {
            id: record.id,
            name: if name.is_empty() { record.target } else { name },
            target: target.display,
            last_connected_at: record.last_connected_at,
            settings: settings.filter(|settings| !settings.is_empty()),
        };
        hosts.retain(|host| host.id != saved.id && target_id(&host.target).is_ok_and(|other| other.key != target.key));
        hosts.insert(0, saved.clone());
        hosts.truncate(MAX_SAVED_HOSTS);
        self.commit(hosts).await?;
        Ok(saved)
    }

    /// A name for the server; an empty name changes nothing.
    pub async fn rename(&self, id: &str, name: &str) -> Result<(), StoreError> {
        let label = clean_name(name);
        let _gate = self.inner.gate.lock().await;
        let mut hosts = self.list();
        let Some(host) = hosts.iter_mut().find(|host| host.id == id) else { return Ok(()) };
        if label.is_empty() {
            return Ok(());
        }
        host.name = label;
        self.commit(hosts).await
    }

    /// Replaces the settings of a saved server with the validated `raw` (an empty result removes them); an unknown
    /// id changes nothing.
    pub async fn update_settings(&self, id: &str, raw: &Value) -> Result<(), StoreError> {
        let _gate = self.inner.gate.lock().await;
        let mut hosts = self.list();
        let Some(host) = hosts.iter_mut().find(|host| host.id == id) else { return Ok(()) };
        let next = parse_host_settings(raw)?;
        host.settings = (!next.is_empty()).then_some(next);
        self.commit(hosts).await
    }

    /// Forgets the server.
    pub async fn forget(&self, id: &str) -> Result<(), StoreError> {
        let _gate = self.inner.gate.lock().await;
        let mut hosts = self.list();
        let before = hosts.len();
        hosts.retain(|host| host.id != id);
        if hosts.len() == before {
            return Ok(());
        }
        self.commit(hosts).await
    }

    /// Publishes the new list, then writes it (keeping the replaced file as `.bak`). The caller holds the gate.
    async fn commit(&self, hosts: Vec<SshHostRecord>) -> Result<(), StoreError> {
        let document = serde_json::json!({ "version": 1, "hosts": hosts });
        self.inner.state.send_replace(Arc::new(hosts));
        write_state(self.inner.io, self.inner.file.clone(), document, true).await
    }
}
