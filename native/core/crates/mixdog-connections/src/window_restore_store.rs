//! The server windows open at the last quit, reopened at the next launch: their host ids live in a small JSON file
//! beside the saved servers. A window the user closes is forgotten; quitting keeps the list. The file is read on
//! first use; a read that fails is not remembered, the next call reads again.

use std::path::PathBuf;

use mixdog_rt::DurabilityIo;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Mutex;

use crate::paths::ConnectionsPaths;
use crate::paths::StoreError;
use crate::paths::read_state;
use crate::paths::write_state;

const MAX_REMEMBERED: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
struct RestoreState {
    enabled: bool,
    open: Vec<String>,
}

/// A missing or damaged file reads as the defaults: on, nothing open.
fn parsed(value: Option<&Value>) -> RestoreState {
    let mut open: Vec<String> = Vec::new();
    if let Some(entries) = value.and_then(|state| state.get("open")).and_then(Value::as_array) {
        for id in entries.iter().filter_map(Value::as_str).filter(|id| !id.is_empty()) {
            if !open.iter().any(|known| known == id) {
                open.push(id.to_string());
            }
        }
    }
    open.truncate(MAX_REMEMBERED);
    RestoreState { enabled: value.and_then(|state| state.get("enabled")) != Some(&Value::Bool(false)), open }
}

pub struct WindowRestoreStore {
    io: DurabilityIo,
    file: PathBuf,
    /// `None` until the file was read; held across a change from its read to the end of its write.
    state: Mutex<Option<RestoreState>>,
}

impl WindowRestoreStore {
    pub fn new(paths: &ConnectionsPaths, io: DurabilityIo) -> Self {
        Self { io, file: paths.server_windows(), state: Mutex::new(None) }
    }

    async fn loaded<'a>(&self, state: &'a mut Option<RestoreState>) -> Result<&'a mut RestoreState, StoreError> {
        if state.is_none() {
            let document = read_state(self.io, self.file.clone(), None).await?;
            *state = Some(parsed(document.as_ref()));
        }
        Ok(state.get_or_insert_with(|| parsed(None)))
    }

    /// Writes the new state (without a backup copy), keeping it in memory first.
    async fn change(&self, change: impl FnOnce(&mut RestoreState)) -> Result<RestoreState, StoreError> {
        let mut state = self.state.lock().await;
        let current = self.loaded(&mut state).await?;
        change(current);
        let next = current.clone();
        let document = json!({ "version": 1, "enabled": next.enabled, "open": next.open });
        write_state(self.io, self.file.clone(), document, false).await?;
        Ok(next)
    }

    /// Whether the windows are reopened at launch (on unless the file says otherwise).
    pub async fn enabled(&self) -> Result<bool, StoreError> {
        let mut state = self.state.lock().await;
        Ok(self.loaded(&mut state).await?.enabled)
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<bool, StoreError> {
        Ok(self.change(|state| state.enabled = enabled).await?.enabled)
    }

    /// A server window opened.
    pub async fn remember(&self, id: &str) -> Result<(), StoreError> {
        if self.list().await?.iter().any(|open| open == id) {
            return Ok(());
        }
        self.change(|state| {
            if !state.open.iter().any(|open| open == id) {
                state.open.push(id.to_string());
            }
            let extra = state.open.len().saturating_sub(MAX_REMEMBERED);
            state.open.drain(..extra);
        })
        .await?;
        Ok(())
    }

    /// The user closed a server window (not a quit).
    pub async fn forget(&self, id: &str) -> Result<(), StoreError> {
        if !self.list().await?.iter().any(|open| open == id) {
            return Ok(());
        }
        self.change(|state| state.open.retain(|open| open != id)).await?;
        Ok(())
    }

    /// The remembered server ids, in the order their windows opened.
    pub async fn list(&self) -> Result<Vec<String>, StoreError> {
        let mut state = self.state.lock().await;
        Ok(self.loaded(&mut state).await?.open.clone())
    }

    /// Forgets the remembered ids `keep` does not name: a server removed from the saved list is not remembered.
    pub async fn retain(&self, keep: impl Fn(&str) -> bool) -> Result<(), StoreError> {
        if self.list().await?.iter().all(|open| keep(open)) {
            return Ok(());
        }
        self.change(|state| state.open.retain(|open| keep(open))).await?;
        Ok(())
    }
}
