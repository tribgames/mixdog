//! The session's tail reminder source.

use std::sync::Arc;

use mixdog_agent::env::TailReminder;
use mixdog_agent::tail_rules::RuleTailReminder;
use mixdog_agent::tail_rules::TailContext;
use mixdog_agent::tail_rules::TailLanguage;
use mixdog_agent::tail_rules::TailRole;
use mixdog_store::schema::record::Header;
use serde_json::Value;

/// The built-in rules against the session's provider, language and role.
pub fn session_tail_reminder(context: TailContext) -> Arc<dyn TailReminder> {
    Arc::new(RuleTailReminder { context })
}

/// `withTailReminder`'s context for a session: its provider, its recorded response language and its
/// role (`tailReminderRole`: `worker` for an agent-owned session, `bot` in agent mode, else
/// `lead`). A header with no `responseLanguage` record (an agent, an older record) reads the
/// config: `config_language` is `rules_lead::build_lead_language` for the install, which the caller
/// runs in a lane job and which is asked for only then. A recorded `null` is a recorded "no language".
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
    use mixdog_agent::tail_rules::TailLanguage;
    use mixdog_agent::tail_rules::TailRole;

    use super::*;

    #[test]
    fn opus_korean_lead_gets_the_language_reminder() {
        let reminder = session_tail_reminder(TailContext {
            provider: "anthropic-oauth".into(),
            language: Some(TailLanguage { id: "ko".into(), name: "Korean".into() }),
            role: TailRole::Lead,
        });
        assert_eq!(
            reminder.text("claude-opus-5-5-20260101").as_deref(),
            Some("<system-reminder>Write all user-facing text in Korean.</system-reminder>")
        );
        assert_eq!(reminder.text("gpt-5"), None);
    }

    fn header(value: serde_json::Value) -> Header {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn the_context_follows_the_headers_role_and_recorded_language() {
        let lead = tail_context(&header(serde_json::json!({ "provider": "openai", "responseLanguage": { "id": "ko", "name": "Korean" } })), || panic!("a recorded language is not re-read"));
        assert_eq!((lead.provider.as_str(), lead.role, lead.language.map(|l| l.name)), ("openai", TailRole::Lead, Some("Korean".to_owned())));
        let bot = tail_context(&header(serde_json::json!({ "sessionMode": "agent", "responseLanguage": null })), || panic!("null is a recorded no language"));
        assert!(bot.role == TailRole::Bot && bot.language.is_none());
        let worker = tail_context(&header(serde_json::json!({ "owner": "agent", "sessionMode": "agent" })), || Some(("ja".into(), "Japanese".into())));
        assert!(worker.role == TailRole::Worker);
        assert_eq!(worker.language.map(|l| l.id).as_deref(), Some("ja"));
    }
}
