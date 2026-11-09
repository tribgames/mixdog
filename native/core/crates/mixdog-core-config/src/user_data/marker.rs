//! The init marker (`readInitInstanceId`, `markUserDataInitialized`).

use std::path::Path;

use mixdog_rt::InLane;
use mixdog_statefile::WriteLane;
use serde_json::Map;
use serde_json::Value;

use super::GuardError;
use super::INIT_MARKER;
use super::UserData;
use super::names::iso;
use super::resolve;

impl UserData {
    /// `readInitInstanceId(dataDir)`: the `instanceId` of the dir's init marker; `None` only when it is absent. A marker
    /// that is not JSON, or has no non-empty `instanceId`, is damaged and an error.
    pub(super) fn init_instance_id(&self, data_dir: &Path) -> Result<Option<String>, GuardError> {
        if data_dir.as_os_str().is_empty() {
            return Ok(None);
        }
        let path = data_dir.join(INIT_MARKER);
        let Some(bytes) = mixdog_statefile::read_content(&path)? else { return Ok(None) };
        let marker = mixdog_js::json_parse(&String::from_utf8_lossy(&bytes))
            .map_err(|_| GuardError::Syntax(format!("[user-data] invalid initialization marker at {}", path.display())))?;
        match marker.get("instanceId").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => Ok(Some(id.to_owned())),
            _ => Err(GuardError::Syntax(format!(
                "[user-data] initialization marker at {} must have a non-empty instanceId",
                path.display()
            ))),
        }
    }

    /// `hasUserDataInitMarker(dataDir)`.
    pub fn has_init_marker(&self, data_dir: &Path) -> Result<bool, GuardError> {
        Ok(self.init_instance_id(data_dir)?.is_some())
    }

    /// `markUserDataInitialized(dataDir)`: creates a missing marker and answers its `instanceId`, or `None` when the dir
    /// is gone or the missing marker cannot be created. Never creates the dir. An existing marker is never replaced;
    /// when another creator published since the absent read, it wins.
    pub fn mark_initialized<L: WriteLane>(&self, lane: &InLane<L>, data_dir: &Path) -> Result<Option<String>, GuardError> {
        let existing = self.init_instance_id(data_dir)?;
        if existing.is_some() || data_dir.as_os_str().is_empty() || mixdog_statefile::metadata(lane, data_dir).is_err() {
            return Ok(existing);
        }
        let mut marker = Map::new();
        marker.insert("instanceId".into(), Value::String((self.new_id)()));
        marker.insert("dataDir".into(), Value::String(resolve(data_dir).to_string_lossy().into_owned()));
        marker.insert("createdAt".into(), Value::String(iso(self.now())));
        let opts = mixdog_statefile::Opts { create_only: true, ..mixdog_statefile::Opts::default() };
        // A failed write is not an error here: the read below answers what is there.
        let _ = mixdog_statefile::write_json(lane, &data_dir.join(INIT_MARKER), &Value::Object(marker), &opts);
        self.init_instance_id(data_dir)
    }
}
