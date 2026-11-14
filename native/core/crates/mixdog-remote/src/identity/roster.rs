//! The paired-device list as last reported by the relay (`remote-clients.json`), kept so the
//! off state can still show it, plus revocations asked for while the relay link was closed and
//! the secure-desktop controller keys owed a revoke. Display fields only: no tokens.

use std::collections::BTreeMap;
use std::path::PathBuf;

use mixdog_rt::InLane;
use mixdog_store::fsio::WriteLane;
use serde::{Deserialize, Serialize};

use super::secret::{SecretError, read_raw, write_secret};

const FILE: &str = "clients.json";
pub const MAX_OWED_KEYS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub browser: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    #[serde(default)]
    pub online: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pending_removal: bool,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    clients: Vec<ClientInfo>,
    pending_revokes: Vec<String>,
    controller_keys: BTreeMap<String, String>,
    repair_required: bool,
    #[serde(default)]
    owed_access_keys: Vec<String>,
    #[serde(default)]
    owed_access_unknown: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerKeyRecord {
    pub client_id: String,
    pub public_key: String,
    pub unpaired: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwedAccess {
    pub keys: Vec<String>,
    pub unknown: u64,
}

pub fn is_controller_key(value: &str) -> bool {
    use base64::Engine;
    value.len() == 87
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 65 && bytes[0] == 4)
}

fn clip(value: &str, max: usize) -> String {
    mixdog_js::slice_utf16(value, max)
}

fn normalized(row: &ClientInfo) -> Option<ClientInfo> {
    (!row.id.is_empty()).then(|| ClientInfo {
        id: clip(&row.id, 80),
        name: clip(&row.name, 80),
        platform: clip(&row.platform, 80),
        browser: clip(&row.browser, 80),
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        online: false,
        pending_removal: false,
    })
}

/// Strict reading: a wrong shape is damage, never an empty list.
fn parse(bytes: &[u8]) -> Option<Stored> {
    let mut stored: Stored = serde_json::from_slice(bytes).ok()?;
    if !stored.owed_access_keys.iter().all(|key| is_controller_key(key)) {
        return None;
    }
    stored.controller_keys.retain(|id, key| !id.is_empty() && is_controller_key(key));
    stored.clients = stored.clients.iter().filter_map(normalized).collect();
    Some(stored)
}

pub struct Roster {
    path: PathBuf,
    state: Stored,
    /// Queued revocation → its instance (this run only: no acknowledgement outlives a restart).
    revocations: BTreeMap<String, u64>,
    last_revocation: u64,
}

impl Roster {
    /// Damage keeps the bytes beside the file and sets `repair_required`: the revocations it held
    /// are unknown, so every paired device is revoked by the pairing reset that flag asks for.
    pub fn load<L: WriteLane>(lane: &InLane<L>, dir: &std::path::Path) -> Result<Self, SecretError> {
        let path = dir.join(FILE);
        let mut roster = Self { path, state: Stored::default(), revocations: BTreeMap::new(), last_revocation: 0 };
        match read_raw(lane, &roster.path) {
            Ok(Some(bytes)) => match parse(&bytes) {
                Some(stored) => roster.state = stored,
                None => {
                    roster.state.repair_required = true;
                    roster.state.owed_access_unknown = 1;
                    let mut aside = roster.path.as_os_str().to_owned();
                    aside.push(".corrupt");
                    let _ = write_secret(lane, &PathBuf::from(aside), &bytes);
                    roster.persist(lane)?;
                }
            },
            Ok(None) => {}
            Err(_) => {
                roster.state.repair_required = true;
                roster.state.owed_access_unknown = 1;
                roster.persist(lane)?;
            }
        }
        for id in roster.state.pending_revokes.clone() {
            roster.issue(&id);
        }
        Ok(roster)
    }

    fn persist<L: WriteLane>(&self, lane: &InLane<L>) -> Result<(), SecretError> {
        write_secret(lane, &self.path, &serde_json::to_vec(&self.state).unwrap_or_default())
    }

    fn issue(&mut self, client_id: &str) {
        self.last_revocation += 1;
        self.revocations.insert(client_id.to_owned(), self.last_revocation);
    }

    /// Owes the access keys of `ids` in memory; past the cap the revocations become unknown.
    fn owe(&mut self, ids: Option<&[&str]>) {
        let keys: Vec<String> = match ids {
            None => self.state.controller_keys.values().cloned().collect(),
            Some(ids) => ids.iter().filter_map(|id| self.state.controller_keys.get(*id).cloned()).collect(),
        };
        for key in keys {
            if self.state.owed_access_keys.contains(&key) {
                continue;
            }
            if self.state.owed_access_keys.len() >= MAX_OWED_KEYS {
                self.state.owed_access_unknown += 1;
            } else {
                self.state.owed_access_keys.push(key);
            }
        }
    }

    pub fn list(&self) -> Vec<ClientInfo> {
        self.state
            .clients
            .iter()
            .map(|client| ClientInfo {
                pending_removal: self.state.pending_revokes.contains(&client.id),
                ..client.clone()
            })
            .collect()
    }

    pub fn pending(&self) -> Vec<String> {
        self.state.pending_revokes.clone()
    }

    pub fn revocation(&self, client_id: &str) -> Option<u64> {
        self.revocations.get(client_id).copied()
    }

    pub fn repair_required(&self) -> bool {
        self.state.repair_required
    }

    /// Records what the relay reported; an unchanged list is not rewritten.
    pub fn remember<L: WriteLane>(&mut self, lane: &InLane<L>, clients: &[ClientInfo]) -> Result<(), SecretError> {
        let next: Vec<ClientInfo> = clients.iter().filter_map(normalized).collect();
        if next == self.state.clients {
            return Ok(());
        }
        self.state.clients = next;
        self.persist(lane)
    }

    /// Queues the revocation for the next relay leg; the access key is owed in the same write.
    pub fn queue_revoke<L: WriteLane>(&mut self, lane: &InLane<L>, client_id: &str) -> Result<(), SecretError> {
        self.owe(Some(&[client_id]));
        if !self.state.pending_revokes.iter().any(|id| id == client_id) {
            self.state.pending_revokes.push(client_id.to_owned());
            self.issue(client_id);
        }
        self.persist(lane)
    }

    /// The relay confirmed the revocation sent for `revocation`; a newer one stays queued.
    pub fn applied<L: WriteLane>(
        &mut self,
        lane: &InLane<L>,
        client_id: &str,
        revocation: u64,
    ) -> Result<(), SecretError> {
        if self.revocations.get(client_id) != Some(&revocation) {
            return self.persist(lane);
        }
        self.revocations.remove(client_id);
        self.owe(Some(&[client_id]));
        self.state.clients.retain(|client| client.id != client_id);
        self.state.pending_revokes.retain(|id| id != client_id);
        self.state.controller_keys.remove(client_id);
        self.persist(lane)
    }

    /// The device was approved again: a revocation still queued for it no longer applies.
    pub fn repaired<L: WriteLane>(&mut self, lane: &InLane<L>, client_id: &str) -> Result<(), SecretError> {
        if !self.state.pending_revokes.iter().any(|id| id == client_id) {
            return Ok(());
        }
        self.revocations.remove(client_id);
        self.state.pending_revokes.retain(|id| id != client_id);
        self.persist(lane)
    }

    /// The device identity changed: nothing earlier applies, and damage is answered. Every
    /// mapped controller key is owed first.
    pub fn clear<L: WriteLane>(&mut self, lane: &InLane<L>) -> Result<(), SecretError> {
        self.revocations.clear();
        self.owe(None);
        self.state = Stored {
            owed_access_keys: std::mem::take(&mut self.state.owed_access_keys),
            owed_access_unknown: self.state.owed_access_unknown,
            ..Stored::default()
        };
        self.persist(lane)
    }

    pub fn owed_access(&self) -> OwedAccess {
        OwedAccess { keys: self.state.owed_access_keys.clone(), unknown: self.state.owed_access_unknown }
    }

    /// Takes over revocations another store owed (the desktop's old pending-revokes file): the keys join the owed
    /// access; past the cap, or with `unknown`, the revocations count as unknown (at least 1, so folding the same
    /// record twice owes nothing twice). Nothing is written when all of it is held already; a failed write keeps
    /// the state as it was.
    pub fn owe_access<L: WriteLane>(&mut self, lane: &InLane<L>, keys: &[String], unknown: bool) -> Result<(), SecretError> {
        let before = (self.state.owed_access_keys.clone(), self.state.owed_access_unknown);
        let mut lost = unknown;
        for key in keys {
            if self.state.owed_access_keys.contains(key) {
                continue;
            }
            if self.state.owed_access_keys.len() >= MAX_OWED_KEYS {
                lost = true;
            } else {
                self.state.owed_access_keys.push(key.clone());
            }
        }
        if lost && self.state.owed_access_unknown == 0 {
            self.state.owed_access_unknown = 1;
        }
        if before == (self.state.owed_access_keys.clone(), self.state.owed_access_unknown) {
            return Ok(());
        }
        if let Err(error) = self.persist(lane) {
            (self.state.owed_access_keys, self.state.owed_access_unknown) = before;
            return Err(error);
        }
        Ok(())
    }

    /// The desktop app holds `keys` (and the `unknown` it read) durably now.
    pub fn settle_owed_access<L: WriteLane>(
        &mut self,
        lane: &InLane<L>,
        keys: &[String],
        unknown: u64,
    ) -> Result<(), SecretError> {
        let left: Vec<String> = self.state.owed_access_keys.iter().filter(|key| !keys.contains(key)).cloned().collect();
        let resolved = unknown > 0 && self.state.owed_access_unknown == unknown;
        if left.len() == self.state.owed_access_keys.len() && !resolved {
            return Ok(());
        }
        self.state.owed_access_keys = left;
        if resolved {
            self.state.owed_access_unknown = 0;
        }
        self.persist(lane)
    }

    pub fn controller_keys(&self) -> Vec<ControllerKeyRecord> {
        self.state
            .controller_keys
            .iter()
            .map(|(client_id, public_key)| ControllerKeyRecord {
                client_id: client_id.clone(),
                public_key: public_key.clone(),
                unpaired: self.state.pending_revokes.contains(client_id),
            })
            .collect()
    }

    /// Keeps the key a paired device delivered. A different earlier key is replaced and owed a
    /// revoke in the same write; a failed write keeps both as they were.
    pub fn set_controller_key<L: WriteLane>(
        &mut self,
        lane: &InLane<L>,
        client_id: &str,
        public_key: &str,
    ) -> Result<(), SecretError> {
        let previous = self.state.controller_keys.get(client_id).cloned();
        if previous.as_deref() == Some(public_key) {
            return Ok(());
        }
        let before = (self.state.controller_keys.clone(), self.state.owed_access_keys.clone(), self.state.owed_access_unknown);
        if previous.is_some() {
            self.owe(Some(&[client_id]));
        }
        self.state.controller_keys.insert(client_id.to_owned(), public_key.to_owned());
        if let Err(error) = self.persist(lane) {
            (self.state.controller_keys, self.state.owed_access_keys, self.state.owed_access_unknown) = before;
            return Err(error);
        }
        Ok(())
    }
}
