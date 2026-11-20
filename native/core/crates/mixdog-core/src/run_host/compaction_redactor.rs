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

    #[test]
    fn a_session_is_redacted_by_its_own_marks_only() {
        let store = Arc::new(SensitiveStore::default());
        store.remember("a", &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "text": "s3cret", "sensitive": true } } })]);
        let row = json!({ "role": "user", "content": "s3cret" });
        assert_eq!(SensitiveRedactor::new(store.clone(), "a").redact(vec![row.clone()]), [json!({ "role": "user", "content": "[redacted]" })]);
        assert_eq!(SensitiveRedactor::new(store, "b").redact(vec![row.clone()]), [row]);
    }


}
