//! The session's tail reminder source.

use std::sync::Arc;

use mixdog_agent::env::TailReminder;
use mixdog_agent::tail_rules::RuleTailReminder;
use mixdog_agent::tail_rules::TAIL_REMINDER_RULES;
use mixdog_agent::tail_rules::TailContext;
use mixdog_agent::tail_rules::TailLanguage;
use mixdog_agent::tail_rules::TailRole;
use mixdog_store::schema::record::Header;
use serde_json::Value;

/// The built-in rules against the session's provider, language and role.
pub fn session_tail_reminder(context: TailContext) -> Arc<dyn TailReminder> {
    Arc::new(RuleTailReminder { context, rules: TAIL_REMINDER_RULES })
}

/// The role is `worker` for an agent-owned session, `bot` in agent mode, else `lead`. A header with no
/// `responseLanguage` record reads `config_language`, called only then; a recorded `null` is a recorded "no language".
pub fn tail_context(header: &Header, config_language: impl FnOnce() -> Option<(String, String)>) -> TailContext {
    let text = |key: &str| header.get(key).and_then(Value::as_str).unwrap_or_default();
    let language = match header.get("responseLanguage") {
        Some(Value::Object(language)) => {
            let part = |key: &str| language.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            Some(TailLanguage { id: part("id"), name: part("name") })
        }
        Some(_) => None,
        None => config_language().map(|(id, name)| TailLanguage { id, name }),
    };
    let role = if text("owner") == "agent" {
        TailRole::Worker
    } else if text("sessionMode") == "agent" {
        TailRole::Bot
    } else {
        TailRole::Lead
    };
    TailContext { provider: text("provider").to_owned(), language, role }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::tail_rules::TailRole;

    use super::*;

    fn header(value: serde_json::Value) -> Header {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn the_context_follows_the_headers_role_and_recorded_language() {
        let lead = tail_context(&header(serde_json::json!({ "provider": "openai", "responseLanguage": { "id": "ko", "name": "Korean" } })), || {
            panic!("a recorded language is not re-read")
        });
        assert_eq!((lead.provider.as_str(), lead.role, lead.language.map(|l| l.name)), ("openai", TailRole::Lead, Some("Korean".to_owned())));
        let bot = tail_context(&header(serde_json::json!({ "sessionMode": "agent", "responseLanguage": null })), || panic!("null is a recorded no language"));
        assert!(bot.role == TailRole::Bot && bot.language.is_none());
        let worker = tail_context(&header(serde_json::json!({ "owner": "agent", "sessionMode": "agent" })), || Some(("ja".into(), "Japanese".into())));
        assert!(worker.role == TailRole::Worker);
        assert_eq!(worker.language.map(|l| l.id).as_deref(), Some("ja"));
    }
}
