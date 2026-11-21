use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::support::io_failure;
use mixdog_core_base::support::on_lane;
use mixdog_core_base::support::write_atomic;
use mixdog_mcp::hook_bus::TranscriptExport;
use mixdog_rt::CancellationToken;
use mixdog_rt::MaintenanceIo;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use super::SessionLanes;
use super::delete::is_session_id;
use super::run::read_context;
use super::seams::ThreadStore;

/// `SESSION_LOG_SUFFIX`.
const LOG_SUFFIX: &str = ".log.jsonl";

/// `<data>/sessions/<id>.log.jsonl`: the file a session's export is written to and delete
/// removes.
pub fn export_path(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("sessions").join(format!("{id}{LOG_SUFFIX}"))
}

/// The log's base form for `messages`: `encodeSessionRecord` and `encodeCompacted(1, …)`, every
/// message as `JSON.stringify` writes it.
pub fn render(log_id: &str, id: &str, header: &Header, messages: &[Value]) -> String {
    let session = json!({
        "t": "session", "s": 0, "v": 1, "logId": log_id, "id": id, "prev": null, "legacy": null, "header": header,
    });
    let messages: Vec<String> = messages.iter().map(mixdog_js::json_stringify).collect();
    format!("{}\n{{\"t\":\"compacted\",\"s\":1,\"len\":{},\"messages\":[{}]}}\n", mixdog_js::json_stringify(&session), messages.len(), messages.join(","))
}

/// The exports of the sessions the thread store holds.
pub struct TranscriptFiles {
    data_dir: PathBuf,
    store: Arc<dyn ThreadStore>,
    lanes: SessionLanes,
    writes: MaintenanceIo,
}

impl TranscriptFiles {
    pub fn new(data_dir: &Path, store: Arc<dyn ThreadStore>, lanes: SessionLanes, writes: MaintenanceIo) -> Self {
        Self { data_dir: data_dir.to_owned(), store, lanes, writes }
    }

    /// The stored session's log id, header and model context; `None` for an unknown session.
    async fn read(&self, thread: &ThreadId) -> Result<Option<(String, Header, Vec<Value>)>, CoreError> {
        let token = CancellationToken::new();
        self.store.unheld().await;
        let (store, id) = (self.store.clone(), thread.clone());
        let header = match on_lane(self.lanes.io, &token, move |lane| store.read_header(lane, &id)).await? {
            Ok(header) => header,
            Err(CoreError::ThreadNotFound { .. }) => return Ok(None),
            Err(error) => return Err(error),
        };
        let (store, id) = (self.store.clone(), thread.clone());
        let log_id = on_lane(self.lanes.io, &token, move |lane| store.read_log_id(lane, &id)).await??;
        let rows = read_context(&self.store, &self.lanes, thread).await?;
        Ok(Some((
            log_id,
            header,
            rows.into_iter()
                .map(|(_, mut message)| {
                    mixdog_agent::interrupt::without_recovery_mark(&mut message);
                    message
                })
                .collect(),
        )))
    }

    /// Writes the export; false when the session has no model context to export.
    async fn refresh(&self, id: &str) -> Result<bool, CoreError> {
        let Some((log_id, header, messages)) = self.read(&ThreadId::from(id)).await? else { return Ok(false) };
        if messages.is_empty() {
            return Ok(false);
        }
        let text = render(&log_id, id, &header, &messages);
        let path = export_path(&self.data_dir, id);
        on_lane(self.writes, &CancellationToken::new(), move |lane| write_atomic(lane, &path, text.as_bytes(), false))
            .await?
            .map_err(|failure| io_failure("session", &failure))?;
        Ok(true)
    }
}

#[async_trait]
impl TranscriptExport for TranscriptFiles {
    async fn transcript_path(&self, session_id: &str) -> Value {
        if !is_session_id(session_id) {
            return Value::Null;
        }
        let exported = self.refresh(session_id).await.unwrap_or_else(|error| {
            tracing::warn!(?error, session_id, "hook transcript export failed");
            false
        });
        let shown = if exported { export_path(&self.data_dir, session_id) } else { self.data_dir.join("sessions").join(format!("{session_id}.json")) };
        json!(shown.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_without_messages_renders_an_empty_base() {
        let header: Header = [("id".to_owned(), json!("sess_a"))].into_iter().collect();
        assert_eq!(
            render("0123456789abcdef01234567", "sess_a", &header, &[]),
            "{\"t\":\"session\",\"s\":0,\"v\":1,\"logId\":\"0123456789abcdef01234567\",\"id\":\"sess_a\",\"prev\":null,\"legacy\":null,\"header\":{\"id\":\"sess_a\"}}\n{\"t\":\"compacted\",\"s\":1,\"len\":0,\"messages\":[]}\n"
        );
    }
}
