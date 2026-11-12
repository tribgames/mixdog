//! The session transcript file user hooks are told about (`transcript_path`): a read-only
//! copy of the session in 1.4.5's `<data>/sessions/<id>.log.jsonl` form, derived from the
//! thread store when a hook is about to run.
//!
//! The thread store stays the only owner of the real log (`sessions/<id>/`); nothing reads the
//! copy back. It is the log's base form: the `session` record and one `compacted` record that
//! holds the whole model context (`session-log-format.mjs`), written whole through a
//! temporary file and a rename, so a hook never reads half of it. A session with no model
//! context yet has no such file: the path is the `<id>.json` 1.4.5 names before its first log
//! (`hookTranscriptPath`), and an id that cannot name a session gets `null`.

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
    format!(
        "{}\n{{\"t\":\"compacted\",\"s\":1,\"len\":{},\"messages\":[{}]}}\n",
        mixdog_js::json_stringify(&session),
        messages.len(),
        messages.join(",")
    )
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
        Ok(Some((log_id, header, rows
            .into_iter()
            .map(|(_, mut message)| {
                mixdog_agent::interrupt::without_recovery_mark(&mut message);
                message
            })
            .collect())))
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
        let shown = if exported {
            export_path(&self.data_dir, session_id)
        } else {
            self.data_dir.join("sessions").join(format!("{session_id}.json"))
        };
        json!(shown.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The log a real 1.4.5 `saveSessionDurably` wrote for a conversation
    /// (`fixtures/session-log-export/session_log.json`, recorded by
    /// `benchmarks/rust-core/recorders/record-session-log-export.mjs`): the same id, header,
    /// messages and log id must give the same bytes.
    #[test]
    fn the_export_is_the_log_node_wrote_for_the_conversation() {
        let (golden, record, header) = recorded();
        let messages = record["messages"].as_array().expect("messages");
        let made = render(golden["logId"].as_str().expect("logId"), record["id"].as_str().expect("id"), &header, messages);
        assert_eq!(made, golden["log"].as_str().expect("log"));
    }

    /// The golden, the record Node saved (in the key order Node had it: the log's key order is the
    /// record's), and its header: the record without its messages.
    fn recorded() -> (Value, serde_json::Map<String, Value>, Header) {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/session-log-export/session_log.json")).expect("golden");
        let record = golden["record"].as_object().expect("record").clone();
        let header: Header = record.iter().filter(|(key, _)| key.as_str() != "messages").map(|(key, value)| (key.clone(), value.clone())).collect();
        (golden, record, header)
    }

    /// A session in the real thread store with the given log id, header and message bodies, made
    /// through the store's own creation (`create_log`) and append (`commit`) path. The log id and
    /// bodies are injected here because a live session generates its own and a turn writes
    /// its own header fields; nothing outside tests can do this.
    async fn seed(store: &Arc<dyn ThreadStore>, id: &str, log_id: &str, header: &Header, messages: &[Value]) {
        use mixdog_rt::testing::tokens;
        use mixdog_store::schema::blob::Slot;
        use mixdog_store::schema::bounded::Id;
        use mixdog_store::schema::bounded::Name;
        use mixdog_store::schema::bounded::Text;
        use mixdog_store::schema::record::Form;
        use mixdog_store::schema::record::ItemRecord;
        use mixdog_store::schema::record::Record;
        use mixdog_store::schema::record::SESSION_RECORD_VERSION;
        use mixdog_store::schema::record::SessionRecord;

        use super::super::seams::CommitRecord;
        use super::super::seams::RecordCodec;

        let tokens = tokens();
        let token = CancellationToken::new();
        let mut records = vec![Record::Session(SessionRecord {
            v: SESSION_RECORD_VERSION,
            id: Text::try_from(id).expect("session id"),
            log_id: Text::try_from(log_id).expect("log id"),
            base: None,
            origin: None,
            op: None,
            control: false,
            header: Slot::Inline(header.clone()),
        })];
        for (n, message) in messages.iter().enumerate() {
            let iid = format!("m{n}");
            records.push(Record::Item(ItemRecord {
                iid: Id::try_from(iid.as_str()).expect("item id"),
                turn: None,
                role: message["role"].as_str().and_then(|role| Name::try_from(role).ok()),
                form: Form::Message,
                model: true,
                visible: true,
                archive: None,
                op: None,
                prompt: None,
                refs: Vec::new().try_into().expect("empty list fits"),
                body: Slot::Inline(message.clone()),
            }));
        }
        let batch = on_lane(tokens.cpu_interactive, &token, move |lane| {
            records
                .into_iter()
                .map(|record| {
                    let encoded = super::super::StoreCodec.encode(lane, &record)?;
                    Ok::<_, CoreError>(CommitRecord { record: Arc::new(record), encoded })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .await
        .expect("encode job")
        .expect("encoded");
        let (store, thread) = (store.clone(), ThreadId::from(id));
        on_lane(tokens.durability_io, &token, move |lane| {
            let (session, items) = batch.split_first().expect("the session record");
            let (mut log, _) = store.create_log(lane, &thread, session)?;
            log.commit(lane, items)
        })
        .await
        .expect("commit job")
        .expect("seeded");
    }

    /// The conversation Node's recorded log holds, rebuilt in the real thread store with Node's
    /// log id, header and message bodies: the export is Node's log byte for byte.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_store_session_exports_the_log_node_wrote_for_the_conversation() {
        let (golden, record, header) = recorded();
        let id = record["id"].as_str().expect("id");
        let data = tempfile::tempdir().expect("data dir");
        let store = super::super::tests::real_store(data.path()).await;
        seed(&store, id, golden["logId"].as_str().expect("logId"), &header, record["messages"].as_array().expect("messages")).await;

        let tokens = mixdog_rt::testing::tokens();
        let lanes = SessionLanes { cpu: tokens.cpu_interactive, io: tokens.interactive_io, durability: tokens.durability_io };
        let files = TranscriptFiles::new(data.path(), store, lanes, tokens.maintenance_io);
        let path = export_path(data.path(), id);
        assert_eq!(files.transcript_path(id).await, json!(path.to_string_lossy()));
        let read = path.clone();
        let bytes = on_lane(tokens.maintenance_io, &CancellationToken::new(), move |_| mixdog_statefile::read_content(&read))
            .await
            .expect("read job")
            .expect("readable")
            .expect("the export exists");
        assert_eq!(String::from_utf8(bytes).expect("UTF-8"), golden["log"].as_str().expect("log"));
    }

    #[test]
    fn a_session_without_messages_renders_an_empty_base() {
        let header: Header = [("id".to_owned(), json!("sess_a"))].into_iter().collect();
        assert_eq!(
            render("0123456789abcdef01234567", "sess_a", &header, &[]),
            "{\"t\":\"session\",\"s\":0,\"v\":1,\"logId\":\"0123456789abcdef01234567\",\"id\":\"sess_a\",\"prev\":null,\"legacy\":null,\"header\":{\"id\":\"sess_a\"}}\n{\"t\":\"compacted\",\"s\":1,\"len\":0,\"messages\":[]}\n"
        );
    }
}
