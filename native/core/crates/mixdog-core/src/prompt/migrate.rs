//! The 1.4.5 system messages to the header fields (for WP-MIGRATE).
//!
//! A 1.4.5 session record carries its system prompt as the leading `system` messages of
//! `messages`. The migration reads the record's `messages` and header with
//! [`migrate_system_messages`], starts the model rows at [`Migration::rows_from`] and writes
//! [`Migration::apply`] into the header it stores. Nothing is guessed: a record whose prefix is
//! not one Node writes is an error for the migration to report.

use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::blocks::ShapeError;
use super::blocks::SystemBlocks;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MigrateError {
    #[error(transparent)]
    Shape(#[from] ShapeError),
    /// A system message after the first non-system one: Node never writes one.
    #[error("system message {0} follows conversation messages")]
    LateSystem(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migration {
    pub blocks: SystemBlocks,
    /// Index of the first model row in the record's `messages`.
    pub rows_from: usize,
    /// The record lacks `bp3EnvSplit: true`. Node 1.4.6 does not convert such a session on load
    /// (no code writes the flag except `buildSessionRecord`, `session-record.mjs:178`), and every
    /// rewrite keeps the combined layout: `refreshSessionBp3Environment` `prompt-utils.mjs:180`,
    /// `rerootSessionWorkspace` `:304`, `resetSessionBp3Environment` `:574`, `rewriteBp3Core` and
    /// `rewriteConversationBp3Core` `surface-helpers.mjs:62,89`. So the message stays one combined
    /// `tier3` message, in `promptTier3`, and the flag stays absent.
    pub combined_layout: bool,
}

/// `messages`: the record's array; `header`: the record minus `messages`.
pub fn migrate_system_messages(messages: &[Value], header: &Header) -> Result<Migration, MigrateError> {
    let is_system = |message: &Value| message.get("role").and_then(Value::as_str) == Some("system");
    let rows_from = messages.iter().position(|message| !is_system(message)).unwrap_or(messages.len());
    if let Some(late) = messages[rows_from..].iter().position(is_system) {
        return Err(MigrateError::LateSystem(rows_from + late));
    }
    let mut blocks = SystemBlocks::from_node_messages(&messages[..rows_from])?;
    blocks.combined = header.get("bp3EnvSplit") != Some(&Value::Bool(true));
    Ok(Migration { combined_layout: blocks.combined, blocks, rows_from })
}

impl Migration {
    /// Writes the blocks into the header the migrated session stores. A split record gets the
    /// four fields (`bp3CoreContext` is the `tier3` text, removed when the record had no `tier3`
    /// message); a combined one gets `promptTier3` and keeps its `bp3CoreContext` (the core) and
    /// its missing flag.
    pub fn apply(&self, header: &mut Header) {
        self.blocks.write(header);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn header(value: Value) -> Header {
        value.as_object().expect("object").clone()
    }

    fn sys(content: &str, tier: Option<&str>) -> Value {
        let mut message = json!({"role": "system", "content": content, "meta": {"transcript": {"messageId": "msg_1"}}});
        if let Some(tier) = tier {
            message["cacheTier"] = json!(tier);
        }
        message
    }

    #[test]
    fn a_split_record_maps_message_for_message_and_the_message_text_wins() {
        let messages = vec![
            sys("rules", None),
            sys("stable", None),
            sys("core", Some("tier3")),
            sys("env", Some("env")),
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "content": "yo"}),
        ];
        let mut h = header(json!({"bp3EnvSplit": true, "bp3CoreContext": "stale core", "bp3EnvironmentContext": "tail"}));
        let migration = migrate_system_messages(&messages, &h).unwrap();
        assert_eq!(migration.rows_from, 4);
        assert!(!migration.combined_layout);
        migration.apply(&mut h);
        assert_eq!(
            Value::Object(h),
            json!({"bp3EnvSplit": true, "bp3CoreContext": "core", "bp3EnvironmentContext": "tail",
                   "promptBase": "rules", "promptStable": "stable", "promptEnv": "env"})
        );
    }

    #[test]
    fn a_record_without_a_tier3_message_loses_the_empty_core_field() {
        let messages = vec![sys("rules", None), json!({"role": "user", "content": "hi"})];
        let mut h = header(json!({"bp3EnvSplit": true, "bp3CoreContext": ""}));
        migrate_system_messages(&messages, &h).unwrap().apply(&mut h);
        assert!(h.get("bp3CoreContext").is_none());
        assert_eq!(h["promptBase"], "rules");
        let none = migrate_system_messages(&[json!({"role": "user", "content": "x"})], &h).unwrap();
        assert_eq!((none.rows_from, none.blocks), (0, SystemBlocks::default()));
    }

    #[test]
    fn a_combined_layout_record_stays_one_combined_tier3_message_with_the_flag_absent() {
        let tier3 = "core\n\n---\n\n# Session\nCwd: C:/p\n\n---\n\n- Cwd: C:/p";
        let messages = vec![sys("rules", None), sys("stable", None), sys(tier3, Some("tier3"))];
        let mut h = header(json!({"bp3CoreContext": "core", "bp3EnvironmentContext": "- Cwd: C:/p"}));
        let migration = migrate_system_messages(&messages, &h).unwrap();
        assert!(migration.combined_layout);
        assert_eq!(migration.blocks.env, None);
        migration.apply(&mut h);
        assert_eq!(
            Value::Object(h.clone()),
            json!({"bp3CoreContext": "core", "bp3EnvironmentContext": "- Cwd: C:/p",
                   "promptBase": "rules", "promptStable": "stable", "promptTier3": tier3})
        );
        let sent = crate::prompt::blocks::request_system_messages(&h);
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[2].content, mixdog_core_api::domain::provider::Content::Text(tier3.to_owned()));
    }

    #[test]
    fn a_system_message_among_conversation_rows_is_refused() {
        let messages = vec![sys("rules", None), json!({"role": "user", "content": "hi"}), sys("late", None)];
        assert_eq!(migrate_system_messages(&messages, &Header::new()), Err(MigrateError::LateSystem(2)));
    }
}
