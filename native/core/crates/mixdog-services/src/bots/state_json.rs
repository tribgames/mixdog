//! One JSON state file of the bots module (`heartbeat.json`, `routine-results.json`): every
//! read and write is a job on the durability lane, never on an executor thread.

use std::path::{Path, PathBuf};

use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use mixdog_statefile::{Opts, Peek, StateError, peek, read_json, update_json, write_json};
use serde_json::Value;

#[derive(Clone)]
pub struct StateJson {
    path: PathBuf,
    lane: DurabilityIo,
}

impl StateJson {
    pub fn new(path: PathBuf, lane: DurabilityIo) -> Self {
        Self { path, lane }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    async fn job<R: Send + 'static>(&self, job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> Result<R, String> {
        let handle = self.lane.submit_wait(&CancellationToken::new(), job).await.map_err(|e| e.to_string())?;
        handle.await.map_err(|e| e.to_string())
    }

    /// What the file holds, touching nothing (`readFile` + `JSON.parse`): `None` for a missing,
    /// unreadable or unparsable file.
    pub async fn peek_value(&self) -> Option<Value> {
        let path = self.path.clone();
        match self.job(move |lane| peek(lane, &path, None)).await {
            Ok(Ok(Peek::Value(value))) => Some(value),
            _ => None,
        }
    }

    /// `writeJsonAtomicAsync`: the document, two-space indented, renamed into place.
    pub async fn write(&self, value: Value) -> Result<(), String> {
        let path = self.path.clone();
        self.job(move |lane| write_json(lane, &path, &value, &Opts::default()).map(drop).map_err(|e| e.to_string())).await?
    }

    /// `readJsonState`: a damaged file is kept aside and its last good copy restored.
    pub async fn read_state(&self) -> Result<Option<Value>, String> {
        let path = self.path.clone();
        self.job(move |lane| read_json(lane, &path, None, &Opts::default()).map_err(|e| e.to_string())).await?
    }

    /// `updateJsonAtomic` with a backup of the replaced version: under the file's lock the
    /// mutator turns the stored document into the next one (`None` keeps the file).
    pub async fn update<R: Send + 'static>(
        &self,
        mutator: impl FnOnce(Option<Value>) -> Result<(Option<Value>, R), String> + Send + 'static,
    ) -> Result<R, String> {
        let path = self.path.clone();
        let opts = Opts { backup: true, ..Opts::default() };
        self.job(move |lane| {
            let mut out = None;
            let written = update_json(
                lane,
                &path,
                |current| {
                    let (next, result) = mutator(current)?;
                    out = Some(result);
                    Ok::<_, String>(next)
                },
                &opts,
            );
            match written {
                Ok(_) => Ok(out.expect("the mutator ran")),
                Err(StateError::Mutator(message)) => Err(message),
                Err(other) => Err(other.to_string()),
            }
        })
        .await?
    }
}
