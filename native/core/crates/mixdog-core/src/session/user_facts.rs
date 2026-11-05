//! The typed facts of a row as the live writer stores them: the one classification the
//! migration also writes (`mixdog_protocol::message_class::row_facts`), so a live row and a
//! migrated row of one message are identical.

use std::path::PathBuf;

pub use mixdog_protocol::message_class::RowFacts;
use mixdog_protocol::message_class::row_facts;
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_protocol::message_class::user_text::ReadError;
use mixdog_protocol::message_class::user_text::UserText;
use serde_json::Value;

/// The facts of a message the writer stores (`meta.taskCard` / `meta.turnEnd` go into
/// `body`); a message that is neither a room row nor user-role shows as given.
pub fn user_facts(body: &mut Value, blobs: &dyn Blobs) -> RowFacts {
    row_facts(body, &mut UserText::new(blobs)).unwrap_or(RowFacts { visible: true, prompt: None })
}

/// The prompt-attachment store (`<data>/prompt-attachments/sha256/<ab>/<hex>`).
pub struct DataBlobs(pub PathBuf);

impl Blobs for DataBlobs {
    fn text_within(&self, hex: &str, max_bytes: u64) -> Result<Option<String>, ReadError> {
        let Some(shard) = hex.get(..2) else {
            return Err(ReadError::Other);
        };
        let path = self.0.join("prompt-attachments/sha256").join(shard).join(hex);
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() as u64 > max_bytes => Ok(None),
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ReadError::Missing),
            Err(_) => Err(ReadError::Other),
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_migrate::session::model::Row;
    use mixdog_migrate::session::restore::convert;
    use mixdog_store::schema::record::Form;

    use serde_json::json;

    use super::*;

    struct NoBlobs;

    impl Blobs for NoBlobs {
        fn text_within(&self, _hex: &str, _max: u64) -> Result<Option<String>, ReadError> {
            Err(ReadError::Missing)
        }
    }

    #[test]
    fn a_live_row_equals_the_migrated_row_of_the_same_message() {
        for message in [
            json!({ "role": "user", "content": "write a haiku" }),
            json!({ "role": "user", "content": "loaded skill", "meta": "skill" }),
            json!({ "role": "user", "content": "done", "meta": {
                "source": "task-notification",
                "execution": { "taskId": "t1", "status": "completed" } } }),
            json!({ "role": "user", "content": "steer", "meta": { "source": "steering" } }),
            json!({ "role": "user", "content": "result", "meta": { "source": "schedule-result" } }),
            json!({ "role": "user", "content": "[Request interrupted by user]" }),
            json!({ "role": "user", "content": "", "meta": { "transcript": { "displayText": "shown" } } }),
        ] {
            let mut migrated = Row {
                iid: "i".into(),
                turn: None,
                role: Some("user".into()),
                form: Form::Message,
                model: true,
                visible: true,
                archive: None,
                prompt: None,
                body: message.clone(),
            };
            convert([&mut migrated], &NoBlobs);
            let mut live = message.clone();
            let facts = user_facts(&mut live, &NoBlobs);
            assert_eq!(
                (facts.visible, facts.prompt, live),
                (migrated.visible, migrated.prompt, migrated.body),
                "{message}"
            );
        }
    }
}
