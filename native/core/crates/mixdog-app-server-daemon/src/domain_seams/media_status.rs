//! The `media` domain of the setup tool's `status` (`executor.mjs` `mediaDefaults`): the default
//! generator the user pinned per kind (Settings -> Built-in -> Media generation; none is Auto) and
//! the last generator used (which applies only to a kind on Auto), both read from the media store's
//! `defaults.json`. The dispatcher puts the `domain` key first.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::setup::StatusReader;
use mixdog_core_api::ids::ThreadId;
use mixdog_services::media::MediaStore;
use mixdog_tools::orch::util::PortError;
use serde_json::{Map, Value};

/// `MEDIA_KINDS`.
const KINDS: [&str; 2] = ["image", "video"];

pub struct MediaStatus {
    store: Arc<MediaStore>,
}

impl MediaStatus {
    pub fn new(store: Arc<MediaStore>) -> Self {
        Self { store }
    }
}

/// `fieldsOf(row, fields)`: the row's named fields in that order, or null when there is no row.
fn fields_of(row: &Value, fields: &[&str]) -> Value {
    if row.is_null() {
        return Value::Null;
    }
    Value::Object(fields.iter().map(|field| ((*field).to_owned(), row.get(*field).cloned().unwrap_or(Value::Null))).collect::<Map<_, _>>())
}

#[async_trait]
impl StatusReader for MediaStatus {
    fn domains(&self) -> &'static [&'static str] {
        &["media"]
    }

    async fn read(&self, _domain: &str, _detail: bool, _thread: &ThreadId) -> Result<Value, PortError> {
        // Both reads are file work: one job on the store's lane.
        let (pins, remembered) = self
            .store
            .run(|store| {
                let pins = store.get_pins();
                let remembered: Vec<Value> = KINDS.iter().map(|kind| store.get_default(Some(&Value::String((*kind).to_owned())))).collect();
                (pins, remembered)
            })
            .await
            .map_err(|error| PortError::Failed { capability: "media".into(), message: error.to_string() })?;
        let pinned: Map<String, Value> =
            KINDS.iter().map(|kind| ((*kind).to_owned(), fields_of(pins.get(*kind).unwrap_or(&Value::Null), &["lane", "model", "account"]))).collect();
        let remembered: Map<String, Value> =
            KINDS.iter().zip(&remembered).map(|(kind, row)| ((*kind).to_owned(), fields_of(row, &["lane", "model"]))).collect();
        let mut out = Map::new();
        out.insert("pinned".into(), Value::Object(pinned));
        out.insert("remembered".into(), Value::Object(remembered));
        Ok(Value::Object(out))
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {}
