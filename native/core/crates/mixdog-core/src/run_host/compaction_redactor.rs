//! The sensitive-value redaction a compaction applies to the stored rows it judges (Node
//! `_messagesForDisk(messages, sessionId)`, `session/store/serialize.mjs`).
//!
//! The rows a compaction reads are the bodies the store holds, already in stored form (media is
//! a reference or a placeholder), and Node's stored-form projection passes such content through
//! unchanged, so what remains of `_messagesForDisk` for them is the session's sensitive marks:
//! [`SensitiveStore::redact_messages`] with the thread as the session.

use std::sync::Arc;

use mixdog_agent::compact::dropped::Redactor;
use mixdog_services::memory::sensitive::SensitiveStore;
use serde_json::Value;

/// One session's redaction of stored rows.
pub struct SensitiveRedactor {
    store: Arc<SensitiveStore>,
    session: String,
}

impl SensitiveRedactor {
    pub fn new(store: Arc<SensitiveStore>, session: &str) -> Self {
        Self { store, session: session.to_owned() }
    }
}

impl Redactor for SensitiveRedactor {
    fn redact(&self, rows: Vec<Value>) -> Vec<Value> {
        self.store.redact_messages(&self.session, &rows)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Node's `_messagesForDisk` over stored rows, recorded for a session without marks and two
    /// with (`golden/compaction_redactor.json`, from `gen-compaction-redactor.mjs`).
    const GOLDEN: &str = include_str!("golden/compaction_redactor.json");

    #[test]
    fn rows_are_redacted_as_nodes_messages_for_disk_stores_them() {
        let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
        let rows: Vec<Value> = golden["rows"].as_array().expect("rows").clone();
        let store = Arc::new(SensitiveStore::default());
        for session in golden["sessions"].as_array().expect("sessions") {
            let id = session["id"].as_str().expect("id");
            let calls: Vec<Value> = session["calls"].as_array().expect("calls").clone();
            assert_eq!(store.remember(id, &calls), session["marked"].as_bool().expect("marked"), "{id}");
            let got = SensitiveRedactor::new(store.clone(), id).redact(rows.clone());
            let want = session["stored"].as_array().expect("stored");
            assert_eq!(got.len(), want.len(), "{id}");
            for (index, (got, want)) in got.iter().zip(want).enumerate() {
                assert_eq!(got, want, "{id} row {index}: {}", rows[index]);
            }
            assert_eq!(got == rows, session["same"].as_bool().expect("same"), "{id}: untouched rows stay as they are");
        }
    }

    #[test]
    fn a_session_is_redacted_by_its_own_marks_only() {
        let store = Arc::new(SensitiveStore::default());
        store.remember("a", &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "text": "s3cret", "sensitive": true } } })]);
        let row = json!({ "role": "user", "content": "s3cret" });
        assert_eq!(SensitiveRedactor::new(store.clone(), "a").redact(vec![row.clone()]), [json!({ "role": "user", "content": "[redacted]" })]);
        assert_eq!(SensitiveRedactor::new(store, "b").redact(vec![row.clone()]), [row]);
    }
}
