//! The port forwards of each saved server, kept on this PC beside the saved servers and started again whenever that
//! server's connection comes back. The file is read on first use; a read that fails is not remembered, the next call
//! reads again.

use std::path::PathBuf;

use mixdog_rt::DurabilityIo;
use serde_json::Value;
use serde_json::json;
use std::sync::{Mutex, PoisonError};
use tokio::sync::Semaphore;

use crate::paths::ConnectionsPaths;
use crate::paths::StoreError;
use crate::paths::read_state;
use crate::paths::write_state;

const MAX_FORWARDS_PER_HOST: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SavedPortForward {
    pub remote_port: u16,
    /// The local port last used; taken again when it is free.
    pub local_port: u16,
}

/// The forwards of every server, in the order the file keeps them.
type Forwards = Vec<(String, Vec<SavedPortForward>)>;

/// A port: a whole number from 1 to 65535.
fn valid_port(value: Option<&Value>) -> Option<u16> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && (1.0..=65_535.0).contains(&number)).then_some(number as u16)
}

fn parsed(value: &Value) -> Forwards {
    let Some(hosts) = value.get("hosts").and_then(Value::as_object) else { return Vec::new() };
    let mut result = Vec::new();
    for (id, list) in hosts {
        let Some(list) = list.as_array() else { continue };
        let forwards: Vec<SavedPortForward> = list
            .iter()
            .filter_map(|entry| {
                Some(SavedPortForward { remote_port: valid_port(entry.get("remotePort"))?, local_port: valid_port(entry.get("localPort"))? })
            })
            .take(MAX_FORWARDS_PER_HOST)
            .collect();
        if !forwards.is_empty() {
            result.push((id.clone(), forwards));
        }
    }
    result
}

pub struct PortForwardStore {
    io: DurabilityIo,
    file: PathBuf,
    /// `None` until a successful read; the transaction permit spans read, edit and write.
    turn: Semaphore,
    state: Mutex<Option<Forwards>>,
}

impl PortForwardStore {
    pub fn new(paths: &ConnectionsPaths, io: DurabilityIo) -> Self {
        Self { io, file: paths.port_forwards(), state: Mutex::new(None), turn: Semaphore::new(1) }
    }

    /// A missing or damaged file (kept aside, the last good copy restored) starts empty; only an I/O error fails.
    // Called only while holding the transaction permit. Never hold data across I/O.
    async fn loaded(&self) -> Result<(), StoreError> {
        let missing = self.state.lock().unwrap_or_else(PoisonError::into_inner).is_none();
        if missing {
            let document = read_state(self.io, self.file.clone(), None).await?;
            *self.state.lock().unwrap_or_else(PoisonError::into_inner) = Some(document.as_ref().map(parsed).unwrap_or_default());
        }
        Ok(())
    }

    /// The forwards saved for the server.
    pub async fn get(&self, host_id: &str) -> Result<Vec<SavedPortForward>, StoreError> {
        let _turn = self.turn.acquire().await.expect("store transaction gate is never closed");
        self.loaded().await?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let all = state.as_mut().expect("state loaded under transaction permit");
        Ok(all.iter().find(|(id, _)| id == host_id).map(|(_, list)| list.clone()).unwrap_or_default())
    }

    /// Saves the server's forwards (at most 64; a port of 0 is dropped; an empty list forgets the server).
    pub async fn set(&self, host_id: &str, forwards: &[SavedPortForward]) -> Result<(), StoreError> {
        let _turn = self.turn.acquire().await.expect("store transaction gate is never closed");
        self.loaded().await?;
        let hosts = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let all = state.as_mut().expect("state loaded under transaction permit");
            let kept: Vec<SavedPortForward> =
                forwards.iter().filter(|entry| entry.remote_port != 0 && entry.local_port != 0).take(MAX_FORWARDS_PER_HOST).copied().collect();
            match (all.iter().position(|(id, _)| id == host_id), kept.is_empty()) {
                (Some(at), true) => {
                    all.remove(at);
                }
                (Some(at), false) => all[at].1 = kept,
                (None, false) => all.push((host_id.to_string(), kept)),
                (None, true) => {}
            }
            all.iter()
                .map(|(id, list)| {
                    let rows: Vec<Value> = list.iter().map(|f| json!({ "remotePort": f.remote_port, "localPort": f.local_port })).collect();
                    (id.clone(), Value::Array(rows))
                })
                .collect::<serde_json::Map<String, Value>>()
        };
        write_state(self.io, self.file.clone(), json!({ "version": 1, "hosts": hosts }), true).await
    }
}
