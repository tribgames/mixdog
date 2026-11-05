//! This install's relay registration (`relay-device.json`) and the queue of registrations
//! still to be deleted at the relay (`relay-device-revocations.json`), so Unpair works offline.
//!
//! One core owns the data directory, so the files need no cross-process lock; the mutex only
//! orders this process's read-modify-write cycles.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mixdog_rt::InLane;
use mixdog_store::fsio::WriteLane;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use super::secret::{SecretError, read_secret, write_secret};

const IDENTITY_FILE: &str = "relay-device.json";
const REVOCATIONS_FILE: &str = "relay-device-revocations.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_secret: String,
}

impl DeviceIdentity {
    fn is_valid(&self) -> bool {
        (8..=64).contains(&self.device_id.len())
            && self.device_id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
            && self.device_secret.len() >= 16
    }

    /// A fresh identity that is never written down: what a tunnel runs with when its identity
    /// file can be neither read nor written.
    pub fn mint() -> Self {
        let mut secret = [0u8; 24];
        rand::rng().fill_bytes(&mut secret);
        Self { device_id: uuid::Uuid::new_v4().to_string(), device_secret: hex(&secret) }
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// What the revocation queue file holds: a list, or damage (which is not an empty list).
#[derive(Debug, thiserror::Error)]
pub enum QueueError {
    #[error("the queued device revocations are damaged")]
    Damaged(Vec<u8>),
    #[error(transparent)]
    Secret(#[from] SecretError),
}

pub struct DeviceFiles {
    dir: PathBuf,
    identity_file: String,
    ordered: Mutex<()>,
}

fn parse_identity(bytes: &[u8]) -> Option<DeviceIdentity> {
    serde_json::from_slice::<DeviceIdentity>(bytes).ok().filter(DeviceIdentity::is_valid)
}

fn parse_queue(bytes: &[u8]) -> Option<Vec<DeviceIdentity>> {
    let list: Vec<DeviceIdentity> = serde_json::from_slice(bytes).ok()?;
    list.iter().all(DeviceIdentity::is_valid).then_some(list)
}

fn quarantine_path(path: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".corrupt-{stamp}"));
    PathBuf::from(name)
}

impl DeviceFiles {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self::at(dir, IDENTITY_FILE)
    }

    /// Another registration kept the same way, e.g. the webhook tunnel's `relay-hook-device.json`.
    /// Its revocation queue is the desktop's; only the identity file differs.
    pub fn at(dir: impl Into<PathBuf>, identity_file: &str) -> Self {
        Self { dir: dir.into(), identity_file: identity_file.to_owned(), ordered: Mutex::new(()) }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.ordered.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_identity<L: WriteLane>(&self, lane: &InLane<L>) -> Result<DeviceIdentity, SecretError> {
        let identity = DeviceIdentity::mint();
        let text = serde_json::to_vec_pretty(&identity).unwrap_or_default();
        write_secret(lane, &self.path(&self.identity_file), &text)?;
        Ok(identity)
    }

    /// Only a genuinely absent file mints an identity; a read or permission error propagates, so
    /// a retry later cannot orphan every paired phone's device id. A file that reads but holds
    /// no valid identity is kept beside the original, then replaced.
    pub fn load_or_create<L: WriteLane>(&self, lane: &InLane<L>) -> Result<DeviceIdentity, SecretError> {
        let _guard = self.guard();
        let path = self.path(&self.identity_file);
        if let Some(bytes) = read_secret(lane, &path)? {
            if let Some(identity) = parse_identity(&bytes) {
                return Ok(identity);
            }
            write_secret(lane, &quarantine_path(&path), &bytes)?;
        }
        self.write_identity(lane)
    }

    pub fn load_queue<L: WriteLane>(&self, lane: &InLane<L>) -> Result<Vec<DeviceIdentity>, QueueError> {
        match read_secret(lane, &self.path(REVOCATIONS_FILE))? {
            None => Ok(Vec::new()),
            Some(bytes) => parse_queue(&bytes).ok_or(QueueError::Damaged(bytes)),
        }
    }

    pub fn queue_damaged<L: WriteLane>(&self, lane: &InLane<L>) -> Result<bool, SecretError> {
        match self.load_queue(lane) {
            Ok(_) => Ok(false),
            Err(QueueError::Damaged(_)) => Ok(true),
            Err(QueueError::Secret(error)) => Err(error),
        }
    }

    fn write_queue<L: WriteLane>(&self, lane: &InLane<L>, list: &[DeviceIdentity]) -> Result<(), SecretError> {
        let path = self.path(REVOCATIONS_FILE);
        if let Some(previous) = read_secret(lane, &path)?
            && parse_queue(&previous).is_some()
        {
            write_secret(lane, &self.path(&format!("{REVOCATIONS_FILE}.bak")), &previous)?;
        }
        write_secret(lane, &path, &serde_json::to_vec(list).unwrap_or_default())
    }

    /// The damaged text is kept aside, and the previous version (`.bak`) is read for the
    /// identities it names. That copy may lack the latest entry, so it only adds revocations to
    /// attempt; it never says the queue is complete.
    fn salvage<L: WriteLane>(&self, lane: &InLane<L>, damaged: &[u8]) -> Result<Vec<DeviceIdentity>, SecretError> {
        write_secret(lane, &quarantine_path(&self.path(REVOCATIONS_FILE)), damaged)?;
        let previous = read_secret(lane, &self.path(&format!("{REVOCATIONS_FILE}.bak")))?;
        Ok(previous.and_then(|bytes| parse_queue(&bytes)).unwrap_or_default())
    }

    /// Queues the current registration for authenticated deletion at the relay, then replaces it
    /// at once so Unpair can refresh QR codes while the relay is down. A damaged queue does not
    /// block this: the replaced identity is the one that must be revoked.
    pub fn rotate<L: WriteLane>(&self, lane: &InLane<L>) -> Result<DeviceIdentity, SecretError> {
        let previous = self.load_or_create(lane)?;
        let _guard = self.guard();
        let (mut queued, damaged) = match self.load_queue(lane) {
            Ok(list) => (list, false),
            Err(QueueError::Damaged(bytes)) => (self.salvage(lane, &bytes)?, true),
            Err(QueueError::Secret(error)) => return Err(error),
        };
        let listed = queued.iter().any(|identity| identity.device_id == previous.device_id);
        if damaged || !listed {
            if !listed {
                queued.push(previous);
            }
            self.write_queue(lane, &queued)?;
        }
        self.write_identity(lane)
    }

    /// The relay confirmed the deletion of `device_id`.
    pub fn remove_queued<L: WriteLane>(&self, lane: &InLane<L>, device_id: &str) -> Result<(), QueueError> {
        let _guard = self.guard();
        let queued = self.load_queue(lane)?;
        let kept: Vec<_> = queued.into_iter().filter(|identity| identity.device_id != device_id).collect();
        self.write_queue(lane, &kept)?;
        Ok(())
    }
}
